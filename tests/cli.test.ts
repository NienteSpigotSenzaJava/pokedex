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
});
