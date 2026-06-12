import { describe, expect, it } from 'vitest';
import { parseBearer, redactSecrets, verifyBearerToken } from '../packages/security/src/index.js';

describe('security guards', () => {
  it('parses bearer tokens', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
  });

  it('rejects invalid bearer tokens', () => {
    expect(() => verifyBearerToken('Bearer nope', '1234567890123456')).toThrow();
  });

  it('does not redact token usage counters', () => {
    expect(
      redactSecrets({
        relayToken: '1234567890123456',
        usage: { input_tokens: 5, outputTokens: 7, total_tokens: 12, totalTokens: 12 },
      })
    ).toEqual({
      relayToken: '[redacted]',
      usage: { input_tokens: 5, outputTokens: 7, total_tokens: 12, totalTokens: 12 },
    });
  });
});
