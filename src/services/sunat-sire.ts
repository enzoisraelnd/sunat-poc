import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { InvoiceItem } from './dynamodb';
import { getAccessToken } from './sunat-auth';
import { logger } from '../utils/logger';

const SIRE_BASE = 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes';
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 30;

const s3 = new S3Client({});

// SUNAT SIRE ticket status values
type TicketStatus = 'En Proceso' | 'Atendido' | 'Rechazado';

interface SireTicketResponse {
  numTicket: string;
}

interface SireStatusResponse {
  estado: TicketStatus;
  mensaje?: string;
}

// Raw invoice line as returned by SUNAT SIRE for RVIE (sales register)
interface SireInvoiceLine {
  numCpe: string;            // series + number: "F001-00000123"
  fecEmision: string;        // "2025-01-15"
  numDocAdquiriente: string; // buyer RUC/DNI
  nomAdquiriente: string;    // buyer name
  mtoValFactExpo: number;    // base amount (taxable)
  mtoIgv: number;            // IGV tax
  mtoImporteTotal: number;   // total amount
  codMoneda: string;         // "PEN" | "USD"
  tipCpe: string;            // "01" = factura, "07" = nota crédito, etc.
  estado: string;            // "0" = accepted, "1" = cancelled
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createTicket(ruc: string, period: string, token: string): Promise<string> {
  const url = `${SIRE_BASE}/${ruc}/sireventa/rvie/propuesta/comprobantes/exportar`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ perTributario: period }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('SIRE create ticket failed', { ruc, period, status: response.status, body: text });
    throw new Error(`SIRE ticket creation failed: ${response.status}`);
  }

  const data = await response.json() as SireTicketResponse;
  logger.info('SIRE ticket created', { ruc, period, ticket: data.numTicket });
  return data.numTicket;
}

async function pollTicket(ruc: string, ticketNumber: string, token: string): Promise<void> {
  const url = `${SIRE_BASE}/${ruc}/sireventa/rvie/propuesta/comprobantes/exportar/${ticketNumber}`;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      logger.warn('SIRE poll status non-OK, retrying', { ruc, ticketNumber, status: response.status, attempt });
      continue;
    }

    const data = await response.json() as SireStatusResponse;
    logger.info('SIRE ticket status', { ruc, ticketNumber, status: data.estado, attempt });

    if (data.estado === 'Atendido') return;
    if (data.estado === 'Rechazado') {
      throw new Error(`SIRE ticket rejected: ${data.mensaje ?? 'No details'}`);
    }
  }

  throw new Error(`SIRE ticket polling timed out after ${POLL_MAX_ATTEMPTS} attempts`);
}

async function downloadAndParse(
  ruc: string,
  period: string,
  ticketNumber: string,
  token: string,
): Promise<InvoiceItem[]> {
  const url = `${SIRE_BASE}/${ruc}/sireventa/rvie/propuesta/comprobantes/exportar/descarga/${ticketNumber}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('SIRE download failed', { ruc, period, ticketNumber, status: response.status, body: text });
    throw new Error(`SIRE download failed: ${response.status}`);
  }

  // SUNAT returns a ZIP. We read it as ArrayBuffer, save to S3, then parse the JSON inside.
  const zipBuffer = Buffer.from(await response.arrayBuffer());

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

  // Filter: only facturas (tipo 01) with status accepted (estado "0")
  return lines
    .filter(l => l.tipCpe === '01' && l.estado === '0')
    .map(l => ({
      series_number: l.numCpe,
      issue_date: l.fecEmision,
      buyer_ruc: l.numDocAdquiriente,
      buyer_company_name: l.nomAdquiriente,
      base_amount: l.mtoValFactExpo,
      igv: l.mtoIgv,
      total_amount: l.mtoImporteTotal,
      currency: l.codMoneda,
      status: 'ACCEPTED',
    }));
}

async function parseZipToInvoiceLines(zipBuffer: Buffer): Promise<SireInvoiceLine[]> {
  // Node.js 20 does not have a built-in ZIP API — use the DecompressionStream (Web Streams)
  // which is available in Node 18+, but only for gzip/deflate, not zip archives.
  // For a proper ZIP we use the fflate or jszip package.
  // For the pilot we implement a minimal ZIP central-directory parser.
  //
  // SUNAT SIRE downloads a ZIP containing a single JSON file.
  // We locate the first local file entry and decompress it.

  // ZIP local file header signature: PK\x03\x04
  const LOCAL_FILE_HEADER_SIG = 0x04034b50;
  const view = new DataView(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);

  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER_SIG) {
    throw new Error('Response is not a valid ZIP file');
  }

  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);
  const dataOffset = 30 + fileNameLength + extraFieldLength;

  const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

  let jsonString: string;
  if (compressionMethod === 0) {
    // Stored (no compression)
    jsonString = compressedData.toString('utf8');
  } else if (compressionMethod === 8) {
    // Deflate — use Node.js zlib
    const { inflateRawSync } = await import('zlib');
    jsonString = inflateRawSync(compressedData).toString('utf8');
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }

  const parsed = JSON.parse(jsonString);
  // SUNAT wraps the array in an object: { data: [...] } or returns array directly
  return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
}

export async function fetchAcceptedInvoices(ruc: string, period: string): Promise<InvoiceItem[]> {
  const token = await getAccessToken(ruc);

  const ticketNumber = await createTicket(ruc, period, token);
  await pollTicket(ruc, ticketNumber, token);
  const invoices = await downloadAndParse(ruc, period, ticketNumber, token);

  logger.info('Accepted invoices fetched from SUNAT', { ruc, period, count: invoices.length });
  return invoices;
}
