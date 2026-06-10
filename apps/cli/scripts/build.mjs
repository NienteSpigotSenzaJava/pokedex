import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const common = {
  absWorkingDir: repoRoot,
  alias: {
    '@pokedex/codex-runner': './packages/codex-runner/src/index.ts',
    '@pokedex/protocol': './packages/protocol/src/index.ts',
    '@pokedex/security': './packages/security/src/index.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['apps/agent/src/index.ts'],
    outfile: 'apps/cli/dist/agent.cjs',
  }),
  build({
    ...common,
    entryPoints: ['apps/relay/src/index.ts'],
    outfile: 'apps/cli/dist/relay.cjs',
  }),
]);
