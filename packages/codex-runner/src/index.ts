import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type {
  ApprovalApprove,
  ApprovalTarget,
  AgentConfig,
  GitCheck,
  GoalSet,
  PluginList,
  ReviewStart,
  RuntimeSettingsSchema,
  SkillList,
  ToolResult,
  Usage,
  Workspace,
} from '@pokedex/protocol';
import {
  ApprovalApproveSchema,
  ApprovalTargetSchema,
  GitCheckSchema,
  GoalSetSchema,
  PluginListSchema,
  ReviewStartSchema,
  SkillListSchema,
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
type RpcId = string | number;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
type RuntimeSettings = ReturnType<typeof RuntimeSettingsSchema.parse>;
type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
type PendingApproval = {
  approvalId: string;
  requestId: RpcId;
  kind: 'command' | 'file';
  method: string;
  createdAt: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string;
  command?: string[];
  commandText?: string;
  cwd?: string;
  grantRoot?: string;
  availableDecisions?: string[];
  raw: unknown;
};
type SkillReference = { name: string; path: string };
type ListedSkill = SkillReference & {
  description?: string;
  enabled?: boolean;
  source?: string;
  cwd?: string;
};
type ListedPlugin = {
  name: string;
  path?: string;
  description?: string;
  installed?: boolean;
  enabled?: boolean;
  source?: string;
  marketplace?: string;
  availability?: string;
};
type OptionalEndpointResult = {
  method: string;
  result?: unknown;
  error?: string;
};
const turnCompletionTimeoutMs = 570_000;

export type AppServerEvent = {
  method?: string;
  params?: unknown;
  raw: unknown;
};

export type RunnerProgress = {
  event: unknown;
  threadId?: string;
  turnId?: string;
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
  const input = asRecord(value);
  const raw = asRecord('usage' in input ? input.usage : value);
  const tokenKeys = [
    'input_tokens',
    'inputTokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'output_tokens',
    'outputTokens',
    'reasoning_output_tokens',
    'reasoningOutputTokens',
  ];
  if (!tokenKeys.some((key) => key in raw)) return null;

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
  private commandKey = '';
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private nextApprovalId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly threadCwds = new Map<string, string>();
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

  async warm(config: AgentConfig): Promise<void> {
    this.ensureStarted(config);
    await this.ensureInitialized();
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

  async listSkills(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = SkillListSchema.parse(input) satisfies SkillList;
    const workspace = args.workspaceAlias
      ? findWorkspace(config, args.workspaceAlias)
      : config.workspaces[0];
    if (!workspace) throw new Error('no workspace configured');
    const cwd = resolveWorkspaceRoot(workspace);
    const result = await this.skillsListForCwd(config, cwd, args.forceReload);
    const skills = normalizeSkills(result, cwd);
    return {
      ok: true,
      summary: skills.length
        ? `${skills.length} codex skill${skills.length === 1 ? '' : 's'} available.`
        : 'no codex skills found.',
      data: { cwd, skillRoots: defaultSkillRoots(), skills, result },
    };
  }

  async listPlugins(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = PluginListSchema.parse(input) satisfies PluginList;
    const installed = await this.readOptional(config, 'plugin/installed', {});
    const marketplace = args.includeMarketplace
      ? await this.readOptional(config, 'plugin/list', {})
      : undefined;
    const endpoints = [installed, marketplace].filter(
      (endpoint): endpoint is OptionalEndpointResult => Boolean(endpoint)
    );
    const plugins = uniquePlugins(
      endpoints.flatMap((endpoint) => normalizePlugins(endpoint.result, endpoint.method))
    );
    const errors = endpoints
      .filter((endpoint) => endpoint.error)
      .map(({ method, error }) => ({ method, error }));

    return {
      ok: endpoints.some((endpoint) => !endpoint.error),
      summary: plugins.length
        ? `${plugins.length} codex plugin${plugins.length === 1 ? '' : 's'} found.`
        : errors.length
          ? 'codex plugin listing is unavailable.'
          : 'no codex plugins found.',
      data: stripUndefined({
        plugins,
        installed: installed.result,
        marketplace: marketplace?.result,
        errors,
      }),
    };
  }

  async readRateLimits(config: AgentConfig): Promise<ToolResult> {
    const result = await this.request(config, 'account/rateLimits/read', {}, 30_000);
    return {
      ok: true,
      summary: 'codex account rate limits loaded.',
      data: { result },
    };
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
      this.threadCwds.set(threadId, cwd);
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
    const cwd = this.cwdForTurn(config, task.threadId, task.workspaceAlias);
    const skills = await this.resolveTurnSkills(config, cwd, task);
    const events: unknown[] = [];
    const off = this.collect(events, onProgress, task.threadId);

    try {
      const outcome = await this.requestWithApprovalYield(
        config,
        'turn/start',
        {
          threadId: task.threadId,
          input: [
            ...skills.map(({ name, path }) => ({ type: 'skill', name, path })),
            { type: 'text', text: task.prompt },
          ],
          settings: stripUndefined({
            model: task.model ?? config.defaultModel,
            profile: task.profile,
            model_reasoning_effort: task.reasoningEffort ?? config.defaultReasoning,
            model_verbosity: task.verbosity ?? config.defaultVerbosity,
            approval_policy: task.approvalPolicy ?? config.defaultApprovalPolicy,
            web_search: task.webSearch,
          }),
        },
        task.threadId
      );

      if (outcome.approval) {
        return {
          threadId: task.threadId,
          finalMessage: approvalWaitMessage(outcome.approval),
          usage: UsageSchema.parse({}),
          events,
        };
      }

      const result = outcome.result;

      return {
        threadId: task.threadId,
        finalMessage: extractFinalMessage(result) || 'turn started.',
        usage: latestUsage([...events, result]) ?? UsageSchema.parse({}),
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
      const outcome = await this.requestWithApprovalYield(
        config,
        'review/start',
        { threadId },
        threadId
      );

      if (outcome.approval) {
        return {
          threadId,
          finalMessage: approvalWaitMessage(outcome.approval),
          usage: UsageSchema.parse({}),
          events,
        };
      }

      const result = outcome.result;
      return {
        threadId,
        finalMessage: extractFinalMessage(result) || 'review started.',
        usage: latestUsage([...events, result]) ?? UsageSchema.parse({}),
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

  async listApprovals(): Promise<ToolResult> {
    const approvals = this.approvalList();
    return {
      ok: true,
      summary: approvals.length
        ? `${approvals.length} pending codex approval${approvals.length === 1 ? '' : 's'}.`
        : 'no pending codex approvals.',
      data: { approvals },
    };
  }

  async approve(input: unknown): Promise<ToolResult> {
    const args = ApprovalApproveSchema.parse(input) satisfies ApprovalApprove;
    return this.resolveApproval(args.approvalId, args.forSession ? 'acceptForSession' : 'accept');
  }

  async decline(input: unknown): Promise<ToolResult> {
    const args = ApprovalTargetSchema.parse(input) satisfies ApprovalTarget;
    return this.resolveApproval(args.approvalId, 'decline');
  }

  async cancelApproval(input: unknown): Promise<ToolResult> {
    const args = ApprovalTargetSchema.parse(input) satisfies ApprovalTarget;
    return this.resolveApproval(args.approvalId, 'cancel');
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

  private async readOptional(
    config: AgentConfig,
    method: string,
    params: unknown
  ): Promise<OptionalEndpointResult> {
    try {
      return { method, result: await this.request(config, method, params, 30_000) };
    } catch (error) {
      return { method, error: error instanceof Error ? error.message : 'request failed' };
    }
  }

  private async requestWithApprovalYield(
    config: AgentConfig,
    method: string,
    params: unknown,
    threadId?: string,
    timeoutMs = 120_000
  ): Promise<{ result?: unknown; approval?: PendingApproval }> {
    let turnId: string | undefined;
    let stopApprovalWaiting = (): void => {};
    let stopTerminalWaiting = (): void => {};
    const approvalPromise = new Promise<PendingApproval>((resolve) => {
      const existing = this.findApprovalForThread(threadId);
      if (existing) {
        resolve(existing);
        return;
      }
      stopApprovalWaiting = this.onEvent((event) => {
        const approval = this.approvalFromEvent(event);
        if (!approval || !approvalMatchesThread(approval, threadId)) return;
        stopApprovalWaiting();
        resolve(approval);
      });
    });
    const terminalPromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stopTerminalWaiting();
        reject(new Error(`codex app-server timeout waiting for ${method} completion`));
      }, turnCompletionTimeoutMs);

      const stopEvents = this.onEvent((event) => {
        const terminal = terminalTurnResult(event.raw, threadId, turnId);
        if (!terminal) return;
        stopTerminalWaiting();
        resolve(terminal);
      });
      stopTerminalWaiting = () => {
        clearTimeout(timeout);
        stopEvents();
      };
    });
    const requestPromise = this.request(config, method, params, timeoutMs);
    requestPromise.catch(() => undefined);
    terminalPromise.catch(() => undefined);

    try {
      const first = await Promise.race([
        requestPromise.then((result) => ({ kind: 'result' as const, result })),
        approvalPromise.then((approval) => ({ kind: 'approval' as const, approval })),
        terminalPromise.then((result) => ({ kind: 'terminal' as const, result })),
      ]);

      if (first.kind === 'approval') return { approval: first.approval };
      if (first.kind === 'terminal') return { result: first.result };

      turnId = extractTurnId(first.result);
      if (!turnNeedsTerminalWait(first.result)) return { result: first.result };

      const second = await Promise.race([
        approvalPromise.then((approval) => ({ kind: 'approval' as const, approval })),
        terminalPromise.then((result) => ({ kind: 'terminal' as const, result })),
      ]);
      if (second.kind === 'approval') return { approval: second.approval };
      return { result: second.result };
    } finally {
      stopApprovalWaiting();
      stopTerminalWaiting();
    }
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

  private sendResponse(id: RpcId, result: unknown): void {
    const child = this.child;
    if (!child) throw new Error('codex app-server is not running');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  stop(): void {
    this.stopCurrentChild();
  }

  async close(timeoutMs = 2_000): Promise<void> {
    const child = this.stopCurrentChild();
    if (!child) return;
    if (await waitForChildClose(child, timeoutMs)) return;
    signalChild(child, 'SIGKILL');
    await waitForChildClose(child, 1_000);
  }

  private stopCurrentChild(): AppServerProcess | null {
    const child = this.child;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('codex app-server stopped'));
      this.pending.delete(id);
    }
    if (child && !childExited(child)) signalChild(child, 'SIGTERM');
    this.approvals.clear();
    this.child = null;
    this.commandKey = '';
    this.initialized = false;
    this.initializing = null;
    return child;
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
      const turnId = extractTurnId(event.raw);
      if (turnId) progress.turnId = turnId;
      const finalMessage = extractFinalMessage(event.raw);
      if (finalMessage) progress.finalMessage = finalMessage;
      const usage = extractUsage(event.raw);
      if (usage) progress.usage = usage;
      onProgress?.(progress);
    });
  }

  private approvalList(): unknown[] {
    return [...this.approvals.values()].map((approval) => redactSecrets(publicApproval(approval)));
  }

  private cwdForTurn(
    config: AgentConfig,
    threadId: string,
    workspaceAlias: string | undefined
  ): string {
    if (workspaceAlias) {
      const cwd = resolveWorkspaceRoot(findWorkspace(config, workspaceAlias));
      this.threadCwds.set(threadId, cwd);
      return cwd;
    }
    const cached = this.threadCwds.get(threadId);
    if (cached) return cached;
    const workspace = config.workspaces[0];
    if (!workspace) throw new Error('no workspace configured');
    return resolveWorkspaceRoot(workspace);
  }

  private async resolveTurnSkills(
    config: AgentConfig,
    cwd: string,
    task: RuntimeSettings & { prompt: string }
  ): Promise<SkillReference[]> {
    const explicit = [...task.skills, ...linkedSkillsFromPrompt(task.prompt)];
    const explicitNames = [...new Set(task.skillNames)].filter(
      (name) => !explicit.some((skill) => skill.name === name)
    );
    const markerNames = [...new Set(skillMarkersFromPrompt(task.prompt))].filter(
      (name) => !explicitNames.includes(name) && !explicit.some((skill) => skill.name === name)
    );
    if (!explicitNames.length && !markerNames.length) return uniqueSkills(explicit);

    const listed = normalizeSkills(await this.skillsListForCwd(config, cwd, false), cwd);
    const explicitResolved = explicitNames.map((name) => resolveSkillName(name, listed));
    const missing = explicitResolved
      .map((skill, index) => (skill ? '' : explicitNames[index]))
      .filter((name): name is string => Boolean(name));
    if (missing.length) {
      throw new Error(
        `unknown skill${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. use pokedex_list_skills.`
      );
    }
    const markerResolved = markerNames
      .map((name) => resolveSkillName(name, listed))
      .filter((skill): skill is SkillReference => Boolean(skill));
    return uniqueSkills([
      ...explicit,
      ...(explicitResolved.filter(Boolean) as SkillReference[]),
      ...markerResolved,
    ]);
  }

  private async skillsListForCwd(
    config: AgentConfig,
    cwd: string,
    forceReload: boolean
  ): Promise<unknown> {
    return await this.request(
      config,
      'skills/list',
      {
        cwds: [cwd],
        forceReload,
        perCwdExtraUserRoots: [{ cwd, extraUserRoots: defaultSkillRoots() }],
      },
      30_000
    );
  }

  private resolveApproval(approvalId: string | undefined, decision: ApprovalDecision): ToolResult {
    const approval = this.findApproval(approvalId);
    if (!approval) {
      const approvals = this.approvalList();
      return {
        ok: false,
        summary: approvals.length
          ? 'choose an approvalId because more than one codex approval is pending.'
          : 'no pending codex approval.',
        data: { approvals },
      };
    }

    if (approval.availableDecisions?.length && !approval.availableDecisions.includes(decision)) {
      return {
        ok: false,
        summary: `${decision} is not available for approval ${approval.approvalId}.`,
        data: { approval: redactSecrets(publicApproval(approval)) },
      };
    }

    this.sendResponse(approval.requestId, decision);
    this.approvals.delete(approval.approvalId);
    return {
      ok: true,
      summary: `codex approval ${decision} sent.`,
      data: { approval: redactSecrets(publicApproval(approval)), decision },
    };
  }

  private findApproval(approvalId: string | undefined): PendingApproval | null {
    if (approvalId) return this.approvals.get(approvalId) ?? null;
    return this.approvals.size === 1 ? [...this.approvals.values()][0]! : null;
  }

  private findApprovalForThread(threadId: string | undefined): PendingApproval | null {
    return (
      [...this.approvals.values()].find((approval) => approvalMatchesThread(approval, threadId)) ??
      null
    );
  }

  private approvalFromEvent(event: AppServerEvent): PendingApproval | null {
    const raw = asRecord(event.raw);
    const requestId = raw.id;
    if (!isRpcId(requestId)) return null;
    return (
      [...this.approvals.values()].find((approval) => approval.requestId === requestId) ?? null
    );
  }

  private trackApprovalRequest(requestId: RpcId, message: JsonRecord): void {
    const method = stringFrom(message.method);
    if (
      method !== 'item/commandExecution/requestApproval' &&
      method !== 'item/fileChange/requestApproval'
    ) {
      return;
    }

    const existing = [...this.approvals.values()].find(
      (approval) => approval.requestId === requestId
    );
    const params = asRecord(message.params);
    const command = stringArrayFrom(params.command);
    const approval = stripUndefined({
      approvalId: existing?.approvalId ?? `approval-${this.nextApprovalId++}`,
      requestId,
      kind: method.includes('commandExecution') ? 'command' : 'file',
      method,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      threadId: stringFrom(params.threadId),
      turnId: stringFrom(params.turnId),
      itemId: stringFrom(params.itemId),
      reason: stringFrom(params.reason),
      command,
      commandText: command?.join(' '),
      cwd: stringFrom(params.cwd),
      grantRoot: stringFrom(params.grantRoot),
      availableDecisions: stringArrayFrom(params.availableDecisions),
      raw: redactSecrets(message),
    }) as PendingApproval;
    this.approvals.set(approval.approvalId, approval);
  }

  private clearResolvedApproval(message: JsonRecord): void {
    if (message.method !== 'serverRequest/resolved') return;
    const requestId = asRecord(message.params).requestId;
    if (!isRpcId(requestId)) return;
    for (const approval of this.approvals.values()) {
      if (approval.requestId === requestId) this.approvals.delete(approval.approvalId);
    }
  }

  private ensureStarted(config: AgentConfig): void {
    const commandKey = JSON.stringify([config.appServerCommand, config.appServerArgs]);
    if (this.child && !this.child.killed && this.commandKey !== commandKey) this.stop();
    if (this.child && !this.child.killed) return;

    this.initialized = false;
    this.initializing = null;
    this.commandKey = commandKey;
    this.buffer = '';
    this.stderr = '';
    const child = spawn(config.appServerCommand, config.appServerArgs, {
      cwd: process.cwd(),
      env: gitHeadlessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    child.on('error', (error) => {
      if (this.child === child) this.failAll(error);
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.failAll(new Error(formatAppServerStop(this.stderr)));
      this.child = null;
      this.commandKey = '';
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

    if (isRpcId(message.id)) this.trackApprovalRequest(message.id, message);
    this.clearResolvedApproval(message);

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

function childExited(child: AppServerProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(child: AppServerProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // the app-server may have exited between the liveness check and the signal.
  }
}

function waitForChildClose(child: AppServerProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => done(true);
    const done = (closed: boolean) => {
      clearTimeout(timeout);
      child.off('close', onClose);
      resolve(closed);
    };
    child.once('close', onClose);
  });
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

function publicApproval(approval: PendingApproval): JsonRecord {
  return stripUndefined({
    approvalId: approval.approvalId,
    kind: approval.kind,
    threadId: approval.threadId,
    turnId: approval.turnId,
    itemId: approval.itemId,
    reason: approval.reason,
    command: approval.command,
    commandText: approval.commandText,
    cwd: approval.cwd,
    grantRoot: approval.grantRoot,
    availableDecisions: approval.availableDecisions,
    createdAt: approval.createdAt,
  });
}

function approvalWaitMessage(approval: PendingApproval): string {
  const target =
    approval.kind === 'command'
      ? approval.commandText || 'a command'
      : approval.grantRoot || 'file changes';
  return `codex is waiting for approval: ${target}. inspect pending approvals before asking the user to approve or decline.`;
}

function approvalMatchesThread(approval: PendingApproval, threadId: string | undefined): boolean {
  return !threadId || !approval.threadId || approval.threadId === threadId;
}

function defaultSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills'), join(homedir(), '.codex', 'skills')];
}

function normalizePlugins(result: unknown, source: string): ListedPlugin[] {
  return pluginRecords(result)
    .map((plugin) => listedPluginFrom(plugin, source))
    .filter((plugin): plugin is ListedPlugin => Boolean(plugin));
}

function pluginRecords(value: unknown, depth = 0): unknown[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => pluginRecords(item, depth + 1));
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return [];

  const nested = [
    'plugins',
    'installed',
    'installedPlugins',
    'items',
    'entries',
    'rows',
    'data',
    'marketplaceEntries',
  ].flatMap((key) => pluginRecords(raw[key], depth + 1));
  return looksLikePlugin(raw) ? [raw, ...nested] : nested;
}

function listedPluginFrom(value: unknown, source: string): ListedPlugin | null {
  const raw = asRecord(value);
  const manifest = asRecord(raw.manifest);
  const details = asRecord(raw.details);
  const pluginInterface = asRecord(raw.interface);
  const name =
    stringFrom(raw.name) ??
    stringFrom(raw.displayName) ??
    stringFrom(raw.title) ??
    stringFrom(raw.id) ??
    stringFrom(manifest.name) ??
    stringFrom(details.name) ??
    stringFrom(pluginInterface.name);
  if (!name) return null;

  return stripUndefined({
    name,
    path:
      stringFrom(raw.path) ??
      stringFrom(raw.uri) ??
      stringFrom(raw.pluginUri) ??
      stringFrom(raw.mentionPath) ??
      stringFrom(raw.installUri) ??
      stringFrom(manifest.path),
    description:
      stringFrom(raw.description) ??
      stringFrom(manifest.description) ??
      stringFrom(details.description) ??
      stringFrom(pluginInterface.description),
    installed: booleanFrom(raw.installed),
    enabled: booleanFrom(raw.enabled),
    source,
    marketplace:
      stringFrom(raw.marketplace) ??
      stringFrom(raw.marketplaceName) ??
      stringFrom(asRecord(raw.marketplaceEntry).marketplace),
    availability: stringFrom(raw.availability),
  }) as ListedPlugin;
}

function looksLikePlugin(raw: JsonRecord): boolean {
  return Boolean(
    stringFrom(raw.path)?.startsWith('plugin://') ||
    stringFrom(raw.uri)?.startsWith('plugin://') ||
    stringFrom(raw.pluginUri)?.startsWith('plugin://') ||
    stringFrom(raw.mentionPath)?.startsWith('plugin://') ||
    raw.manifest ||
    raw.interface ||
    raw.marketplaceEntry ||
    (raw.id && (raw.name || raw.displayName || raw.title))
  );
}

function uniquePlugins(plugins: ListedPlugin[]): ListedPlugin[] {
  const seen = new Set<string>();
  return plugins.filter((plugin) => {
    const key = `${plugin.name}\n${plugin.path ?? ''}\n${plugin.marketplace ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSkills(result: unknown, fallbackCwd: string): ListedSkill[] {
  const records = asArray(asRecord(result).data);
  return records.flatMap((record) => {
    const cwd = stringFrom(asRecord(record).cwd) ?? fallbackCwd;
    return asArray(asRecord(record).skills)
      .map((skill) => listedSkillFrom(skill, cwd))
      .filter((skill): skill is ListedSkill => Boolean(skill?.name));
  });
}

function listedSkillFrom(value: unknown, cwd: string): ListedSkill | null {
  const raw = asRecord(value);
  const source = asRecord(raw.source);
  const definition = asRecord(raw.definition);
  const path =
    stringFrom(raw.path) ??
    stringFrom(raw.skillPath) ??
    stringFrom(raw.file) ??
    stringFrom(raw.skillFile) ??
    stringFrom(source.path) ??
    stringFrom(definition.path);
  const name = stringFrom(raw.name);
  if (!name || !path) return null;
  return stripUndefined({
    name,
    path,
    description: stringFrom(raw.description),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    source: stringFrom(source.type),
    cwd,
  }) as ListedSkill;
}

function resolveSkillName(name: string, skills: ListedSkill[]): SkillReference | null {
  const exact = skills.find((skill) => skill.name === name && skill.enabled !== false);
  const fallback = skills.find(
    (skill) => skill.name.toLowerCase() === name.toLowerCase() && skill.enabled !== false
  );
  const skill = exact ?? fallback;
  return skill ? { name: skill.name, path: skill.path } : null;
}

function linkedSkillsFromPrompt(prompt: string): SkillReference[] {
  const links = /\[\$([a-z0-9][\w:-]*)\]\(([^)\s]+SKILL\.md)\)/gi;
  return [...prompt.matchAll(links)].map((match) => ({ name: match[1]!, path: match[2]! }));
}

function skillMarkersFromPrompt(prompt: string): string[] {
  const linked = new Set(linkedSkillsFromPrompt(prompt).map((skill) => skill.name));
  const markers = /(^|[^\w])\$([a-z0-9][\w:-]*)/gi;
  return [...prompt.matchAll(markers)]
    .map((match) => match[2]!)
    .filter((name) => !linked.has(name));
}

function uniqueSkills(skills: SkillReference[]): SkillReference[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.name}\n${skill.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function diffResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = WorkspaceRequestSchema.parse(input);
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const [status, unstagedStat, stagedStat, unstagedNames, stagedNames] = await Promise.all([
    runPlainCommand({
      command: 'git',
      args: ['status', '--short'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({ command: 'git', args: ['diff', '--stat'], cwd: root, env: process.env }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--cached', '--stat'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--name-only'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
    runPlainCommand({
      command: 'git',
      args: ['diff', '--cached', '--name-only'],
      cwd: root,
      env: gitHeadlessEnv(),
    }),
  ]);
  const statusFiles = parseStatusFiles(status.stdout);
  const files = uniqueStrings([
    ...unstagedNames.stdout.split(/\r?\n/).filter(Boolean),
    ...stagedNames.stdout.split(/\r?\n/).filter(Boolean),
    ...statusFiles,
  ]);
  const stat = [unstagedStat.stdout.trim(), stagedStat.stdout.trim()].filter(Boolean).join('\n');
  const ok = [status, unstagedStat, stagedStat, unstagedNames, stagedNames].every(
    (check) => check.exitCode === 0
  );

  return {
    ok,
    summary: stat || (files.length ? `${files.length} changed file(s).` : 'no diff.'),
    data: {
      stat,
      status: status.stdout,
      files,
      unstagedFiles: unstagedNames.stdout.split(/\r?\n/).filter(Boolean),
      stagedFiles: stagedNames.stdout.split(/\r?\n/).filter(Boolean),
      statusFiles,
    },
  };
}

export async function gitCheckResult(config: AgentConfig, input: unknown): Promise<ToolResult> {
  const args = GitCheckSchema.parse(input) satisfies GitCheck;
  const workspace = findWorkspace(config, args.workspaceAlias);
  const root = resolveWorkspaceRoot(workspace);
  const gitEnv = gitHeadlessEnv();
  const checks = Object.fromEntries(
    await Promise.all(
      [
        ['insideWorkTree', ['rev-parse', '--is-inside-work-tree']],
        ['topLevel', ['rev-parse', '--show-toplevel']],
        ['branch', ['branch', '--show-current']],
        ['statusShort', ['status', '--short']],
        ['remoteVerbose', ['remote', '-v']],
        ['pushRemote', ['remote', 'get-url', '--push', 'origin']],
        ['userName', ['config', '--get', 'user.name']],
        ['userEmail', ['config', '--get', 'user.email']],
        ['commitGpgSign', ['config', '--get', 'commit.gpgsign']],
        ['gpgFormat', ['config', '--get', 'gpg.format']],
        ['userSigningKey', ['config', '--get', 'user.signingkey']],
        ['credentialHelper', ['config', '--get', 'credential.helper']],
        ['coreSshCommand', ['config', '--get', 'core.sshCommand']],
      ].map(async ([name, gitArgs]) => [
        name,
        await runPlainCommand({
          command: 'git',
          args: gitArgs as string[],
          cwd: root,
          env: gitEnv,
          timeoutMs: 10_000,
        }),
      ])
    )
  );
  const sshAgent = await runPlainCommand({
    command: 'ssh-add',
    args: ['-l'],
    cwd: root,
    env: gitEnv,
    timeoutMs: 5_000,
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'ssh-add failed',
  }));
  const remoteAuth = args.checkRemote
    ? await runPlainCommand({
        command: 'git',
        args: ['ls-remote', '--heads', 'origin'],
        cwd: root,
        env: gitEnv,
        timeoutMs: 15_000,
      })
    : undefined;
  const issues = gitCheckIssues(checks, sshAgent, remoteAuth);

  return {
    ok: checkSucceeded(checks.insideWorkTree) && issues.length === 0,
    summary: issues.length
      ? `git check found ${issues.length} issue${issues.length === 1 ? '' : 's'} for commit/push.`
      : 'git check passed for local commit/push prerequisites.',
    data: stripUndefined({
      workspaceAlias: workspace.alias,
      root,
      checks: redactSecrets(checks),
      env: gitEnvSummary(gitEnv),
      sshAgent: redactSecrets(sshAgent),
      remoteAuth: remoteAuth ? redactSecrets(remoteAuth) : undefined,
      issues,
    }),
  };
}

function gitHeadlessEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function gitEnvSummary(env: NodeJS.ProcessEnv): JsonRecord {
  return {
    hasSshAuthSock: Boolean(env.SSH_AUTH_SOCK),
    hasGitAskpass: Boolean(env.GIT_ASKPASS),
    hasSshAskpass: Boolean(env.SSH_ASKPASS),
    hasGpgTty: Boolean(env.GPG_TTY),
    hasGhToken: Boolean(env.GH_TOKEN || env.GITHUB_TOKEN),
    gitTerminalPrompt: env.GIT_TERMINAL_PROMPT,
  };
}

function gitCheckIssues(
  checks: Record<string, { exitCode: number; stdout: string; stderr: string }>,
  sshAgent: { exitCode: number; stdout: string; stderr: string },
  remoteAuth: { exitCode: number; stdout: string; stderr: string } | undefined
): string[] {
  const issues: string[] = [];
  if (!checkSucceeded(checks.insideWorkTree)) issues.push('workspace is not a git repository');
  if (!checkHasOutput(checks.userName)) issues.push('git user.name is not configured');
  if (!checkHasOutput(checks.userEmail)) issues.push('git user.email is not configured');
  if (!checkHasOutput(checks.pushRemote))
    issues.push('git remote origin push URL is not configured');
  if (
    remoteNeedsSshAuth(checks.pushRemote?.stdout) &&
    sshAgent.exitCode !== 0 &&
    !process.env.GH_TOKEN &&
    !process.env.GITHUB_TOKEN
  )
    issues.push('no usable ssh-agent was visible to the Pokedex process');
  if (remoteAuth && remoteAuth.exitCode !== 0)
    issues.push('remote auth check failed in non-interactive mode');
  return issues;
}

function parseStatusFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.split(' -> ').pop() ?? line)
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function remoteNeedsSshAuth(remote: string | undefined): boolean {
  const value = remote?.trim() ?? '';
  return Boolean(value && (value.startsWith('git@') || value.startsWith('ssh://')));
}

function checkSucceeded(
  check: { exitCode: number; stdout: string; stderr: string } | undefined
): boolean {
  return Boolean(check && check.exitCode === 0);
}

function checkHasOutput(
  check: { exitCode: number; stdout: string; stderr: string } | undefined
): boolean {
  return Boolean(check && check.exitCode === 0 && check.stdout.trim());
}

export async function runPlainCommand(command: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timer: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 1);
    });
    if (command.timeoutMs) {
      timer = setTimeout(() => {
        stderr += `\ncommand timed out after ${command.timeoutMs}ms`;
        child.kill('SIGTERM');
      }, command.timeoutMs);
    }
  });

  return { exitCode, stdout, stderr };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractThreadId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const thread = asRecord(raw.thread);
  const paramsThread = asRecord(params.thread);
  return (
    stringFrom(raw.threadId) ??
    stringFrom(params.threadId) ??
    stringFrom(raw.id) ??
    stringFrom(thread.id) ??
    stringFrom(thread.threadId) ??
    stringFrom(paramsThread.id) ??
    stringFrom(paramsThread.threadId)
  );
}

function extractTurnId(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  return (
    stringFrom(raw.turnId) ??
    stringFrom(params.turnId) ??
    stringFrom(turn.id) ??
    stringFrom(turn.turnId) ??
    stringFrom(paramsTurn.id) ??
    stringFrom(paramsTurn.turnId)
  );
}

function extractFinalMessage(value: unknown): string {
  const raw = asRecord(value);
  const item = asRecord(raw.item);
  const params = asRecord(raw.params);
  const paramsItem = asRecord(params.item);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  const output = asRecord(raw.output);
  const paramsOutput = asRecord(params.output);
  return (
    stringFrom(raw.finalMessage) ??
    stringFrom(raw.finalResponse) ??
    stringFrom(raw.output_text) ??
    stringFrom(output.text) ??
    stringFrom(item.text) ??
    stringFrom(item.message) ??
    stringFrom(item.content) ??
    stringFrom(params.finalMessage) ??
    stringFrom(params.finalResponse) ??
    stringFrom(params.output_text) ??
    stringFrom(paramsOutput.text) ??
    stringFrom(params.text) ??
    stringFrom(paramsItem.text) ??
    stringFrom(paramsItem.message) ??
    stringFrom(paramsItem.content) ??
    stringFrom(turn.finalMessage) ??
    stringFrom(turn.finalResponse) ??
    stringFrom(paramsTurn.finalMessage) ??
    stringFrom(paramsTurn.finalResponse) ??
    ''
  );
}

function extractUsage(value: unknown): Usage | null {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  const item = asRecord(raw.item);
  const paramsItem = asRecord(params.item);
  const candidates = [
    raw,
    raw.usage,
    params,
    params.usage,
    turn,
    turn.usage,
    paramsTurn,
    paramsTurn.usage,
    item,
    item.usage,
    paramsItem,
    paramsItem.usage,
  ];
  for (const candidate of candidates) {
    const usage = parseUsage(candidate);
    if (usage) return usage;
  }
  return null;
}

function latestUsage(values: unknown[]): Usage | null {
  let latest: Usage | null = null;
  for (const value of values) {
    const usage = extractUsage(value);
    if (usage && usageTotal(usage) > 0) latest = usage;
  }
  return latest;
}

function terminalTurnResult(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined
): unknown | null {
  if (!isTerminalTurnEvent(value)) return null;
  const eventThreadId = extractThreadId(value);
  if (threadId && eventThreadId && eventThreadId !== threadId) return null;
  const eventTurnId = extractTurnId(value);
  if (turnId && eventTurnId && eventTurnId !== turnId) return null;
  return value;
}

function isTerminalTurnEvent(value: unknown): boolean {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const method = stringFrom(raw.method);
  const type = stringFrom(raw.type) ?? stringFrom(params.type);
  const status = turnStatus(value);
  return (
    method === 'turn/completed' ||
    method === 'turn/failed' ||
    type === 'turn.completed' ||
    type === 'turn.failed' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function turnNeedsTerminalWait(value: unknown): boolean {
  const usage = extractUsage(value);
  if (extractFinalMessage(value) || (usage && usageTotal(usage) > 0)) return false;
  const status = turnStatus(value);
  return (
    status === 'inProgress' ||
    status === 'in_progress' ||
    status === 'running' ||
    status === 'pending' ||
    status === 'queued'
  );
}

function turnStatus(value: unknown): string | undefined {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  return (
    stringFrom(raw.status) ??
    stringFrom(params.status) ??
    stringFrom(turn.status) ??
    stringFrom(paramsTurn.status)
  );
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanFrom(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length ? items : undefined;
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return 0;
}

function usageTotal(usage: Usage): number {
  return (
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningOutputTokens
  );
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
