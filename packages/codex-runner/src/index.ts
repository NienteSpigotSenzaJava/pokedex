import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type {
  AgentConfig,
  GoalSet,
  ReviewStart,
  RuntimeSettingsSchema,
  ToolResult,
  Usage,
  Workspace,
} from '@pokedex/protocol';
import {
  GoalSetSchema,
  ReviewStartSchema,
  ThreadIdSchema,
  ThreadListSchema,
  ThreadReadSchema,
  ThreadStartSchema,
  ToolResultSchema,
  TurnStartSchema,
  UsageSchema,
  WorkspaceRequestSchema,
  stableCapabilities,
} from '@pokedex/protocol';
import {
  assertSandboxAllowed,
  findWorkspace,
  redactSecrets,
  resolveWorkspaceRoot,
} from '@pokedex/security';

type AppServerProcess = ChildProcessByStdio<Writable, Readable, Readable>;
type JsonRecord = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
type RuntimeSettings = ReturnType<typeof RuntimeSettingsSchema.parse>;

export type AppServerEvent = {
  method?: string;
  params?: unknown;
  raw: unknown;
};

export type RunnerProgress = {
  event: unknown;
  threadId?: string;
  finalMessage?: string;
  usage?: Usage;
};

export type RunnerResult = {
  threadId?: string;
  finalMessage: string;
  usage: Usage;
  events: unknown[];
};

export function mapSandboxForAppServer(mode: string): string {
  if (mode === 'workspace_write') return 'workspace-write';
  if (mode === 'danger_full_access') return 'danger-full-access';
  return 'read-only';
}

export function parseUsage(value: unknown): Usage | null {
  const raw = asRecord('usage' in asRecord(value) ? asRecord(value).usage : value);
  if (!Object.keys(raw).length) return null;

  return (
    UsageSchema.safeParse({
      inputTokens: numberFrom(raw.input_tokens ?? raw.inputTokens),
      cachedInputTokens: numberFrom(raw.cached_input_tokens ?? raw.cachedInputTokens),
      outputTokens: numberFrom(raw.output_tokens ?? raw.outputTokens),
      reasoningOutputTokens: numberFrom(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens),
    }).data ?? null
  );
}

export function capabilitiesResult(): ToolResult {
  return {
    ok: true,
    summary: 'pokedex uses native codex app-server threads for local sync.',
    data: { capabilities: stableCapabilities },
  };
}

export class CodexAppServerClient {
  private child: AppServerProcess | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: unknown[] = [];
  private readonly listeners = new Set<(event: AppServerEvent) => void>();

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setupCheck(config: AgentConfig): Promise<ToolResult> {
    const doctor = await runPlainCommand({
      command: config.appServerCommand,
      args: ['doctor'],
      cwd: process.cwd(),
      env: process.env,
    });

    return ToolResultSchema.parse({
      ok: doctor.exitCode === 0,
      summary:
        doctor.exitCode === 0 ? 'codex setup looks usable.' : 'codex doctor reported setup issues.',
      data: {
        stdout: redactSecrets(doctor.stdout),
        stderr: redactSecrets(doctor.stderr),
        appServer: { command: config.appServerCommand, args: config.appServerArgs },
        workspaces: config.workspaces.map(({ alias, description }) => ({ alias, description })),
      },
    });
  }

  async listThreads(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadListSchema.parse(input);
    const params: JsonRecord = {
      limit: args.limit,
      cursor: args.cursor,
      searchTerm: args.searchTerm,
      archived: args.archived,
    };
    if (args.workspaceAlias)
      params.cwd = resolveWorkspaceRoot(findWorkspace(config, args.workspaceAlias));

    const result = await this.request(config, 'thread/list', stripUndefined(params));
    return { ok: true, summary: 'codex local threads loaded.', data: { result } };
  }

  async startThread(
    config: AgentConfig,
    input: unknown,
    onProgress?: (progress: RunnerProgress) => void
  ): Promise<RunnerResult> {
    const task = ThreadStartSchema.parse(input);
    const workspace = findWorkspace(config, task.workspaceAlias);
    const cwd = resolveWorkspaceRoot(workspace);
    const settings = buildSettings(config, workspace, task);
    const events: unknown[] = [];
    const off = this.collect(events, onProgress);

    try {
      const started = await this.request(
        config,
        'thread/start',
        stripUndefined({ cwd, name: task.name, settings })
      );
      const threadId = extractThreadId(started);
      if (!threadId) throw new Error('codex app-server did not return a thread id');
      const turn = await this.startTurn(config, { ...task, threadId }, onProgress);
      return { ...turn, threadId, events: [...events, ...turn.events] };
    } finally {
      off();
    }
  }

  async startTurn(
    config: AgentConfig,
    input: unknown,
    onProgress?: (progress: RunnerProgress) => void
  ): Promise<RunnerResult> {
    const task = TurnStartSchema.parse(input);
    const events: unknown[] = [];
    const off = this.collect(events, onProgress, task.threadId);

    try {
      const result = await this.request(config, 'turn/start', {
        threadId: task.threadId,
        input: [
          ...task.skills.map(({ name, path }) => ({ type: 'skill', name, path })),
          { type: 'text', text: task.prompt },
        ],
        settings: stripUndefined({
          model: task.model,
          profile: task.profile,
          model_reasoning_effort: task.reasoningEffort,
          model_verbosity: task.verbosity,
          web_search: task.webSearch,
        }),
      });

      return {
        threadId: task.threadId,
        finalMessage: extractFinalMessage(result) || 'turn started.',
        usage: extractUsage(result) ?? UsageSchema.parse({}),
        events,
      };
    } finally {
      off();
    }
  }

  async resumeThread(
    config: AgentConfig,
    input: unknown,
    onProgress?: (progress: RunnerProgress) => void
  ): Promise<RunnerResult> {
    const task = TurnStartSchema.parse(input);
    await this.request(config, 'thread/resume', { threadId: task.threadId });
    return this.startTurn(config, task, onProgress);
  }

  async readThread(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadReadSchema.parse(input);
    const result = await this.request(config, 'thread/read', args);
    return { ok: true, summary: `thread ${args.threadId} loaded.`, data: { result } };
  }

  async forkThread(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadIdSchema.parse(input);
    const result = await this.request(config, 'thread/fork', args);
    return { ok: true, summary: `thread ${args.threadId} forked.`, data: { result } };
  }

  async setGoal(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = GoalSetSchema.parse(input) satisfies GoalSet;
    const result = await this.request(config, 'thread/goal/set', args);
    return { ok: true, summary: 'thread goal set.', data: { result } };
  }

  async clearGoal(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadIdSchema.parse(input);
    const result = await this.request(config, 'thread/goal/clear', args);
    return { ok: true, summary: 'thread goal cleared.', data: { result } };
  }

  async review(
    config: AgentConfig,
    input: unknown,
    onProgress?: (progress: RunnerProgress) => void
  ): Promise<RunnerResult> {
    const task = ReviewStartSchema.parse(input) satisfies ReviewStart;
    const threadId =
      task.threadId ??
      (
        await this.startThread(
          config,
          stripUndefined({
            workspaceAlias: task.workspaceAlias,
            prompt: task.prompt,
            model: task.model,
            profile: task.profile,
            reasoningEffort: task.reasoningEffort,
            verbosity: task.verbosity,
            sandbox: task.sandbox,
            approvalPolicy: task.approvalPolicy,
            webSearch: task.webSearch,
          }),
          onProgress
        )
      ).threadId;
    if (!threadId) throw new Error('review needs a thread id');
    const events: unknown[] = [];
    const off = this.collect(events, onProgress, threadId);

    try {
      const result = await this.request(config, 'review/start', { threadId });
      return {
        threadId,
        finalMessage: extractFinalMessage(result) || 'review started.',
        usage: extractUsage(result) ?? UsageSchema.parse({}),
        events,
      };
    } finally {
      off();
    }
  }

  async interrupt(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadIdSchema.parse(input);
    const result = await this.request(config, 'turn/interrupt', args);
    return { ok: true, summary: `thread ${args.threadId} interrupted.`, data: { result } };
  }

  async request(
    config: AgentConfig,
    method: string,
    params: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    this.ensureStarted(config);
    if (method !== 'initialize') await this.ensureInitialized();
    return await this.sendRequest(method, params, timeoutMs);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.sendRequest(
      'initialize',
      {
        clientInfo: {
          name: 'pokedex',
          version: '0.1.0',
        },
      },
      30_000
    )
      .then(() => {
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = null;
      });
    await this.initializing;
  }

  private async sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error('codex app-server did not start');

    const id = this.nextId++;
    const payload = JSON.stringify(stripUndefined({ id, method, params }));

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${payload}\n`);
    });
  }

  stop(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('codex app-server stopped'));
      this.pending.delete(id);
    }
    this.child?.kill();
    this.child = null;
    this.initialized = false;
    this.initializing = null;
  }

  private collect(
    events: unknown[],
    onProgress?: (progress: RunnerProgress) => void,
    threadId?: string
  ): () => void {
    return this.onEvent((event) => {
      const redacted = redactSecrets(event.raw);
      events.push(redacted);
      const progress: RunnerProgress = { event: redacted };
      if (threadId) progress.threadId = threadId;
      const finalMessage = extractFinalMessage(event.raw);
      if (finalMessage) progress.finalMessage = finalMessage;
      const usage = extractUsage(event.raw);
      if (usage) progress.usage = usage;
      onProgress?.(progress);
    });
  }

  private ensureStarted(config: AgentConfig): void {
    if (this.child && !this.child.killed) return;

    this.initialized = false;
    this.initializing = null;
    this.buffer = '';
    this.stderr = '';
    this.child = spawn(config.appServerCommand, config.appServerArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('close', () => {
      this.failAll(new Error(formatAppServerStop(this.stderr)));
      this.child = null;
      this.initialized = false;
      this.initializing = null;
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const message = JSON.parse(line) as JsonRecord;
    const id = typeof message.id === 'number' ? message.id : null;

    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(formatRpcError(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }

    const event: AppServerEvent = { raw: redactSecrets(message) };
    if (typeof message.method === 'string') event.method = message.method;
    if ('params' in message) event.params = message.params;
    this.events.push(event.raw);
    for (const listener of this.listeners) listener(event);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function buildSettings(
  config: AgentConfig,
  workspace: Workspace,
  task: RuntimeSettings
): JsonRecord {
  const sandbox = assertSandboxAllowed(config, workspace, task.sandbox ?? workspace.defaultSandbox);
  return stripUndefined({
    model: task.model ?? config.defaultModel,
    profile: task.profile,
    model_reasoning_effort: task.reasoningEffort ?? config.defaultReasoning,
    model_verbosity: task.verbosity ?? config.defaultVerbosity,
    approval_policy: task.approvalPolicy ?? config.defaultApprovalPolicy,
    sandbox_mode: mapSandboxForAppServer(sandbox),
    web_search: task.webSearch,
  });
}

export async function diffResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = WorkspaceRequestSchema.parse(input);
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const [stat, names] = await Promise.all([
    runPlainCommand({ command: 'git', args: ['diff', '--stat'], cwd: root, env: process.env }),
    runPlainCommand({ command: 'git', args: ['diff', '--name-only'], cwd: root, env: process.env }),
  ]);
  return {
    ok: stat.exitCode === 0 && names.exitCode === 0,
    summary: stat.stdout.trim() || 'no diff.',
    data: { stat: stat.stdout, files: names.stdout.split(/\r?\n/).filter(Boolean) },
  };
}

export async function runPlainCommand(command: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  return { exitCode, stdout, stderr };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function extractThreadId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const thread = asRecord(raw.thread);
  return (
    stringFrom(raw.threadId) ??
    stringFrom(raw.id) ??
    stringFrom(thread.id) ??
    stringFrom(thread.threadId)
  );
}

function extractFinalMessage(value: unknown): string {
  const raw = asRecord(value);
  const item = asRecord(raw.item);
  const params = asRecord(raw.params);
  const output = asRecord(raw.output);
  return (
    stringFrom(raw.finalMessage) ??
    stringFrom(raw.output_text) ??
    stringFrom(output.text) ??
    stringFrom(item.text) ??
    stringFrom(params.text) ??
    ''
  );
}

function extractUsage(value: unknown): Usage | null {
  const raw = asRecord(value);
  return parseUsage(raw.usage) ?? parseUsage(asRecord(raw.params).usage);
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return 0;
}

function stripUndefined<T extends JsonRecord>(input: T): JsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function formatRpcError(error: unknown): string {
  const raw = asRecord(error);
  return stringFrom(raw.message) ?? JSON.stringify(error);
}

function formatAppServerStop(stderr: string): string {
  const details = String(redactSecrets(stderr)).trim();
  return details
    ? `Codex app-server stopped before answering.\n${details}`
    : 'Codex app-server stopped before answering.';
}
