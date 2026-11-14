import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import type { SessionHooks } from "@opencode/plugin/promise/session";
import server from "../src/server.ts";
import { only, settle, stream } from "./helpers.ts";

const unavailable = { windows: [], observedAt: null };
const quota = {
  "x-codex-primary-used-percent": "20",
  "x-codex-primary-window-minutes": "300",
};
const invalidations = [
  "credential.updated", "credential.switched", "integration.updated",
  "provider.updated", "config.updated", "location.shutdown",
];

async function host(failAt?: string) {
  const hooks = new Map<string, (event: SessionHooks["http.response"]) => unknown>();
  const disposed: string[] = [];
  const emitted: unknown[][] = [];
  const emissions: Array<() => void> = [];
  let snapshot: (input: unknown) => Promise<unknown> = async () => { throw Error("missing RPC"); };
  let signal: AbortSignal | undefined;
  let events: ReturnType<typeof stream<{ type: string }>> | undefined;
  let types: string[] = [];
  const context = only({
    session: only({
      async hook(name: string, callback: (event: SessionHooks["http.response"]) => unknown, options: unknown) {
        assert.deepEqual(options, { providerID: "openai" });
        if (name === failAt) throw Error("synthetic setup failure");
        hooks.set(name, callback);
        return { async dispose() { disposed.push(name); hooks.delete(name); } };
      },
    }),
    rpc: only({
      async register(definition: { id: string }, handlers: { snapshot: typeof snapshot }) {
        assert.equal(definition.id, "opencode-quota-footer");
        if (failAt === "rpc") throw Error("synthetic setup failure");
        snapshot = handlers.snapshot;
        return {
          async dispose() { disposed.push("rpc"); },
          events: { async emit(...args: unknown[]) {
            emitted.push(args);
            if (failAt === "emit") throw Error("synthetic emit failure");
            if (failAt === "pending emit") await new Promise<void>((resolve) => emissions.push(resolve));
          } },
        };
      },
    }),
    event: only({
      subscribe(options: { signal: AbortSignal; types: string[] }) {
        signal = options.signal;
        types = options.types;
        if (failAt === "subscribe") throw Error("synthetic setup failure");
        events = stream(options.signal);
        return events;
      },
    }),
  });
  let cleanup: Plugin.Cleanup | void;
  let setupError: unknown;
  try {
    cleanup = await server.setup(context as unknown as Plugin.Context);
  } catch (error) { setupError = error; }
  return {
    hooks, disposed, emitted, emissions, setupError,
    get signal() { return signal; },
    get events() { return events!; },
    get types() { return types; },
    read: (input: unknown = { sessionID: "a" }) => snapshot(input),
    async cleanup() { if (cleanup) await cleanup(); },
    async response(headers: Record<string, string> = quota, providerID = "openai", request = new Proxy(new Request("https://example.invalid"), {
      get() { throw Error("request content must not be read"); },
    })) {
      const response = new Response("untouched body", { headers });
      const body = response.body;
      const event = {
        sessionID: "a", agent: "agent", kind: "primary",
        model: { providerID, modelID: "model" }, request, response,
      } as unknown as SessionHooks["http.response"];
      // The host applies the provider-scoped filter before dispatch.
      if (providerID === "openai") {
        await hooks.get("http.request")?.(event);
        await hooks.get("http.response")?.(event);
      }
      assert.equal(event.response, response);
      assert.equal(response.body, body);
      assert.equal(response.bodyUsed, false);
      assert.equal(await response.text(), "untouched body");
      return event;
    },
  };
}

test("observes only scoped OpenAI headers, preserves bodies, and clears on later missing headers", async (t) => {
  mock.method(globalThis, "fetch", () => { throw Error("active fetch forbidden"); });
  t.after(() => mock.restoreAll());
  const h = await host();
  t.after(() => h.cleanup());
  assert.ifError(h.setupError);
  assert.deepEqual(await h.read(), unavailable);
  await h.response(quota, "other");
  assert.deepEqual(await h.read(), unavailable);
  await h.response();
  const value = await h.read() as { observedAt: number; windows: unknown[] };
  assert.deepEqual(value.windows, [{ windowMinutes: 300, remainingPercent: 80 }]);
  assert.equal(typeof value.observedAt, "number");
  assert.deepEqual(await h.read({ sessionID: "b" }), unavailable);
  await h.response({});
  assert.deepEqual(await h.read(), unavailable);
  assert.deepEqual(h.emitted, [["updated", {}], ["updated", {}]]);
});

for (const type of invalidations) {
  test(`${type} clears quota and rejects a pre-invalidation response`, async (t) => {
    const h = await host();
    t.after(() => h.cleanup());
    assert.ok(h.types.includes(type));
    await h.response();
    const request = new Request("https://example.invalid");
    const event = {
      sessionID: "a", agent: "agent", kind: "primary", model: { providerID: "openai", modelID: "model" },
      request, response: new Response(null, { headers: quota }),
    } as unknown as SessionHooks["http.response"];
    await h.hooks.get("http.request")!(event);
    h.events.push({ type });
    await settle();
    assert.deepEqual(await h.read(), unavailable);
    await h.hooks.get("http.response")!(event);
    assert.deepEqual(await h.read(), unavailable);
  });
}

test("unmatched identity clears state; consumed tags cannot be reused", async (t) => {
  const h = await host();
  t.after(() => h.cleanup());
  const event = await h.response();
  await h.hooks.get("http.response")!({ ...event, request: new Request("https://example.invalid") });
  assert.deepEqual(await h.read(), unavailable);
  await h.response();
  await h.hooks.get("http.response")!(event);
  assert.deepEqual(await h.read(), unavailable);
});

test("RPC input is narrowed and rejects malformed or extra fields", async (t) => {
  const h = await host();
  t.after(() => h.cleanup());
  for (const input of [
    null, {}, [], { sessionID: 1 }, { sessionID: "" }, { sessionID: "a", extra: true },
    Object.assign([], { sessionID: "a" }),
    Object.assign(Object.create({ sessionID: "a" }), { extra: true }),
  ]) {
    await assert.rejects(h.read(input));
  }
});

for (const failure of ["fail", "end"] as const) {
  test(`event stream ${failure} clears and disables observation until reload`, async (t) => {
    const h = await host();
    t.after(() => h.cleanup());
    await h.response();
    h.events[failure]();
    await settle();
    assert.deepEqual(await h.read(), unavailable);
    await h.response();
    assert.deepEqual(await h.read(), unavailable);
  });
}

test("cleanup aborts subscription, clears state, disposes hooks/RPC, and guards captured callbacks", async () => {
  const h = await host();
  const event = await h.response();
  const callback = h.hooks.get("http.response")!;
  await h.cleanup();
  await h.cleanup();
  assert.equal(h.signal?.aborted, true);
  assert.deepEqual(h.disposed.sort(), ["http.request", "http.response", "rpc"]);
  await callback(event);
  assert.deepEqual(await h.read(), unavailable);
});

for (const failAt of ["rpc", "http.request", "http.response", "subscribe"]) {
  test(`partial setup failure at ${failAt} releases acquired resources`, async () => {
    const h = await host(failAt);
    assert.ok(h.setupError);
    assert.equal(h.hooks.size, 0);
    if (h.signal) assert.equal(h.signal.aborted, true);
    if (failAt === "http.response") assert.ok(h.disposed.includes("http.request"));
  });
}

test("update emission failure cannot fail provider traffic or retain quota", async (t) => {
  const h = await host("emit");
  t.after(() => h.cleanup());
  await h.response();
  assert.deepEqual(await h.read(), unavailable);
});

test("slow update delivery cannot block provider traffic or subsequent authentication invalidation", async (t) => {
  const h = await host("pending emit");
  t.after(async () => { for (const release of h.emissions) release(); await h.cleanup(); });
  let returned = false;
  const first = h.response().then(() => { returned = true; });
  await settle();
  assert.equal(returned, true, "passive notification must not delay the provider hook");
  h.events.push({ type: "config.updated" });
  await settle();
  const second = h.response();
  await settle();
  h.events.push({ type: "credential.switched" });
  await settle();
  assert.deepEqual(await h.read(), unavailable);
  await first;
  await second;
});
