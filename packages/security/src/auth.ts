import { timingSafeEqual } from 'node:crypto';
import { SecurityError } from './errors.js';

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function verifyBearerToken(header: string | undefined, expectedToken: string): void {
  const token = parseBearer(header);
  if (!token) throw new SecurityError('missing bearer token');

  const received = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new SecurityError('invalid bearer token');
  }
}
