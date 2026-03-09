import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getClientByOnboardingId } from '../services/dynamodb';
import { buildResponse, errorResponse } from '../utils/validation';
import { logger } from '../utils/logger';

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const onboarding_id = event.pathParameters?.id;
  if (!onboarding_id) {
    return errorResponse(400, 'Missing onboarding id in path');
  }

  logger.info('OnboardingStatus invoked', { onboarding_id });

  const client = await getClientByOnboardingId(onboarding_id);
  if (!client) {
    return errorResponse(404, 'Onboarding not found');
  }

  return buildResponse(200, {
    onboarding_id: client.onboarding_id,
    ruc: client.ruc,
    company_name: client.company_name,
    status: client.status,
    onboarding_date: client.onboarding_date,
    activation_date: client.activation_date,
  });
}
