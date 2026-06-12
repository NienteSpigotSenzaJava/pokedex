import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const relayPath = fileURLToPath(new URL('../apps/relay/src/index.ts', import.meta.url));

describe('pokedex relay shutdown', () => {
  it('closes websocket clients, pending calls, and the http server on signals', () => {
    const source = readFileSync(relayPath, 'utf8');

    expect(source).toContain("const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];");
    expect(source).toContain('process.once(signal, () => void shutdown(signal));');
    expect(source).toContain("rejectAllPending(new Error('relay stopped before");
    expect(source).toContain("socket.close(1001, 'relay shutting down');");
    expect(source).toContain('for (const socket of wss.clients) socket.terminate();');
    expect(source).toContain('server.closeAllConnections();');
    expect(source).toContain('server.closeIdleConnections();');
  });
});
