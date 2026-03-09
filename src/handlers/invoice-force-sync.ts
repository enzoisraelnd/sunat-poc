import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { queryInvoices } from './invoice-query';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return queryInvoices(event, true);
}
