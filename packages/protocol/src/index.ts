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
  userId: z.string().min(1),
  relayUrl: z.string().url(),
  relayToken: z.string().min(16),
  appServerCommand: z.string().min(1).default('codex'),
  appServerArgs: z.array(z.string()).default(['app-server', '--listen', 'stdio://']),
  defaultModel: z.string().default('gpt-5.5'),
  defaultReasoning: ReasoningEffortSchema.default('medium'),
  defaultVerbosity: VerbositySchema.default('medium'),
  defaultApprovalPolicy: ApprovalPolicySchema.default('on-request'),
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
});

export const ThreadIdSchema = z.object({
  threadId: z.string().min(1),
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

export type ThreadStart = z.infer<typeof ThreadStartSchema>;
export type TurnStart = z.infer<typeof TurnStartSchema>;
export type ThreadList = z.infer<typeof ThreadListSchema>;
export type GoalSet = z.infer<typeof GoalSetSchema>;
export type ReviewStart = z.infer<typeof ReviewStartSchema>;

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
    name: 'diff',
    level: 'adapter',
    reason: 'git diff is read locally from allowed workspaces',
    source: 'cli',
  },
];

export function toMcpText(result: ToolResult): string {
  return `${result.summary}\n\njson:\n${JSON.stringify(result, null, 2)}`;
}
