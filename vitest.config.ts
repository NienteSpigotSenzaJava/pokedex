import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@pokedex/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
      '@pokedex/security': new URL('./packages/security/src/index.ts', import.meta.url).pathname,
      '@pokedex/codex-runner': new URL('./packages/codex-runner/src/index.ts', import.meta.url)
        .pathname,
    },
  },
});
