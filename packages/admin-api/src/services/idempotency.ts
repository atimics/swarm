export interface IdempotencyRecord<T> {
  value: T;
  expiresAt: number;
}

export interface IdempotencyStore<T> {
  get: (key: string) => T | null;
  set: (key: string, value: T) => void;
  clear: () => void;
}

export function createIdempotencyStore<T>(params?: {
  now?: () => number;
  ttlMs?: number;
}): IdempotencyStore<T> {
  const now = params?.now ?? (() => Date.now());
  const ttlMs = params?.ttlMs ?? 5 * 60 * 1000;
  const store = new Map<string, IdempotencyRecord<T>>();

  const get = (key: string): T | null => {
    const record = store.get(key);
    if (!record) return null;
    if (record.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return record.value;
  };

  const set = (key: string, value: T) => {
    store.set(key, { value, expiresAt: now() + ttlMs });
  };

  const clear = () => {
    store.clear();
  };

  return { get, set, clear };
}

export const chatIdempotencyStore = createIdempotencyStore<unknown>();
