import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Plugin } from "@opencode/plugin";
import server from "../src/server.ts";
import { only, settle, stream } from "./helpers.ts";

const unavailable = { windows: [], observedAt: null };
const windows = [{ windowMinutes: 10080, remainingPercent: 94 }];
const connection = (id = "account-a", method = "oauth") => ({ type: "credential", id, label: "Fake account", method });
const credential = (methodID = "chatgpt-headless") => ({
  type: "oauth", methodID, access: "fake-token", refresh: "unused-refresh", expires: 9999999999999,
  metadata: { accountID: "fake-account" },
});
const invalidations = [
  "credential.updated", "credential.switched", "integration.updated",
  "provider.updated", "config.updated", "location.shutdown",
];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

async function host(t: TestContext, failAt?: string) {
  let selected: unknown = connection();
  let auth: unknown = credential();
  let active = async (): Promise<unknown> => selected;
  let resolve = async (): Promise<unknown> => auth;
  let fetch = async (): Promise<Response> => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 604800 } },
  }));
  const requests: Array<{ url: unknown; options: RequestInit }> = [];
  const resolutions: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url, options: options! });
    return fetch();
  });
  const disposed: string[] = [];
  const emitted: unknown[][] = [];
  const emissions: Array<() => void> = [];
  let snapshot: (input: unknown) => Promise<unknown> = async () => { throw Error("missing RPC"); };
  let signal: AbortSignal | undefined;
  let events: ReturnType<typeof stream<{ type: string }>> | undefined;
  let types: string[] = [];
  const context = only({
    integration: only({ connection: only({
      async active(id: string) { assert.equal(id, "openai"); return active(); },
      async resolve(value: unknown) { resolutions.push(value); return resolve(); },
    }) }),
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
            if (failAt === "pending emit") await new Promise<void>((done) => emissions.push(done));
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
  try { cleanup = await server.setup(context as unknown as Plugin.Context); }
  catch (error) { setupError = error; }
  const h = {
    disposed, emitted, emissions, setupError, requests, resolutions,
    get signal() { return signal; },
    get events() { return events!; },
    get types() { return types; },
    set selected(value: unknown) { selected = value; },
    set auth(value: unknown) { auth = value; },
    set active(value: typeof active) { active = value; },
    set resolve(value: typeof resolve) { resolve = value; },
    set fetch(value: typeof fetch) { fetch = value; },
    read: (input: unknown = { sessionID: "a" }) => snapshot(input),
    async cleanup() { if (cleanup) await cleanup(); },
  };
  t.after(async () => { for (const release of emissions) release(); await h.cleanup(); });
  return h;
}

for (const method of ["chatgpt-headless", "chatgpt-browser"]) {
  test(`${method} resolves only active OAuth and uses metadata.accountID`, async (t) => {
    const h = await host(t);
    assert.ifError(h.setupError);
    h.auth = credential(method);
    const value = await h.read() as { windows: unknown[]; observedAt: number };
    assert.deepEqual(value.windows, windows);
    assert.equal(typeof value.observedAt, "number");
    assert.deepEqual(h.resolutions, [connection()]);
    const headers = new Headers(h.requests[0].options.headers);
    assert.equal(headers.get("authorization"), "Bearer fake-token");
    assert.equal(headers.get("chatgpt-account-id"), "fake-account");
    assert.equal(JSON.stringify(value).includes("fake-"), false);
    assert.deepEqual(h.emitted, [], "snapshot must not trigger update/snapshot loops");
  });
}

for (const selected of [undefined, { type: "env", name: "OPENAI_API_KEY" }, connection("key", "key"), connection("external", "external"), connection("unknown", "other")]) {
  test("unsupported active connection never resolves or fetches", async (t) => {
    const h = await host(t);
    h.selected = selected;
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.resolutions.length, 0);
    assert.equal(h.requests.length, 0);
  });
}

for (const auth of [
  undefined, { type: "key", key: "unused-key" }, { type: "external", methodID: "chatgpt-headless" },
  credential("chatgpt-token-sharing"), credential("unknown"), { ...credential(), methodID: undefined },
  { ...credential(), access: "" }, { ...credential(), access: undefined },
  { ...credential(), access: "bad\nheader" }, { ...credential(), metadata: undefined },
  { ...credential(), metadata: { accountId: "wrong-case" } },
  ...["", 42, null, "bad\rheader"].map((accountID) => ({ ...credential(), metadata: { accountID } })),
]) {
  test("unsupported/malformed resolved credentials never fetch", async (t) => {
    const h = await host(t);
    h.auth = auth;
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.requests.length, 0);
  });
}

test("successes coalesce across sessions, clone output and throttle for exactly one minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const h = await host(t);
  const gate = deferred<unknown>();
  h.resolve = () => gate.promise;
  const first = h.read();
  const second = h.read({ sessionID: "b" });
  await settle();
  assert.equal(h.resolutions.length, 1);
  gate.resolve(credential());
  assert.deepEqual(await first, { windows, observedAt: 1000 });
  const copy = await second as { windows: Array<{ remainingPercent: number }> };
  copy.windows[0].remainingPercent = 0;
  t.mock.timers.tick(59999);
  assert.deepEqual(await h.read(), { windows, observedAt: 1000 });
  assert.equal(h.requests.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await h.read(), { windows, observedAt: 61000 });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.emitted, []);
});

for (const failure of ["http", "resolve", "schema", "stream"]) {
  test(`${failure} failures clear older quota and throttle failed attempts for one minute`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const h = await host(t);
    assert.deepEqual(await h.read(), { windows, observedAt: 1000 });
    t.mock.timers.tick(60000);
    if (failure === "resolve") h.resolve = async () => { throw Error("sensitive host error"); };
    else if (failure === "stream") h.fetch = async () => new Response(new ReadableStream({
      start(c) { c.error(Error("sensitive stream error")); },
    }));
    else h.fetch = async () => new Response("sensitive response", { status: failure === "http" ? 401 : 200 });
    assert.deepEqual(await h.read(), unavailable);
    const attempts = h.resolutions.length;
    t.mock.timers.tick(59999);
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.resolutions.length, attempts);
    t.mock.timers.tick(1);
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.resolutions.length, attempts + 1);
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`${outcome} attempts stay throttled through repeated same-account invalidations`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const h = await host(t);
    if (outcome === "failure") h.fetch = async () => new Response(null, { status: 429 });
    assert.deepEqual(await h.read(), outcome === "success" ? { windows, observedAt: 1000 } : unavailable);
    t.mock.timers.tick(1000);
    for (const type of [...invalidations, ...invalidations]) {
      h.events.push({ type });
      await settle();
      const value = await h.read();
      assert.equal(h.requests.length, 1, `${type} must not reset the GET throttle`);
      assert.equal(h.resolutions.length, 1);
      assert.deepEqual(value, unavailable, "invalidated quota must never be displayed");
    }
    t.mock.timers.tick(58999);
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.requests.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await h.read(), outcome === "success" ? { windows, observedAt: 61000 } : unavailable);
    assert.equal(h.requests.length, 2);
    assert.equal(h.resolutions.length, 2);
  });

  test(`${outcome} attempt followed by invalidation still permits a different account immediately`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const h = await host(t);
    if (outcome === "failure") h.fetch = async () => new Response(null, { status: 429 });
    await h.read();
    h.events.push({ type: "credential.switched" });
    await settle();
    h.selected = connection("b");
    h.auth = { ...credential(), metadata: { accountID: "fake-account-b" } };
    const value = await h.read();
    assert.equal(h.requests.length, 2);
    assert.equal(h.resolutions.length, 2);
    assert.equal(new Headers(h.requests[1].options.headers).get("chatgpt-account-id"), "fake-account-b");
    assert.deepEqual(value, outcome === "success" ? { windows, observedAt: 1000 } : unavailable);
  });
}

for (const delay of [1000, 300000, 360001]) {
  test(`post-fetch identity delay of ${delay}ms cannot advance quota observation time`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const h = await host(t);
    const gate = deferred<unknown>();
    let checks = 0;
    h.active = async () => ++checks === 3 ? gate.promise : connection();
    const result = h.read();
    await settle();
    assert.equal(checks, 3, "hold the identity check after the bounded quota read");
    assert.equal(h.requests.length, 1);
    t.mock.timers.tick(delay);
    gate.resolve(connection());
    assert.deepEqual(await result, delay < 300000 ? { windows, observedAt: 1000 } : unavailable);
  });
}

for (const [phase, throwAt] of [["initial", 1], ["pre-fetch", 2], ["post-fetch", 3], ["final", 4]] as const) {
  test(`${phase} identity lookup failure discards quota without resetting the attempt throttle`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const h = await host(t);
    if (phase === "initial") await h.read();
    let calls = 0;
    h.active = async () => {
      if (++calls === throwAt) throw Error("sensitive host lookup failure");
      return connection();
    };
    assert.deepEqual(await h.read(), unavailable);
    const requests = phase === "pre-fetch" ? 0 : 1;
    assert.equal(h.requests.length, requests);
    const next = await h.read({ sessionID: "b" });
    assert.equal(h.requests.length, requests);
    assert.deepEqual(next, unavailable);
    assert.equal(h.resolutions.length, 1);
    t.mock.timers.tick(59999);
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.requests.length, requests);
    assert.equal(h.resolutions.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await h.read(), { windows, observedAt: 61000 });
    assert.equal(h.requests.length, requests + 1);
    assert.equal(h.resolutions.length, 2);
  });
}

test("active account switches without an event never reuse an earlier account's cache", async (t) => {
  const h = await host(t);
  await h.read();
  h.selected = connection("account-b");
  h.auth = { ...credential(), metadata: { accountID: "fake-account-b" } };
  assert.deepEqual((await h.read() as { windows: unknown[] }).windows, windows);
  assert.equal(h.requests.length, 2);
  assert.equal(new Headers(h.requests[1].options.headers).get("chatgpt-account-id"), "fake-account-b");
  h.selected = connection("key", "key");
  assert.deepEqual(await h.read(), unavailable);
  assert.equal(h.requests.length, 2);
});

test("a new account lookup aborts old in-flight work without letting it clear the new cache", async (t) => {
  const h = await host(t);
  const gate = deferred<Response>();
  h.fetch = () => gate.promise;
  const old = h.read();
  await settle();
  const oldSignal = h.requests[0].options.signal!;
  h.selected = connection("b");
  h.auth = { ...credential(), metadata: { accountID: "fake-account-b" } };
  h.fetch = async () => new Response(JSON.stringify({
    rate_limit: { secondary_window: { used_percent: 25, limit_window_seconds: 3600 } },
  }));
  const fresh = await h.read({ sessionID: "b" });
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(await old, unavailable);
  gate.resolve(new Response("{}"));
  await settle();
  assert.deepEqual((fresh as { windows: unknown[] }).windows, [{ windowMinutes: 60, remainingPercent: 75 }]);
  assert.deepEqual(await h.read(), fresh);
  assert.equal(h.requests.length, 2);
});

for (const phase of ["resolve", "fetch", "cached"] as const) {
  test(`active identity is rechecked after ${phase} even without delivered events`, async (t) => {
    const h = await host(t);
    if (phase === "resolve") h.resolve = async () => { h.selected = connection("b"); return credential(); };
    if (phase === "fetch") h.fetch = async () => {
      h.selected = connection("b");
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 604800 } } }));
    };
    if (phase === "cached") {
      await h.read();
      let calls = 0;
      h.active = async () => connection(++calls === 1 ? "account-a" : "b");
    }
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.requests.length, phase === "resolve" ? 0 : 1);
  });
}

for (const type of invalidations) {
  test(`${type} aborts fetched data, invalidates cache and emits only an empty update`, async (t) => {
    const h = await host(t);
    assert.ok(h.types.includes(type));
    const gate = deferred<Response>();
    h.fetch = () => gate.promise;
    const result = h.read();
    await settle();
    const signal = h.requests[0].options.signal!;
    h.events.push({ type });
    await settle();
    assert.equal(signal.aborted, true);
    gate.resolve(new Response("{}"));
    assert.deepEqual(await result, unavailable);
    assert.deepEqual(h.emitted, [["updated", {}]]);
  });
}

test("invalidation during resolve suppresses old auth without discarding the new generation", async (t) => {
  const h = await host(t);
  const gate = deferred<unknown>();
  h.resolve = () => gate.promise;
  const old = h.read();
  await settle();
  h.events.push({ type: "credential.switched" });
  await settle();
  h.selected = connection("b");
  h.resolve = async () => credential();
  const fresh = await h.read();
  gate.resolve(credential());
  assert.deepEqual(await old, unavailable);
  assert.deepEqual(await h.read(), fresh);
  assert.equal(h.requests.length, 1);
});

for (const action of ["invalidate", "dispose"] as const) {
  for (const phase of ["initial", "resolve", "pre-fetch", "post-fetch", "final", "cached-final"] as const) {
    test(`${action} releases snapshots waiting for uncancellable SDK ${phase}`, async (t) => {
      const h = await host(t);
      const gate = deferred<unknown>();
      if (phase === "cached-final") await h.read();
      const checks = { initial: 1, "pre-fetch": 2, "post-fetch": 3, final: 4, "cached-final": 2 };
      let calls = 0;
      if (phase === "resolve") h.resolve = () => gate.promise;
      else h.active = async () => ++calls === checks[phase] ? gate.promise : connection();
      let returned = false;
      const result = h.read().then((value) => { returned = true; return value; });
      await settle();
      const requests = phase === "post-fetch" || phase === "final" || phase === "cached-final" ? 1 : 0;
      assert.equal(h.requests.length, requests);
      if (action === "dispose") await h.cleanup();
      else h.events.push({ type: "credential.switched" });
      await settle();
      try {
        assert.equal(returned, true, `RPC must not wait for the host's uncancellable ${phase}`);
        assert.deepEqual(await result, unavailable);
      } finally {
        gate.resolve(phase === "resolve" ? credential() : connection());
        await result;
      }
      await settle();
      assert.equal(h.requests.length, requests, "late host results must not start another GET");
    });
  }
}

test("invalidation during a pending final identity check cannot republish cached quota", async (t) => {
  const h = await host(t);
  await h.read();
  let calls = 0;
  const gate = deferred<unknown>();
  h.active = async () => ++calls === 1 ? connection() : gate.promise;
  let returned = false;
  const result = h.read().then((value) => { returned = true; return value; });
  await settle();
  h.events.push({ type: "credential.switched" });
  await settle();
  try {
    assert.equal(returned, true, "final lookup cancellation must not depend on releasing the host gate");
    assert.deepEqual(await result, unavailable);
  } finally {
    gate.resolve(connection());
    await result;
  }
});

test("RPC input rejects malformed/extra fields before any credential resolution", async (t) => {
  const h = await host(t);
  for (const input of [
    null, {}, [], { sessionID: 1 }, { sessionID: "" }, { sessionID: "a", extra: true },
    Object.assign([], { sessionID: "a" }),
    Object.assign(Object.create({ sessionID: "a" }), { extra: true }),
  ]) await assert.rejects(h.read(input), { message: "Invalid snapshot input" });
  assert.equal(h.resolutions.length, 0);
});

for (const failure of ["fail", "end"] as const) {
  test(`event stream ${failure} aborts work and disables lookups until reload`, async (t) => {
    const h = await host(t);
    h.fetch = () => new Promise<Response>(() => {});
    const result = h.read();
    await settle();
    h.events[failure]();
    await settle();
    assert.deepEqual(await result, unavailable);
    assert.deepEqual(await h.read(), unavailable);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.signal?.aborted, true);
  });
}

test("cleanup aborts work/subscription, disposes RPC once and disables captured snapshots", async (t) => {
  const h = await host(t);
  h.fetch = () => new Promise<Response>(() => {});
  const result = h.read();
  await settle();
  await h.cleanup();
  await h.cleanup();
  assert.deepEqual(await result, unavailable);
  assert.equal(h.signal?.aborted, true);
  assert.deepEqual(h.disposed, ["rpc"]);
  assert.equal(h.requests[0].options.signal?.aborted, true);
  assert.deepEqual(await h.read(), unavailable);
});

for (const failAt of ["rpc", "subscribe"]) {
  test(`partial setup failure at ${failAt} releases acquired resources`, async (t) => {
    const h = await host(t, failAt);
    assert.ok(h.setupError);
    if (h.signal) assert.equal(h.signal.aborted, true);
  });
}

test("update emission failure clears quota and disables unsafe reads", async (t) => {
  const h = await host(t, "emit");
  await h.read();
  h.events.push({ type: "config.updated" });
  await settle();
  assert.deepEqual(await h.read(), unavailable);
  assert.equal(h.requests.length, 1);
});

test("slow notification cannot block later invalidation or unload", async (t) => {
  const h = await host(t, "pending emit");
  await h.read();
  h.events.push({ type: "config.updated" });
  h.events.push({ type: "credential.switched" });
  await settle();
  assert.deepEqual(h.emitted, [["updated", {}], ["updated", {}]]);
  await h.cleanup();
  assert.deepEqual(await h.read(), unavailable);
});
