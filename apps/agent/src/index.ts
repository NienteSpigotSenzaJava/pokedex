#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import WebSocket, { type RawData } from 'ws';
import {
  AgentConfigSchema,
  AgentRequestSchema,
  UsageSchema,
  parseJsonc,
  type AgentConfig,
  type ToolResult,
  type Usage,
} from '@pokedex/protocol';
import {
  CodexAppServerClient,
  capabilitiesResult,
  diffResult,
  gitCheckResult,
  type RunnerProgress,
} from '@pokedex/codex-runner';
import { redactSecrets } from '@pokedex/security';

type UsageSnapshot = {
  at: string;
  usage: Usage;
  totalTokens: number;
  source: 'event' | 'turn';
  threadId?: string;
  turnId?: string;
};
type OperationStatus = 'running' | 'completed' | 'failed';
type OperationRecord = {
  operationId: string;
  toolName: string;
  label: string;
  status: OperationStatus;
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
  error?: unknown;
  promise: Promise<void>;
};

const logger = pino({ name: 'pokedex-agent', level: 'warn' });
const configPath = value('--config') ?? existingDefaultConfigPath();
const codex = new CodexAppServerClient();
const operations = new Map<string, OperationRecord>();
const operationReturnDeadlineMs = 8_000;
const maxOperations = 50;
let activeSocket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
const runtime = {
  reconnectMs: 1000,
  startedAt: new Date().toISOString(),
  localDate: localDate(),
  completedTurns: 0,
  sessionTotal: emptyUsage(),
  todayTotal: emptyUsage(),
  lastUsage: undefined as UsageSnapshot | undefined,
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
connect();

function loadConfig(): AgentConfig {
  if (!existsSync(configPath))
    throw new Error(`missing config file: ${configPath}. run pokedex first.`);
  const raw = parseJsonc(readFileSync(configPath, 'utf8'));
  const saved = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return AgentConfigSchema.parse({
    ...saved,
    userId: value('--user-id') ?? saved.userId,
    relayUrl: value('--relay-url') ?? saved.relayUrl,
  });
}

function connect(): void {
  if (shuttingDown) return;
  const config = loadConfig();
  const url = new URL(config.relayUrl);
  url.searchParams.set('userId', config.userId);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.relayToken}` } });
  activeSocket = socket;
  let opened = false;

  socket.on('open', () => {
    opened = true;
    runtime.reconnectMs = 1000;
    logger.info({ relayUrl: config.relayUrl }, 'connected to relay');
    void codex.warm(config).catch((error: unknown) => {
      logger.warn({ err: redactSecrets(error) }, 'codex warm-up failed');
    });
  });
  socket.on('close', () => {
    if (activeSocket === socket) activeSocket = null;
    if (shuttingDown) return;
    const wait = runtime.reconnectMs;
    runtime.reconnectMs = Math.min(runtime.reconnectMs * 2, 30_000);
    if (opened) logger.warn({ wait }, 'relay disconnected; reconnecting');
    reconnectTimer = setTimeout(connect, wait);
  });
  socket.on('error', (error) => {
    if (opened) logger.warn({ err: redactSecrets(error) }, 'relay websocket error');
  });
  socket.on('message', async (raw) => {
    if (shuttingDown) return;
    const request = parseAgentRequest(raw);
    if (!request) return;
    const result = await dispatch(request.toolName, request.arguments).catch(
      (error: unknown): ToolResult => ({
        ok: false,
        summary: error instanceof Error ? error.message : 'agent tool failed',
        data: { error: redactSecrets(error) },
      })
    );
    try {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ id: request.id, result }));
    } catch (error) {
      logger.warn({ err: redactSecrets(error) }, 'relay websocket send failed');
    }
  });
}

function parseAgentRequest(raw: RawData): ReturnType<typeof AgentRequestSchema.parse> | null {
  try {
    return AgentRequestSchema.parse(JSON.parse(raw.toString()));
  } catch (error) {
    logger.warn({ err: redactSecrets(error) }, 'agent request could not be parsed');
    return null;
  }
}

async function dispatch(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const config = loadConfig();
  logger.info({ toolName, args: redactSecrets(args) }, 'tool call');

  if (toolName === 'pokedex_setup_check') return await codex.setupCheck(config);
  if (toolName === 'pokedex_list_workspaces') return listWorkspaces(config);
  if (toolName === 'pokedex_list_tasks') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_list_sessions') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_list_threads') return await codex.listThreads(config, args);
  if (toolName === 'pokedex_list_skills') return await codex.listSkills(config, args);
  if (toolName === 'pokedex_list_plugins') return await codex.listPlugins(config, args);
  if (toolName === 'pokedex_list_operations') return listOperations();
  if (toolName === 'pokedex_read_operation') return readOperation(args);
  if (toolName === 'pokedex_start_task')
    return await trackOperation(toolName, 'task start', async () =>
      runnerResultToTool(
        'codex task started.',
        await codex.startThread(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_start_thread')
    return await trackOperation(toolName, 'thread start', async () =>
      runnerResultToTool(
        'codex thread started.',
        await codex.startThread(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_continue_task')
    return await trackOperation(toolName, 'task turn', async () =>
      runnerResultToTool(
        'codex task continued.',
        await codex.startTurn(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_send_turn')
    return await trackOperation(toolName, 'thread turn', async () =>
      runnerResultToTool(
        'codex turn sent.',
        await codex.startTurn(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_resume_task')
    return await trackOperation(toolName, 'task resume', async () =>
      runnerResultToTool(
        'codex task resumed.',
        await codex.resumeThread(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_resume_thread')
    return await trackOperation(toolName, 'thread resume', async () =>
      runnerResultToTool(
        'codex thread resumed.',
        await codex.resumeThread(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_read_thread') return await codex.readThread(config, args);
  if (toolName === 'pokedex_fork_thread') return await codex.forkThread(config, args);
  if (toolName === 'pokedex_set_goal') return await codex.setGoal(config, args);
  if (toolName === 'pokedex_clear_goal') return await codex.clearGoal(config, args);
  if (toolName === 'pokedex_review')
    return await trackOperation(toolName, 'review', async () =>
      runnerResultToTool(
        'codex review started.',
        await codex.review(config, args, trackRunnerProgress)
      )
    );
  if (toolName === 'pokedex_interrupt') return await codex.interrupt(config, args);
  if (toolName === 'pokedex_list_approvals') return await codex.listApprovals();
  if (toolName === 'pokedex_approve') return await codex.approve(args);
  if (toolName === 'pokedex_decline') return await codex.decline(args);
  if (toolName === 'pokedex_cancel_approval') return await codex.cancelApproval(args);
  if (toolName === 'pokedex_get_diff') return await diffResult(config, args);
  if (toolName === 'pokedex_git_check') return await gitCheckResult(config, args);
  if (toolName === 'pokedex_get_usage') return await usageResult(config);

  return {
    ok: false,
    summary: `unknown tool: ${toolName}`,
    data: { capabilities: capabilitiesResult().data },
  };
}

async function trackOperation(
  toolName: string,
  label: string,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  pruneOperations();
  const operation = createOperation(toolName, label);
  operation.promise = run()
    .then((result) => {
      operation.status = 'completed';
      operation.finishedAt = new Date().toISOString();
      operation.result = addOperationData(result, operation);
    })
    .catch((error: unknown) => {
      operation.status = 'failed';
      operation.finishedAt = new Date().toISOString();
      operation.error = redactSecrets(error);
    });
  operations.set(operation.operationId, operation);

  await Promise.race([operation.promise, delay(operationReturnDeadlineMs)]);
  return operationResult(operation);
}

function createOperation(toolName: string, label: string): OperationRecord {
  const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    operationId,
    toolName,
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
    promise: Promise.resolve(),
  };
}

function listOperations(): ToolResult {
  pruneOperations();
  const items = [...operations.values()].reverse().map(operationSummary);
  return {
    ok: true,
    summary: items.length
      ? `${items.length} codex operation${items.length === 1 ? '' : 's'} tracked.`
      : 'no codex operations tracked.',
    data: { operations: items },
  };
}

function readOperation(args: Record<string, unknown>): ToolResult {
  const operationId = typeof args.operationId === 'string' ? args.operationId : '';
  const operation = operations.get(operationId);
  if (!operation) {
    return {
      ok: false,
      summary: operationId
        ? `codex operation ${operationId} was not found.`
        : 'operationId is required.',
      data: { operations: [...operations.values()].reverse().map(operationSummary) },
    };
  }
  return operationResult(operation);
}

function operationResult(operation: OperationRecord): ToolResult {
  if (operation.status === 'completed' && operation.result) return operation.result;
  if (operation.status === 'failed') {
    return {
      ok: false,
      summary: `codex ${operation.label} failed. inspect the operation data before retrying.`,
      data: {
        ...operationSummary(operation),
        error: operation.error,
      },
    };
  }
  return {
    ok: false,
    summary: `codex ${operation.label} is not complete yet. do not claim completion, do not retry the same request, and use pokedex_read_operation with operationId ${operation.operationId}.`,
    data: { ...operationSummary(operation), incomplete: true },
  };
}

function addOperationData(result: ToolResult, operation: OperationRecord): ToolResult {
  return {
    ...result,
    data: {
      ...result.data,
      operationId: operation.operationId,
      operationStatus: operation.status,
      operationStartedAt: operation.startedAt,
      operationFinishedAt: operation.finishedAt,
    },
  };
}

function operationSummary(operation: OperationRecord): Record<string, unknown> {
  return stripUndefined({
    operationId: operation.operationId,
    operationStatus: operation.status,
    toolName: operation.toolName,
    label: operation.label,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    threadId:
      operation.result && typeof operation.result.data.threadId === 'string'
        ? operation.result.data.threadId
        : undefined,
    finalMessage:
      operation.result && typeof operation.result.data.finalMessage === 'string'
        ? operation.result.data.finalMessage
        : undefined,
  });
}

function pruneOperations(): void {
  while (operations.size > maxOperations) {
    const first = operations.keys().next().value;
    if (!first) return;
    operations.delete(first);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listWorkspaces(config: AgentConfig): ToolResult {
  return {
    ok: true,
    summary: 'configured workspaces loaded. access is the effective workspace access label.',
    data: {
      workspaces: config.workspaces.map((workspace) => ({
        alias: workspace.alias,
        description: workspace.description,
        access: workspaceAccess(config, workspace),
      })),
    },
  };
}

function workspaceAccess(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number]
): string {
  if (config.fullAccessEnabled && workspace.allowFullAccess) return 'full access';
  if (config.writeTasksEnabled && workspace.allowWrite) return 'write access';
  return 'read only';
}

async function usageResult(config: AgentConfig): Promise<ToolResult> {
  resetTodayIfNeeded();
  const rateLimits = await codex.readRateLimits(config).catch((error: unknown): ToolResult => {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : 'rate limits unavailable',
      data: { error: redactSecrets(error) },
    };
  });
  const observedTokens = usageTotal(runtime.todayTotal);

  return {
    ok: Boolean(runtime.lastUsage) || rateLimits.ok,
    summary: runtime.lastUsage
      ? `usage loaded. observed today: ${observedTokens} tokens across ${runtime.completedTurns} completed turn${runtime.completedTurns === 1 ? '' : 's'}.`
      : rateLimits.ok
        ? 'no token usage events seen yet; account rate limits loaded.'
        : 'no token usage seen yet.',
    data: stripUndefined({
      startedAt: runtime.startedAt,
      localDate: runtime.localDate,
      completedTurns: runtime.completedTurns,
      lastUsage: runtime.lastUsage,
      sessionTotal: runtime.sessionTotal,
      todayTotal: runtime.todayTotal,
      rateLimits: rateLimits.ok ? rateLimits.data.result : undefined,
      rateLimitError: rateLimits.ok ? undefined : rateLimits.summary,
    }),
  };
}

function trackRunnerProgress(progress: RunnerProgress): void {
  const usage = usageFrom(progress.usage);
  if (!usage) return;
  rememberUsage(usage, {
    source: 'event',
    threadId: progress.threadId,
    turnId: progress.turnId,
  });
}

function runnerResultToTool(
  summary: string,
  result: { threadId?: string; finalMessage: string; usage: unknown; events: unknown[] }
): ToolResult {
  const usage = usageFrom(result.usage);
  if (usage) {
    rememberUsage(usage, { source: 'turn', threadId: result.threadId });
    runtime.completedTurns += 1;
    runtime.sessionTotal = addUsage(runtime.sessionTotal, usage);
    runtime.todayTotal = addUsage(runtime.todayTotal, usage);
  }

  const toolResult = {
    ok: true,
    summary,
    data: {
      threadId: result.threadId,
      finalMessage: result.finalMessage,
      usage: result.usage,
    },
  };
  return toolResult;
}

function rememberUsage(
  usage: Usage,
  details: {
    source: UsageSnapshot['source'];
    threadId?: string | undefined;
    turnId?: string | undefined;
  }
): void {
  resetTodayIfNeeded();
  runtime.lastUsage = stripUndefined({
    at: new Date().toISOString(),
    usage,
    totalTokens: usageTotal(usage),
    source: details.source,
    threadId: details.threadId,
    turnId: details.turnId,
  }) as UsageSnapshot;
}

function usageFrom(value: unknown): Usage | null {
  const parsed = UsageSchema.safeParse(value);
  if (!parsed.success || usageTotal(parsed.data) === 0) return null;
  return parsed.data;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function usageTotal(usage: Usage): number {
  return (
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningOutputTokens
  );
}

function emptyUsage(): Usage {
  return UsageSchema.parse({});
}

function resetTodayIfNeeded(): void {
  const today = localDate();
  if (runtime.localDate === today) return;
  runtime.localDate = today;
  runtime.completedTurns = 0;
  runtime.todayTotal = emptyUsage();
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const socket = activeSocket;
  activeSocket = null;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close(1001, 'pokedex agent shutting down');
    setTimeout(() => socket.terminate(), 1_000).unref();
  }
  await codex.close();
  process.exit(0);
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultConfigPath(): string {
  return join(homedir(), '.pokedex', 'config.jsonc');
}

function legacyConfigPath(): string {
  return join(homedir(), '.pokedex', 'config.json');
}

function existingDefaultConfigPath(): string {
  return existsSync(defaultConfigPath()) ? defaultConfigPath() : legacyConfigPath();
}
