import * as z from 'zod/v4';
import { type McpToolName } from '@pokedex/protocol';

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
const skillList = z.object({
  workspaceAlias: z.string().optional(),
  forceReload: z.boolean().optional(),
});
const pluginList = z.object({
  includeMarketplace: z.boolean().optional(),
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
    description: 'check codex login, app-server command, relay pairing, and workspace visibility.',
    inputSchema: empty,
  },
  {
    name: 'pokedex_list_workspaces',
    title: 'list workspaces',
    description: 'list configured local workspace aliases. arbitrary paths are not accepted.',
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
      'list native local codex threads from app-server, optionally filtered by workspace.',
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
    name: 'pokedex_start_task',
    title: 'start task',
    description:
      'compatibility alias for starting a native codex thread. prefer pokedex_start_thread.',
    inputSchema: startThread,
  },
  {
    name: 'pokedex_start_thread',
    title: 'start thread',
    description:
      'preferred tool for new codex work: create a native local thread and send the first user turn.',
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
    description: 'preferred follow-up tool: send a new turn to an existing native codex thread.',
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
    description:
      'resume a stored local codex thread and send a new turn, useful after reconnects or list/read lookups.',
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
      'approve a pending codex command or file-change request. omit approvalId when only one is pending.',
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
    description: 'read git diff summary for an allowed local workspace.',
    inputSchema: workspace,
  },
  {
    name: 'pokedex_get_usage',
    title: 'get usage',
    description: 'return the latest usage seen by the local agent.',
    inputSchema: empty,
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
