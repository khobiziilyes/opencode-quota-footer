import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin/tui";
import { createFooterController } from "../src/footer.ts";
import { only, settle, stream } from "./helpers.ts";

const available = (observedAt = Date.now()) => ({
  windows: [{ windowMinutes: 300, remainingPercent: 80 }], observedAt,
});

function host(failAt?: "subscribe" | "listen") {
  let listener: ((event: { details: { type: string } }) => void) | undefined;
  let text = "";
  let stopped = false;
  let location = { directory: "/one" };
  const calls: Array<{ sessionID: string; location: unknown; signal: AbortSignal }> = [];
  const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const subscriptions: Array<{ events: ReturnType<typeof stream<{ location: typeof location }>>; signal: AbortSignal }> = [];
  const makeClient = () => only({
    rpc(definition: { id: string }) {
      assert.equal(definition.id, "opencode-quota-footer");
      return only({
        snapshot(input: { sessionID: string }, options: { location: unknown; signal: AbortSignal }) {
          calls.push({ ...input, ...options });
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        },
        events: only({
          subscribe(name: string, options: { signal: AbortSignal }) {
            assert.equal(name, "updated");
            if (failAt === "subscribe") throw Error("synthetic setup failure");
            const events = stream<{ location: typeof location }>(options.signal);
            subscriptions.push({ events, signal: options.signal });
            return events;
          },
        }),
      });
    },
  });
  let client = makeClient();
  const ctx = only({
    get client() { return client; },
    get location() { return location; },
    data: only({
      listen(handler: typeof listener) {
        if (failAt === "listen") throw Error("synthetic setup failure");
        listener = handler;
        return () => { stopped = true; listener = undefined; };
      },
      location: only({ default: () => location }),
    }),
  }) as unknown as Plugin.Context;
  const controller = createFooterController(ctx, (value) => { text = value; });
  return {
    controller, ctx, calls, pending, subscriptions,
    get text() { return text; },
    get stopped() { return stopped; },
    update(sessionID: string | undefined = "a", providerID: string | undefined = "openai") {
      controller.update(sessionID, providerID);
    },
    event(type: string) { listener?.({ details: { type } }); },
    updated(directory = location.directory) {
      subscriptions.at(-1)!.events.push({ location: { directory } });
    },
    changeClient() { client = makeClient(); },
    changeLocation() { location = { directory: "/two" }; },
  };
}

test("starts unavailable and queries only a selected OpenAI session", async () => {
  const h = host();
  assert.equal(h.text, "Codex unavailable");
  h.controller.update(undefined, "openai");
  h.update("a", "other");
  h.controller.update("a", undefined);
  assert.equal(h.calls.length, 0);
  h.update();
  assert.equal(h.text, "Codex unavailable");
  assert.equal(h.calls[0].sessionID, "a");
  assert.deepEqual(h.calls[0].location, { directory: "/one" });
  h.pending[0].resolve(available());
  await settle();
  assert.equal(h.text, "Codex 5h 80% left");
  h.controller.dispose();
});

test("updates refresh current session only at the current location", async () => {
  const h = host();
  h.update();
  h.pending[0].resolve(available());
  await settle();
  h.updated("/elsewhere");
  await settle();
  assert.equal(h.calls.length, 1);
  h.updated();
  await settle();
  assert.equal(h.calls[1].sessionID, "a");
  h.pending[1].resolve({ windows: [], observedAt: null });
  await settle();
  assert.equal(h.text, "Codex unavailable");
  h.controller.dispose();
});

test("session/provider navigation clears synchronously and aborts late results", async () => {
  const h = host();
  h.update();
  h.pending[0].resolve(available());
  await settle();
  h.update("b");
  assert.equal(h.text, "Codex unavailable");
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[1].sessionID, "b");
  h.update("b", "other");
  h.pending[1].resolve(available());
  await settle();
  assert.equal(h.text, "Codex unavailable");
  h.controller.dispose();
});

test("newer updates supersede pending older RPC results", async () => {
  const h = host();
  h.update();
  h.updated();
  await settle();
  h.pending[1].resolve({ windows: [], observedAt: null });
  await settle();
  h.pending[0].resolve(available());
  await settle();
  assert.equal(h.text, "Codex unavailable");
  h.controller.dispose();
});

test("RPC failure clears without exposing raw errors or immediate retries", async () => {
  const h = host();
  h.update();
  h.pending[0].resolve(available());
  await settle();
  h.updated();
  await settle();
  h.pending[1].reject(new Error("sensitive upstream error"));
  await settle();
  assert.equal(h.text, "Codex unavailable");
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("hard freshness expires quota even between minute reads", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = host();
  h.update();
  h.pending[0].resolve(available(-298999));
  await settle();
  assert.equal(h.text, "Codex 5h 80% left");
  t.mock.timers.tick(1);
  assert.equal(h.text, "Codex unavailable");
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("mounted OpenAI footer reads once per minute without model traffic", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = host();
  t.after(() => h.controller.dispose());
  h.update();
  h.pending[0].resolve(available());
  await settle();
  t.mock.timers.tick(59999);
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve(available());
  await settle();
  assert.equal(h.text, "Codex 5h 80% left");
  t.mock.timers.tick(60000);
  assert.equal(h.calls.length, 3);
});

test("minute reads supersede pending RPCs and cannot restore late old values", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = host();
  t.after(() => h.controller.dispose());
  h.update();
  t.mock.timers.tick(60000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].signal.aborted, true);
  h.pending[1].resolve({ windows: [], observedAt: null });
  h.pending[0].resolve(available());
  await settle();
  assert.equal(h.text, "Codex unavailable");
});

test("navigation and unload clear refresh and expiry work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = host();
  h.update();
  h.pending[0].resolve(available());
  await settle();
  h.update("a", "other");
  t.mock.timers.tick(600000);
  assert.equal(h.calls.length, 1);
  h.controller.update(undefined, "openai");
  t.mock.timers.tick(600000);
  assert.equal(h.calls.length, 1);
  h.update();
  h.pending[1].resolve(available());
  await settle();
  h.controller.dispose();
  t.mock.timers.tick(600000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.text, "Codex unavailable");
});

test("auth invalidation discards old values and the next minute reads fresh data", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const h = host();
  t.after(() => h.controller.dispose());
  h.update();
  h.event("credential.switched");
  h.pending[0].resolve(available());
  await settle();
  assert.equal(h.text, "Codex unavailable");
  t.mock.timers.tick(60000);
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve(available());
  await settle();
  assert.equal(h.text, "Codex 5h 80% left");
});

for (const value of [
  null, {}, { windows: [], observedAt: 1 },
  { windows: [{ windowMinutes: 0, remainingPercent: 80 }], observedAt: 1 },
  { windows: [{ windowMinutes: 300, remainingPercent: 101 }], observedAt: 1 },
  { windows: [{ windowMinutes: 300, remainingPercent: NaN }], observedAt: 1 },
  { windows: [{ windowMinutes: 300, remainingPercent: 80, secret: "no" }], observedAt: 1 },
  available(Date.now() - 300001), available(Date.now() + 60000),
]) {
  test("malformed, stale, or future RPC snapshots remain unavailable", async () => {
    const h = host();
    h.update();
    h.pending[0].resolve(value);
    await settle();
    assert.equal(h.text, "Codex unavailable");
    h.controller.dispose();
  });
}

for (const type of ["credential.updated", "credential.switched", "integration.updated", "provider.updated", "config.updated", "location.shutdown", "server.connected"]) {
  test(`${type} invalidates pending reads and waits for a fresh update`, async () => {
    const h = host();
    h.update();
    h.event(type);
    h.pending[0].resolve(available());
    await settle();
    assert.equal(h.text, "Codex unavailable");
    assert.equal(h.calls.length, 1);
    h.updated();
    await settle();
    h.pending[1].resolve(available());
    await settle();
    assert.equal(h.text, "Codex 5h 80% left");
    h.controller.dispose();
  });
}

for (const failure of ["fail", "end"] as const) {
  test(`RPC stream ${failure} clears, ignores in-flight data, and stops polling`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const h = host();
    h.update();
    h.subscriptions[0].events[failure]();
    await settle();
    h.pending[0].resolve(available());
    await settle();
    assert.equal(h.text, "Codex unavailable");
    t.mock.timers.tick(600000);
    assert.equal(h.calls.length, 1);
    h.controller.dispose();
  });
}

for (const change of ["changeClient", "changeLocation"] as const) {
  test(`${change} suppresses pending data even before the reactive update runs`, async () => {
    const h = host();
    h.update();
    h[change]();
    h.pending[0].resolve(available());
    await settle();
    assert.equal(h.text, "Codex unavailable");
    h.update();
    assert.equal(h.calls.length, 2);
    h.pending[1].resolve(available());
    await settle();
    assert.equal(h.text, "Codex 5h 80% left");
    h.controller.dispose();
  });
}

for (const change of ["changeClient", "changeLocation"] as const) {
  test(`${change} prevents minute reads using an obsolete client/location`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const h = host();
    t.after(() => h.controller.dispose());
    h.update();
    h[change]();
    t.mock.timers.tick(60000);
    assert.equal(h.calls.length, 1);
  });
}

test("disposal unsubscribes, aborts, clears the timeout, and suppresses late data", async () => {
  const h = host();
  h.update();
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.stopped, true);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.subscriptions[0].signal.aborted, true);
  h.pending[0].resolve(available());
  await settle();
  assert.equal(h.text, "Codex unavailable");
});

test("synchronous stream setup failure leaves no snapshot request or unhandled task", async () => {
  const h = host("subscribe");
  h.update();
  await settle();
  assert.equal(h.text, "Codex unavailable");
  assert.equal(h.calls.length, 0);
  h.controller.dispose();
  assert.equal(h.stopped, true);
});

test("public-listener setup failure happens before any asynchronous work is acquired", () => {
  assert.throws(() => host("listen"), /synthetic setup failure/);
});
