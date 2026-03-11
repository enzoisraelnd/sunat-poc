import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { InvoiceItem } from './dynamodb';
import { getAccessToken } from './sunat-auth';
import { logger } from '../utils/logger';

const SIRE_BASE = 'https://api-sire.sunat.gob.pe/v1/contribuyente';
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 30;

const s3 = new S3Client({});

// codEstadoProceso values returned by consultaestadotickets
const COD_ESTADO_TERMINADO = '06';
const COD_ESTADO_ERROR     = '03'; // "Procesado con Errores"

interface SireTicketResponse {
  numTicket: string;
}

interface SireArchivoReporte {
  codTipoAchivoReporte: string;
  nomArchivoReporte: string;
  nomArchivoContenido: string | null;
}

interface SireRegistro {
  numTicket: string;
  perTributario: string;
  codEstadoProceso: string;
  desEstadoProceso: string;
  codProceso: string;
  archivoReporte: SireArchivoReporte[] | null;
}

interface SireStatusResponse {
  paginacion: { page: number; perPage: number; totalRegistros: number };
  registros: SireRegistro[];
}

/**
 * Parsed invoice line from SUNAT SIRE CSV export (codTipoArchivo=1).
 *
 * CSV columns (0-indexed):
 *  0  Ruc                        13 Valor Facturado Exportación   26 Moneda
 *  1  Razon Social               14 BI Gravada                    27 Tipo Cambio
 *  2  Periodo                    15 Dscto BI                      28 Fecha Emisión Doc Modificado
 *  3  CAR SUNAT                  16 IGV / IPM                     29 Tipo CP Modificado
 *  4  Fecha de emisión           17 Dscto IGV / IPM               30 Serie CP Modificado
 *  5  Fecha Vcto/Pago            18 Mto Exonerado                 31 Nro CP Modificado
 *  6  Tipo CP/Doc.               19 Mto Inafecto                  32 ID Proyecto
 *  7  Serie del CDP              20 ISC                           33 Tipo de Nota
 *  8  Nro CP o Doc.              21 BI Grav IVAP                  34 Est. Comp
 *  9  Nro Final (Rango)          22 IVAP                          35 Valor FOB Embarcado
 * 10  Tipo Doc Identidad         23 ICBPER                        36 Valor OP Gratuitas
 * 11  Nro Doc Identidad          24 Otros Tributos                37 Tipo Operación
 * 12  Apellidos/Razón Social     25 Total CP                      38 DAM / CP
 *                                                                  39 CLU
 */
interface SireInvoiceLine {
  tipoCpDoc: string;           // col 6  — "01" = factura, "03" = boleta, "07" = nota crédito
  serieCdp: string;            // col 7  — e.g. "FFF1", "B001"
  nroCpDoc: string;            // col 8  — e.g. "302"
  fechaEmision: string;        // col 4  — dd/mm/yyyy
  tipoDocIdentidad: string;    // col 10 — "6" = RUC, "1" = DNI
  nroDocIdentidad: string;     // col 11 — buyer RUC/DNI
  razonSocial: string;         // col 12 — buyer name
  biGravada: number;           // col 14 — base imponible gravada
  igv: number;                 // col 16 — IGV / IPM
  mtoExonerado: number;        // col 18 — monto exonerado
  mtoInafecto: number;         // col 19 — monto inafecto
  totalCp: number;             // col 25 — total comprobante
  moneda: string;              // col 26 — "PEN" | "USD"
  estComp: string;             // col 34 — "1" = active, "0" = cancelled
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads response body as text, logs it, then parses as JSON.
 * Avoids silent "Unexpected end of JSON input" by surfacing the raw body.
 */
async function safeJson<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();
  if (!text || text.trim() === '') {
    throw new Error(`${context}: empty response body`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    logger.error(`${context}: invalid JSON`, { preview: text.slice(0, 300) });
    throw new Error(`${context}: invalid JSON — ${(err as Error).message}`);
  }
}

async function createTicket(ruc: string, period: string, token: string): Promise<string> {
  const url =
    `${SIRE_BASE}/migeigv/libros/rvie/propuesta/web/propuesta/${period}/exportapropuesta` +
    `?codTipoArchivo=1`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('SIRE create ticket failed', { ruc, period, status: response.status, body: text });
    throw new Error(`SIRE ticket creation failed: ${response.status}`);
  }

  const data = await safeJson<SireTicketResponse>(response, 'createTicket');
  logger.info('SIRE ticket created', { ruc, period, ticket: data.numTicket });
  return data.numTicket;
}

/**
 * Polls the ticket status list endpoint (filtered by the same period the ticket was created for)
 * until the target ticket reaches codEstadoProceso "06" (Terminado).
 * perIni === perFin === period because the ticket belongs to that single period.
 */
async function pollTicket(
  ruc: string,
  period: string,
  ticketNumber: string,
  token: string,
): Promise<SireRegistro> {
  const url =
    `${SIRE_BASE}/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets` +
    `?perIni=${period}&perFin=${period}&page=1&perPage=20` +
    `&codLibro=140000&codOrigenEnvio=2`;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.warn('SIRE poll status non-OK, retrying', { ruc, ticketNumber, status: response.status, attempt });
      continue;
    }

    const data = await safeJson<SireStatusResponse>(response, 'pollTicket');
    const registro = data.registros?.find(r => r.numTicket === ticketNumber);

    if (!registro) {
      logger.warn('Ticket not yet in status list, retrying', { ruc, ticketNumber, attempt });
      continue;
    }

    logger.info('SIRE ticket status', {
      ruc, ticketNumber, codEstado: registro.codEstadoProceso, desEstado: registro.desEstadoProceso, attempt,
    });

    if (registro.codEstadoProceso === COD_ESTADO_TERMINADO) return registro;

    if (registro.codEstadoProceso === COD_ESTADO_ERROR) {
      throw new Error(`SIRE ticket processed with errors: ${registro.desEstadoProceso} (ticket: ${ticketNumber})`);
    }
  }

  throw new Error(`SIRE ticket polling timed out after ${POLL_MAX_ATTEMPTS} attempts`);
}

async function downloadAndParse(
  ruc: string,
  period: string,
  ticketNumber: string,
  registro: SireRegistro,
  token: string,
): Promise<InvoiceItem[]> {
  // codTipoAchivoReporte "00" = export/propuesta file — fallback to first available
  const archivos = registro.archivoReporte ?? [];
  const exportArchivo = archivos.find(a => a.codTipoAchivoReporte === '00') ?? archivos[0];

  if (!exportArchivo?.nomArchivoReporte) {
    throw new Error(`No download file found in ticket ${ticketNumber} archivoReporte`);
  }

  const SIRE_COD_LIBRO_RVIE = '140000';

  const fileName   = exportArchivo.nomArchivoReporte;
  const codTipo    = exportArchivo.codTipoAchivoReporte;
  const url =
    `${SIRE_BASE}/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte` +
    `?nomArchivoReporte=${encodeURIComponent(fileName)}` +
    `&codTipoArchivoReporte=${codTipo}` +
    `&codLibro=${SIRE_COD_LIBRO_RVIE}` +
    `&perTributario=${period}` +
    `&codProceso=${registro.codProceso}` +
    `&numTicket=${ticketNumber}`;

  logger.info('Downloading SIRE ZIP', { ruc, period, ticketNumber, fileName });

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('SIRE download failed', { ruc, period, ticketNumber, status: response.status, body: text });
    throw new Error(`SIRE download failed: ${response.status}`);
  }

  // SUNAT returns a ZIP. We read it as ArrayBuffer, save to S3, then parse the CSV inside.
  const zipBuffer = Buffer.from(await response.arrayBuffer());

  logger.info('SIRE download received', { ruc, period, ticketNumber, sizeBytes: zipBuffer.length });

  // Save raw ZIP to S3 for audit / reprocessing
  const s3Key = `${ruc}/${period}/${ticketNumber}.zip`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: s3Key,
    Body: zipBuffer,
    ContentType: 'application/zip',
  }));
  logger.info('ZIP saved to S3', { ruc, period, s3Key });

  // Parse ZIP in memory using Node.js built-in zlib / manual ZIP parsing
  const lines = await parseZipToInvoiceLines(zipBuffer);

  // Filter: only facturas (tipo 01) with active status (estComp "1")
  return lines
    .filter(l => l.tipoCpDoc === '01' && l.estComp === '1')
    .map(l => ({
      series_number: `${l.serieCdp}-${l.nroCpDoc}`,
      issue_date: convertDate(l.fechaEmision),      // dd/mm/yyyy → yyyy-mm-dd
      buyer_ruc: l.nroDocIdentidad,
      buyer_company_name: l.razonSocial,
      base_amount: l.biGravada,
      igv: l.igv,
      total_amount: l.totalCp,
      currency: l.moneda,
      status: 'ACCEPTED',
    }));
}

/** Convert dd/mm/yyyy → yyyy-mm-dd */
function convertDate(ddmmyyyy: string): string {
  const parts = ddmmyyyy.split('/');
  if (parts.length !== 3) return ddmmyyyy;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

async function parseZipToInvoiceLines(zipBuffer: Buffer): Promise<SireInvoiceLine[]> {
  // SUNAT SIRE returns a ZIP containing a single CSV file (comma-delimited, with header row).
  // The ZIP may be prefixed with a data descriptor (PK\x07\x08) before the local file header.

  const LOCAL_FILE_HEADER_SIG = 0x04034b50; // PK\x03\x04
  const DATA_DESCRIPTOR_SIG   = 0x08074b50; // PK\x07\x08

  // Find the start of the local file header (may be offset by a data descriptor prefix)
  let offset = 0;
  const view = new DataView(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);

  if (view.getUint32(0, true) === DATA_DESCRIPTOR_SIG) {
    // Skip the 4-byte data descriptor signature prefix
    offset = 4;
    logger.info('ZIP has data descriptor prefix, skipping 4 bytes');
  }

  if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER_SIG) {
    const actual = view.getUint32(offset, true).toString(16).padStart(8, '0');
    throw new Error(`Response is not a valid ZIP file (sig at offset ${offset}: 0x${actual})`);
  }

  const compressionMethod = view.getUint16(offset + 8, true);
  const compressedSize    = view.getUint32(offset + 18, true);
  const fileNameLength    = view.getUint16(offset + 26, true);
  const extraFieldLength  = view.getUint16(offset + 28, true);

  const fileNameStart = offset + 30;
  const fileName = zipBuffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString('utf8');
  logger.info('ZIP inner file', { fileName, compressionMethod, compressedSize });

  const dataOffset = fileNameStart + fileNameLength + extraFieldLength;
  const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

  let content: string;
  if (compressionMethod === 0) {
    content = compressedData.toString('utf8');
  } else if (compressionMethod === 8) {
    const { inflateRawSync } = await import('zlib');
    content = inflateRawSync(compressedData).toString('utf8');
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }

  logger.info('Decompressed CSV content', { lengthChars: content.length });

  return parseCsvContent(content);
}

/**
 * Parse SUNAT SIRE comma-delimited CSV export (codTipoArchivo=1).
 * First row is a header — skipped. Subsequent rows are data.
 */
function parseCsvContent(content: string): SireInvoiceLine[] {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length <= 1) return []; // header only or empty

  // Skip header row (index 0)
  const dataLines = lines.slice(1);

  logger.info('CSV parsing', { totalLines: lines.length, dataRows: dataLines.length, headerCols: lines[0].split(',').length });

  const results: SireInvoiceLine[] = [];

  for (const line of dataLines) {
    const cols = line.split(',');
    if (cols.length < 35) continue; // skip malformed lines

    results.push({
      tipoCpDoc:         cols[6] ?? '',
      serieCdp:          cols[7] ?? '',
      nroCpDoc:          cols[8] ?? '',
      fechaEmision:      cols[4] ?? '',
      tipoDocIdentidad:  cols[10] ?? '',
      nroDocIdentidad:   cols[11] ?? '',
      razonSocial:       cols[12] ?? '',
      biGravada:         parseFloat(cols[14] || '0') || 0,
      igv:               parseFloat(cols[16] || '0') || 0,
      mtoExonerado:      parseFloat(cols[18] || '0') || 0,
      mtoInafecto:       parseFloat(cols[19] || '0') || 0,
      totalCp:           parseFloat(cols[25] || '0') || 0,
      moneda:            cols[26] ?? '',
      estComp:           cols[34] ?? '',
    });
  }

  logger.info('CSV parsed', { parsedRecords: results.length });
  return results;
}

export async function fetchAcceptedInvoices(ruc: string, period: string): Promise<InvoiceItem[]> {
  const token = await getAccessToken(ruc);

  const ticketNumber = await createTicket(ruc, period, token);
  const registro    = await pollTicket(ruc, period, ticketNumber, token);
  const invoices    = await downloadAndParse(ruc, period, ticketNumber, registro, token);

  logger.info('Accepted invoices fetched from SUNAT', { ruc, period, count: invoices.length });
  return invoices;
}
