import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaState, formatQuota, parseQuotaHeaders } from "../src/quota.ts";

const primary = {
  "x-codex-primary-used-percent": "20",
  "x-codex-primary-window-minutes": "300",
};
const secondary = {
  "x-codex-secondary-used-percent": "90",
  "x-codex-secondary-window-minutes": "10080",
};
const unavailable = { windows: [], observedAt: null };

test("parses primary and secondary in their display order", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({ ...secondary, ...primary })), [
    { windowMinutes: 300, remainingPercent: 80 },
    { windowMinutes: 10080, remainingPercent: 10 },
  ]);
});

test("accepts either complete window without the other", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers(primary)), [
    { windowMinutes: 300, remainingPercent: 80 },
  ]);
  assert.deepEqual(parseQuotaHeaders(new Headers(secondary)), [
    { windowMinutes: 10080, remainingPercent: 10 },
  ]);
});

test("accepts surrounding whitespace and retains fractional remaining quota", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({
    "x-codex-primary-used-percent": " 20.25 ",
    "x-codex-primary-window-minutes": " 300 ",
  })), [{ windowMinutes: 300, remainingPercent: 79.75 }]);
});

test("accepts both inclusive percentage boundaries", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({
    ...primary,
    ...secondary,
    "x-codex-primary-used-percent": "0",
    "x-codex-secondary-used-percent": "100",
  })), [
    { windowMinutes: 300, remainingPercent: 100 },
    { windowMinutes: 10080, remainingPercent: 0 },
  ]);
});

test("missing headers do not imply zero usage", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers()), []);
});

for (const missing of Object.keys(primary)) {
  test(`rejects a partial primary window missing ${missing}`, () => {
    const headers = new Headers(primary);
    headers.delete(missing);
    assert.deepEqual(parseQuotaHeaders(headers), []);
  });
}

test("never combines values from different windows", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({
    "x-codex-primary-used-percent": "20",
    "x-codex-secondary-window-minutes": "300",
  })), []);
});

for (const value of ["", " ", "invalid", "NaN", "Infinity", "-Infinity", "-0.1", "100.1", "20%", "1,2"]) {
  test(`rejects invalid used percentage ${JSON.stringify(value)} without losing secondary`, () => {
    assert.deepEqual(parseQuotaHeaders(new Headers({
      ...primary,
      ...secondary,
      "x-codex-primary-used-percent": value,
    })), [{ windowMinutes: 10080, remainingPercent: 10 }]);
  });
}

for (const value of ["", " ", "invalid", "NaN", "Infinity", "-Infinity", "0", "-1", "1.5"]) {
  test(`rejects invalid duration ${JSON.stringify(value)}`, () => {
    assert.deepEqual(parseQuotaHeaders(new Headers({
      ...primary,
      "x-codex-primary-window-minutes": value,
    })), []);
  });
}

test("skips an invalid secondary window without losing primary", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers({
    ...primary,
    ...secondary,
    "x-codex-secondary-used-percent": "101",
  })), [{ windowMinutes: 300, remainingPercent: 80 }]);
});

test("reads only the four documented quota headers", () => {
  const allowed = new Set([...Object.keys(primary), ...Object.keys(secondary)]);
  const values = new Headers({
    ...primary,
    "x-ratelimit-remaining-requests": "0",
    "x-codex-primary-reset-at": "0",
  });
  const headers = {
    get(name: string) {
      assert.ok(allowed.has(name), `unexpected header read: ${name}`);
      return values.get(name);
    },
  };
  assert.deepEqual(parseQuotaHeaders(headers), [
    { windowMinutes: 300, remainingPercent: 80 },
  ]);
});

test("formats the pinned five-hour and weekly labels as remaining", () => {
  assert.equal(formatQuota({
    windows: [{ windowMinutes: 300, remainingPercent: 80 }],
    observedAt: 0,
  }), "Codex 5h 80% left");
  assert.equal(formatQuota({
    windows: [
      { windowMinutes: 300, remainingPercent: 80 },
      { windowMinutes: 10080, remainingPercent: 10 },
    ],
    observedAt: 0,
  }), "Codex 5h 80% left · 7d 10% left");
});

test("formats unavailable without pretending quota is zero", () => {
  assert.equal(formatQuota(unavailable), "Codex unavailable");
});

for (const [windowMinutes, label] of [
  [1, "1m"],
  [90, "90m"],
  [120, "2h"],
  [1440, "1d"],
] as const) {
  test(`derives ${label} from the observed duration and rounds remaining for display`, () => {
    assert.equal(formatQuota({
      windows: [{ windowMinutes, remainingPercent: 79.75 }],
      observedAt: 0,
    }), `Codex ${label} 80% left`);
  });
}

test("starts unavailable", () => {
  assert.deepEqual(createQuotaState().read("session-a", 0), unavailable);
});

test("retains only normalized quota and the observation time", () => {
  const state = createQuotaState();
  const headers = new Headers(primary);
  state.observe("session-a", headers, 100);
  headers.set("x-codex-primary-used-percent", "100");
  assert.deepEqual(state.read("session-a", 101), {
    windows: [{ windowMinutes: 300, remainingPercent: 80 }],
    observedAt: 100,
  });
});

test("returned snapshots cannot mutate the stored normalized observation", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  const snapshot = state.read("session-a", 1);
  snapshot.windows[0].remainingPercent = -1;
  snapshot.windows.length = 0;
  assert.deepEqual(state.read("session-a", 2), {
    windows: [{ windowMinutes: 300, remainingPercent: 80 }],
    observedAt: 0,
  });
});

test("another session cannot read the latest observation", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  assert.deepEqual(state.read("session-b", 1), unavailable);
  assert.equal(formatQuota(state.read("session-a", 1)), "Codex 5h 80% left");
});

test("keeps at most one session's observation", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  state.observe("session-b", new Headers(secondary), 1);
  assert.deepEqual(state.read("session-a", 2), unavailable);
  assert.equal(formatQuota(state.read("session-b", 2)), "Codex 7d 10% left");
});

test("partial later observations do not inherit earlier windows", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers({ ...primary, ...secondary }), 0);
  state.observe("session-a", new Headers(secondary), 1);
  assert.deepEqual(state.read("session-a", 2), {
    windows: [{ windowMinutes: 10080, remainingPercent: 10 }],
    observedAt: 1,
  });
});

for (const headers of [
  new Headers(),
  new Headers({ "x-codex-primary-used-percent": "10" }),
  new Headers({ ...primary, "x-codex-primary-used-percent": "NaN" }),
]) {
  test(`a later unavailable response clears earlier quota (${JSON.stringify([...headers])})`, () => {
    const state = createQuotaState();
    state.observe("session-a", new Headers(primary), 0);
    state.observe("session-a", headers, 1);
    assert.deepEqual(state.read("session-a", 2), unavailable);
  });
}

test("does not inherit a missing half-window from an earlier response", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  state.observe("session-a", new Headers({
    "x-codex-primary-used-percent": "30",
    ...secondary,
  }), 1);
  assert.deepEqual(state.read("session-a", 2), {
    windows: [{ windowMinutes: 10080, remainingPercent: 10 }],
    observedAt: 1,
  });
});

test("expires at exactly 300,000 milliseconds, not one millisecond earlier", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 123);
  assert.equal(formatQuota(state.read("session-a", 300122)), "Codex 5h 80% left");
  assert.deepEqual(state.read("session-a", 300123), unavailable);
  assert.deepEqual(state.read("session-a", 300124), unavailable);
});

test("a fresh observation restarts the freshness limit", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  state.observe("session-a", new Headers(secondary), 299999);
  assert.equal(formatQuota(state.read("session-a", 300000)), "Codex 7d 10% left");
});

test("clear invalidates observations and permits a later fresh observation", () => {
  const state = createQuotaState();
  state.observe("session-a", new Headers(primary), 0);
  state.clear();
  state.clear();
  assert.deepEqual(state.read("session-a", 1), unavailable);
  state.observe("session-a", new Headers(secondary), 2);
  assert.equal(formatQuota(state.read("session-a", 3)), "Codex 7d 10% left");
});
