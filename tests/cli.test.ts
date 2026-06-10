import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../apps/cli/src/index.js', import.meta.url));
const runnerPath = fileURLToPath(new URL('../packages/codex-runner/src/index.ts', import.meta.url));

describe('pokedex cli', () => {
  it('prints setup and prompt guidance in help', () => {
    const output = execFileSync(process.execPath, [cliPath, 'help'], { encoding: 'utf8' });

    expect(output).toContain('Poke login opens automatically if needed');
    expect(output).toContain('pokedex help');
    expect(output).toContain('~/.pokedex/config.jsonc');
    expect(output).toContain('output [relay|agent|poke]');
  });

  it('keeps terminal-facing failure text friendly', () => {
    const source = `${readFileSync(cliPath, 'utf8')}\n${readFileSync(runnerPath, 'utf8')}`;

    for (const text of [
      'startup failed',
      'exited with code',
      'poke logs:',
      "Run 'poke login'",
      "Everything's ready",
    ]) {
      expect(source).not.toContain(text);
    }
  });

  it('confirms saved settings without replaying startup guidance', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('console.log(`✅ ${setting} set to ${value}`);');
    expect(source).toContain('if (restart) await startStack({ announceReady: false });');
    expect(source).not.toContain('console.log(`✅ ${message}. Saved.`);');
  });

  it('writes commented jsonc with inline app-server args', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('function stringifyConfigJsonc');
    expect(source).toContain('global write gate; workspace_write also needs allowWrite');
    expect(source).toContain('workspace full-access gate; danger_full_access needs this');
    expect(source).toContain('`  "appServerArgs": ${inlineArray(raw.appServerArgs)},`');
  });

  it('labels status workspace output as active among configured workspaces', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('console.log(`active ${workspace.alias} -> ${workspace.root}`);');
    expect(source).toContain(
      "`${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'} configured`"
    );
    expect(source).not.toContain('console.log(`spaces ${config.workspaces.length}');
    expect(source).not.toContain('console.log(`space  ${activeWorkspace().alias}');
  });

  it('does not rewrite an existing config just by starting pokedex', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain('if (!configFileExists || startupConfigOverrides()) saveConfig();');
    expect(source).not.toContain('config = createConfig(loadSavedConfig());\n  saveConfig();');
  });

  it('keeps normal config edits live without restarting the mcp stack', () => {
    const source = readFileSync(cliPath, 'utf8');

    expect(source).toContain("if (name === 'approval' || name === 'approve')");
    expect(source).toContain('await saveSetting(key, raw);');
    expect(source).toContain("await saveSetting('port', config.port, true);");
  });
});
