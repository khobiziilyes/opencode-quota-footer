# Task 2 — host integration report

## Outcome

Implemented original passive-only server and TUI integration on
`feat/passive-footer`, consuming Task 1 commit `297a875` unchanged.
The implementation commit is the commit containing this report.
All Task 1 and Task 2 task-section checkboxes in the original plan are marked
complete; no requirements or coordinator `progress.md` were rewritten.
No subagents/reviewers were spawned, as explicitly instructed. Self-review was
performed instead; fresh external review remains the coordinator's responsibility.

## Changed paths and interfaces

- `src/rpc.ts`: real SDK `Rpc.define`, ID `opencode-quota-footer`,
  `snapshot({sessionID})`, normalized `QuotaSnapshot` output JSON Schema,
  empty-object `updated` event schema, explicit unknown-input narrowing and
  conservative result validation.
- `src/server.ts`: real SDK `Plugin.define`, provider-scoped HTTP hooks,
  request-object WeakSet, fail-closed matching, one observation, empty update
  notifications, public invalidations, stream failure handling and cleanup.
- `src/footer.ts`: focused non-rendering lifecycle controller needed for
  synthetic testing; current-client/location/session/provider guarding,
  event-driven reads, aborts/revision guards and one expiry timeout.
- `src/tui.tsx`: minimal real SDK TUI entrypoint, additive `prompt.footer`,
  reactive model/session context, host `theme.text.base`, Solid cleanup.
- `tests/server.test.ts`, `tests/footer.test.ts`, `tests/tui.test.ts`,
  `tests/helpers.ts`: fake host boundaries, real definitions/controller/compiler/
  Solid. Only the native renderer is faked for the compiled TUI entrypoint.
- `scripts/source-transform.mjs`, `scripts/build-check.mjs`: actual shipped
  pinned OpenTUI TypeScript/Solid transformation and syntax parsing, no emitted
  artifact and no live host/native renderer.
- `package.json`, `package-lock.json`, `tsconfig.json`: source exports,
  package allowlist, pinned SDK/UI tooling/peers and verification commands.
- `README.md`: local opt-in directory loading only, boundaries and limitations.
- `docs/superpowers/plans/2026-11-14-passive-quota-footer.md`: task checkboxes
  only. `src/quota.ts` and `tests/quota.test.ts` were not modified.

## Official evidence

Read the supplied brief, approved spec, and `sdk-evidence.md` first. Consulted:

- https://opencode.ai/docs/build/plugins.md
- https://opencode.ai/docs/build/plugins/cli.md
- https://opencode.ai/docs/build/plugins/rpc.md

Context7 commands both succeeded:

```sh
npx --ignore-scripts ctx7@latest library OpenCode "V2 plugin http request response hook filters public events subscription TUI reactive model"
npx --ignore-scripts ctx7@latest docs /anomalyco/opencode "V2 plugins http.request http.response filters request identity events.subscribe AbortSignal cleanup"
```

Published `@opencode/plugin@2.3.0` declarations were authoritative:
`promise/plugin.d.ts`, `promise/session.d.ts`, `promise/registration.d.ts`,
`promise/event.d.ts`, `promise/rpc.d.ts`, `tui/plugin.d.ts`,
`tui/context.d.ts`; also SDK client RPC declarations and the published RPC
schema definition. Confirmed async hook disposal, third-argument provider
filter, unknown JSON Schema inputs, top-level event schemas, optional slot
session IDs, reactive model selection, and current-client access.
Public RPC event locations contain a directory, not workspace identity:
events are filtered by directory, while snapshot reads pass the current
location/workspace and result guards also reject workspace/context changes.

## RED / GREEN evidence

1. Before server production code:

   ```sh
   node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/server.test.ts
   ```

   RED, exit 1: `ERR_MODULE_NOT_FOUND` for nonexistent `src/server.ts`.
   Following implementation, `npm test` was GREEN: 65/65, including all 48
   unchanged Task 1 cases.

2. Before footer-controller production code:

   ```sh
   node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/footer.test.ts
   ```

   RED, exit 1: nonexistent `src/footer.ts`. First full run after implementation
   exposed a test-helper default-argument mistake (explicit undefined became
   its default); the test now calls the controller directly for absent
   session/provider. This was not hidden as a production fix.

3. Before TUI entrypoint production code:

   ```sh
   node --experimental-strip-types --experimental-vm-modules --disable-warning=ExperimentalWarning --test tests/tui.test.ts
   ```

   RED, exit 1: `ENOENT` for nonexistent `src/tui.tsx`.
   After implementation, full suite GREEN: 93/93. The actual TSX source is
   compiled by the pinned OpenTUI compiler, linked in a VM using real SDK
   `Plugin.define`, real Solid client runtime and the real controller.
   The tiny fake renderer checks additive placement, theme, initial text,
   updates, navigation/provider clearing and unmount cleanup.

4. Self-review regression for slow notification delivery:

   ```sh
   node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/server.test.ts
   ```

   RED 17/18: provider hook was waiting for a stalled update emission.
   Removed notification awaiting from hooks/event consumption so a slow RPC
   subscriber cannot block provider traffic or later auth invalidation.
   Notification failures remain caught and clear/disable observation.
   The same test also verifies a subsequent credential switch while earlier
   emissions are still unresolved.

5. Boundary regression:

   Same server command RED 17/18: an array carrying a `sessionID` property was
   incorrectly accepted. Narrowing now excludes arrays and requires an own
   `sessionID`; inherited-property/extra-field attempts are also rejected.
   Final full suite GREEN: 96/96.

Early typechecks correctly reported synthetic branded-ID fixture casts,
an overly narrow fixture header default, the absence of `workspaceID` on
public event locations, and the VM namespace declaration. These were fixed;
unvalidated production input is never cast to a trusted shape.
Extra synchronous subscription/listener setup-failure cases were added as
coverage of already-present guards; they did not require new production logic.

## Final fresh verification

After reproducible installation:

```sh
npm ci --ignore-scripts --legacy-peer-deps --omit=optional
```

Exit 0, 362 packages installed; engine/deprecation/audit warnings below.

| Command | Final result |
| --- | --- |
| `npm test` | Exit 0, **96 tests passed**, 0 failed/skipped/cancelled |
| `npm run typecheck` | Exit 0, no diagnostics |
| `npm run build` | Exit 0, transformed and parsed all five source modules |
| `npm pack --dry-run --ignore-scripts --json` | Exit 0, exactly 7 files, no bundled dependencies |
| `git diff --check` | Exit 0 |
| `npm ls --depth=0` | Exact six declared direct SDK/development packages |
| `npm audit --omit=dev --json` | Exit 1, **26 moderate**, 0 high/critical; not a clean audit |

Build is deliberately a source-transformation check, not a fake emitted
JavaScript entrypoint or a host runtime test. It uses the pinned package's
actual `scripts/solid-transform.js`, which is an internal development-tooling
path, not a public production API. OpenCode owns production source loading.

Actual package file list:

```text
README.md
package.json
src/footer.ts
src/quota.ts
src/rpc.ts
src/server.ts
src/tui.tsx
```

Final inspected pack size: 6,386 bytes packed / 18,004 unpacked. No tests,
plans, reports, node_modules, generated dist, lockfile, scripts, credentials,
or host configuration are in the package. Repository-only check scripts are
intentionally not part of the local plugin payload.

## Security and race review

- Production imports are exclusively the official SDK (`@opencode/plugin`,
  its `/rpc` and `/tui` entrypoints), existing Solid UI primitives, and local
  modules. No filesystem/network/generation/credential/config/storage APIs,
  fetch, intervals, logging or installers appear in production code.
- Fake hosts throw on any undeclared API access; server tests also replace
  global fetch with a throwing trap. Request objects are proxied to throw on
  all property access. Header/body tests confirm the original Response,
  body stream and body contents are unchanged and unconsumed by the plugin.
  The unchanged Task 1 suite enforces the four-header allowlist.
- Auth/provider/integration/config changes replace the WeakSet and clear
  state. Consumed tags cannot be reused. Unmatched identities discard quota;
  old pre-switch responses cannot restore it.
- Public stream failures/end disable server observation until reload.
  Cleanup clears state before abort/disposal, is idempotent, attempts every
  registration disposal, and makes captured callbacks harmless.
  Partial setup failures at subscribe, RPC registration and both hooks are
  exercised, with acquired registrations disposed and subscription aborted.
- The TUI validates normalized results, rejects invalid/stale/future results,
  scopes reads to the current selected OpenAI session/location, reads the
  current client at call time, aborts prior reads and ignores obsolete
  revisions/context/client/location results. Missing fields cannot inherit
  prior values.
- RPC update stream failure/end clears the display and aborts work without
  a retry-poll loop. Public invalidation/reconnect clears immediately and
  waits for a fresh update. Disposal removes the public listener, cancels
  subscriptions/pending reads/timer and guards late resolutions.
- No raw headers, account identifiers, secrets, credentials or upstream error
  content are stored/logged/transmitted. Update events carry only `{}`.
- Original source was written from supplied interfaces and official APIs.
  The audited plugin was never inspected, imported, copied or installed.
- No live host loading, authenticated tests, host configuration changes,
  global installation or publishing occurred.

## Dependency/package inspection and concerns

Before installation inspected registry metadata for SDK 2.3.0, OpenTUI core/
Solid 0.8.4. The SDK's own development metadata pins those versions and Solid
1.9.17, as requested. Only direct production dependency:
`@opencode/plugin@2.3.0`; TUI peer/development packages are exactly
`@opentui/core@0.8.4`, `@opentui/solid@0.8.4`, `solid-js@1.9.17`.
Existing TypeScript 5.9.3 and @types/node 22.19.1 were retained.

Both install and reproducibility check used `--ignore-scripts`,
`--legacy-peer-deps`, and `--omit=optional`. Inspection of the **actual 362
installed package manifests** found:

- No Electron, Vite, vite-plugin-solid, Bun runtime, @effect/platform-bun,
  or optional OpenTUI native binary packages installed.
- `electron-to-chromium` is only browser-version data used by Babel, not an
  Electron runtime.
- 62 manifests contain prepare/prepublish/prepack-style lifecycle entries.
  Their contents were inspected; some upstream source-package prepare scripts
  include compilation, Husky, or git-hook commands. None ran. No installed
  manifest declares preinstall/install/postinstall.
- The official SDK has a large mandatory transitive graph; for example
  `@npmcli/arborist@9.4.0` comes from `@opencode/util@2.3.0`, not a plugin
  installer added here. No transitive graph was silently replaced or patched.

Runtime compatibility remains unverified: on Node 22.13.1 upstream engine
warnings include OpenTUI core's Node >=26.4.0 / Bun >=1.3.14 requirements and
@effect/opentelemetry, @effect/platform-node, @effect/platform-node-shared,
undici requiring Node >=22.19.0. Pure/fake-host checks pass but do not prove a
native renderer works under that older Node version.

Audit's 26 moderate findings include SDK/util and TUI compiler transitive
glob/minimatch cancellation/DoS advisories and propagated npm tooling issues.
Some show no compatible fix; the suggested OpenTUI downgrade conflicts with
the required SDK compatibility target. No `npm audit fix` or version changes
were made. The coordinator should retain these as disclosed upstream risks,
not treat this dependency graph as security-reviewed or warning-free.

## Deviations and limits

- Added the allowed focused controller and a compiled-entrypoint test rather
  than using source-text regex assertions. No new runtime validation/build
  dependency was added; the SDK handles JSON Schema validation in the host,
  with explicit unknown narrowing/result checks in this plugin.
- Added public `location.shutdown` invalidation and conservative stream/
  emission failure handling, within the approved disconnection constraint.
- No separate reviewers were spawned because the dispatch explicitly forbids
  them. This report records self-review, not an independent review approval.
- Source build verification is real compiler transformation and parsing, not
  a bundle, native rendering certification, or live host-loader test.
- SDK 2.3.0 does not expose a universal disconnect signal/account identity.
  Hidden disconnects or unobservable failed update delivery may leave the
  last UI value visible until its local five-minute expiry. Detected stream
  failure and public reconnect/invalidation clear conservatively.
- No active fetching, WebSocket interception, commands/dialogs, historical
  data, additional providers, extra configuration, or installation behavior
  was added.
