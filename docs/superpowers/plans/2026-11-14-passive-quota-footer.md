# Passive Quota Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an original, passive-only Codex quota indicator in OpenCode V2's prompt footer.

**Architecture:** The server observes quota headers on existing OpenAI HTTP responses and keeps a single session-tagged observation in memory. A narrow, validated RPC and update events supply the TUI; the TUI appends text to `prompt.footer` without replacing the built-in display. No external requests, credential APIs, or polling.

**Tech Stack:** TypeScript; official `@opencode/plugin` 2.3.0; host-compatible Solid/OpenTUI peers; JSON Schema; Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-14-passive-quota-footer-design.md`

## Global Constraints

- Write original code; do not copy, import, depend on, or fork the previously audited third-party plugin.
- Observe quota headers on existing OpenAI HTTP responses only.
- Do not initiate model requests, external network requests, polling, authentication, or token refresh.
- Do not read credentials, request bodies, conversation content, project files, or configuration files.
- Keep only normalized quota values in memory. Do not persist or log response headers, credentials, account identifiers, or raw upstream errors.
- Clear observations on authentication changes, disconnection, and plugin disposal.
- Use supported OpenCode V2 plugin APIs; target installed OpenCode 2.3.0.
- Contribute to `prompt.footer` without replacing built-in content or manipulating host renderables.
- Treat missing, invalid, expired, or unobservable quota data as unavailable, not zero.
- No automatic installation, global configuration edits, npm publishing, or live authenticated tests.
- Use only the official OpenCode SDK and its existing UI primitives at runtime. Avoid extra runtime dependencies.

## Review Focus

- A normal response lacks quota headers: previously displayed quota must become unavailable.
- Account/session/provider changes: clear the cache, invalidate request tags and reject responses crossing an observed authentication-change boundary.
- Malformed or partially present numeric headers: display valid windows only, without inherited values.
- No new response arrives: a local expiry timeout must clear the display without making requests.
- Navigation/disposal races: late RPC results must not restore stale text or leak subscriptions.

## File map

- `package.json`, `package-lock.json`, `tsconfig.json`: private source-distributed package, pinned development tooling and host peers.
- `src/quota.ts`: header validation, single-observation state, freshness and display formatting.
- `src/rpc.ts`: normalized JSON Schema RPC contract and update-event contract.
- `src/server.ts`: scoped passive response hook, cache invalidation, RPC registration and cleanup.
- `src/tui.tsx`: footer contribution, event-driven reads, expiry timer and cleanup.
- `tests/quota.test.ts`, `tests/server.test.ts`, `tests/footer.test.ts`: synthetic boundary and fake-host tests.
- `README.md`: behavior, security boundaries, limitations, checks and opt-in local loading instructions.

### Task 1: Validated quota observations

**Files:** Create package/tooling files, `src/quota.ts`, `tests/quota.test.ts`.

**Interfaces:**
- `QuotaWindow = { windowMinutes: number; remainingPercent: number }`.
- `QuotaSnapshot = { windows: QuotaWindow[]; observedAt: number | null }`.
- `parseQuotaHeaders(headers: Pick<Headers, "get">): QuotaWindow[]`.
- `formatQuota(snapshot: QuotaSnapshot): string`.
- `createQuotaState()` returns `observe(sessionID: string, headers: Pick<Headers, "get">, now: number): void`, `read(sessionID: string, now: number): QuotaSnapshot`, and `clear(): void`.
- State contains at most one observation. It expires at 300,000 ms; another session reads unavailable.

- [x] **Step 1: Write failing tests** for primary/secondary windows, partial windows, whitespace, missing headers, invalid/empty/NaN/infinite/out-of-range percentages, invalid durations, no inheritance, session mismatch, clear and expiry at exactly 300,000 ms.
  Pin formatting: 300-minute window at 20% used yields `Codex 5h 80% left`; 10,080-minute window at 90% used adds ` · 7d 10% left`; unavailable yields `Codex unavailable`.
- [x] **Step 2: Run the tests and confirm they fail because the new functions do not exist.**
- [x] **Step 3: Implement the interfaces.** Read only `x-codex-{primary,secondary}-{used-percent,window-minutes}`. Require finite percentages from 0 through 100 and positive integer minutes; round remaining percentages for display. Skip invalid windows. Replace, rather than merge, observations. Use returned durations for minute/hour/day labels.
- [x] **Step 4: Run `npm test` and `npm run typecheck`; require passing tests and no type errors.** Use pinned tooling, commit the lockfile, and install development dependencies only with lifecycle scripts disabled. Do not install or refer to the audited package.
- [x] **Step 5: Commit the completed task.**

### Task 2: Passive host integration and footer

**Files:** Create `src/rpc.ts`, `src/server.ts`, `src/tui.tsx`, `tests/server.test.ts`, `tests/footer.test.ts`, `README.md`; update package exports/scripts as required.

**Interfaces:**
- Consumes all Task 1 interfaces.
- Package exports `.` for server and `./tui` for TUI, using the official supported source-loading pipeline.
- RPC ID `opencode-quota-footer`; method `snapshot`, input `{sessionID: string}`, output `QuotaSnapshot`; event `updated` with empty-object payload.
- JSON Schema validates requests, outputs and events. Narrow unknown inputs at the boundary; never assert unvalidated RPC input into a trusted type.

- [x] **Step 1: Write failing fake-host tests** showing that an eligible OpenAI HTTP response updates the state, another provider does not, and a later response without quota headers clears it. Assert the original response/body is untouched and no generation, fetch, credential, storage or filesystem API is used.
- [x] **Step 2: Run those tests and confirm they fail because integration does not exist.**
- [x] **Step 3: Implement server setup** using `http.request` and `http.response` hooks scoped with `{providerID: "openai"}`. Tag Request objects in a WeakSet; never read request headers or bodies. Accept only a matching tagged response, then remove its tag. Authentication changes replace the WeakSet and clear state; mismatched request identity fails closed to unavailable. Register snapshot RPC and empty update events. Subscribe to `credential.updated`, `credential.switched`, `integration.updated`, `provider.updated` and `config.updated`; clear conservatively on these events, and on disposal. Abort the public-event subscription and dispose registrations on cleanup. Add tests for a pre-switch response arriving late and a response with unmatched request identity. Use published SDK 2.3.0 types, not the audited plugin.
- [x] **Step 4: Write failing footer-controller tests** for initial unavailable text, current-session refresh after updates, session/provider change clearing, RPC failure, local expiry without another response, and disposal/navigation during pending RPC. Test behavior through fake APIs, not source-code regex assertions.
- [x] **Step 5: Implement the footer contribution** with `append: "prompt.footer"` and host theme tokens. Read cached quota only for a currently selected OpenAI session. Use update events/navigation to refresh and a single local expiry timeout; no interval or network polling. Suppress late results after context changes/disposal. Keep JSX presentation minimal; extract lifecycle logic only if needed to exercise it without a live terminal.
- [x] **Step 6: Document security boundaries and limitations.** Explain unavailable quota for transports/auth methods without headers, HTTP-only observation, five-minute freshness, fail-closed request-identity matching, event-based invalidation limitations, and the absence of active fetching. Describe manual local loading without editing user configuration. Document source transpilation by OpenCode and any build verification accurately.
- [x] **Step 7: Verify `npm test`, `npm run typecheck`, the supported build check, and `npm pack --dry-run --ignore-scripts`.** Inspect the package file list, production imports, dependency lifecycle scripts, and git diff. Require no secrets, generated noise, audited-repository references in product code, or automatic installers. Live loading remains explicitly untested.
- [x] **Step 8: Commit the completed task.**

## Review and delivery

Use fresh task reviewers and a final security/quality review. Report test/type
check/package evidence and limitations accurately. Keep the finished project
local and uninstalled; do not modify the user's OpenCode configuration or load
the plugin without permission.

## Plan self-review

All approved requirements map to the two tasks. Shared interfaces are defined
above and consumed unchanged. Each review-focus item has a behavioral test.
The first version deliberately excludes active requests and WebSocket handling.
The remaining builder choices are the host-compatible development versions and
the smallest officially supported source-loading/type-check pipeline.

## Confirmed SDK decisions

Official SDK 2.3.0 exposes `event.sessionID`, `event.model.providerID`,
`event.request` and `event.response` on HTTP response hooks, but no account
identity. Hook registrations return an asynchronous `dispose()`. Source
`.ts`/`.tsx` package exports are officially supported, so no bundler is needed.
Pin development OpenTUI packages to `0.8.4` and Solid to `1.9.17`, matching SDK
2.3.0's own development metadata; do not advertise untested OpenTUI 0.9 support.
Use explicit RPC input/output schemas and top-level events despite looser prose
in the current docs. Versioned SDK declarations take precedence.
