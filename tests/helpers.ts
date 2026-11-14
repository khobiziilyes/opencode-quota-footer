import assert from "node:assert/strict";

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export function stream<T>(signal?: AbortSignal) {
  const waiting: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  const queued: T[] = [];
  let done = false;
  let error: Error | undefined;
  const end = () => {
    done = true;
    for (const item of waiting.splice(0)) item.resolve({ done: true, value: undefined });
  };
  signal?.addEventListener("abort", end, { once: true });
  return {
    push(value: T) {
      const item = waiting.shift();
      if (item) item.resolve({ done: false, value });
      else queued.push(value);
    },
    end,
    fail() {
      error = new Error("synthetic stream failure");
      for (const item of waiting.splice(0)) item.reject(error);
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (error) throw error;
          if (done) return { done: true, value: undefined };
          if (queued.length) return { done: false, value: queued.shift()! };
          return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
        },
        async return(): Promise<IteratorResult<T>> {
          end();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export function only<T extends object>(allowed: T): T {
  return new Proxy(allowed, {
    get(target, key, receiver) {
      assert.ok(Reflect.has(target, key), `forbidden host API: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
