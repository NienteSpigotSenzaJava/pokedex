import { z } from 'zod';

export const sandboxModes = ['read_only', 'workspace_write', 'danger_full_access'] as const;
export const approvalPolicies = ['untrusted', 'on-request', 'never'] as const;
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const verbosityLevels = ['low', 'medium', 'high'] as const;
export const webSearchModes = ['cached', 'live', 'disabled'] as const;

export const SandboxModeSchema = z.enum(sandboxModes);
export const ApprovalPolicySchema = z.enum(approvalPolicies);
export const ReasoningEffortSchema = z.enum(reasoningEfforts);
export const VerbositySchema = z.enum(verbosityLevels);
export const WebSearchModeSchema = z.enum(webSearchModes);

export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type Verbosity = z.infer<typeof VerbositySchema>;
export type WebSearchMode = z.infer<typeof WebSearchModeSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningOutputTokens: z.number().int().nonnegative().default(0),
});

export const WorkspaceSchema = z.object({
  alias: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  root: z.string().min(1),
  description: z.string().optional(),
  allowWrite: z.boolean().default(false),
  allowFullAccess: z.boolean().default(false),
  defaultSandbox: SandboxModeSchema.default('read_only'),
});

export const AgentConfigSchema = z.object({
  userId: z.string().min(1).default('local'),
  relayUrl: z.string().url().default('ws://127.0.0.1:3000/agent'),
  relayToken: z.string().min(16),
  appServerCommand: z.string().min(1).default('codex'),
  appServerArgs: z.array(z.string()).default(['app-server', '--listen', 'stdio://']),
  defaultModel: z.string().default('gpt-5.5'),
  defaultReasoning: ReasoningEffortSchema.default('medium'),
  defaultVerbosity: VerbositySchema.default('medium'),
  defaultApprovalPolicy: ApprovalPolicySchema.default('never'),
  writeTasksEnabled: z.boolean().default(false),
  fullAccessEnabled: z.boolean().default(false),
  workspaces: z.array(WorkspaceSchema).min(1),
});

export type Usage = z.infer<typeof UsageSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const RuntimeSettingsSchema = z.object({
  model: z.string().optional(),
  profile: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  verbosity: VerbositySchema.optional(),
  sandbox: SandboxModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  webSearch: WebSearchModeSchema.optional(),
  imagePaths: z.array(z.string()).default([]),
  skillNames: z.array(z.string().min(1)).default([]),
  skills: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).default([]),
});

export const ThreadStartSchema = RuntimeSettingsSchema.extend({
  workspaceAlias: z.string().min(1),
  prompt: z.string().min(1),
  name: z.string().optional(),
});

export const TurnStartSchema = RuntimeSettingsSchema.extend({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
  workspaceAlias: z.string().optional(),
});

export const ThreadIdSchema = z.object({
  threadId: z.string().min(1),
});

export const ApprovalTargetSchema = z.object({
  approvalId: z.string().min(1).optional(),
});

export const ApprovalApproveSchema = ApprovalTargetSchema.extend({
  forSession: z.boolean().default(false),
});

export const ThreadReadSchema = ThreadIdSchema.extend({
  includeTurns: z.boolean().default(true),
});

export const ThreadListSchema = z.object({
  workspaceAlias: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  searchTerm: z.string().optional(),
  archived: z.boolean().optional(),
});

export const GoalSetSchema = ThreadIdSchema.extend({
  goal: z.string().min(1),
});

export const ReviewStartSchema = RuntimeSettingsSchema.extend({
  workspaceAlias: z.string().min(1),
  threadId: z.string().optional(),
  prompt: z.string().default('review current changes'),
});

export const WorkspaceRequestSchema = z.object({
  workspaceAlias: z.string().min(1),
});

export const SkillListSchema = z.object({
  workspaceAlias: z.string().optional(),
  forceReload: z.boolean().default(false),
});

export type ThreadStart = z.infer<typeof ThreadStartSchema>;
export type TurnStart = z.infer<typeof TurnStartSchema>;
export type ThreadList = z.infer<typeof ThreadListSchema>;
export type GoalSet = z.infer<typeof GoalSetSchema>;
export type ReviewStart = z.infer<typeof ReviewStartSchema>;
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ApprovalApprove = z.infer<typeof ApprovalApproveSchema>;
export type SkillList = z.infer<typeof SkillListSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export const AgentRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export const AgentResponseSchema = z.object({
  id: z.string(),
  result: ToolResultSchema.optional(),
  error: z.string().optional(),
});

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const mcpToolNames = [
  'pokedex_setup_check',
  'pokedex_list_workspaces',
  'pokedex_list_tasks',
  'pokedex_list_sessions',
  'pokedex_list_threads',
  'pokedex_list_skills',
  'pokedex_start_task',
  'pokedex_start_thread',
  'pokedex_continue_task',
  'pokedex_send_turn',
  'pokedex_resume_task',
  'pokedex_resume_thread',
  'pokedex_read_thread',
  'pokedex_fork_thread',
  'pokedex_set_goal',
  'pokedex_clear_goal',
  'pokedex_review',
  'pokedex_interrupt',
  'pokedex_list_approvals',
  'pokedex_approve',
  'pokedex_decline',
  'pokedex_cancel_approval',
  'pokedex_get_diff',
  'pokedex_get_usage',
] as const;

export type McpToolName = (typeof mcpToolNames)[number];

export type Capability = {
  name: string;
  level: 'stable' | 'adapter';
  reason: string;
  source: 'app_server' | 'cli' | 'relay' | 'local_config';
};

export const stableCapabilities: Capability[] = [
  {
    name: 'native_threads',
    level: 'stable',
    reason: 'uses codex app-server thread APIs',
    source: 'app_server',
  },
  {
    name: 'resume',
    level: 'stable',
    reason: 'thread/resume appends turns to stored local codex threads',
    source: 'app_server',
  },
  {
    name: 'fork',
    level: 'stable',
    reason: 'thread/fork copies stored local thread history',
    source: 'app_server',
  },
  {
    name: 'goals',
    level: 'stable',
    reason: 'thread/goal methods are exposed by app-server',
    source: 'app_server',
  },
  {
    name: 'review',
    level: 'stable',
    reason: 'review/start runs codex reviewer on a native thread',
    source: 'app_server',
  },
  {
    name: 'approvals',
    level: 'stable',
    reason: 'app-server approval requests can be listed and answered from poke',
    source: 'app_server',
  },
  {
    name: 'skills',
    level: 'stable',
    reason: 'app-server skills/list exposes local codex and agents skills',
    source: 'app_server',
  },
  {
    name: 'diff',
    level: 'adapter',
    reason: 'git diff is read locally from allowed workspaces',
    source: 'cli',
  },
];

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export function stripJsonc(text: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      } else output += ' ';
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else output += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }

    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }

    output += char;
  }

  return removeTrailingCommas(output);
}

function removeTrailingCommas(text: string): string {
  let output = '';
  let quote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';

    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] ?? '')) nextIndex += 1;
      if (['}', ']'].includes(text[nextIndex] ?? '')) continue;
    }

    output += char;
  }

  return output;
}

export function toMcpText(result: ToolResult): string {
  return `${result.summary}\n\njson:\n${JSON.stringify(result, null, 2)}`;
}
