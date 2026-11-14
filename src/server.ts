import { Plugin } from "@opencode/plugin";
import type { QuotaSnapshot } from "./quota.ts";
import { Quota, sessionInput } from "./rpc.ts";
import { fetchQuotaUsage } from "./usage.ts";

export default Plugin.define({
  id: "opencode-quota-footer",
  async setup(ctx) {
    const abort = new AbortController();
    let rpc: Awaited<ReturnType<typeof ctx.rpc.register<typeof Quota>>> | undefined;
    let disposed = false;
    let observing = true;
    let streamFailed = false;
    let generation = 0;
    let identity: string | undefined;
    let attemptedAt: number | undefined;
    let cached: QuotaSnapshot = { windows: [], observedAt: null };
    let pending: { abort: AbortController; done: Promise<void> } | undefined;
    let lifecycle = new AbortController();
    type Connection = Awaited<ReturnType<typeof ctx.integration.connection.active>>;

    function clear() {
      generation++;
      lifecycle.abort();
      lifecycle = new AbortController();
      pending?.abort.abort();
      pending = undefined;
      // Keep the same-connection attempt bound across public invalidations.
      cached = { windows: [], observedAt: null };
    }
    function connectionID(connection: Connection) {
      return connection?.type === "credential" && connection.method === "oauth" &&
        typeof connection.id === "string" && connection.id ? connection.id : undefined;
    }
    function current(token: number) {
      return !disposed && observing && generation === token;
    }
    async function cancellable<T>(signal: AbortSignal, work: Promise<T>): Promise<T | undefined> {
      let cancel!: () => void;
      const cancelled = new Promise<undefined>((resolve) => {
        cancel = () => resolve(undefined);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        return await Promise.race([work, cancelled]);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    async function sameConnection(id: string, token: number) {
      if (!current(token)) return false;
      const selected = await cancellable(lifecycle.signal, ctx.integration.connection.active("openai"));
      if (!current(token)) return false;
      if (connectionID(selected) === id) return true;
      clear();
      return false;
    }
    async function load(connection: NonNullable<Connection>, id: string, token: number, signal: AbortSignal) {
      try {
        // The host may refresh its credential here; the plugin never redeems tokens.
        const auth = await ctx.integration.connection.resolve(connection);
        if (!current(token) || signal.aborted || auth?.type !== "oauth" ||
          !["chatgpt-browser", "chatgpt-headless"].includes(auth.methodID) ||
          typeof auth.metadata?.accountID !== "string") return;
        if (!await sameConnection(id, token)) return;
        const windows = await fetchQuotaUsage(auth.access, auth.metadata.accountID, signal);
        const observedAt = Date.now();
        if (await sameConnection(id, token) && current(token)) cached = { windows, observedAt };
      } catch {
        // Fail closed without carrying SDK errors or upstream content into RPC.
      }
    }
    async function notify() {
      try {
        await rpc?.events.emit("updated", {});
      } catch {
        observing = false;
        clear();
      }
    }
    async function cleanup() {
      if (disposed) return;
      disposed = true;
      observing = false;
      clear();
      abort.abort();
      if (rpc) await Promise.allSettled([rpc.dispose()]);
    }

    try {
      const events = ctx.event.subscribe({
        types: [
          "credential.updated", "credential.switched", "integration.updated",
          "provider.updated", "config.updated", "location.shutdown",
        ],
        signal: abort.signal,
      });
      void (async () => {
        try {
          for await (const _event of events) {
            if (disposed) break;
            clear();
            void notify();
          }
        } catch {
          // A lost invalidation stream makes account attribution unsafe.
        } finally {
          if (!disposed) {
            streamFailed = true;
            observing = false;
            clear();
            void notify();
          }
        }
      })();
      rpc = await ctx.rpc.register(Quota, {
        async snapshot(input) {
          sessionInput(input);
          const unavailable = { windows: [], observedAt: null };
          let token = generation;
          if (!current(token)) return unavailable;
          try {
            const connection = await cancellable(lifecycle.signal, ctx.integration.connection.active("openai"));
            if (!current(token)) return unavailable;
            const id = connectionID(connection);
            if (!id || !connection) {
              clear();
              return unavailable;
            }
            if (identity !== id) {
              if (identity !== undefined) clear();
              identity = id;
              attemptedAt = undefined;
              token = generation;
            }
            if (!pending && (attemptedAt === undefined || Date.now() - attemptedAt >= 60_000)) {
              cached = unavailable;
              attemptedAt = Date.now();
              const request = new AbortController();
              const work = {
                abort: request,
                done: cancellable(request.signal, load(connection, id, token, request.signal)),
              };
              pending = work;
              void work.done.finally(() => { if (pending === work) pending = undefined; });
            }
            await pending?.done;
            if (!current(token) || !await sameConnection(id, token) || !current(token)) return unavailable;
            if (cached.observedAt === null || Date.now() - cached.observedAt >= 300_000) return unavailable;
            return { windows: cached.windows.map((window) => ({ ...window })), observedAt: cached.observedAt };
          } catch {
            if (current(token)) cached = unavailable;
            return unavailable;
          }
        },
      });
      observing = !streamFailed;
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  },
});
