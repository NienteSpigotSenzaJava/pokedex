import type { JsonRecord } from './types.js';
import { asRecord, booleanFrom, stringFrom, stripUndefined } from './utils.js';

export type ListedPlugin = {
  name: string;
  path?: string;
  description?: string;
  installed?: boolean;
  enabled?: boolean;
  source?: string;
  marketplace?: string;
  availability?: string;
};

export function normalizePlugins(result: unknown, source: string): ListedPlugin[] {
  return pluginRecords(result)
    .map((plugin) => listedPluginFrom(plugin, source))
    .filter((plugin): plugin is ListedPlugin => Boolean(plugin));
}

export function uniquePlugins(plugins: ListedPlugin[]): ListedPlugin[] {
  const seen = new Set<string>();
  return plugins.filter((plugin) => {
    const key = `${plugin.name}\n${plugin.path ?? ''}\n${plugin.marketplace ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pluginRecords(value: unknown, depth = 0): unknown[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => pluginRecords(item, depth + 1));
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return [];

  const nested = [
    'plugins',
    'installed',
    'installedPlugins',
    'items',
    'entries',
    'rows',
    'data',
    'marketplaceEntries',
  ].flatMap((key) => pluginRecords(raw[key], depth + 1));
  return looksLikePlugin(raw) ? [raw, ...nested] : nested;
}

function listedPluginFrom(value: unknown, source: string): ListedPlugin | null {
  const raw = asRecord(value);
  const manifest = asRecord(raw.manifest);
  const details = asRecord(raw.details);
  const pluginInterface = asRecord(raw.interface);
  const name =
    stringFrom(raw.name) ??
    stringFrom(raw.displayName) ??
    stringFrom(raw.title) ??
    stringFrom(raw.id) ??
    stringFrom(manifest.name) ??
    stringFrom(details.name) ??
    stringFrom(pluginInterface.name);
  if (!name) return null;

  return stripUndefined({
    name,
    path:
      stringFrom(raw.path) ??
      stringFrom(raw.uri) ??
      stringFrom(raw.pluginUri) ??
      stringFrom(raw.mentionPath) ??
      stringFrom(raw.installUri) ??
      stringFrom(manifest.path),
    description:
      stringFrom(raw.description) ??
      stringFrom(manifest.description) ??
      stringFrom(details.description) ??
      stringFrom(pluginInterface.description),
    installed: booleanFrom(raw.installed),
    enabled: booleanFrom(raw.enabled),
    source,
    marketplace:
      stringFrom(raw.marketplace) ??
      stringFrom(raw.marketplaceName) ??
      stringFrom(asRecord(raw.marketplaceEntry).marketplace),
    availability: stringFrom(raw.availability),
  }) as ListedPlugin;
}

function looksLikePlugin(raw: JsonRecord): boolean {
  return Boolean(
    stringFrom(raw.path)?.startsWith('plugin://') ||
    stringFrom(raw.uri)?.startsWith('plugin://') ||
    stringFrom(raw.pluginUri)?.startsWith('plugin://') ||
    stringFrom(raw.mentionPath)?.startsWith('plugin://') ||
    raw.manifest ||
    raw.interface ||
    raw.marketplaceEntry ||
    (raw.id && (raw.name || raw.displayName || raw.title))
  );
}
