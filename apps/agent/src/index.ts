#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import WebSocket, { type RawData } from 'ws';
import {
  AgentConfigSchema,
  AgentRequestSchema,
  RuntimeSettingsSchema,
  UsageSchema,
  parseJsonc,
  type AgentConfig,
  type ToolResult,
  type Usage,
} from '@pokedex/protocol';
import {
  CodexAppServerClient,
  buildSettings,
  capabilitiesResult,
  diffResult,
  gitCheckResult,
  gitCommitPushResult,
  gitCommitResult,
  gitPushResult,
  type RunnerProgress,
} from '@pokedex/codex-runner';
import { findWorkspace, redactSecrets, resolveWorkspaceRoot } from '@pokedex/security';
import { listWorkspaces, pokedexCommandResult } from './pokedex-commands.js';

type UsageSnapshot = {
  at: string;
  usage: Usage;
  totalTokens: number;
  source: 'event' | 'turn';
  threadId?: string;
  turnId?: string;
};
type RateLimitSnapshot = {
  at: string;
  raw: unknown;
  status?: RateLimitStatus;
};
type RateLimitStatus = {
  limited: boolean;
  summary: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  resetsInSeconds?: number;
  windowMinutes?: number;
};
type OperationStatus = 'running' | 'completed' | 'failed';
type OperationFailureKind = 'rate_limit' | 'cancelled' | 'error';
type OperationRecord = {
  operationId: string;
  toolName: string;
  label: string;
  status: OperationStatus;
  startedAt: string;
  finishedAt?: string;
  result?: ToolResult;
  error?: unknown;
  failureKind?: OperationFailureKind;
  failureMessage?: string;
  eventsSeen: number;
  lastProgressAt?: string;
  lastEventName?: string;
  lastStatus?: string;
  lastMessage?: string;
  lastError?: string;
  lastUsage?: Usage;
  threadId?: string;
  turnId?: string;
  workspaceAlias?: string;
  cwd?: string;
  settings?: Record<string, unknown>;
  rateLimits?: unknown;
  rateLimitStatus?: RateLimitStatus;
  waiters: Set<() => void>;
  promise: Promise<void>;
};

const logger = pino({ name: 'pokedex-agent', level: 'warn' });
const configPath = value('--config') ?? existingDefaultConfigPath();
const codex = new CodexAppServerClient();
const operations = new Map<string, OperationRecord>();
const operationReturnDeadlineMs = 8_000;
const operationStalledAfterMs = 120_000;
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
  lastRateLimits: undefined as RateLimitSnapshot | undefined,
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
  if (toolName === 'pokedex_read_operation') return await readOperation(args);
  if (toolName === 'pokedex_start_task')
    return await trackOperation(config, toolName, 'task start', args, async (onProgress) =>
      runnerResultToTool('codex task started.', await codex.startThread(config, args, onProgress))
    );
  if (toolName === 'pokedex_start_thread')
    return await trackOperation(config, toolName, 'thread start', args, async (onProgress) =>
      runnerResultToTool('codex thread started.', await codex.startThread(config, args, onProgress))
    );
  if (toolName === 'pokedex_continue_task')
    return await trackOperation(config, toolName, 'task turn', args, async (onProgress) =>
      runnerResultToTool('codex task continued.', await codex.startTurn(config, args, onProgress))
    );
  if (toolName === 'pokedex_send_turn')
    return await trackOperation(config, toolName, 'thread turn', args, async (onProgress) =>
      runnerResultToTool('codex turn sent.', await codex.startTurn(config, args, onProgress))
    );
  if (toolName === 'pokedex_resume_task')
    return await trackOperation(config, toolName, 'task resume', args, async (onProgress) =>
      runnerResultToTool('codex task resumed.', await codex.resumeThread(config, args, onProgress))
    );
  if (toolName === 'pokedex_resume_thread')
    return await trackOperation(config, toolName, 'thread resume', args, async (onProgress) =>
      runnerResultToTool(
        'codex thread resumed.',
        await codex.resumeThread(config, args, onProgress)
      )
    );
  if (toolName === 'pokedex_read_thread') return await codex.readThread(config, args);
  if (toolName === 'pokedex_fork_thread') return await codex.forkThread(config, args);
  if (toolName === 'pokedex_set_goal') return await codex.setGoal(config, args);
  if (toolName === 'pokedex_clear_goal') return await codex.clearGoal(config, args);
  if (toolName === 'pokedex_review')
    return await trackOperation(config, toolName, 'review', args, async (onProgress) =>
      runnerResultToTool('codex review started.', await codex.review(config, args, onProgress))
    );
  if (toolName === 'pokedex_interrupt') return await codex.interrupt(config, args);
  if (toolName === 'pokedex_list_approvals') return await codex.listApprovals();
  if (toolName === 'pokedex_approve') return await codex.approve(args);
  if (toolName === 'pokedex_decline') return await codex.decline(args);
  if (toolName === 'pokedex_cancel_approval') return await codex.cancelApproval(args);
  if (toolName === 'pokedex_get_diff') return await diffResult(config, args);
  if (toolName === 'pokedex_git_check') return await gitCheckResult(config, args);
  if (toolName === 'pokedex_git_commit') return await gitCommitResult(config, args);
  if (toolName === 'pokedex_git_push') return await gitPushResult(config, args);
  if (toolName === 'pokedex_git_commit_push') return await gitCommitPushResult(config, args);
  if (toolName === 'pokedex_get_usage') return await usageResult(config);
  if (toolName === 'pokedex_command') return pokedexCommandResult(config, args, configPath);

  return {
    ok: false,
    summary: `unknown tool: ${toolName}`,
    data: { capabilities: capabilitiesResult().data },
  };
}

async function trackOperation(
  config: AgentConfig,
  toolName: string,
  label: string,
  args: Record<string, unknown>,
  run: (onProgress: (progress: RunnerProgress) => void) => Promise<ToolResult>
): Promise<ToolResult> {
  pruneOperations();
  const operation = createOperation(config, toolName, label, args);
  const onProgress = (progress: RunnerProgress) => {
    trackRunnerProgress(progress);
    trackOperationProgress(operation, progress);
  };
  operation.promise = run(onProgress)
    .then((result) => {
      operation.status = 'completed';
      operation.finishedAt = new Date().toISOString();
      syncOperationFromResult(operation, result);
      operation.result = addOperationData(result, operation);
    })
    .catch(async (error: unknown) => {
      operation.status = 'failed';
      operation.finishedAt = new Date().toISOString();
      await diagnoseOperationError(config, operation, error);
    })
    .finally(() => {
      notifyOperation(operation);
    });
  operations.set(operation.operationId, operation);

  await Promise.race([operation.promise, delay(operationReturnDeadlineMs)]);
  return operationResult(operation);
}

function createOperation(
  config: AgentConfig,
  toolName: string,
  label: string,
  args: Record<string, unknown>
): OperationRecord {
  const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const metadata = operationMetadata(config, args);
  return {
    operationId,
    toolName,
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
    ...metadata,
    eventsSeen: 0,
    waiters: new Set(),
    promise: Promise.resolve(),
  };
}

function operationMetadata(
  config: AgentConfig,
  args: Record<string, unknown>
): Pick<OperationRecord, 'workspaceAlias' | 'cwd' | 'settings' | 'threadId'> {
  const threadId = stringFrom(args.threadId);
  const workspaceAlias =
    stringFrom(args.workspaceAlias) ??
    (config.workspaces.length === 1 ? config.workspaces[0]?.alias : undefined);
  if (!workspaceAlias)
    return stripUndefined({ threadId }) as Pick<
      OperationRecord,
      'workspaceAlias' | 'cwd' | 'settings' | 'threadId'
    >;

  try {
    const workspace = findWorkspace(config, workspaceAlias);
    const cwd = resolveWorkspaceRoot(workspace);
    const settings = buildSettings(config, workspace, RuntimeSettingsSchema.parse(args));
    return stripUndefined({ threadId, workspaceAlias, cwd, settings }) as Pick<
      OperationRecord,
      'workspaceAlias' | 'cwd' | 'settings' | 'threadId'
    >;
  } catch {
    return stripUndefined({ threadId, workspaceAlias }) as Pick<
      OperationRecord,
      'workspaceAlias' | 'cwd' | 'settings' | 'threadId'
    >;
  }
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

async function readOperation(args: Record<string, unknown>): Promise<ToolResult> {
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
  await waitForOperationChange(operation, numberArg(args.waitMs), numberArg(args.afterEventsSeen));
  return operationResult(operation);
}

function operationResult(operation: OperationRecord): ToolResult {
  if (operation.status === 'completed' && operation.result) return operation.result;
  if (operation.status === 'failed') {
    return {
      ok: false,
      summary: failedOperationSummary(operation),
      data: {
        ...operationSummary(operation),
        error: operation.error,
        nextAction: failedOperationNextAction(operation),
      },
    };
  }
  return {
    ok: false,
    summary: runningOperationSummary(operation),
    data: {
      ...operationSummary(operation),
      incomplete: true,
      nextAction: pollInstruction(operation),
    },
  };
}

function addOperationData(result: ToolResult, operation: OperationRecord): ToolResult {
  return {
    ...result,
    data: {
      ...result.data,
      ...operationData(operation),
    },
  };
}

function operationSummary(operation: OperationRecord): Record<string, unknown> {
  const data = operation.result?.data ?? {};
  return stripUndefined({
    ...operationData(operation),
    threadId: operation.threadId ?? stringFrom(data.threadId),
    finalMessage:
      typeof data.finalMessage === 'string' && data.finalMessage ? data.finalMessage : undefined,
  });
}

function operationData(operation: OperationRecord): Record<string, unknown> {
  return stripUndefined({
    operationId: operation.operationId,
    operationStatus: operation.status,
    toolName: operation.toolName,
    label: operation.label,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    elapsedMs: operationElapsedMs(operation),
    eventsSeen: operation.eventsSeen,
    lastProgressAt: operation.lastProgressAt,
    lastEventName: operation.lastEventName,
    lastStatus: operation.lastStatus,
    lastMessage: operation.lastMessage,
    lastError: operation.lastError,
    lastUsage: operation.lastUsage,
    threadId: operation.threadId,
    turnId: operation.turnId,
    workspaceAlias: operation.workspaceAlias,
    cwd: operation.cwd,
    settings: operation.settings,
    operationHealth: operationHealth(operation),
    stalledMs: operationStalledMs(operation),
    rateLimitStatus: operation.rateLimitStatus,
    rateLimits: operation.rateLimits,
    failureKind: operation.failureKind,
    failureMessage: operation.failureMessage,
  });
}

function pruneOperations(): void {
  while (operations.size > maxOperations) {
    const first = operations.keys().next().value;
    if (!first) return;
    operations.delete(first);
  }
}

function trackOperationProgress(operation: OperationRecord, progress: RunnerProgress): void {
  operation.eventsSeen += 1;
  operation.lastProgressAt = new Date().toISOString();
  if (progress.eventName) operation.lastEventName = progress.eventName;
  if (progress.status) operation.lastStatus = progress.status;
  if (progress.message) operation.lastMessage = trimForTool(progress.message);
  if (progress.error) operation.lastError = trimForTool(progress.error);
  if (progress.threadId) operation.threadId = progress.threadId;
  if (progress.turnId) operation.turnId = progress.turnId;
  if (progress.usage) operation.lastUsage = progress.usage;
  if (progress.rateLimits) rememberRateLimits(progress.rateLimits, operation);
  if (progress.error && isRateLimitProblem(progress.error)) operation.failureKind = 'rate_limit';
  notifyOperation(operation);
}

function syncOperationFromResult(operation: OperationRecord, result: ToolResult): void {
  const threadId = stringFrom(result.data.threadId);
  if (threadId) operation.threadId ??= threadId;
  const workspaceAlias = stringFrom(result.data.workspaceAlias);
  if (workspaceAlias) operation.workspaceAlias ??= workspaceAlias;
  const cwd = stringFrom(result.data.cwd);
  if (cwd) operation.cwd ??= cwd;
  const settings = asRecord(result.data.settings);
  if (Object.keys(settings).length) operation.settings ??= settings;
  const usage = usageFrom(result.data.usage);
  if (usage) operation.lastUsage = usage;
}

async function diagnoseOperationError(
  config: AgentConfig,
  operation: OperationRecord,
  error: unknown
): Promise<void> {
  const message = errorMessage(error);
  operation.failureMessage = message;
  operation.lastError = message;
  operation.failureKind =
    operation.failureKind ??
    (isRateLimitProblem(message)
      ? 'rate_limit'
      : isCancellationProblem(message)
        ? 'cancelled'
        : 'error');

  const rateLimitRead =
    operation.failureKind === 'rate_limit'
      ? await codex.readRateLimits(config).catch((readError: unknown): ToolResult => {
          return {
            ok: false,
            summary: readError instanceof Error ? readError.message : 'rate limits unavailable',
            data: { error: redactSecrets(readError) },
          };
        })
      : undefined;
  if (rateLimitRead?.ok) rememberRateLimits(rateLimitRead.data.result, operation);

  operation.error = stripUndefined({
    message,
    kind: operation.failureKind,
    rateLimitLikely: operation.failureKind === 'rate_limit',
    rateLimitStatus: operation.rateLimitStatus,
    rateLimits: operation.rateLimits,
    rateLimitReadError: rateLimitRead?.ok === false ? rateLimitRead.summary : undefined,
    raw: redactSecrets(error),
  });
}

function rememberRateLimits(value: unknown, operation?: OperationRecord): void {
  const snapshot = stripUndefined({
    at: new Date().toISOString(),
    raw: value,
    status: normalizeRateLimitStatus(value),
  }) as RateLimitSnapshot;
  runtime.lastRateLimits = snapshot;
  if (!operation) return;
  operation.rateLimits = snapshot.raw;
  if (snapshot.status) operation.rateLimitStatus = snapshot.status;
  if (snapshot.status?.limited) operation.failureKind = 'rate_limit';
}

async function waitForOperationChange(
  operation: OperationRecord,
  waitMs: number | undefined,
  afterEventsSeen: number | undefined
): Promise<void> {
  if (!waitMs || operation.status !== 'running') return;
  const previousEventsSeen = afterEventsSeen ?? operation.eventsSeen;
  if (operation.eventsSeen > previousEventsSeen) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      operation.waiters.delete(done);
      resolve();
    };
    const timeout = setTimeout(done, Math.min(waitMs, 30_000));
    operation.waiters.add(done);
  });
}

function notifyOperation(operation: OperationRecord): void {
  for (const waiter of operation.waiters) waiter();
  operation.waiters.clear();
}

function runningOperationSummary(operation: OperationRecord): string {
  const stalledMs = operationStalledMs(operation);
  const detail = [
    stalledMs
      ? `stalled for ${formatDuration(stalledMs)}`
      : `running for ${formatDuration(operationElapsedMs(operation))}`,
    operation.lastEventName ? `last event ${operation.lastEventName}` : '',
    operation.lastStatus ? `status ${operation.lastStatus}` : '',
    operation.lastMessage ? `message: ${operation.lastMessage}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return `codex ${operation.label} is not complete yet (${detail || 'no progress event seen yet'}). do not claim completion, do not promise a future update after ending your response, do not retry the same request, and use pokedex_read_operation with operationId ${operation.operationId}.`;
}

function failedOperationSummary(operation: OperationRecord): string {
  if (operation.failureKind === 'rate_limit')
    return `codex ${operation.label} hit a Codex rate limit${resetClause(
      operation.rateLimitStatus
    )}. do not retry before the reset time.`;
  if (operation.failureKind === 'cancelled') return `codex ${operation.label} was cancelled.`;
  return `codex ${operation.label} failed. inspect the operation data before retrying.`;
}

function failedOperationNextAction(operation: OperationRecord): string {
  if (operation.failureKind === 'rate_limit')
    return `tell the user Codex is rate-limited${resetClause(
      operation.rateLimitStatus
    )}; use pokedex_get_usage for a fresh limit snapshot before retrying.`;
  return 'report the failure message to the user and retry only if the user asks or the error is clearly transient.';
}

function pollInstruction(operation: OperationRecord): string {
  if (operationStalledMs(operation))
    return `call pokedex_read_operation again with operationId ${operation.operationId}, afterEventsSeen ${operation.eventsSeen}, and waitMs up to 30000; if it remains stalled, inspect logs or interrupt the thread before retrying the request.`;
  return `call pokedex_read_operation again with operationId ${operation.operationId}, afterEventsSeen ${operation.eventsSeen}, and waitMs up to 30000 until operationStatus is completed or failed.`;
}

function operationHealth(operation: OperationRecord): 'active' | 'stalled' | undefined {
  if (operation.status !== 'running') return undefined;
  return operationStalledMs(operation) ? 'stalled' : 'active';
}

function operationStalledMs(operation: OperationRecord): number | undefined {
  if (operation.status !== 'running') return undefined;
  const lastSignalAt = Date.parse(operation.lastProgressAt ?? operation.startedAt);
  const stalledMs = Date.now() - lastSignalAt;
  return stalledMs >= operationStalledAfterMs ? stalledMs : undefined;
}

function normalizeRateLimitStatus(value: unknown): RateLimitStatus | undefined {
  if (!value) return undefined;
  const usedPercent = firstNumberForKeys(value, ['usedpercent', 'usedpercentage']);
  const remainingPercent = firstNumberForKeys(value, [
    'remainingpercent',
    'remainingpercentage',
    'percentremaining',
  ]);
  const resetsAt = firstResetDate(value);
  const resetsInSeconds = resetsAt
    ? Math.max(0, Math.round((resetsAt.getTime() - Date.now()) / 1000))
    : undefined;
  const limited =
    firstBooleanForKeys(value, ['limited', 'islimited', 'exhausted', 'depleted']) === true ||
    (typeof remainingPercent === 'number' && remainingPercent <= 0) ||
    (typeof usedPercent === 'number' && usedPercent >= 100);
  const status = stripUndefined({
    limited,
    summary: rateLimitSummary(limited, usedPercent, remainingPercent, resetsAt),
    usedPercent,
    remainingPercent,
    resetsAt: resetsAt?.toISOString(),
    resetsInSeconds,
    windowMinutes: firstNumberForKeys(value, [
      'windowdurationmins',
      'windowminutes',
      'durationminutes',
    ]),
  }) as RateLimitStatus;
  return Object.keys(status).length > 2 || JSON.stringify(value).toLowerCase().includes('limit')
    ? status
    : undefined;
}

function rateLimitSummary(
  limited: boolean,
  usedPercent: number | undefined,
  remainingPercent: number | undefined,
  resetsAt: Date | undefined
): string {
  return [
    limited ? 'limit reached' : 'rate limits loaded',
    typeof usedPercent === 'number' ? `${roundPercent(usedPercent)}% used` : '',
    typeof remainingPercent === 'number' ? `${roundPercent(remainingPercent)}% remaining` : '',
    resetsAt ? `resets at ${resetsAt.toISOString()}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function firstResetDate(value: unknown, depth = 0): Date | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const date = firstResetDate(item, depth + 1);
      if (date) return date;
    }
    return undefined;
  }
  const raw = asRecord(value);
  for (const [key, item] of Object.entries(raw)) {
    if (/reset|resets|retryafter/i.test(key)) {
      const date = dateFromReset(item);
      if (date) return date;
    }
  }
  for (const item of Object.values(raw)) {
    const date = firstResetDate(item, depth + 1);
    if (date) return date;
  }
  return undefined;
}

function firstNumberForKeys(value: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNumberForKeys(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const raw = asRecord(value);
  for (const [key, item] of Object.entries(raw)) {
    if (keys.includes(normalizeKey(key)) && numberFrom(item) !== undefined) return numberFrom(item);
  }
  for (const item of Object.values(raw)) {
    const found = firstNumberForKeys(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstBooleanForKeys(value: unknown, keys: string[], depth = 0): boolean | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstBooleanForKeys(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const raw = asRecord(value);
  for (const [key, item] of Object.entries(raw)) {
    if (keys.includes(normalizeKey(key)) && typeof item === 'boolean') return item;
  }
  for (const item of Object.values(raw)) {
    const found = firstBooleanForKeys(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function dateFromReset(value: unknown): Date | undefined {
  const number = numberFrom(value);
  if (number !== undefined) {
    const millis =
      number > 1_000_000_000_000
        ? number
        : number > 1_000_000_000
          ? number * 1000
          : Date.now() + number * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function resetClause(status: RateLimitStatus | undefined): string {
  if (!status?.resetsAt) return '';
  return `; ${status.summary}`;
}

function isRateLimitProblem(value: unknown): boolean {
  return /rate.?limit|usage.?limit|too many requests|\b429\b|quota|credit|depleted|exhausted/i.test(
    errorMessage(value)
  );
}

function isCancellationProblem(value: unknown): boolean {
  return /cancelled|canceled|interrupted/i.test(errorMessage(value));
}

function operationElapsedMs(operation: OperationRecord): number {
  return (
    Date.parse(operation.finishedAt ?? new Date().toISOString()) - Date.parse(operation.startedAt)
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  const raw = asRecord(value);
  return (
    stringFrom(raw.message) ??
    stringFrom(raw.summary) ??
    stringFrom(raw.error) ??
    JSON.stringify(redactSecrets(value))
  );
}

function numberArg(value: unknown): number | undefined {
  const number = numberFrom(value);
  return number === undefined ? undefined : Math.max(0, Math.floor(number));
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function trimForTool(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (rateLimits.ok) rememberRateLimits(rateLimits.data.result);
  const observedTokens = usageTotal(runtime.todayTotal);
  const rateLimitStatus = rateLimits.ok
    ? normalizeRateLimitStatus(rateLimits.data.result)
    : runtime.lastRateLimits?.status;

  return {
    ok: Boolean(runtime.lastUsage) || rateLimits.ok,
    summary: runtime.lastUsage
      ? `usage loaded. observed today: ${observedTokens} tokens across ${runtime.completedTurns} completed turn${runtime.completedTurns === 1 ? '' : 's'}${resetClause(rateLimitStatus)}.`
      : rateLimits.ok
        ? `no token usage events seen yet; account rate limits loaded${resetClause(rateLimitStatus)}.`
        : 'no token usage seen yet.',
    data: stripUndefined({
      startedAt: runtime.startedAt,
      localDate: runtime.localDate,
      completedTurns: runtime.completedTurns,
      lastUsage: runtime.lastUsage,
      lastRateLimits: runtime.lastRateLimits,
      sessionTotal: runtime.sessionTotal,
      todayTotal: runtime.todayTotal,
      rateLimits: rateLimits.ok ? rateLimits.data.result : undefined,
      rateLimitStatus,
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
  result: {
    threadId?: string;
    finalMessage: string;
    usage: unknown;
    events: unknown[];
    cwd?: string;
    workspaceAlias?: string;
    settings?: Record<string, unknown>;
  }
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
    data: stripUndefined({
      threadId: result.threadId,
      workspaceAlias: result.workspaceAlias,
      cwd: result.cwd,
      settings: result.settings,
      finalMessage: result.finalMessage,
      usage: result.usage,
    }),
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
