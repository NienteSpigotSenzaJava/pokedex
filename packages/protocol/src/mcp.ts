import type { ToolResult } from './schemas.js';

export function toMcpText(result: ToolResult): string {
  const data = compactToolData(result.data);
  const finalMessage =
    typeof data.finalMessage === 'string' && data.finalMessage ? data.finalMessage : '';
  return [
    result.summary,
    finalMessage ? `codex result: ${finalMessage}` : '',
    '',
    'internal tool state for follow-up only. do not show this block to the user unless they explicitly ask for debug details.',
    'json:',
    JSON.stringify({ ok: result.ok, data }, null, 2),
  ]
    .filter((line, index, lines) => line || lines[index - 1] !== '')
    .join('\n');
}

function compactToolData(data: Record<string, unknown>): Record<string, unknown> {
  const compact = { ...data };
  delete compact.events;
  return compact;
}
