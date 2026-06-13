import type { AgentConfig, RuntimeSettingsSchema, Workspace } from '@pokedex/protocol';
import { assertSandboxAllowed } from '@pokedex/security';
import type { JsonRecord } from './types.js';
import { stripUndefined } from './utils.js';

type RuntimeSettings = ReturnType<typeof RuntimeSettingsSchema.parse>;

export function mapSandboxForAppServer(mode: string): string {
  if (mode === 'workspace_write') return 'workspace-write';
  if (mode === 'danger_full_access') return 'danger-full-access';
  return 'read-only';
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
