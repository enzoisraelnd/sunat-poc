import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

export interface SunatCredentials {
  sol_username: string;
  sol_password: string;
  client_id?: string;
  client_secret?: string;
}

function secretName(ruc: string): string {
  return `sunat/${ruc}/credentials`;
}

export async function getCredentials(ruc: string): Promise<SunatCredentials> {
  const result = await client.send(new GetSecretValueCommand({
    SecretId: secretName(ruc),
  }));
  if (!result.SecretString) throw new Error(`No secret found for RUC ${ruc}`);
  return JSON.parse(result.SecretString) as SunatCredentials;
}

export async function createCredentials(ruc: string, creds: SunatCredentials): Promise<void> {
  await client.send(new CreateSecretCommand({
    Name: secretName(ruc),
    SecretString: JSON.stringify(creds),
    Description: `SUNAT SOL credentials for RUC ${ruc}`,
  }));
}

export async function updateCredentials(ruc: string, partial: Partial<SunatCredentials>): Promise<void> {
  const existing = await getCredentials(ruc);
  const updated: SunatCredentials = { ...existing, ...partial };
  await client.send(new PutSecretValueCommand({
    SecretId: secretName(ruc),
    SecretString: JSON.stringify(updated),
  }));
}
