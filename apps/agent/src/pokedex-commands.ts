import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import {
  AgentConfigSchema,
  PokedexCommandSchema,
  RuntimeSettingsSchema,
  codexHistoryGuidance,
  codexPromptGuidance,
  parseJsonc,
  pokeResponseGuidance,
  pokedexRepositoryUrl,
  supportedPokedexCommands,
  terminalOnlyPokedexCommands,
  type AgentConfig,
  type PokedexCommand,
  type ToolResult,
} from '@pokedex/protocol';
import { buildSettings } from '@pokedex/codex-runner';

export function listWorkspaces(config: AgentConfig): ToolResult {
  return {
    ok: true,
    summary: 'configured workspaces loaded. access is the effective workspace access label.',
    data: {
      pokedexCommandsEnabled: config.pokedexCommandsEnabled,
      pokedexRepositoryUrl,
      codexHistory: { nativeThreads: true, persistent: true, guidance: codexHistoryGuidance },
      runtimeDefaults: runtimeDefaults(config),
      commandSurface: pokedexCommandSurface(),
      assistantGuidance: assistantGuidance(),
      workspaces: config.workspaces.map((workspace) => ({
        alias: workspace.alias,
        description: workspace.description,
        access: workspaceAccess(config, workspace),
        defaultSettings: buildSettings(config, workspace, RuntimeSettingsSchema.parse({})),
      })),
    },
  };
}

export function pokedexCommandResult(
  config: AgentConfig,
  input: unknown,
  configPath: string
): ToolResult {
  if (!config.pokedexCommandsEnabled) {
    return {
      ok: false,
      summary:
        'Pokedex prompt commands are disabled. The user can type `shell on` in the Pokedex terminal to let Poke change Pokedex settings.',
      data: {
        enabled: false,
        nextAction: 'ask the user to enable Pokedex prompt commands first',
        commandSurface: pokedexCommandSurface(),
        assistantGuidance: assistantGuidance(),
      },
    };
  }

  const args = PokedexCommandSchema.parse(input) satisfies PokedexCommand;
  const [name, subcommand, ...rest] = splitCommand(args.command.trim());
  if (!name || name === 'status') return pokedexStatusResult(config);
  if (name === 'help') return pokedexHelpResult();
  if (name === 'shell')
    return savePokedexCommand(config, configPath, args.command, () =>
      setPokedexEnabled(config, subcommand)
    );
  if (name === 'write' || name === 'full-access')
    throw new Error('use `ws perms <alias> read-only|write|full-access` instead');
  if (name === 'ws')
    return savePokedexCommand(config, configPath, args.command, () =>
      handleWorkspaceCommand(config, subcommand, rest)
    );
  if (name === 'model')
    return savePokedexCommand(config, configPath, args.command, () =>
      setScalar(config, 'defaultModel', subcommand, 'model <name>')
    );
  if (name === 'reasoning')
    return savePokedexCommand(config, configPath, args.command, () =>
      setEnum(config, 'defaultReasoning', subcommand, ['minimal', 'low', 'medium', 'high', 'xhigh'])
    );
  if (name === 'verbosity')
    return savePokedexCommand(config, configPath, args.command, () =>
      setEnum(config, 'defaultVerbosity', subcommand, ['low', 'medium', 'high'])
    );
  if (name === 'approval')
    return savePokedexCommand(config, configPath, args.command, () =>
      setEnum(config, 'defaultApprovalPolicy', subcommand, ['untrusted', 'on-request', 'never'])
    );

  if (['restart', 'quit', 'port', 'token', 'logs'].includes(name)) {
    return {
      ok: false,
      summary: `\`${name}\` is a terminal-only Pokedex command. The user must type it in the Pokedex terminal.`,
      data: { command: args.command, terminalOnly: true },
    };
  }

  throw new Error(`unknown Pokedex command: ${name}`);
}

function runtimeDefaults(config: AgentConfig): Record<string, unknown> {
  return {
    model: config.defaultModel,
    reasoningEffort: config.defaultReasoning,
    verbosity: config.defaultVerbosity,
    approvalPolicy: config.defaultApprovalPolicy,
    writeTasksEnabled: config.writeTasksEnabled,
    fullAccessEnabled: config.fullAccessEnabled,
    pokedexCommandsEnabled: config.pokedexCommandsEnabled,
  };
}

function workspaceAccess(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number]
): string {
  if (config.fullAccessEnabled && workspace.allowFullAccess) return 'full-access';
  if (config.writeTasksEnabled && workspace.allowWrite) return 'write';
  return 'read-only';
}

function pokedexCommandSurface(): Record<string, unknown> {
  return {
    supported: supportedPokedexCommands,
    terminalOnly: terminalOnlyPokedexCommands,
    spellingRule: 'only the supported command strings are valid; every other spelling is invalid',
  };
}

function assistantGuidance(): Record<string, unknown> {
  return {
    prompt: codexPromptGuidance,
    response: pokeResponseGuidance,
  };
}

function savePokedexCommand(
  config: AgentConfig,
  configPath: string,
  command: string,
  mutate: () => string | ToolResult
): ToolResult {
  const summary = mutate();
  if (typeof summary !== 'string') return summary;
  saveAgentConfig(configPath, config);
  return {
    ok: true,
    summary,
    data: { command, config: redactAgentConfig(config) },
  };
}

function pokedexStatusResult(config: AgentConfig): ToolResult {
  return {
    ok: true,
    summary: 'Pokedex status loaded from saved config.',
    data: {
      relayUrl: config.relayUrl,
      activeWorkspace: workspaceSummary(config, config.workspaces[0]),
      pokedexCommandsEnabled: config.pokedexCommandsEnabled,
      workspaces: config.workspaces.map((workspace) => workspaceSummary(config, workspace)),
      pokedexRepositoryUrl,
      codexHistory: { nativeThreads: true, persistent: true, guidance: codexHistoryGuidance },
      commandSurface: pokedexCommandSurface(),
      assistantGuidance: assistantGuidance(),
    },
  };
}

function pokedexHelpResult(): ToolResult {
  return {
    ok: true,
    summary: 'Supported Pokedex commands loaded.',
    data: {
      commands: supportedPokedexCommands,
      ...pokedexCommandSurface(),
      assistantGuidance: assistantGuidance(),
    },
  };
}

function handleWorkspaceCommand(
  config: AgentConfig,
  subcommand: string | undefined,
  rest: string[]
): string | ToolResult {
  if (subcommand === 'list' || !subcommand)
    return {
      ok: true,
      summary: 'Pokedex workspaces loaded.',
      data: { workspaces: config.workspaces },
    };
  if (subcommand === 'add') return addWorkspace(config, rest);
  if (subcommand === 'rm') return removeWorkspace(config, rest[0]);
  if (subcommand === 'use') return useWorkspace(config, rest[0]);
  if (subcommand === 'desc') return describeWorkspace(config, rest[0], rest.slice(1).join(' '));
  if (subcommand === 'perms') return setWorkspacePermissions(config, rest[0], rest[1]);
  if (subcommand === 'write' || subcommand === 'full-access')
    throw new Error('use `ws perms <alias> read-only|write|full-access` instead');
  throw new Error('ws commands: list, add, rm, use, desc, perms');
}

function addWorkspace(config: AgentConfig, parts: string[]): string {
  const [alias, root, ...description] = parts;
  assertAlias(alias);
  if (!root) throw new Error('usage: ws add <alias> <absolute-path> [description]');
  upsertWorkspace(config.workspaces, {
    alias,
    root: resolveConfigPath(root),
    description: description.join(' ') || `${alias} workspace`,
    allowWrite: config.writeTasksEnabled,
    allowFullAccess: config.fullAccessEnabled,
    defaultSandbox: sandboxFor(config.writeTasksEnabled, config.fullAccessEnabled),
  });
  return `workspace ${alias} saved.`;
}

function removeWorkspace(config: AgentConfig, alias: string | undefined): string {
  assertAlias(alias);
  if (config.workspaces.length === 1) throw new Error('cannot remove the last workspace');
  findConfiguredWorkspace(config, alias);
  config.workspaces = config.workspaces.filter((workspace) => workspace.alias !== alias);
  syncGlobalAccessGates(config);
  return `workspace ${alias} removed.`;
}

function useWorkspace(config: AgentConfig, alias: string | undefined): string {
  assertAlias(alias);
  const workspace = findConfiguredWorkspace(config, alias);
  config.workspaces = [workspace, ...config.workspaces.filter((item) => item.alias !== alias)];
  return `active workspace ${alias}.`;
}

function describeWorkspace(
  config: AgentConfig,
  alias: string | undefined,
  description: string
): string {
  assertAlias(alias);
  if (!description) throw new Error('usage: ws desc <alias> <description>');
  findConfiguredWorkspace(config, alias).description = description;
  return `workspace ${alias} described.`;
}

function setWorkspacePermissions(
  config: AgentConfig,
  alias: string | undefined,
  raw: string | undefined
): string {
  if (!alias || !raw) throw new Error('usage: ws perms <alias> read-only|write|full-access');
  const workspace = findConfiguredWorkspace(config, alias);
  const mode = parseWorkspacePermission(raw);
  workspace.allowWrite = mode !== 'read-only';
  workspace.allowFullAccess = mode === 'full-access';
  syncWorkspaceSandbox(workspace);
  syncGlobalAccessGates(config);
  return `workspace ${workspace.alias} permissions set to ${mode}.`;
}

function setPokedexEnabled(config: AgentConfig, raw: string | undefined): string {
  config.pokedexCommandsEnabled = parseOnOff(raw, 'shell <on|off>');
  return `Pokedex prompt commands ${config.pokedexCommandsEnabled ? 'enabled' : 'disabled'}.`;
}

function setScalar(
  config: AgentConfig,
  key: 'defaultModel',
  value: string | undefined,
  usage: string
): string {
  if (!value) throw new Error(`usage: ${usage}`);
  config[key] = value;
  return `${key} set to ${value}.`;
}

function setEnum<T extends 'defaultReasoning' | 'defaultVerbosity' | 'defaultApprovalPolicy'>(
  config: AgentConfig,
  key: T,
  value: string | undefined,
  allowed: readonly AgentConfig[T][]
): string {
  const parsed = value as AgentConfig[T] | undefined;
  if (!parsed || !allowed.includes(parsed))
    throw new Error(`allowed values: ${allowed.join(', ')}`);
  config[key] = parsed;
  return `${key} set to ${parsed}.`;
}

function upsertWorkspace(
  workspaces: AgentConfig['workspaces'],
  workspace: AgentConfig['workspaces'][number]
): void {
  const index = workspaces.findIndex((item) => item.alias === workspace.alias);
  if (index === -1) workspaces.unshift(workspace);
  else workspaces[index] = { ...workspaces[index], ...workspace };
}

function findConfiguredWorkspace(
  config: AgentConfig,
  alias: string | undefined
): AgentConfig['workspaces'][number] {
  assertAlias(alias);
  const workspace = config.workspaces.find((item) => item.alias === alias);
  if (!workspace) throw new Error(`unknown workspace: ${alias}`);
  return workspace;
}

function workspaceSummary(
  config: AgentConfig,
  workspace: AgentConfig['workspaces'][number] | undefined
): Record<string, unknown> | undefined {
  return workspace
    ? {
        alias: workspace.alias,
        root: workspace.root,
        description: workspace.description,
        access: workspaceAccess(config, workspace),
      }
    : undefined;
}

function syncWorkspaceSandbox(workspace: AgentConfig['workspaces'][number]): void {
  workspace.defaultSandbox = sandboxFor(workspace.allowWrite, workspace.allowFullAccess);
}

function syncGlobalAccessGates(config: AgentConfig): void {
  config.fullAccessEnabled = config.workspaces.some((workspace) => workspace.allowFullAccess);
  config.writeTasksEnabled =
    config.fullAccessEnabled || config.workspaces.some((workspace) => workspace.allowWrite);
}

function sandboxFor(
  writeEnabled: boolean,
  fullAccess: boolean
): AgentConfig['workspaces'][number]['defaultSandbox'] {
  if (fullAccess) return 'danger_full_access';
  if (writeEnabled) return 'workspace_write';
  return 'read_only';
}

function parseOnOff(raw: string | undefined, usage: string): boolean {
  if (!raw) throw new Error(`usage: ${usage}`);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error('use on or off');
}

function parseWorkspacePermission(raw: string | undefined): 'read-only' | 'write' | 'full-access' {
  const value = raw?.toLowerCase().replace(/_/g, '-');
  if (!value) throw new Error('usage: ws perms <alias> read-only|write|full-access');
  if (['read-only', 'write', 'full-access'].includes(value))
    return value as 'read-only' | 'write' | 'full-access';
  throw new Error('allowed permissions: read-only, write, full-access');
}

function assertAlias(alias: string | undefined): asserts alias is string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(alias ?? ''))
    throw new Error('alias must match /^[a-z0-9][a-z0-9_-]{0,63}$/i');
}

function resolveConfigPath(path: string): string {
  const expanded =
    path === '~'
      ? homedir()
      : path.startsWith('~/') || path.startsWith('~\\')
        ? join(homedir(), path.slice(2))
        : path;
  if (!isAbsolute(expanded)) throw new Error('workspace paths changed by Poke must be absolute');
  return normalize(expanded);
}

function saveAgentConfig(configPath: string, config: AgentConfig): void {
  const existing = existsSync(configPath)
    ? asRecord(parseJsonc(readFileSync(configPath, 'utf8')))
    : {};
  writeFileSync(
    configPath,
    `${JSON.stringify(AgentConfigSchema.parse({ ...existing, ...config }), null, 2)}\n`
  );
}

function redactAgentConfig(config: AgentConfig): Record<string, unknown> {
  return {
    ...config,
    relayToken: config.relayToken ? `${config.relayToken.slice(0, 6)}...` : '',
  };
}

function splitCommand(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
