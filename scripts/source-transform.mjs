// Use the pinned OpenTUI compiler, without loading its native terminal runtime.
export const { transformSolidSource } = await import(
  new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid"))
);
