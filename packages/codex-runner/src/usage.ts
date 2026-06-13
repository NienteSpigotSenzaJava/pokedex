import { UsageSchema, type Usage } from '@pokedex/protocol';
import { asRecord, numberFrom } from './utils.js';

export function parseUsage(value: unknown): Usage | null {
  const input = asRecord(value);
  const raw = asRecord('usage' in input ? input.usage : value);
  const tokenKeys = [
    'input_tokens',
    'inputTokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'output_tokens',
    'outputTokens',
    'reasoning_output_tokens',
    'reasoningOutputTokens',
  ];
  if (!tokenKeys.some((key) => key in raw)) return null;

  return (
    UsageSchema.safeParse({
      inputTokens: numberFrom(raw.input_tokens ?? raw.inputTokens),
      cachedInputTokens: numberFrom(raw.cached_input_tokens ?? raw.cachedInputTokens),
      outputTokens: numberFrom(raw.output_tokens ?? raw.outputTokens),
      reasoningOutputTokens: numberFrom(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens),
    }).data ?? null
  );
}

export function extractUsage(value: unknown): Usage | null {
  const raw = asRecord(value);
  const params = asRecord(raw.params);
  const turn = asRecord(raw.turn);
  const paramsTurn = asRecord(params.turn);
  const item = asRecord(raw.item);
  const paramsItem = asRecord(params.item);
  const candidates = [
    raw,
    raw.usage,
    params,
    params.usage,
    turn,
    turn.usage,
    paramsTurn,
    paramsTurn.usage,
    item,
    item.usage,
    paramsItem,
    paramsItem.usage,
  ];
  for (const candidate of candidates) {
    const usage = parseUsage(candidate);
    if (usage) return usage;
  }
  return null;
}

export function latestUsage(values: unknown[]): Usage | null {
  let latest: Usage | null = null;
  for (const value of values) {
    const usage = extractUsage(value);
    if (usage && usageTotal(usage) > 0) latest = usage;
  }
  return latest;
}

export function usageTotal(usage: Usage): number {
  return (
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningOutputTokens
  );
}
