import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { User } from './orders.js';
import { AppError } from './errors.js';

declare module 'express-session' {
  interface SessionData {
    user?: User;
    csrf?: string;
  }
}

export function requireUser(request: Request, response: Response, next: NextFunction): void {
  if (!request.session.user) throw new AppError(401, 'Please log in to continue.');
  next();
}
export function requireMerchant(request: Request, response: Response, next: NextFunction): void {
  if (request.session.user?.role !== 'merchant')
    throw new AppError(403, 'Merchant access is required.');
  next();
}
export function csrfToken(request: Request): string {
  if (!request.session.csrf) request.session.csrf = randomBytes(32).toString('hex');
  return request.session.csrf;
}
export function checkCsrf(request: Request, origin: string): void {
  if (request.get('Origin') !== origin) throw new AppError(403, 'Request origin is not allowed.');
  const token = request.get('X-CSRF-Token') || '';
  const expected = request.session.csrf || '';
  if (
    !expected ||
    Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    throw new AppError(403, 'Your session has changed. Refresh the page and try again.');
  }
}
export async function startSession(request: Request, user: User): Promise<void> {
  // express-session uses callbacks; these small Promises let routes use async/await.
  await new Promise<void>(function (resolve, reject) {
    request.session.regenerate(function (error) {
      if (error) reject(error);
      else resolve();
    });
  });
  request.session.user = user;
  request.session.csrf = randomBytes(32).toString('hex');
  await new Promise<void>(function (resolve, reject) {
    request.session.save(function (error) {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function readCredentials(body: unknown): { email: string; password: string } {
  const input = body as { email?: unknown; password?: unknown } | null;
  if (!input || typeof input.email !== 'string' || typeof input.password !== 'string') {
    throw new AppError(400, 'Enter an email address and password.');
  }
  const email = input.email.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    input.password.length < 12 ||
    input.password.length > 128
  ) {
    throw new AppError(400, 'Use a valid email and a password between 12 and 128 characters.');
  }
  return { email, password: input.password };
}
