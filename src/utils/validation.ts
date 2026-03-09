export function isValidRuc(ruc: string): boolean {
  if (!/^\d{11}$/.test(ruc)) return false;

  // Luhn-like check digit algorithm for Peruvian RUC
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const digits = ruc.split('').map(Number);
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  const remainder = sum % 11;
  const checkDigit = remainder < 2 ? remainder : 11 - remainder;
  return checkDigit === digits[10];
}

export function isValidPeriod(period: string): boolean {
  if (!/^\d{6}$/.test(period)) return false;
  const month = parseInt(period.slice(4, 6), 10);
  return month >= 1 && month <= 12;
}

export function buildResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, message: string, details?: string) {
  return buildResponse(statusCode, { error: message, details });
}
