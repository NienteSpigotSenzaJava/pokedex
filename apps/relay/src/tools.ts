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
const runtime = {
  model: z.string().optional(),
  profile: z.string().optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
  sandbox: z.enum(['read_only', 'workspace_write', 'danger_full_access']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
  webSearch: z.enum(['cached', 'live', 'disabled']).optional(),
  imagePaths: z.array(z.string()).optional(),
  skills: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).optional(),
};
const workspace = z.object({ workspaceAlias: z.string().min(1) });
const startThread = z.object({
  workspaceAlias: z.string().min(1),
  prompt: z.string().min(1),
  name: z.string().optional(),
  ...runtime,
});
const turn = z.object({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
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
    description: 'list local codex tasks from native threads.',
    inputSchema: listThreads,
  },
  {
    name: 'pokedex_list_sessions',
    title: 'list sessions',
    description: 'list local codex sessions from native threads.',
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
    name: 'pokedex_start_task',
    title: 'start task',
    description: 'create a local codex task and send the first user turn.',
    inputSchema: startThread,
  },
  {
    name: 'pokedex_start_thread',
    title: 'start thread',
    description: 'create a native local codex thread and send the first user turn.',
    inputSchema: startThread,
  },
  {
    name: 'pokedex_continue_task',
    title: 'continue task',
    description: 'send a new turn to an existing local codex task.',
    inputSchema: turn,
  },
  {
    name: 'pokedex_send_turn',
    title: 'send turn',
    description: 'send a new turn to an existing native codex thread.',
    inputSchema: turn,
  },
  {
    name: 'pokedex_resume_task',
    title: 'resume task',
    description: 'resume a stored local codex task and send a new turn.',
    inputSchema: turn,
  },
  {
    name: 'pokedex_resume_thread',
    title: 'resume thread',
    description: 'resume a stored local codex thread and send a new turn.',
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
    description: 'start codex review mode on an existing or new native local thread.',
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
