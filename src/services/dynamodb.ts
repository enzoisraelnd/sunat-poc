import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client);

export const Tables = {
  clients: process.env.CLIENTS_TABLE!,
  tokensCache: process.env.TOKENS_CACHE_TABLE!,
  invoicesCache: process.env.INVOICES_CACHE_TABLE!,
};

// ─── Client record ────────────────────────────────────────────────────────

export type ClientStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export interface ClientRecord {
  ruc: string;
  company_name: string;
  contact_email: string;
  status: ClientStatus;
  onboarding_id: string;
  onboarding_date: string;
  activation_date?: string;
}

export async function getClient(ruc: string): Promise<ClientRecord | undefined> {
  const result = await ddb.send(new GetCommand({
    TableName: Tables.clients,
    Key: { ruc },
  }));
  return result.Item as ClientRecord | undefined;
}

export async function putClient(record: ClientRecord): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: Tables.clients,
    Item: record,
  }));
}

export async function updateClientStatus(
  ruc: string,
  status: ClientStatus,
  activation_date?: string,
): Promise<void> {
  const updateExpr = activation_date
    ? 'SET #s = :s, activation_date = :ad'
    : 'SET #s = :s';
  const values: Record<string, unknown> = { ':s': status };
  if (activation_date) values[':ad'] = activation_date;

  await ddb.send(new UpdateCommand({
    TableName: Tables.clients,
    Key: { ruc },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: values,
  }));
}

export async function getClientByOnboardingId(onboarding_id: string): Promise<ClientRecord | undefined> {
  const result = await ddb.send(new QueryCommand({
    TableName: Tables.clients,
    IndexName: 'onboarding_id-index',
    KeyConditionExpression: 'onboarding_id = :id',
    ExpressionAttributeValues: { ':id': onboarding_id },
    Limit: 1,
  }));
  return result.Items?.[0] as ClientRecord | undefined;
}

// ─── Token cache ──────────────────────────────────────────────────────────

export async function getCachedToken(ruc: string): Promise<string | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const result = await ddb.send(new GetCommand({
    TableName: Tables.tokensCache,
    Key: { ruc },
  }));
  const item = result.Item;
  if (!item || item.ttl <= now) return undefined;
  return item.access_token as string;
}

export async function setCachedToken(ruc: string, access_token: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 55 * 60; // 55 minutes
  await ddb.send(new PutCommand({
    TableName: Tables.tokensCache,
    Item: { ruc, access_token, ttl },
  }));
}

// ─── Invoices cache ───────────────────────────────────────────────────────

export interface InvoiceCacheRecord {
  ruc_period: string;
  ruc: string;
  period: string;
  company_name: string;
  invoices: InvoiceItem[];
  total_invoices: number;
  total_amount: number;
  query_date: string;
  ttl: number;
}

export interface InvoiceItem {
  series_number: string;
  issue_date: string;
  buyer_ruc: string;
  buyer_company_name: string;
  base_amount: number;
  igv: number;
  total_amount: number;
  currency: string;
  status: string;
}

export async function getCachedInvoices(ruc: string, period: string): Promise<InvoiceCacheRecord | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const result = await ddb.send(new GetCommand({
    TableName: Tables.invoicesCache,
    Key: { ruc_period: `${ruc}#${period}` },
  }));
  const item = result.Item;
  if (!item || item.ttl <= now) return undefined;
  return item as InvoiceCacheRecord;
}

export async function setCachedInvoices(record: Omit<InvoiceCacheRecord, 'ttl'>): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours
  await ddb.send(new PutCommand({
    TableName: Tables.invoicesCache,
    Item: { ...record, ttl },
  }));
}
