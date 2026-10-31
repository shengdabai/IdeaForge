import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("README keeps the first-run, dashboard token and import instructions", async () => {
  const readme = await read("README.md");
  // profile.local.md is a hard requirement before any generation.
  assert.match(readme, /cp profile\.md profile\.local\.md/);
  // The Dashboard only generates when opened through the printed token URL.
  assert.match(readme, /#forge-token=/);
  assert.match(readme, /X-Forge-Token/);
  assert.match(readme, /start-dashboard\.command[^\n]*terminal/);
  // Import copies by default; --link registers file:// paths the HTTP dashboard cannot open.
  assert.match(readme, /default \(or `--copy`\): copies HTML into `pages\/<category>\/`/);
  assert.match(readme, /`--link`[^\n]*file:\/\//);
});

test("README describes the test script that package.json actually runs", async () => {
  const readme = await read("README.md");
  const { scripts } = JSON.parse(await read("package.json"));
  const row = readme.split("\n").find((line) => line.startsWith("| `npm run test` |"));
  assert.ok(row, "README must document npm run test");
  assert.ok(row.includes(scripts.test), row);
});

test("the B2 handoff's README claim matches the README", async () => {
  const handoff = await read("docs/HANDOFF-20261002-B2.md");
  const line = handoff.split("\n").find((text) => text.includes("README first-run instructions"));
  assert.ok(line);
  assert.match(line, /cp profile\.md profile\.local\.md/);
  assert.match(line, /restored/);
});
