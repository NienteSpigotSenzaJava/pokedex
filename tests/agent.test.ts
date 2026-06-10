import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const agentPath = fileURLToPath(new URL('../apps/agent/src/index.ts', import.meta.url));

describe('pokedex agent config loading', () => {
  it('reloads config for each mcp tool call', () => {
    const source = readFileSync(agentPath, 'utf8');

    expect(source).toContain('const configPath = value');
    expect(source).toContain(
      'async function dispatch(toolName: string, args: Record<string, unknown>)'
    );
    expect(source).toContain('const config = loadConfig();');
    expect(source).not.toContain(
      'const config = loadConfig();\nconst codex = new CodexAppServerClient();'
    );
  });
});
