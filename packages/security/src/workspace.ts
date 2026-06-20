import { isAbsolute, normalize } from 'node:path';
import type { AgentConfig, SandboxMode, Workspace } from '@pokedex/protocol';
import { SecurityError } from './errors.js';

export function findWorkspace(config: AgentConfig, alias: string): Workspace {
  const workspace = config.workspaces.find((item) => item.alias === alias);
  if (!workspace) throw new SecurityError(`unknown workspace alias: ${alias}`);
  return workspace;
}

export function resolveWorkspaceRoot(workspace: Workspace): string {
  if (!isAbsolute(workspace.root)) {
    throw new SecurityError(`workspace ${workspace.alias} root must be absolute`);
  }
  return normalize(workspace.root);
}

export function assertSandboxAllowed(
  config: AgentConfig,
  workspace: Workspace,
  requested: SandboxMode
): SandboxMode {
  if (
    requested === 'danger_full_access' &&
    (!config.fullAccessEnabled || !workspace.allowFullAccess)
  ) {
    throw new SecurityError('danger_full_access is disabled for this agent or workspace');
  }

  if (requested === 'workspace_write' && (!config.writeTasksEnabled || !workspace.allowWrite)) {
    throw new SecurityError('workspace_write is disabled for this agent or workspace');
  }

  return requested;
}
