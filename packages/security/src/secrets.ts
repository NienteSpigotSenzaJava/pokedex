const secretPatterns = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /(?:api[_-]?key|token|secret|password)["'\s:=]+[a-zA-Z0-9_.\-+/=]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// redact values before they leave the local process through logs, relay responses, or diagnostics.
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return secretPatterns.reduce((text, pattern) => text.replace(pattern, '[redacted]'), value);
  }

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretKey(key) ? '[redacted]' : redactSecrets(item),
      ])
    );
  }

  return value;
}

function isSecretKey(key: string): boolean {
  if (
    /^(input|cached_input|output|reasoning_output|prompt|completion|total)_tokens$/i.test(key) ||
    /^(input|cachedInput|output|reasoningOutput|prompt|completion|total)Tokens$/.test(key) ||
    key === 'tokensUsed'
  ) {
    return false;
  }
  return /token|secret|password|api[_-]?key/i.test(key);
}
