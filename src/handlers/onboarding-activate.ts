import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getClientByOnboardingId, updateClientStatus } from '../services/dynamodb';
import { updateCredentials } from '../services/secrets';
import { buildResponse, errorResponse } from '../utils/validation';
import { logger } from '../utils/logger';

interface ActivateBody {
  client_id: string;
  client_secret: string;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const onboarding_id = event.pathParameters?.id;
  if (!onboarding_id) {
    return errorResponse(400, 'Missing onboarding id in path');
  }

  if (!event.body) {
    return errorResponse(400, 'Request body is required');
  }

  let body: ActivateBody;
  try {
    body = JSON.parse(event.body) as ActivateBody;
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { client_id, client_secret } = body;
  if (!client_id || !client_secret) {
    return errorResponse(400, 'Missing required fields: client_id, client_secret');
  }

  logger.info('OnboardingActivate invoked', { onboarding_id });

  const client = await getClientByOnboardingId(onboarding_id);
  if (!client) {
    return errorResponse(404, 'Onboarding not found');
  }

  if (client.status === 'ACTIVE') {
    return errorResponse(409, 'Client is already active');
  }

  try {
    await updateCredentials(client.ruc, { client_id, client_secret });
  } catch (err) {
    logger.error('Failed to update credentials in Secrets Manager', err);
    return errorResponse(500, 'Failed to update SUNAT credentials');
  }

  const activation_date = new Date().toISOString();

  try {
    await updateClientStatus(client.ruc, 'ACTIVE', activation_date);
  } catch (err) {
    logger.error('Failed to update client status in DynamoDB', err);
    return errorResponse(500, 'Failed to activate client');
  }

  logger.info('Client activated', { ruc: client.ruc, onboarding_id });

  return buildResponse(200, {
    ruc: client.ruc,
    company_name: client.company_name,
    status: 'ACTIVE',
    activation_date,
  });
}
