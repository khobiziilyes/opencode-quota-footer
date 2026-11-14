# Authenticated Quota Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed quota footer obtain actual account limits from the verified legacy Codex quota endpoint without inference requests.

**Architecture:** Replace passive hooks with a bounded authenticated quota reader behind the existing snapshot RPC. The server resolves only the active connection, caches/coalesces per account for 60 seconds, and invalidates old work on public changes. The existing footer requests fresh snapshots every minute while visible.

**Tech Stack:** Existing TypeScript, OpenCode SDK 2.3.0, built-in fetch/Node tests, existing Solid/OpenTUI.

**Spec:** `docs/superpowers/specs/2026-11-14-active-quota-design.md`

## Global Constraints

- Write original code; do not copy or depend on CodexBar or the previously audited plugin.
- Use only the active OpenCode OpenAI connection through the supported SDK; never read credential files or fall back to another account.
- Allow only legacy OAuth methods `chatgpt-browser` and `chatgpt-headless` before any quota request; reject token-sharing, API-key, external, and unknown methods.
- Send credentials only to `https://chatgpt.com/backend-api/wham/usage`, using GET, forbidden redirects, a 10-second deadline, and at most 131,072 response bytes.
- Use `metadata.accountID` for `ChatGPT-Account-Id`; fail closed when it or the access token is absent or invalid.
- Never generate model requests, perform login/logout, implement token refresh, modify authentication files, log secrets/raw responses, consume reset credits, or add runtime dependencies.
- SDK resolution may perform OpenCode-managed refresh of its existing credential; document this accurately rather than promising no authentication side effects.
- Keep normalized quota in memory only; transmit no credential/account identifiers over the plugin RPC.
- Preserve the existing additive themed footer and RPC shapes; five-minute UI freshness remains a hard upper limit.
- Cancel pending work on invalidation/unload and suppress results from old account/context generations.
- Do not revert or commit the pre-existing deletion of the old tracked Task 2 report.
- No publishing, global configuration changes, or unrelated source changes.

## Review Focus

- A successful legacy read followed by token-sharing/key/unknown auth must not send credentials or reuse the previous quota.
- Account switches during resolution, fetching, or pending cached reads must not publish the old account.
- Repeated failures, update events and simultaneous sessions must not cause unbounded endpoint traffic.
- A stalled or oversized response must be bounded even when content-length is absent or false.
- Timer/event/navigation races and disposal must neither poll in the background after unmount nor restore obsolete data.

## File map

- Create `src/usage.ts`, `tests/usage.test.ts`: bounded HTTP reader and response validation.
- Modify `src/server.ts`, `tests/server.test.ts`, relevant `tests/helpers.ts`: active-connection source, account cache/coalescing/throttle, invalidation/cleanup; remove obsolete passive hook assertions.
- Modify `src/footer.ts`, `tests/footer.test.ts`, `tests/tui.test.ts` only as necessary: minute refresh lifecycle with existing freshness and current-client/context guards.
- Modify `README.md`: source, auth limitations/host refresh, live verification vs unverified rendering, checks.
- Preserve public `src/rpc.ts`/`src/quota.ts` interfaces unless a test demonstrates a required change. Do not remove useful existing parser/state tests just because the new source does not consume that helper.
- No package/dependency/lock changes are expected.

### Task 1: Replace the source and verify end to end

**Files:** The file map above.

**Interfaces:**
- Consume existing `QuotaWindow`, `QuotaSnapshot`, `formatQuota` and `Quota` RPC contract.
- Produce `fetchQuotaUsage(accessToken: string, accountID: string, signal: AbortSignal): Promise<QuotaWindow[]>` in `src/usage.ts`. Use standard fetch; tests can stub it. Failure throws a sanitized local error, never raw response content.
- Keep `snapshot({sessionID}) -> QuotaSnapshot` and empty `updated` events unchanged. Session input remains validated; direct account data may be shared by sessions of the active account.
- Footer controller retains `update(sessionID, providerID)` and `dispose()`.

- [x] **Step 1: Write failing HTTP-boundary tests.** Valid 604,800 seconds at 6% used becomes `{windowMinutes:10080, remainingPercent:94}`; two windows preserve order, partial/invalid windows do not inherit. Assert the exact fixed URL, GET, redirect rejection, expected auth/account headers, deadline cancellation, byte cap including streamed/chunked data, malformed JSON, non-200 responses, and header-injection rejection.
- [x] **Step 2: Run the focused tests and record the expected missing-feature failure.**
- [x] **Step 3: Implement the bounded reader.** Read successful bodies incrementally, cancel on excess bytes, release readers, validate finite/ranged percentages and safe positive whole-minute durations. Never include secrets/upstream content in thrown messages or logs.
- [x] **Step 4: Write failing server tests.** Use fake active/resolve SDK APIs and fake HTTP; cover verified legacy auth and the active metadata account ID, every unsupported auth branch without fetch, missing tokens/metadata, one-minute successes/failures, concurrent single-flight, different sessions sharing the selected account, switches without delivered events, observed invalidations during resolve/fetch, stream failure and disposal. Ensure no HTTP response-header hooks, filesystem, storage, manual refresh/login or generation APIs are used. Test supported SDK method shapes rather than speculative APIs.
- [x] **Step 5: Run the focused server tests, record expected failures, then replace passive setup with the source/cache.** Cache only normalized results/connection identity/attempt time; no retained raw tokens. Use public invalidations already handled by the plugin. Recheck active identity before returning results; abort in-flight requests on invalidation/disposal. Throttle failed attempts as well as successful ones for 60,000 ms. Do not emit update events for every cached read or create a snapshot/event feedback loop.
- [x] **Step 6: Write failing footer refresh tests.** An eligible mounted footer refreshes after 60,000 ms without model traffic; non-OpenAI/no-session views do not read; navigation/disposal clears both refresh and expiry work; pending reads obey existing race guards; event failures and auth invalidation cannot restore old values. Use fake clock/event APIs and extend the compiled TUI test only where needed.
- [x] **Step 7: Run the focused footer tests, record expected failures, then implement the minimal minute timer and cleanup.** Retain current-client/location checks and hard freshness; no new settings or commands.
- [x] **Step 8: Update README.** Remove current passive-only/no-network/no-auth-resolution claims, explain the authenticated GET, minute cache/polling, legacy-only auth, SDK-managed refresh caveat and no manual token handling/files. Do not describe mock tests as actual rendering. Keep loading guidance and known dependency warnings.
- [x] **Step 9: Verify the full suite, typecheck, source build, package dry run and diff.** Commands: `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run --ignore-scripts --json`, `git diff --check`. Inspect package allowlist/imports for no secrets/extra dependencies. Tests never use real auth or network.
- [x] **Step 10: Self-review and commit only this task's paths with Git hooks disabled.** Report RED/GREEN evidence, exact paths, commit and unresolved risks. Do not touch the pre-existing report deletion.

## Review and live delivery

Run a task compliance/quality review and a final source/security review. Fix
blocking findings through the implementer with regression tests. Then call the
installed snapshot RPC in a fresh temporary local location, explicitly scoped
using the documented location query. Require actual returned quota (or report
a concrete blocker), not just `active` plugin status. Let the user trigger
`/reload` for the existing view rather than automatically rebuilding every
loaded location/cancelling pending permissions and forms. No model request or
separate login is authorized.

## Self-review

One task owns the connected source/cache/UI change so its reviewer can evaluate
the credential and timer boundaries together. Every review-focus item maps to
tests in Steps 1, 4 and 6. Interfaces match the existing RPC and controller.
The bounded HTTP helper is the only new production file. The user delegated
choices and already approved proceeding; do not restart an approval loop.
