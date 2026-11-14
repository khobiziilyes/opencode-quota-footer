import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SourceTextModule, SyntheticModule } from "node:vm";
import type { Plugin } from "@opencode/plugin/tui";
import type { SlotClaim } from "@opencode/plugin/tui/context";
// @ts-expect-error Solid's client runtime is shipped without a subpath declaration.
import * as solidRuntime from "solid-js/dist/solid.js";
const solid: typeof import("solid-js") = solidRuntime;
// @ts-expect-error Build tooling is JavaScript, not a production TypeScript module.
import { transformSolidSource } from "../scripts/source-transform.mjs";
import { only, settle, stream } from "./helpers.ts";

async function loadTui(): Promise<Plugin.Definition> {
  const url = new URL("../src/tui.tsx", import.meta.url);
  const code = await transformSolidSource(await readFile(url, "utf8"), { filename: url.pathname });
  const source = new SourceTextModule(code);
  await source.link(async (specifier) => {
    // Only the native renderer is faked; plugin definition, compiler, Solid, and controller are real.
    const exports: Record<string, unknown> = specifier === "@opentui/solid" ? {
      createElement: (type: string) => ({ type }),
      insert: (element: { text: string }, value: () => string) => solid.createRenderEffect(() => { element.text = value(); }),
      effect: solid.createRenderEffect,
      setProp: (element: Record<string, unknown>, name: string, value: unknown) => { element[name] = value; },
    } : specifier === "solid-js" ? solid :
      await import(specifier.startsWith(".") ? new URL(specifier, url).href : specifier);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
  });
  await source.evaluate();
  return (source.namespace as { default: Plugin.Definition }).default;
}

test("real TUI entrypoint appends themed footer and reacts to session/model changes with cleanup", async () => {
  const tui = await loadTui();
  let claim: SlotClaim | undefined;
  let unmount = () => {};
  let unregistered = false;
  let stopListener = false;
  const [sessionID, setSessionID] = solid.createSignal("a");
  const [providerID, setProviderID] = solid.createSignal("openai");
  const events = stream();
  const calls: string[] = [];
  const context = only({
    location: { directory: "/one" },
    client: only({
      rpc() {
        return {
          async snapshot(input: { sessionID: string }) {
            calls.push(input.sessionID);
            return { windows: [{ windowMinutes: 300, remainingPercent: 80 }], observedAt: Date.now() };
          },
          events: { subscribe: () => events },
        };
      },
    }),
    data: only({ listen: () => () => { stopListener = true; } }),
    theme: { text: { base: "host-theme-color" } },
    ui: only({
      model: only({ current: () => ({ providerID: providerID(), modelID: "model" }) }),
      slot(value: SlotClaim) {
        claim = value;
        return () => { unregistered = true; unmount(); };
      },
    }),
  }) as unknown as Plugin.Context;
  const cleanup = await tui.setup(context);
  assert.ok(claim && "append" in claim && claim.append === "prompt.footer");
  let element!: { type: string; text: string; fg: string };
  solid.createRoot((dispose) => {
    unmount = dispose;
    const footer = claim as SlotClaim<"prompt.footer">;
    element = footer.render({
      get sessionID() { return sessionID(); },
      mode: "normal", showDetails: false,
    }) as unknown as typeof element;
  });
  assert.equal(element.type, "text");
  assert.equal(element.fg, "host-theme-color");
  assert.equal(element.text, "Codex unavailable");
  await settle();
  assert.equal(element.text, "Codex 5h 80% left");
  setSessionID("b");
  assert.equal(element.text, "Codex unavailable");
  await settle();
  assert.deepEqual(calls, ["a", "b"]);
  setProviderID("other");
  assert.equal(element.text, "Codex unavailable");
  if (cleanup) await cleanup();
  assert.equal(unregistered, true);
  assert.equal(stopListener, true);
  events.end();
});
