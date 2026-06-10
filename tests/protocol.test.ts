import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  ThreadStartSchema,
  mcpToolNames,
  stableCapabilities,
} from '../packages/protocol/src/index.js';
import { mcpToolDefinitions, toolSpecs } from '../apps/relay/src/tools.js';

describe('protocol schemas', () => {
  it('validates agent config with app-server defaults', () => {
    const parsed = AgentConfigSchema.parse({
      userId: 'user',
      relayUrl: 'ws://localhost:3000/agent',
      relayToken: '1234567890123456',
      workspaces: [{ alias: 'repo', root: '/tmp/repo' }],
    });

    expect(parsed.appServerArgs).toEqual(['app-server', '--listen', 'stdio://']);
    expect(parsed.workspaces[0]?.defaultSandbox).toBe('read_only');
  });

  it('rejects empty first turns', () => {
    expect(() => ThreadStartSchema.parse({ workspaceAlias: 'repo', prompt: '' })).toThrow();
  });

  it('declares native app-server capabilities', () => {
    expect(
      stableCapabilities.some(
        (capability) => capability.name === 'native_threads' && capability.source === 'app_server'
      )
    ).toBe(true);
  });

  it('registers every public mcp tool exactly once', () => {
    expect(toolSpecs.map((tool) => tool.name).sort()).toEqual([...mcpToolNames].sort());
  });

  it('publishes non-empty mcp tool definitions for poke sync', () => {
    const tools = mcpToolDefinitions();
    expect(tools.length).toBe(mcpToolNames.length);
    expect(tools.some((tool) => tool.name === 'pokedex_start_task')).toBe(true);
    expect(tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object')).toBe(
      true
    );
  });
});
