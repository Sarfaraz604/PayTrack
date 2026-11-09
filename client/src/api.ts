let csrfToken = '';

export function saveCsrfToken(token: string): void {
  csrfToken = token;
}

export async function api(
  path: string,
  method = 'GET',
  body?: object,
  key?: string
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch('/api' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 204) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The server is unavailable. Try refreshing shortly.');
  }
  if (!response.ok) throw new Error(data.message || 'The request could not be completed.');
  return data;
}

export function money(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
}

export function operationKey(name: string): string {
  // Survives reloads and PayPal redirects. It contains no credentials or payment data.
  let key = sessionStorage.getItem(name);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(name, key);
  }
  return key;
}
