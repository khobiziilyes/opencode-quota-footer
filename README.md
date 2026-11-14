# Passive Codex quota footer

An original, local-only OpenCode V2 plugin targeting **OpenCode 2.3.0**.
It appends a compact indicator to `prompt.footer`, preserving the built-in
footer and using the host's theme:

```text
Codex 5h 80% left · 7d 10% left
```

Window labels come from observed durations, not assumed subscription limits.
Missing, invalid, or expired observations show `Codex unavailable`, never a
made-up zero. Only the currently selected OpenAI session can display its cache.

## Security boundary

- Observes the four documented primary/secondary Codex quota headers on
  **existing OpenAI HTTP responses only**.
- Never starts provider requests, external fetches, generation, polling,
  authentication, or token refresh. Calls to its own snapshot RPC read only
  the server's in-memory cache.
- Never reads request headers/bodies, credentials, conversation content,
  configuration files, or project files. Never consumes or replaces response
  bodies. No storage, telemetry, or raw-header/error logging.
- Keeps one normalized observation, associated with its source session, for
  at most five minutes. A later eligible response without usable quota clears
  the observation; partial windows never inherit older values.
- Tags request objects by identity, without inspecting their contents.
  Authentication/configuration/provider/integration events clear the cache
  and replace those tags. Unmatched response identities fail closed.
- Public invalidations, location shutdown, stream failure, and disposal clear
  observations. Failed invalidation streams disable server observation until
  plugin reload. TUI failures clear the display, abort pending reads, and
  suppress late results; reconnect invalidation waits for a fresh update.
- Uses update events and one local expiry timeout, not an interval or network
  polling. Cleanup unregisters hooks/RPC/slots and aborts owned subscriptions.

### Limitations

Normal provider traffic must occur before quota can appear. Token-sharing
authentication and other transports/auth methods may expose no numeric quota
headers. WebSocket-only traffic is not observed. If OpenCode does not preserve
request identity between hooks, quota remains unavailable.

Invalidation depends on public host events: SDK 2.3.0 exposes no account
identity on response hooks and no universal disconnect notification. Live-only
subscriptions can miss events during disconnection; reconnects invalidate the
display, but an undetected connection loss may leave it visible until local
expiry. This is passive, possibly stale information, not an authoritative
billing or account-status service. Original code is not a safety guarantee.

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
**Live loading, real terminal rendering, and authenticated traffic have not
been tested.** No host installation or configuration change was performed.

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
1.3.14+ requirements) and npm audit findings; the fake-host checks do not
certify those runtimes or dependencies.

`build` is a **source-transformation check**, not a bundle: it invokes the
pinned OpenTUI package's shipped Solid/TypeScript compiler and parses every
transformed source module without writing artifacts. That compiler is accessed
by a version-pinned internal path in development tooling only. Tests exercise
the real SDK definitions and compiled TUI entrypoint with synthetic host APIs,
real Solid reactivity, and a fake native renderer. No live OpenCode process is
started. Production uses the host loader, not this check script.
