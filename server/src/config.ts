export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  origin: string;
  production: boolean;
  paypalClientId: string;
  paypalSecret: string;
  paypalMerchantId: string;
  paypalWebhookId: string;
}

export function readConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL || '';
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (!databaseUrl || sessionSecret.length < 32) {
    throw new Error('Set DATABASE_URL and a SESSION_SECRET of at least 32 characters.');
  }
  const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
  const production = process.env.NODE_ENV === 'production';
  if (production && !origin.startsWith('https://')) {
    throw new Error('Production sessions require an HTTPS APP_ORIGIN.');
  }
  return {
    databaseUrl,
    sessionSecret,
    origin,
    production,
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    paypalMerchantId: process.env.PAYPAL_MERCHANT_ID || '',
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || ''
  };
}
