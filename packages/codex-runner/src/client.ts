import type {
  ApprovalApprove,
  ApprovalTarget,
  AgentConfig,
  GoalSet,
  PluginList,
  ReviewStart,
  RuntimeSettingsSchema,
  SkillList,
  ToolResult,
  Workspace,
} from '@pokedex/protocol';
import {
  ApprovalApproveSchema,
  ApprovalTargetSchema,
  GoalSetSchema,
  PluginListSchema,
  ReviewStartSchema,
  SkillListSchema,
  ThreadIdSchema,
  ThreadListSchema,
  ThreadReadSchema,
  ThreadStartSchema,
  TurnStartSchema,
  UsageSchema,
  stableCapabilities,
} from '@pokedex/protocol';
import { findWorkspace, redactSecrets, resolveWorkspaceRoot } from '@pokedex/security';
import {
  type ApprovalDecision,
  ApprovalStore,
  type PendingApproval,
  approvalMatchesThread,
  approvalWaitMessage,
  publicApproval,
} from './approvals.js';
import {
  extractErrorMessage,
  extractEventName,
  extractEventThreadId,
  extractFinalMessage,
  extractProgressMessage,
  extractRateLimits,
  extractThreadId,
  extractTurnId,
  terminalTurnResult,
  throwIfFailedTurn,
  turnNeedsTerminalWait,
  turnStatus,
} from './events.js';
import { setupCheckResult } from './local.js';
import { normalizePlugins, uniquePlugins } from './plugins.js';
import { buildSettings } from './settings.js';
import {
  type SkillReference,
  defaultSkillRoots,
  linkedSkillsFromPrompt,
  normalizeSkills,
  resolveSkillName,
  skillMarkersFromPrompt,
  uniqueSkills,
} from './skills.js';
import { AppServerTransport } from './transport.js';
import type { AppServerEvent, JsonRecord, RunnerProgress, RunnerResult } from './types.js';
import { extractUsage, latestUsage } from './usage.js';
import { asRecord, isRpcId, stringFrom, stripUndefined } from './utils.js';

type RuntimeSettings = ReturnType<typeof RuntimeSettingsSchema.parse>;
type OptionalEndpointResult = {
  method: string;
  result?: unknown;
  error?: string;
};

const turnCompletionTimeoutMs = 570_000;

export function capabilitiesResult(): ToolResult {
  return {
    ok: true,
    summary: 'pokedex uses native codex app-server threads for local sync.',
    data: { capabilities: stableCapabilities },
  };
}

export class CodexAppServerClient {
  private readonly transport = new AppServerTransport();
  private readonly approvals = new ApprovalStore();
  private readonly threadCwds = new Map<string, string>();

  constructor() {
    this.transport.onEvent((event) => this.approvals.handleEvent(event));
  }

  onEvent(listener: (event: AppServerEvent) => void): () => void {
    return this.transport.onEvent(listener);
  }

  async setupCheck(config: AgentConfig): Promise<ToolResult> {
    return await setupCheckResult(config);
  }

  async warm(config: AgentConfig): Promise<void> {
    await this.transport.warm(config);
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
    this.rememberThreadCwdsFromResult(config, result);
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
    let off = this.collect(events, onProgress);

    try {
      const started = await this.request(
        config,
        'thread/start',
        stripUndefined({ cwd, name: task.name, ephemeral: false, settings })
      );
      const threadId = extractThreadId(started);
      if (!threadId) throw new Error('codex app-server did not return a thread id');
      this.threadCwds.set(threadId, cwd);
      off();
      off = () => {};
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
    const workspace = this.workspaceForTurn(config, task.threadId, task.workspaceAlias);
    const cwd = resolveWorkspaceRoot(workspace);
    const skills = await this.resolveTurnSkills(config, cwd, task);
    const settings = buildSettings(config, workspace, task);
    const events: unknown[] = [];
    const off = this.collect(events, onProgress, task.threadId);

    try {
      const outcome = await this.requestWithApprovalYield(
        config,
        'turn/start',
        {
          threadId: task.threadId,
          cwd,
          input: [
            ...skills.map(({ name, path }) => ({ type: 'skill', name, path })),
            { type: 'text', text: task.prompt },
          ],
          settings,
        },
        task.threadId
      );

      if (outcome.approval) {
        return {
          threadId: task.threadId,
          finalMessage: approvalWaitMessage(outcome.approval),
          usage: UsageSchema.parse({}),
          events,
          cwd,
          workspaceAlias: workspace.alias,
          settings,
        };
      }

      const result = outcome.result;
      throwIfFailedTurn(result);

      return {
        threadId: task.threadId,
        finalMessage: extractFinalMessage(result) || 'turn started.',
        usage: latestUsage([...events, result]) ?? UsageSchema.parse({}),
        events,
        cwd,
        workspaceAlias: workspace.alias,
        settings,
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
    const workspace = this.workspaceForTurn(config, task.threadId, task.workspaceAlias);
    await this.request(config, 'thread/resume', { threadId: task.threadId });
    return this.startTurn(config, { ...task, workspaceAlias: workspace.alias }, onProgress);
  }

  async readThread(config: AgentConfig, input: unknown): Promise<ToolResult> {
    const args = ThreadReadSchema.parse(input);
    const result = await this.request(config, 'thread/read', args);
    this.rememberThreadCwdsFromResult(config, result);
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
      throwIfFailedTurn(result);
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
    const approvals = this.approvals.list();
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
    return await this.transport.request(config, method, params, timeoutMs);
  }

  stop(): void {
    this.approvals.clear();
    this.transport.stop();
  }

  async close(timeoutMs = 2_000): Promise<void> {
    this.approvals.clear();
    await this.transport.close(timeoutMs);
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
      const existing = this.approvals.findForThread(threadId);
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

  private collect(
    events: unknown[],
    onProgress?: (progress: RunnerProgress) => void,
    threadId?: string
  ): () => void {
    return this.onEvent((event) => {
      const redacted = redactSecrets(event.raw);
      events.push(redacted);
      const progress: RunnerProgress = { event: redacted };
      const eventName = event.method ?? extractEventName(redacted);
      if (eventName) progress.eventName = eventName;
      if (threadId) progress.threadId = threadId;
      const eventThreadId = extractEventThreadId(redacted);
      if (eventThreadId) progress.threadId = eventThreadId;
      const turnId = extractTurnId(redacted);
      if (turnId) progress.turnId = turnId;
      const status = turnStatus(redacted);
      if (status) progress.status = status;
      const message = extractProgressMessage(redacted);
      if (message) progress.message = message;
      const error = extractErrorMessage(redacted);
      if (error) progress.error = error;
      const finalMessage = extractFinalMessage(redacted);
      if (finalMessage) progress.finalMessage = finalMessage;
      const rateLimits = extractRateLimits(redacted);
      if (rateLimits) progress.rateLimits = rateLimits;
      const usage = extractUsage(redacted);
      if (usage) progress.usage = usage;
      onProgress?.(progress);
    });
  }

  private workspaceForTurn(
    config: AgentConfig,
    threadId: string,
    workspaceAlias: string | undefined
  ): Workspace {
    if (workspaceAlias) {
      const workspace = findWorkspace(config, workspaceAlias);
      this.threadCwds.set(threadId, resolveWorkspaceRoot(workspace));
      return workspace;
    }

    const cached = this.threadCwds.get(threadId);
    if (cached) {
      const workspace = config.workspaces.find((item) => resolveWorkspaceRoot(item) === cached);
      if (workspace) return workspace;
    }

    if (config.workspaces.length === 1) {
      const workspace = config.workspaces[0]!;
      this.threadCwds.set(threadId, resolveWorkspaceRoot(workspace));
      return workspace;
    }

    throw new Error(
      `workspaceAlias is required for thread ${threadId} because Pokedex has multiple workspaces and does not know which one this thread belongs to after reconnect. call pokedex_list_threads or pokedex_read_thread, then retry with the matching workspaceAlias.`
    );
  }

  private rememberThreadCwdsFromResult(config: AgentConfig, result: unknown): void {
    for (const thread of threadRecords(result)) {
      const id = stringFrom(thread.id);
      if (!id) continue;
      const root = mentionedWorkspaceRoot(config, thread);
      if (root) this.threadCwds.set(id, root);
    }
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
    const approval = this.approvals.find(approvalId);
    if (!approval) {
      const approvals = this.approvals.list();
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

    this.transport.sendResponse(approval.requestId, decision);
    this.approvals.delete(approval.approvalId);
    return {
      ok: true,
      summary: `codex approval ${decision} sent.`,
      data: { approval: redactSecrets(publicApproval(approval)), decision },
    };
  }

  private approvalFromEvent(event: AppServerEvent): PendingApproval | null {
    const requestId = asRecord(event.raw).id;
    return isRpcId(requestId) ? this.approvals.findByRequestId(requestId) : null;
  }
}

function threadRecords(value: unknown, depth = 0): JsonRecord[] {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => threadRecords(item, depth + 1));
  const raw = asRecord(value);
  const nested = Object.values(raw).flatMap((item) => threadRecords(item, depth + 1));
  return looksLikeThread(raw) ? [raw, ...nested] : nested;
}

function looksLikeThread(record: JsonRecord): boolean {
  return Boolean(
    stringFrom(record.id) &&
    ('turns' in record ||
      'preview' in record ||
      'createdAt' in record ||
      'path' in record ||
      'status' in record)
  );
}

function mentionedWorkspaceRoot(config: AgentConfig, record: JsonRecord): string | undefined {
  return config.workspaces
    .map((workspace) => resolveWorkspaceRoot(workspace))
    .find((root) => valueMentions(record, root));
}

function valueMentions(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => valueMentions(item, needle, depth + 1));
  const raw = asRecord(value);
  return Object.values(raw).some((item) => valueMentions(item, needle, depth + 1));
}
