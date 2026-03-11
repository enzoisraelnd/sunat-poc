import { getCachedToken, setCachedToken } from './dynamodb';
import { getCredentials } from './secrets';
import { logger } from '../utils/logger';

const SUNAT_TOKEN_URL = 'https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/';
const SUNAT_SCOPE = 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes';

export async function getAccessToken(ruc: string): Promise<string> {
  const cached = await getCachedToken(ruc);
  if (cached) {
    logger.info('Using cached access token', { ruc });
    return cached;
  }

  const creds = await getCredentials(ruc);
  if (!creds.client_id || !creds.client_secret) {
    throw new Error(`Client ${ruc} does not have SUNAT API credentials yet`);
  }

  const url = SUNAT_TOKEN_URL.replace('{client_id}', creds.client_id);
  const body = new URLSearchParams({
    grant_type: 'password',
    scope: SUNAT_SCOPE,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    username: `${ruc}${creds.sol_username}`,
    password: creds.sol_password,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('SUNAT OAuth token request failed', { ruc, status: response.status, body: text });
    throw new Error(`SUNAT OAuth failed: ${response.status}`);
  }

  const raw = await response.text();
  let data: { access_token: string; expires_in: number };
  try {
    data = JSON.parse(raw);
  } catch {
    logger.error('SUNAT OAuth response is not valid JSON', { ruc, preview: raw.slice(0, 300) });
    throw new Error(`SUNAT OAuth invalid JSON response`);
  }
  if (!data.access_token) {
    logger.error('SUNAT OAuth response missing access_token', { ruc, preview: raw.slice(0, 300) });
    throw new Error('SUNAT OAuth: access_token not present in response');
  }
  logger.info('New SUNAT access token generated', { ruc });

  await setCachedToken(ruc, data.access_token);
  return data.access_token;
}
