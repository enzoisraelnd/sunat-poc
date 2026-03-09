import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { putClient } from '../services/dynamodb';
import { createCredentials } from '../services/secrets';
import { notifyNewOnboarding } from '../services/ses';
import { isValidRuc, buildResponse, errorResponse } from '../utils/validation';
import { logger } from '../utils/logger';

interface OnboardingBody {
  ruc: string;
  company_name: string;
  contact_email: string;
  sol_username: string;
  sol_password: string;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  logger.info('OnboardingCreate invoked');

  if (!event.body) {
    return errorResponse(400, 'Request body is required');
  }

  let body: OnboardingBody;
  try {
    body = JSON.parse(event.body) as OnboardingBody;
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { ruc, company_name, contact_email, sol_username, sol_password } = body;

  if (!ruc || !company_name || !contact_email || !sol_username || !sol_password) {
    return errorResponse(400, 'Missing required fields: ruc, company_name, contact_email, sol_username, sol_password');
  }

  if (!isValidRuc(ruc)) {
    return errorResponse(400, 'Invalid RUC format or check digit');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
    return errorResponse(400, 'Invalid contact_email format');
  }

  const onboarding_id = uuidv4();
  const onboarding_date = new Date().toISOString();

  try {
    await createCredentials(ruc, { sol_username, sol_password });
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error?.name === 'ResourceExistsException') {
      logger.warn('Credentials already exist for RUC, proceeding with existing secret', { ruc });
    } else {
      logger.error('Failed to store credentials in Secrets Manager', err);
      return errorResponse(500, 'Failed to store credentials');
    }
  }

  try {
    await putClient({
      ruc,
      company_name,
      contact_email,
      status: 'PENDING',
      onboarding_id,
      onboarding_date,
    });
  } catch (err) {
    logger.error('Failed to save client to DynamoDB', err);
    return errorResponse(500, 'Failed to register client');
  }

  await notifyNewOnboarding({ ruc, company_name, contact_email, onboarding_id });

  logger.info('Onboarding created', { ruc, onboarding_id });

  return buildResponse(201, {
    onboarding_id,
    ruc,
    company_name,
    status: 'PENDING',
    message: 'Onboarding registered. Our team will activate your account after completing SUNAT portal setup.',
  });
}
