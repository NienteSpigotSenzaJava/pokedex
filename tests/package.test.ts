import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPackagePath = fileURLToPath(new URL('../apps/cli/package.json', import.meta.url));
const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as {
  name?: string;
};

describe('published cli package', () => {
  it('keeps the npm package name unscoped', () => {
    expect(cliPackage.name).toBe('codex-to-poke');
    expect(cliPackage.name).not.toMatch(/^@/);
  });
});
