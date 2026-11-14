# Passive quota footer

## Approved intent

Create a fresh OpenCode V2 terminal plugin in
`/Users/ilyesk/Developer/opencode-quota-footer`. Show remaining Codex quota
in the prompt footer near the built-in context percentage. Exact adjacency
is not required. Do not replace OpenCode's existing footer.

The user approved passive observation with an unavailable state when the
provider does not expose quota information.

## Constraints

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

## Behavior

Observe only the documented Codex primary/secondary quota headers. Validate
percentages and window durations at the boundary; derive labels from observed
durations rather than assuming five-hour or weekly windows. Display whole
percentages remaining, explicitly labeled as remaining. Partial observations
must not inherit missing values from an earlier response.

Start with `Codex unavailable`. Display available quota compactly in the footer
using the host theme. Missing quota on a later eligible response clears the old
observation. Use a five-minute freshness limit; expired information becomes
unavailable even if no further model response arrives.

Never consume or replace an HTTP response body. WebSocket frame interception,
active quota fetching, commands, dialogs, alerts, billing totals, multiple
provider support, and historical usage are out of scope.

The implementation may keep a single latest observation associated with its
source session. It must not show one session's or account's cached quota as
another session's current quota.

## Architecture

An original server plugin observes headers and exposes a narrow RPC returning
normalized display data only. Its TUI part reads that state and contributes a
compact indicator to the prompt footer. Updates are event-driven, not polled.
Subscriptions, hooks, timers, and pending asynchronous UI results are cleaned up
when the plugin unloads.

Use JSON Schema for RPC validation instead of adding a validation library.
Use TypeScript and Node's built-in test runner. Pin development tooling and
SDK peer versions after checking compatibility; do not run dependency lifecycle
scripts during setup. The builder chooses the smallest supported UI build
pipeline and documents it.

## Verification

Tests use synthetic headers and fake host APIs, never real accounts.
Cover parsing, partial and invalid data, expiry, session/account invalidation,
provider scoping, response preservation, footer contribution, cleanup, and
late asynchronous results. Type-check and build/package inspection are required.
Document manual loading separately; do not load the plugin into the user's
running OpenCode without permission.

## Known limitations

Token-sharing authentication may provide no numeric subscription-quota headers.
WebSocket-only traffic is not observed by this first version. Normal generation
must occur before quota can become available, and passive data can become stale.
From-scratch implementation reduces reliance on the audited project but is not
a guarantee of safety.
