import { describe, expect, it } from 'vitest';
import { parseBearer, verifyBearerToken } from '../packages/security/src/index.js';

describe('security guards', () => {
  it('parses bearer tokens', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
  });

  it('rejects invalid bearer tokens', () => {
    expect(() => verifyBearerToken('Bearer nope', '1234567890123456')).toThrow();
  });
});
