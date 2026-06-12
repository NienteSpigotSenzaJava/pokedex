import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  ThreadStartSchema,
  mcpToolNames,
  parseJsonc,
  stableCapabilities,
  toMcpText,
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

    expect(parsed.userId).toBe('user');
    expect(parsed.relayUrl).toBe('ws://localhost:3000/agent');
    expect(parsed.appServerArgs).toEqual(['app-server', '--listen', 'stdio://']);
    expect(parsed.workspaces[0]?.defaultSandbox).toBe('read_only');
  });

  it('defaults derived local config fields when the saved config omits them', () => {
    const parsed = AgentConfigSchema.parse({
      relayToken: '1234567890123456',
      workspaces: [{ alias: 'repo', root: '/tmp/repo' }],
    });

    expect(parsed.userId).toBe('local');
    expect(parsed.relayUrl).toBe('ws://127.0.0.1:3000/agent');
    expect(parsed.appServerCommand).toBe('codex');
    expect(parsed.appServerArgs).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('parses jsonc agent config with comments and trailing commas', () => {
    const parsed = AgentConfigSchema.parse(
      parseJsonc(`{
        // local agent identity.
        "userId": "user",
        "relayUrl": "ws://localhost:3000/agent",
        "relayToken": "1234567890123456",
        "appServerArgs": ["app-server", "--listen", "stdio://"],
        "workspaces": [
          {
            "alias": "repo",
            "root": "/tmp/repo",
          },
        ],
      }`)
    );

    expect(parsed.appServerArgs).toEqual(['app-server', '--listen', 'stdio://']);
    expect(parsed.workspaces[0]?.alias).toBe('repo');
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
    expect(tools.some((tool) => tool.name === 'pokedex_list_skills')).toBe(true);
    expect(tools.some((tool) => tool.name === 'pokedex_list_plugins')).toBe(true);
    expect(tools.some((tool) => tool.name === 'pokedex_approve')).toBe(true);
    expect(tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object')).toBe(
      true
    );
  });

  it('formats mcp tool output without raw debug events', () => {
    const text = toMcpText({
      ok: true,
      summary: 'codex thread started.',
      data: {
        threadId: 'thread-1',
        finalMessage: 'done',
        events: [{ method: 'debug/event' }],
      },
    });

    expect(text).toContain('codex thread started.');
    expect(text).toContain('internal tool state for follow-up only');
    expect(text).toContain('"threadId": "thread-1"');
    expect(text).not.toContain('debug/event');
  });
});
