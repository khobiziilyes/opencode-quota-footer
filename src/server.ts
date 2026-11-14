import { Plugin } from "@opencode/plugin";
import { createQuotaState } from "./quota.ts";
import { Quota, sessionInput } from "./rpc.ts";

export default Plugin.define({
  id: "opencode-quota-footer",
  async setup(ctx) {
    const state = createQuotaState();
    let requests = new WeakSet<Request>();
    const abort = new AbortController();
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    let rpc: Awaited<ReturnType<typeof ctx.rpc.register<typeof Quota>>> | undefined;
    let disposed = false;
    let observing = false;
    let streamFailed = false;

    function clear() {
      requests = new WeakSet();
      state.clear();
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
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
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
          return state.read(sessionInput(input), Date.now());
        },
      });
      registrations.push(rpc);
      registrations.push(await ctx.session.hook("http.request", (event) => {
        if (observing && event.model.providerID === "openai") requests.add(event.request);
      }, { providerID: "openai" }));
      registrations.push(await ctx.session.hook("http.response", (event) => {
        if (!observing || event.model.providerID !== "openai") return;
        if (requests.delete(event.request)) {
          state.observe(event.sessionID, event.response.headers, Date.now());
        } else {
          // The SDK does not promise stable request identity; mismatches must fail closed.
          state.clear();
        }
        void notify();
      }, { providerID: "openai" }));
      observing = !streamFailed;
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  },
});
