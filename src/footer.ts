import type { Plugin } from "@opencode/plugin/tui";
import { formatQuota } from "./quota.ts";
import { isQuotaSnapshot, Quota } from "./rpc.ts";

export function createFooterController(ctx: Plugin.Context, display: (text: string) => void) {
  let disposed = false;
  let sessionID: string | undefined;
  let providerID: string | undefined;
  let generation = 0;
  let revision = 0;
  let subscription: AbortController | undefined;
  let pending: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function clear() {
    clearTimeout(expiry);
    expiry = undefined;
    display("Codex unavailable");
  }
  function stop() {
    generation++;
    revision++;
    subscription?.abort();
    pending?.abort();
    clear();
  }
  function update(nextSessionID: string | undefined, nextProviderID: string | undefined, read = true) {
    if (disposed) return;
    stop();
    sessionID = nextSessionID;
    providerID = nextProviderID;
    if (!sessionID || providerID !== "openai") return;
    const currentSessionID = sessionID;
    const client = ctx.client;
    const location = ctx.location ?? ctx.data.location.default();
    const directory = location.directory;
    const workspaceID = location.workspaceID;
    const token = generation;
    const abort = new AbortController();
    subscription = abort;
    function current() {
      const nowLocation = ctx.location ?? ctx.data.location.default();
      return !disposed && generation === token && !abort.signal.aborted &&
        ctx.client === client && nowLocation.directory === directory &&
        nowLocation.workspaceID === workspaceID;
    }
    async function refresh() {
      if (!current()) return;
      const ticket = ++revision;
      pending?.abort();
      const request = new AbortController();
      pending = request;
      clear();
      try {
        // Read the current client at call time, not a subclient retained across restarts.
        const result = await ctx.client.rpc(Quota).snapshot(
          { sessionID: currentSessionID },
          { location, signal: request.signal },
        );
        if (!current() || ticket !== revision) return;
        const now = Date.now();
        if (!isQuotaSnapshot(result) || result.observedAt === null ||
          result.observedAt > now || now - result.observedAt >= 300_000) return;
        display(formatQuota(result));
        expiry = setTimeout(clear, result.observedAt + 300_000 - now);
      } catch {
        if (current() && ticket === revision) clear();
      }
    }
    void (async () => {
      try {
        for await (const event of ctx.client.rpc(Quota).events.subscribe("updated", { signal: abort.signal })) {
          if (!current()) break;
          if (event.location.directory !== directory) continue;
          void refresh();
        }
      } catch {
        // No retry loop: a broken event stream cannot safely maintain this cache.
      } finally {
        if (generation === token && !disposed && !abort.signal.aborted) stop();
      }
    })();
    if (read && current()) void refresh();
  }

  clear();
  const unsubscribe = ctx.data.listen(({ details }) => {
    switch (details.type) {
      case "credential.updated":
      case "credential.switched":
      case "integration.updated":
      case "provider.updated":
      case "config.updated":
      case "location.shutdown":
      case "server.connected":
        // Live-only subscriptions may have missed an account change; wait for a fresh update.
        update(sessionID, providerID, false);
    }
  });
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      unsubscribe();
    },
  };
}
