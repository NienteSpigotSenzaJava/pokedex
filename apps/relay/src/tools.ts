import * as z from 'zod/v4';
import { codexPromptGuidance, pokeResponseGuidance, type McpToolName } from '@pokedex/protocol';

type ToolSpec = {
  name: McpToolName;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
};

const empty = z.object({});
const threadId = z.object({ threadId: z.string().min(1) });
const approvalTarget = z.object({ approvalId: z.string().min(1).optional() });
const approvalApprove = approvalTarget.extend({ forSession: z.boolean().optional() });
const runtime = {
  model: z.string().optional(),
  profile: z.string().optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
  sandbox: z.enum(['read_only', 'workspace_write', 'danger_full_access']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
  webSearch: z.enum(['cached', 'live', 'disabled']).optional(),
  skillNames: z.array(z.string().min(1)).optional(),
  skills: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).optional(),
};
const workspace = z.object({ workspaceAlias: z.string().min(1) });
const gitCheck = workspace.extend({ checkRemote: z.boolean().optional() });
const gitCommit = workspace.extend({
  message: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).optional(),
  stage: z.enum(['staged', 'files', 'tracked', 'all']).optional(),
});
const gitPush = workspace.extend({
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  setUpstream: z.boolean().optional(),
});
const gitCommitPush = gitCommit.merge(gitPush.omit({ workspaceAlias: true }));
const pokedexCommand = z.object({
  command: z.string().min(1),
});
const skillList = z.object({
  workspaceAlias: z.string().optional(),
  forceReload: z.boolean().optional(),
});
const pluginList = z.object({
  includeMarketplace: z.boolean().optional(),
});
const operationTarget = z.object({
  operationId: z.string().min(1),
  afterEventsSeen: z.number().int().min(0).optional(),
  waitMs: z.number().int().min(0).max(30000).optional(),
});
const startThread = z.object({
  workspaceAlias: z.string().min(1),
  prompt: z.string().min(1),
  name: z.string().optional(),
  ...runtime,
});
const turn = z.object({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
  workspaceAlias: z.string().optional(),
  ...runtime,
});
const listThreads = z.object({
  workspaceAlias: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  searchTerm: z.string().optional(),
  archived: z.boolean().optional(),
});

export const toolSpecs: ToolSpec[] = [
  {
    name: 'pokedex_setup_check',
    title: 'setup check',
    description:
      'check codex login, app-server command, relay pairing, workspace visibility, effective workspace access, and current Pokedex command grammar.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_list_workspaces',
    title: 'list workspaces',
    description:
      'list configured local workspace aliases, effective access levels, command grammar, and guidance. arbitrary paths are not accepted.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_list_tasks',
    title: 'list tasks',
    description:
      'compatibility alias for listing native codex threads. prefer pokedex_list_threads unless the user says task.',
    inputSchema: listThreads,
  },
  {
    name: 'pokedex_list_sessions',
    title: 'list sessions',
    description:
      'compatibility alias for listing native codex threads. prefer pokedex_list_threads unless the user says session.',
    inputSchema: listThreads,
  },
  {
    name: 'pokedex_list_threads',
    title: 'list threads',
    description:
      'list native local codex threads from app-server, optionally filtered by workspace. use after reconnects and before resuming recent work; persisted thread history may be visible to Codex desktop/IDE after refresh, but this is not a live mirror.',
    inputSchema: listThreads,
  },
  {
    name: 'pokedex_list_skills',
    title: 'list skills',
    description:
      'list local codex skills available to a workspace, including ~/.agents/skills and ~/.codex/skills.',
    inputSchema: skillList,
  },
  {
    name: 'pokedex_list_plugins',
    title: 'list plugins',
    description:
      'discover codex plugins known to app-server, including installed plugins and marketplace data when available.',
    inputSchema: pluginList,
  },
  {
    name: 'pokedex_list_operations',
    title: 'list operations',
    description:
      'list local codex operations with progress, last event, and rate-limit state. use this after reconnects, failed responses, or when the user asks what codex is doing. running means not finished.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_read_operation',
    title: 'read operation',
    description:
      'read one tracked long-running codex operation by operationId. use this instead of retrying the same start/send/resume request. if still running, keep polling now; pass afterEventsSeen from the previous result plus waitMs up to 30000 to wait for the next progress event. do not promise a future update after ending your response.',
    inputSchema: operationTarget,
  },
  {
    name: 'pokedex_start_task',
    title: 'start task',
    description:
      'compatibility alias for starting a native codex thread. prefer pokedex_start_thread.',
    inputSchema: startThread,
  },
  {
    name: 'pokedex_start_thread',
    title: 'start thread',
    description: `preferred tool for new codex work: create a native local thread and send the first user turn. ${codexPromptGuidance} ${pokeResponseGuidance} if this returns an operationId with operationStatus running, the work is not complete; poll with pokedex_read_operation and do not report success or promise later updates.`,
    inputSchema: startThread,
  },
  {
    name: 'pokedex_continue_task',
    title: 'continue task',
    description:
      'compatibility alias for sending a new turn to an existing codex thread. prefer pokedex_send_turn.',
    inputSchema: turn,
  },
  {
    name: 'pokedex_send_turn',
    title: 'send turn',
    description: `preferred follow-up tool: send a new turn to an existing native codex thread. ${codexPromptGuidance} Pass workspaceAlias when continuing after reconnect or after reading/listing a thread. if this returns an operationId with operationStatus running, the work is not complete; poll with pokedex_read_operation and do not report success or promise later updates.`,
    inputSchema: turn,
  },
  {
    name: 'pokedex_resume_task',
    title: 'resume task',
    description:
      'compatibility alias for resuming a stored codex thread. prefer pokedex_resume_thread.',
    inputSchema: turn,
  },
  {
    name: 'pokedex_resume_thread',
    title: 'resume thread',
    description: `resume a stored local codex thread and send a new turn, useful after reconnects or list/read lookups. ${codexPromptGuidance} Pass workspaceAlias unless the current Pokedex process already created or identified the thread workspace. if this returns an operationId with operationStatus running, the work is not complete; poll with pokedex_read_operation and do not report success or promise later updates.`,
    inputSchema: turn,
  },
  {
    name: 'pokedex_read_thread',
    title: 'read thread',
    description: 'read a stored local codex thread, including turns by default.',
    inputSchema: threadId.extend({ includeTurns: z.boolean().optional() }),
  },
  {
    name: 'pokedex_fork_thread',
    title: 'fork thread',
    description: 'fork a stored local codex thread into a new thread.',
    inputSchema: threadId,
  },
  {
    name: 'pokedex_set_goal',
    title: 'set goal',
    description: 'set a codex goal on a native local thread.',
    inputSchema: threadId.extend({ goal: z.string().min(1) }),
  },
  {
    name: 'pokedex_clear_goal',
    title: 'clear goal',
    description: 'clear the codex goal on a native local thread.',
    inputSchema: threadId,
  },
  {
    name: 'pokedex_review',
    title: 'review',
    description:
      'start codex review mode on an existing or new native local thread for code review requests.',
    inputSchema: z.object({
      workspaceAlias: z.string().min(1),
      threadId: z.string().optional(),
      prompt: z.string().optional(),
      ...runtime,
    }),
  },
  {
    name: 'pokedex_interrupt',
    title: 'interrupt',
    description: 'interrupt the active turn for a native local codex thread.',
    inputSchema: threadId,
  },
  {
    name: 'pokedex_list_approvals',
    title: 'list approvals',
    description: 'list codex approvals waiting for a decision from poke.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_approve',
    title: 'approve',
    description:
      'approve a pending codex command or file-change request. omit approvalId when only one is pending. set forSession true when the pending approval lists recommendedDecision acceptForSession and the user approved that scope.',
    inputSchema: approvalApprove,
  },
  {
    name: 'pokedex_decline',
    title: 'decline',
    description:
      'decline a pending codex command or file-change request. omit approvalId when only one is pending.',
    inputSchema: approvalTarget,
  },
  {
    name: 'pokedex_cancel_approval',
    title: 'cancel approval',
    description:
      'cancel a pending codex command or file-change request. omit approvalId when only one is pending.',
    inputSchema: approvalTarget,
  },
  {
    name: 'pokedex_get_diff',
    title: 'get diff',
    description:
      'read git status plus staged, unstaged, and untracked file changes for an allowed local workspace.',
    inputSchema: workspace,
  },
  {
    name: 'pokedex_git_check',
    title: 'git check',
    description:
      'check local git repository state, effective workspace access, and headless git auth environment for commit and push work. use before asking codex to commit or push; set checkRemote true before push/publish/sync requests. if this reports read-only or missing full-access, report its exact nextAction and do not invent commands.',
    inputSchema: gitCheck,
  },
  {
    name: 'pokedex_git_commit',
    title: 'git commit',
    description:
      'create a local git commit through Pokedex, without asking Codex to run shell commands. requires workspace write access and an explicit commit message. stage defaults to staged unless files are provided; use stage all only when the user explicitly asked to commit all changes.',
    inputSchema: gitCommit,
  },
  {
    name: 'pokedex_git_push',
    title: 'git push',
    description:
      'push through Pokedex using local git and headless credentials, without asking Codex to run shell commands. requires workspace full-access. omit remote and branch to use the configured upstream; do not invent them if the user did not name them.',
    inputSchema: gitPush,
  },
  {
    name: 'pokedex_git_commit_push',
    title: 'git commit and push',
    description:
      'create a local git commit and then push it through Pokedex. requires an explicit commit message, workspace write access for the commit, and full-access for the push. do not invent files, stage mode, remote, or branch.',
    inputSchema: gitCommitPush,
  },
  {
    name: 'pokedex_get_usage',
    title: 'get usage',
    description:
      'return the latest usage plus Codex account rate limits and reset timing when available. use after rate-limit failures or before retrying a limited turn.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_command',
    title: 'pokedex command',
    description:
      'apply only a supported Pokedex prompt command such as status, help, shell, ws add/rm/use/desc/perms, model, reasoning, verbosity, or approval after the user enables this dangerous control surface with shell on. this is not an OS shell; logs, port, token rotate, restart, and quit are terminal-only; alternate spellings and unlisted commands are invalid.',
    inputSchema: pokedexCommand,
  },
];

export function mcpToolDefinitions() {
  return toolSpecs.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.inputSchema),
  }));
}
