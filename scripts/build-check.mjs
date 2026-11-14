import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { SourceTextModule } from "node:vm";
import { transformSolidSource } from "./source-transform.mjs";

for (const file of await readdir(new URL("../src/", import.meta.url))) {
  if (!/\.tsx?$/.test(file)) continue;
  const url = new URL(`../src/${file}`, import.meta.url);
  const source = await readFile(url, "utf8");
  const code = await transformSolidSource(source, { filename: url.pathname });
  assert.ok(code.length);
  new SourceTextModule(code, { identifier: url.href });
  console.log(`Transformed and parsed ${file}`);
}
