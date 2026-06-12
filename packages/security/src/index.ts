import { timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { AgentConfig, SandboxMode, Workspace } from '@pokedex/protocol';

const secretPatterns = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /(?:api[_-]?key|token|secret|password)["'\s:=]+[a-zA-Z0-9_.\-+/=]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

// redact before logs leave local machine or relay audit storage.
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

export function findWorkspace(config: AgentConfig, alias: string): Workspace {
  const workspace = config.workspaces.find((item) => item.alias === alias);
  if (!workspace) throw new SecurityError(`unknown workspace alias: ${alias}`);
  return workspace;
}

export function resolveWorkspaceRoot(workspace: Workspace): string {
  if (!isAbsolute(workspace.root)) {
    throw new SecurityError(`workspace ${workspace.alias} root must be absolute`);
  }
  return normalize(workspace.root);
}

export function assertSandboxAllowed(
  config: AgentConfig,
  workspace: Workspace,
  requested: SandboxMode
): SandboxMode {
  if (
    requested === 'danger_full_access' &&
    (!config.fullAccessEnabled || !workspace.allowFullAccess)
  ) {
    throw new SecurityError('danger_full_access is disabled for this agent or workspace');
  }

  if (requested === 'workspace_write' && (!config.writeTasksEnabled || !workspace.allowWrite)) {
    throw new SecurityError('workspace_write is disabled for this agent or workspace');
  }

  return requested;
}
