# Authenticated Codex quota lookup

## Intent and authority

The user approved replacing the ineffective passive-only source with the
independently researched quota-read mechanism, and delegated implementation
choices ("just guess its fine"). This design supersedes the passive-only
source restrictions, not the original project's safety goals.

Before implementation, a bounded authenticated GET returned HTTP 200 and a
normalized 10,080-minute window with 94% remaining for the active OpenCode
connection. Its method is `chatgpt-headless`, publicly labelled legacy Codex.
No inference request, credential-file access, token refresh, or persistence
was needed for that probe. No identity or token was exposed in tool output.

## Binding constraints

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

## Behavior

Use `ctx.integration.connection.active("openai")` and `resolve(connection)`.
Validate OAuth method, access token and account metadata before fetching.
Recheck active connection identity before publishing an asynchronous result.
The host owns credential resolution/refresh; the plugin never redeems tokens.

This is account quota, not per-conversation consumption. The server holds
one bounded cache associated internally with the selected connection, shared
by sessions using that active account. Concurrent reads coalesce, and both
successes and failures are throttled for 60 seconds. Failed reads return
unavailable rather than presenting an earlier account's or failed read's quota.

Snapshots trigger a lookup when necessary; the server has no polling timer.
The visible OpenAI footer reads on mount/context change, public updates, and
once every 60 seconds. No quota requests occur for other selected providers.
The footer uses bounded timers, clears on account/navigation failures, and
never restores obsolete asynchronous results. No response-header hooks remain.

Parse only `rate_limit.primary_window` and `rate_limit.secondary_window`.
For each valid window, `used_percent` must be finite and between 0 and 100;
`limit_window_seconds` must be a positive safe integer divisible by 60.
Convert seconds to minutes and used to remaining; never assume five-hour or
weekly durations, merge missing windows, or infer zero usage. Treat unavailable,
non-200, oversized, invalid JSON/schema, timeout, and unsupported auth as
unavailable without exposing upstream bodies. Read successful response bytes
incrementally so the response size limit is real.

## Delivery and verification

Reuse TypeScript, built-in fetch/tests, existing RPC, theme and build checks.
Use synthetic HTTP/host tests for all boundaries and races. Independent reviews
must cover credential scoping, request limits, cache invalidation, polling and
cleanup. After review, refresh the installed plugin through the documented
location reload and query its snapshot without a model request; report actual
normalized values. Do not mistake server activity for rendered UI verification.

## Deliberate exclusions

No Codex CLI installation, separate sign-in, browser scraping, cookie readers,
configurable URLs, billing/history/reset-credit features, new settings, or
new providers. Modern token-sharing auth is unsupported by this endpoint;
the demonstrated legacy connection is the target. The existing upstream
engine warnings and 26 moderate audit findings remain disclosed risks.
