import { z } from 'zod';
import {
  approvalPolicies,
  defaultRelayPort,
  reasoningEfforts,
  sandboxModes,
  verbosityLevels,
  webSearchModes,
} from './constants.js';

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
  relayUrl: z.string().url().default(`ws://127.0.0.1:${defaultRelayPort}/agent`),
  relayToken: z.string().min(16),
  appServerCommand: z.string().min(1).default('codex'),
  appServerArgs: z.array(z.string()).default(['app-server', '--listen', 'stdio://']),
  defaultModel: z.string().default('gpt-5.5'),
  defaultReasoning: ReasoningEffortSchema.default('medium'),
  defaultVerbosity: VerbositySchema.default('medium'),
  defaultApprovalPolicy: ApprovalPolicySchema.default('never'),
  writeTasksEnabled: z.boolean().default(false),
  fullAccessEnabled: z.boolean().default(false),
  pokedexCommandsEnabled: z.boolean().default(false),
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

export const GitCheckSchema = WorkspaceRequestSchema.extend({
  checkRemote: z.boolean().default(false),
});

export const GitCommitSchema = WorkspaceRequestSchema.extend({
  message: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).default([]),
  stage: z.enum(['staged', 'files', 'tracked', 'all']).optional(),
});

export const GitPushSchema = WorkspaceRequestSchema.extend({
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  setUpstream: z.boolean().default(false),
});

export const GitCommitPushSchema = GitCommitSchema.merge(
  GitPushSchema.omit({ workspaceAlias: true })
);

export const PokedexCommandSchema = z.object({
  command: z.string().min(1),
});

export const SkillListSchema = z.object({
  workspaceAlias: z.string().optional(),
  forceReload: z.boolean().default(false),
});

export const PluginListSchema = z.object({
  includeMarketplace: z.boolean().default(true),
});

export type ThreadStart = z.infer<typeof ThreadStartSchema>;
export type TurnStart = z.infer<typeof TurnStartSchema>;
export type ThreadList = z.infer<typeof ThreadListSchema>;
export type GoalSet = z.infer<typeof GoalSetSchema>;
export type ReviewStart = z.infer<typeof ReviewStartSchema>;
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ApprovalApprove = z.infer<typeof ApprovalApproveSchema>;
export type SkillList = z.infer<typeof SkillListSchema>;
export type PluginList = z.infer<typeof PluginListSchema>;
export type GitCheck = z.infer<typeof GitCheckSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type GitPush = z.infer<typeof GitPushSchema>;
export type GitCommitPush = z.infer<typeof GitCommitPushSchema>;
export type PokedexCommand = z.infer<typeof PokedexCommandSchema>;

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
