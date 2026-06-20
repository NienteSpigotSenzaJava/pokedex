export const mcpToolNames = [
  'pokedex_setup_check',
  'pokedex_list_workspaces',
  'pokedex_list_tasks',
  'pokedex_list_sessions',
  'pokedex_list_threads',
  'pokedex_list_skills',
  'pokedex_list_plugins',
  'pokedex_list_operations',
  'pokedex_read_operation',
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
  'pokedex_git_check',
  'pokedex_git_commit',
  'pokedex_git_push',
  'pokedex_git_commit_push',
  'pokedex_get_usage',
  'pokedex_command',
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
    name: 'plugins',
    level: 'adapter',
    reason: 'app-server plugin/list and plugin/installed expose codex plugins when available',
    source: 'app_server',
  },
  {
    name: 'operations',
    level: 'stable',
    reason: 'long-running codex turns are tracked asynchronously to avoid mcp timeouts',
    source: 'app_server',
  },
  {
    name: 'diff',
    level: 'adapter',
    reason: 'git diff is read locally from allowed workspaces',
    source: 'cli',
  },
  {
    name: 'git_check',
    level: 'adapter',
    reason: 'git and ssh/gpg environment are checked locally for headless commit and push work',
    source: 'cli',
  },
  {
    name: 'git_commit',
    level: 'adapter',
    reason: 'local git commits can be created through structured Pokedex MCP tools',
    source: 'cli',
  },
  {
    name: 'git_push',
    level: 'adapter',
    reason: 'local git pushes can be run through structured Pokedex MCP tools',
    source: 'cli',
  },
  {
    name: 'pokedex_commands',
    level: 'adapter',
    reason:
      'optional control surface applies Pokedex prompt commands only after the user enables it',
    source: 'local_config',
  },
];
