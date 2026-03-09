import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getClient, getCachedInvoices, setCachedInvoices } from '../services/dynamodb';
import { fetchAcceptedInvoices } from '../services/sunat-sire';
import { isValidRuc, isValidPeriod, buildResponse, errorResponse } from '../utils/validation';
import { logger } from '../utils/logger';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return queryInvoices(event, false);
}

export async function queryInvoices(
  event: APIGatewayProxyEvent,
  forceSync: boolean,
): Promise<APIGatewayProxyResult> {
  const ruc = event.pathParameters?.ruc;
  const period = event.queryStringParameters?.period;

  if (!ruc) return errorResponse(400, 'Missing ruc in path');
  if (!period) return errorResponse(400, 'Missing period query parameter (format: YYYYMM)');

  if (!isValidRuc(ruc)) return errorResponse(400, 'Invalid RUC');
  if (!isValidPeriod(period)) return errorResponse(400, 'Invalid period format. Use YYYYMM (e.g. 202501)');

  logger.info('InvoiceQuery invoked', { ruc, period, forceSync });

  const client = await getClient(ruc);
  if (!client) return errorResponse(404, 'Client not found');
  if (client.status !== 'ACTIVE') {
    return errorResponse(403, `Client is not active. Current status: ${client.status}`);
  }

  // Check cache unless force sync
  if (!forceSync) {
    const cached = await getCachedInvoices(ruc, period);
    if (cached) {
      logger.info('Returning invoices from cache', { ruc, period, count: cached.total_invoices });
      return buildResponse(200, {
        ruc: cached.ruc,
        company_name: cached.company_name,
        period: cached.period,
        total_invoices: cached.total_invoices,
        total_amount: cached.total_amount,
        source: 'cache',
        query_date: cached.query_date,
        invoices: cached.invoices,
      });
    }
  }

  // Fetch from SUNAT SIRE (async: ticket → poll → download)
  let invoices;
  try {
    invoices = await fetchAcceptedInvoices(ruc, period);
  } catch (err) {
    logger.error('Failed to fetch invoices from SUNAT', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errorResponse(502, 'Failed to retrieve invoices from SUNAT', message);
  }

  const total_amount = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
  const query_date = new Date().toISOString();

  await setCachedInvoices({
    ruc_period: `${ruc}#${period}`,
    ruc,
    period,
    company_name: client.company_name,
    invoices,
    total_invoices: invoices.length,
    total_amount,
    query_date,
  });

  logger.info('Invoices fetched from SUNAT and cached', { ruc, period, count: invoices.length });

  return buildResponse(200, {
    ruc,
    company_name: client.company_name,
    period,
    total_invoices: invoices.length,
    total_amount,
    source: 'sunat',
    query_date,
    invoices,
  });
}
