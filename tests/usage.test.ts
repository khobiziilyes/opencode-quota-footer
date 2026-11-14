import assert from "node:assert/strict";
import { test } from "node:test";
import * as usage from "../src/usage.ts";

const valid = { used_percent: 6, limit_window_seconds: 604800 };
const body = (primary: unknown = valid, secondary?: unknown) => JSON.stringify({
  rate_limit: { primary_window: primary, secondary_window: secondary },
});
const read = (signal = new AbortController().signal, token = "fake-token", account = "fake-account") =>
  usage.fetchQuotaUsage(token, account, signal);

test("reads only the fixed GET endpoint with scoped headers and forbidden redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.body, undefined);
    assert.deepEqual(Object.fromEntries(new Headers(options?.headers)), {
      accept: "application/json", authorization: "Bearer fake-token", "chatgpt-account-id": "fake-account",
    });
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(body());
  });
  assert.deepEqual(await read(), [{ windowMinutes: 10080, remainingPercent: 94 }]);
});

test("preserves two-window order, inclusive percentages and actual durations", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(body(
    { used_percent: 0, limit_window_seconds: 5400 },
    { used_percent: 100, limit_window_seconds: 120 },
  )));
  assert.deepEqual(await read(), [
    { windowMinutes: 90, remainingPercent: 100 }, { windowMinutes: 2, remainingPercent: 0 },
  ]);
});

for (const invalid of [
  null, {}, { used_percent: 1 }, { limit_window_seconds: 60 },
  ...["6", null, -1, 101, Infinity, NaN].map((used_percent) => ({ ...valid, used_percent })),
  ...["60", null, 0, -60, 61, 90, 1.5, Number.MAX_SAFE_INTEGER + 1].map((limit_window_seconds) => ({ ...valid, limit_window_seconds })),
]) {
  test(`invalid/partial primary never inherits secondary values: ${JSON.stringify(invalid)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(body(invalid, valid)));
    assert.deepEqual(await read(), [{ windowMinutes: 10080, remainingPercent: 94 }]);
  });
}

for (const text of ["sensitive malformed response", "null", "[]", "{}", '{"rate_limit":{}}', body({ used_percent: 6 }, { limit_window_seconds: 60 })]) {
  test("malformed JSON/schema throws only a sanitized local error", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(text));
    await assert.rejects(read(), { message: "Quota unavailable" });
  });
}

for (const status of [201, 204, 302, 401, 429, 500]) {
  test(`non-200 status ${status} is unavailable without reading upstream content`, async (t) => {
    let cancelled = false;
    const response = new Response(status === 204 ? null : new ReadableStream({
      cancel() { cancelled = true; },
    }), { status });
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(read(), { message: "Quota unavailable" });
    if (status !== 204) assert.equal(cancelled, true);
  });
}

test("network errors do not expose raw messages or causes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw Error("secret-token upstream"); });
  await assert.rejects(read(), (error: Error) => {
    assert.equal(error.message, "Quota unavailable");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("stream read errors are sanitized and release the reader", async (t) => {
  const source = new ReadableStream({ start(c) { c.error(Error("sensitive upstream stream error")); } });
  t.mock.method(globalThis, "fetch", async () => new Response(source));
  await assert.rejects(read(), { message: "Quota unavailable" });
  assert.equal(source.locked, false);
});

for (const [token, account] of [
  ["", "account"], ["token", ""], ["token\r\ninjected", "account"],
  ["token", "account\ninjected"], [" token", "account"], ["token", "é"],
  ["token\n", "account"], ["token", "account\r\n"], ["token\t", "account"],
]) {
  test("invalid/header-injection credentials fail before fetch", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw Error("must not fetch"); });
    await assert.rejects(read(undefined, token, account), { message: "Quota unavailable" });
    assert.equal(calls, 0);
  });
}

test("accepts exactly 131072 bytes and cancels/release-locks a chunked oversized body", async (t) => {
  const text = body().padEnd(131072, " ");
  let cancelled = false;
  let pulls = 0;
  let source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? text : "é"));
    },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(source));
  await assert.rejects(read(), { message: "Quota unavailable" });
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
  assert.ok(pulls <= 3, "must stop consuming at byte cap");
  source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  assert.deepEqual(await read(), [{ windowMinutes: 10080, remainingPercent: 94 }]);
  assert.equal(source.locked, false);
});

test("rejects a declared oversized body without consuming it", async (t) => {
  let cancelled = false;
  const source = new ReadableStream({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "content-length": "131073" } }));
  await assert.rejects(read(), { message: "Quota unavailable" });
  assert.equal(cancelled, true);
});

test("ten-second deadline aborts a pending fetch and sanitizes its failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    signal = options!.signal!;
    return new Promise<Response>(() => {});
  });
  const result = assert.rejects(read(), { message: "Quota unavailable" });
  t.mock.timers.tick(9999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await result;
  assert.equal(signal?.aborted, true);
});

test("deadline also cancels a stalled response stream and releases its reader", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const source = new ReadableStream({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, "fetch", async () => new Response(source));
  const result = assert.rejects(read(), { message: "Quota unavailable" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10000);
  await result;
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
});

test("caller cancellation works before fetch and during a response stream", async (t) => {
  const abort = new AbortController();
  let calls = 0;
  let cancelled = false;
  const source = new ReadableStream({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(source); });
  const result = assert.rejects(read(abort.signal), { message: "Quota unavailable" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await result;
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
  await assert.rejects(read(abort.signal), { message: "Quota unavailable" });
  assert.equal(calls, 1);
});

test("successful reads remove the deadline and parent cancellation listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, options?: RequestInit) => {
    signal = options!.signal!;
    return new Response(body());
  });
  const parent = new AbortController();
  await read(parent.signal);
  parent.abort();
  t.mock.timers.tick(10000);
  assert.equal(signal?.aborted, false);
});
