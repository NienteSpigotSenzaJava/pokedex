export const sandboxModes = ['read_only', 'workspace_write', 'danger_full_access'] as const;
export const approvalPolicies = ['untrusted', 'on-request', 'never'] as const;
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const verbosityLevels = ['low', 'medium', 'high'] as const;
export const webSearchModes = ['cached', 'live', 'disabled'] as const;
export const defaultRelayPort = 4200;
export const pokedexRepositoryUrl = 'https://github.com/NienteSpigotSenzaJava/pokedex';

// this grammar is shared by the cli, agent, relay tools, and docs so prompt command spelling stays canonical.
export const supportedPokedexCommands = [
  'status',
  'help',
  'shell <on|off>',
  'ws list',
  'ws add <alias> <absolute-path> [description]',
  'ws rm <alias>',
  'ws use <alias>',
  'ws desc <alias> <description>',
  'ws perms <alias> read-only|write|full-access',
  'model <name>',
  'reasoning minimal|low|medium|high|xhigh',
  'verbosity low|medium|high',
  'approval untrusted|on-request|never',
] as const;

export const terminalOnlyPokedexCommands = [
  'logs [relay|agent|poke]',
  'port <number>',
  'token rotate',
  'restart',
  'quit',
] as const;

export const codexPromptGuidance =
  "Pass Codex only a faithful rewrite of the user's request. Do not add files, paths, branches, remotes, commands, commit messages, tests, or implementation targets unless the user named them or a verified Pokedex/Codex result makes them required for a follow-up.";
export const pokeResponseGuidance =
  'Use Pokedex tool results as the current state source. For recovery, use only nextAction values, supported command strings, operation ids, approval ids, and thread ids returned by Pokedex.';
export const codexHistoryGuidance =
  'Pokedex uses non-ephemeral native Codex app-server threads. Codex desktop/IDE can read persisted thread history, but it is not a live subscriber and may need refresh or resume.';
