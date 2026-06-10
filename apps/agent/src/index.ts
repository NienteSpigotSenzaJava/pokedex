#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import WebSocket from 'ws';
import {
  AgentConfigSchema,
  AgentRequestSchema,
  type AgentConfig,
  type ToolResult,
} from '@pokedex/protocol';
import { CodexAppServerClient, capabilitiesResult, diffResult } from '@pokedex/codex-runner';
import { redactSecrets } from '@pokedex/security';

const logger = pino({ name: 'pokedex-agent', level: 'warn' });
const config = loadConfig();
const codex = new CodexAppServerClient();
const runtime = {
  reconnectMs: 1000,
  lastUsage: undefined as ToolResult | undefined,
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
connect();

function loadConfig(): AgentConfig {
  const path = value('--config') ?? defaultConfigPath();
  if (!existsSync(path)) throw new Error(`missing config file: ${path}. run pokedex first.`);
  return AgentConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function connect(): void {
  const url = new URL(config.relayUrl);
  url.searchParams.set('userId', config.userId);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.relayToken}` } });
  let opened = false;

  socket.on('open', () => {
    opened = true;
    runtime.reconnectMs = 1000;
    logger.info({ relayUrl: config.relayUrl }, 'connected to relay');
  });
  socket.on('close', () => {
    const wait = runtime.reconnectMs;
    runtime.reconnectMs = Math.min(runtime.reconnectMs * 2, 30_000);
    if (opened) logger.warn({ wait }, 'relay disconnected; reconnecting');
    setTimeout(connect, wait);
  });
  socket.on('error', (error) => {
    if (opened) logger.warn({ err: redactSecrets(error) }, 'relay websocket error');
  });
  socket.on('message', async (raw) => {
    const request = AgentRequestSchema.parse(JSON.parse(raw.toString()));
    const result = await dispatch(request.toolName, request.arguments).catch(
      (error: unknown): ToolResult => ({
        ok: false,
        summary: error instanceof Error ? error.message : 'agent tool failed',
        data: { error: redactSecrets(error) },
      })
    );
    socket.send(JSON.stringify({ id: request.id, result }));
  });
}

async function dispatch(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  logger.info({ toolName, args: redactSecrets(args) }, 'tool call');

  if (toolName === 'pokedex_setup_check') return await codex.setupCheck(config);
  if (toolName === 'pokedex_list_workspaces') return listWorkspaces();
  if (toolName === 'pokedex_list_tasks') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_list_sessions') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_list_threads') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_start_task')
    return runnerResultToTool('codex task started.', await codex.startThread(config, args));
  if (toolName === 'pokedex_start_thread')
    return runnerResultToTool('codex thread started.', await codex.startThread(config, args));
  if (toolName === 'pokedex_continue_task')
    return runnerResultToTool('codex task continued.', await codex.startTurn(config, args));
  if (toolName === 'pokedex_send_turn')
    return runnerResultToTool('codex turn sent.', await codex.startTurn(config, args));
  if (toolName === 'pokedex_resume_task')
    return runnerResultToTool('codex task resumed.', await codex.resumeThread(config, args));
  if (toolName === 'pokedex_resume_thread')
    return runnerResultToTool('codex thread resumed.', await codex.resumeThread(config, args));
  if (toolName === 'pokedex_read_thread') return await codex.readThread(config, args);
  if (toolName === 'pokedex_fork_thread') return await codex.forkThread(config, args);
  if (toolName === 'pokedex_set_goal') return await codex.setGoal(config, args);
  if (toolName === 'pokedex_clear_goal') return await codex.clearGoal(config, args);
  if (toolName === 'pokedex_review')
    return runnerResultToTool('codex review started.', await codex.review(config, args));
  if (toolName === 'pokedex_interrupt') return await codex.interrupt(config, args);
  if (toolName === 'pokedex_get_diff') return await diffResult(config, args);
  if (toolName === 'pokedex_get_usage')
    return runtime.lastUsage ?? { ok: false, summary: 'no usage seen yet.', data: {} };

  return {
    ok: false,
    summary: `unknown tool: ${toolName}`,
    data: { capabilities: capabilitiesResult().data },
  };
}

function listWorkspaces(): ToolResult {
  return {
    ok: true,
    summary: 'configured workspaces loaded.',
    data: {
      workspaces: config.workspaces.map(
        ({ alias, description, allowWrite, allowFullAccess, defaultSandbox }) => ({
          alias,
          description,
          allowWrite,
          allowFullAccess,
          defaultSandbox,
        })
      ),
    },
  };
}

function runnerResultToTool(
  summary: string,
  result: { threadId?: string; finalMessage: string; usage: unknown; events: unknown[] }
): ToolResult {
  const toolResult = {
    ok: true,
    summary,
    data: {
      threadId: result.threadId,
      finalMessage: result.finalMessage,
      usage: result.usage,
      events: result.events.slice(-50),
    },
  };
  runtime.lastUsage = {
    ok: true,
    summary: 'last usage loaded.',
    data: { threadId: result.threadId, usage: result.usage },
  };
  return toolResult;
}

function shutdown(): void {
  codex.stop();
  process.exit(0);
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultConfigPath(): string {
  return join(homedir(), '.pokedex', 'config.json');
}
