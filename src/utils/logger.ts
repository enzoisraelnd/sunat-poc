const SENSITIVE_KEYS = new Set([
  'sol_password',
  'sol_username',
  'client_secret',
  'access_token',
  'password',
  'secret',
  'token',
]);

function redact(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(value);
  }
  return result;
}

export const logger = {
  info: (message: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'INFO', message, data: data ? redact(data) : undefined }));
  },
  error: (message: string, error?: unknown) => {
    const errorData = error instanceof Error
      ? { name: error.name, message: error.message }
      : error;
    console.error(JSON.stringify({ level: 'ERROR', message, error: errorData }));
  },
  warn: (message: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'WARN', message, data: data ? redact(data) : undefined }));
  },
};
