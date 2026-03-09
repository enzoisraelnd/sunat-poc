import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../utils/logger';

const ses = new SESClient({});

export async function notifyNewOnboarding(params: {
  ruc: string;
  company_name: string;
  contact_email: string;
  onboarding_id: string;
}): Promise<void> {
  const toEmail = process.env.NOTIFICATION_EMAIL;
  if (!toEmail) {
    logger.warn('NOTIFICATION_EMAIL not set, skipping SES notification');
    return;
  }

  const subject = `[Factoring] New onboarding: ${params.ruc} - ${params.company_name}`;
  const body = [
    `A new client has completed onboarding and requires SUNAT portal activation.`,
    ``,
    `RUC: ${params.ruc}`,
    `Company: ${params.company_name}`,
    `Contact email: ${params.contact_email}`,
    `Onboarding ID: ${params.onboarding_id}`,
    ``,
    `Steps to activate:`,
    `1. Log in to api.sunat.gob.pe using the SOL credentials stored in Secrets Manager: sunat/${params.ruc}/credentials`,
    `2. Register the application and obtain client_id and client_secret`,
    `3. Call POST /onboarding/${params.onboarding_id}/activate with the obtained credentials`,
  ].join('\n');

  try {
    await ses.send(new SendEmailCommand({
      Source: toEmail,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } },
      },
    }));
    logger.info('Onboarding notification sent', { ruc: params.ruc });
  } catch (err) {
    // Non-critical — log but don't fail the onboarding request
    logger.error('Failed to send onboarding notification email', err);
  }
}
