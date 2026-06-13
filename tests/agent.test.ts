import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const agentPath = fileURLToPath(new URL('../apps/agent/src/index.ts', import.meta.url));

describe('pokedex agent config loading', () => {
  it('reloads config for each mcp tool call', () => {
    const source = readFileSync(agentPath, 'utf8');

    expect(source).toContain('const configPath = value');
    expect(source).toContain("value('--relay-url') ?? saved.relayUrl");
    expect(source).toContain('void codex.warm(config).catch');
    expect(source).toContain("if (toolName === 'pokedex_list_skills')");
    expect(source).toContain("if (toolName === 'pokedex_list_plugins')");
    expect(source).toContain(
      "if (toolName === 'pokedex_list_operations') return listOperations();"
    );
    expect(source).toContain(
      "if (toolName === 'pokedex_read_operation') return await readOperation(args);"
    );
    expect(source).toContain(
      "if (toolName === 'pokedex_get_usage') return await usageResult(config);"
    );
    expect(source).toContain("if (toolName === 'pokedex_git_check')");
    expect(source).toContain('trackRunnerProgress');
    expect(source).toContain('trackOperationProgress');
    expect(source).toContain('async function trackOperation');
    expect(source).toContain('waitForOperationChange');
    expect(source).toContain('normalizeRateLimitStatus');
    expect(source).toContain('failureKind');
    expect(source).toContain('afterEventsSeen');
    expect(source).toContain('use pokedex_read_operation with operationId');
    expect(source).toContain('is not complete yet');
    expect(source).toContain('incomplete: true');
    expect(source).toContain('let activeSocket: WebSocket | null = null;');
    expect(source).toContain('if (reconnectTimer) clearTimeout(reconnectTimer);');
    expect(source).toContain('await codex.close();');
    expect(source).toContain(
      'async function dispatch(toolName: string, args: Record<string, unknown>)'
    );
    expect(source).toContain('const config = loadConfig();');
    expect(source).not.toContain(
      'const config = loadConfig();\nconst codex = new CodexAppServerClient();'
    );
  });
});
