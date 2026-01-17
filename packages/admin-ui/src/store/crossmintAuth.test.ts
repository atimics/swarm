import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };

  // @ts-expect-error - test polyfill
  globalThis.localStorage = localStorage;
  return localStorage;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Crossmint auth store reliability', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installMemoryLocalStorage();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('does not call backend and does not throw when wallet address missing', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 500 }));
    globalThis.fetch = fetchMock;

    const { useCrossmintAuth } = await import('./crossmintAuth');
    useCrossmintAuth.getState().resetLocal();

    await useCrossmintAuth.getState().syncWithBackend('jwt', {
      id: 'user-1',
      email: 'a@b.com',
      // wallet missing
    });

    expect(fetchMock).toHaveBeenCalledTimes(0);
    const state = useCrossmintAuth.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.error).toContain('Wallet address');
  });

  test('clears auth and does not wedge loading on 401/failed verify', async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock;

    const { useCrossmintAuth } = await import('./crossmintAuth');
    useCrossmintAuth.getState().resetLocal();

    await useCrossmintAuth.getState().syncWithBackend('jwt', {
      id: 'user-1',
      email: 'a@b.com',
      wallet: { address: 'cm-wallet' },
    });

    const state = useCrossmintAuth.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBe(null);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeTruthy();
  });

  test('prevents concurrent sync calls from spamming the backend', async () => {
    const gate = deferred<Response>();
    const fetchMock = mock(async () => gate.promise);
    globalThis.fetch = fetchMock;

    const { useCrossmintAuth } = await import('./crossmintAuth');
    useCrossmintAuth.getState().resetLocal();

    const sync1 = useCrossmintAuth.getState().syncWithBackend('jwt', {
      id: 'user-1',
      email: 'a@b.com',
      wallet: { address: 'cm-wallet' },
    });

    // Call again before the first finishes
    const sync2 = useCrossmintAuth.getState().syncWithBackend('jwt', {
      id: 'user-1',
      email: 'a@b.com',
      wallet: { address: 'cm-wallet' },
    });

    // Allow the in-flight request to complete successfully
    gate.resolve(
      new Response(
        JSON.stringify({
          success: true,
          user: { walletAddress: 'cm-wallet' },
          gateStatus: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await Promise.all([sync1, sync2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useCrossmintAuth.getState().isLoading).toBe(false);
  });
});
