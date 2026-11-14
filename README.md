# Codex quota footer

An original, opt-in OpenCode V2 plugin targeting **OpenCode 2.3.0**.
It appends a compact indicator to `prompt.footer`, preserving the built-in
footer and using the host's theme:

```text
Codex 5h 80% left · 7d 10% left
```

Window labels come from returned durations, not assumed subscription limits.
Missing, invalid, or expired observations show `Codex unavailable`, never a
made-up zero. Only a selected OpenAI session displays quota; sessions share the
active account's quota, not per-conversation usage.

## Security boundary

- Resolves **only the active OpenAI OAuth connection** through OpenCode's
  supported SDK. Allows legacy `chatgpt-browser` and `chatgpt-headless` methods
  only; token-sharing, API keys, environment/external and unknown methods are
  unsupported and do not make quota requests.
- Sends the resolved access token and `metadata.accountID` only to
  `https://chatgpt.com/backend-api/wham/usage`: an authenticated GET with redirects
  forbidden, a ten-second deadline, and a 131,072-byte incremental response cap.
- Never generates model requests, signs in/out, implements token refresh,
  consumes reset credits, or reads/writes token/authentication files.
  **SDK resolution may refresh and persist the host's existing credential near
  expiry.** OpenCode manages that behavior, not plugin refresh/login code.
- No manual token handling, storage, telemetry, conversation-content access,
  raw response/error logging, or credential/account identifiers in plugin RPC.
- Keeps only normalized quota, connection identity and attempt time in memory.
  Concurrent reads coalesce; successes **and failures** are throttled for one
  minute. A failed lookup clears previous quota; partial windows never inherit
  missing values. Snapshots recheck active identity before returning data.
- Public invalidations, location shutdown, stream failure, and disposal clear
  quota and abort owned requests. Failed invalidation streams disable server
  lookups until plugin reload. TUI failures clear the display, abort pending
  reads, and suppress late results; failed TUI event streams stop polling.
- The visible OpenAI footer reads on mount, context changes, public updates
  and every minute, without requiring model traffic. The server has no polling
  timer. A separate expiry timeout enforces a five-minute freshness ceiling.
  Navigation/unload clears timers, subscriptions and pending reads; cleanup
  unregisters RPC/slots. No provider HTTP hooks remain.

### Limitations

This targets legacy Codex OAuth, not modern token-sharing authentication. Missing
or invalid account metadata/tokens, endpoint errors, unexpected responses and
unsupported auth display unavailable. No separate Codex installation or sign-in
is needed or attempted.

Invalidation still depends on public host events. Live-only subscriptions can
miss events during disconnection; reconnects invalidate the display. An
undetected connection loss may leave quota visible until a later read or local
expiry. The SDK's credential resolution itself has no cancellation parameter;
invalidation/unload releases waiting snapshots and rejects its late results but
cannot cancel host-managed refresh already underway. This is possibly stale
information, not an authoritative billing service. Original code is not a safety
guarantee.

## Local opt-in loading only

This repository is private/unpublished. Nothing installs it into OpenCode,
changes user configuration, or loads it automatically.

If you explicitly choose to try it later, the official directory-loading
mechanism is to manually add this directory to the `plugins` array in your
existing `opencode.json(c)`:

```jsonc
{
  "plugins": ["/Users/ilyesk/Developer/opencode-quota-footer"]
}
```

Merge that entry yourself without replacing unrelated settings. One directory
entry loads both the server (`.`) and TUI (`./tui`) source exports.
Do not point OpenCode at an emitted JavaScript artifact: OpenCode transpiles
the `.ts`/`.tsx` source with its own supported loader and terminal runtime.
Repository tests use fake credentials/HTTP/host APIs, not live authentication or
actual terminal rendering. A separate pre-implementation feasibility probe
confirmed the fixed endpoint with legacy OAuth; it does not verify this
implementation's installed runtime. No installation/configuration change or
live reload is performed by these checks. `/reload` is user-controlled and may
cancel pending permissions/forms globally; isolated live verification belongs
in a fresh temporary location, not a forced reload of an existing view.

Official references:
[plugin loading](https://opencode.ai/docs/build/plugins),
[TUI slots/theme](https://opencode.ai/docs/build/plugins/cli),
[RPC](https://opencode.ai/docs/build/plugins/rpc).
Published 2.3.0 declarations govern exact APIs when current prose differs.

## Repository checks

Development dependencies are pinned to SDK 2.3.0's OpenTUI 0.8.4 and Solid
1.9.17 versions. There is no claim of OpenTUI 0.9 compatibility.
The only direct production dependency is `@opencode/plugin`.

```sh
npm ci --ignore-scripts --legacy-peer-deps --omit=optional
npm test
npm run typecheck
npm run build
npm pack --dry-run --ignore-scripts
```

The install flags avoid lifecycle execution, optional GUI peers, and native
optional binaries. They are for these non-native repository checks, not a
claim that a standalone terminal runtime was installed. The upstream graph
reports engine warnings on Node 22.13.1 (including OpenTUI's Node 26.4+/Bun
1.3.14+ requirements) and 26 moderate npm audit findings; the fake-host checks do not
certify those runtimes or dependencies.

`build` is a **source-transformation check**, not a bundle: it invokes the
pinned OpenTUI package's shipped Solid/TypeScript compiler and parses every
transformed source module without writing artifacts. That compiler is accessed
by a version-pinned internal path in development tooling only. Tests exercise
the real SDK definitions and compiled TUI entrypoint with synthetic host APIs,
real Solid reactivity, and a fake native renderer. No live OpenCode process is
started. Production uses the host loader, not this check script.
