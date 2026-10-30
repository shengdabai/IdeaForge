import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("local generation pipeline validates profile, keeps source records, and indexes only valid output", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-pipeline-"));
  const root = path.join(temporary, "中文 workspace %");
  try {
    await mkdir(path.join(root, "engine"), { recursive: true });
    await mkdir(path.join(root, "templates"));
    await Promise.all(["forge.mjs", "ingest.mjs", "generate.mjs", "prompt.md"].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), path.join(root, "engine", name))));
    await writeFile(path.join(root, "templates", "golden.html"), "<!DOCTYPE html><html><body>Golden fixture</body></html>");
    // No real CLI or model can run: the complete adapter is replaced in this fixture.
    await writeFile(path.join(root, "engine", "engines.mjs"), `
      export const calls = [];
      export let output = '<!DOCTYPE html><html><head><title>Synthetic result</title></head><body><main>结合你的处境</main></body></html>';
      export function setOutput(value) { output = value; }
      export async function run(engine, prompt) { calls.push({ engine, prompt }); return output; }
    `);
    const { forge } = await import(pathToFileURL(path.join(root, "engine", "forge.mjs")).href);
    const mock = await import(pathToFileURL(path.join(root, "engine", "engines.mjs")).href);
    const options = { engine: "ollama", shouldOpen: false };
    await assert.rejects(forge("Synthetic source", options), /profile\.local\.md/);
    assert.equal(mock.calls.length, 0);
    await assert.rejects(readdir(path.join(root, "inputs")), { code: "ENOENT" });

    const profile = "Synthetic independent creator building local knowledge tools for a test audience. Prefers source evidence and small experiments.";
    await writeFile(path.join(root, "profile.local.md"), profile);
    const results = [];
    for (const input of ["First synthetic source", "Second synthetic source"]) {
      const result = await forge(input, options);
      results.push(result);
      assert.equal(result.mode, "generated");
      assert.equal(mock.calls.at(-1).engine, "ollama");
      assert.ok(mock.calls.at(-1).prompt.includes(profile));
      assert.ok(mock.calls.at(-1).prompt.includes(input));
      assert.ok(mock.calls.at(-1).prompt.includes("Golden fixture"));
      const html = await readFile(result.htmlPath, "utf8");
      assert.match(html, /data-ideaforge-provenance/);
      assert.ok(html.includes(`../${result.entry.archivePath}`));
      const archived = JSON.parse(await readFile(path.join(root, result.entry.archivePath), "utf8"));
      assert.equal(archived.rawContent, input);
      assert.equal(archived.fetchedAt, result.entry.fetchedAt);
    }
    assert.notEqual(results[0].entry.htmlPath, results[1].entry.htmlPath);
    const indexPath = path.join(root, "pages.json");
    const indexBeforeFailure = await readFile(indexPath, "utf8");
    assert.deepEqual(JSON.parse(indexBeforeFailure), results.map((result) => result.entry));

    for (const output of ["Model failure: no HTML", "<!DOCTYPE html><html></html>"]) {
      mock.setOutput(output);
      await assert.rejects(forge("Synthetic invalid-output case", options), /full HTML|no closing <\/body>/);
      assert.equal(await readFile(indexPath, "utf8"), indexBeforeFailure);
      assert.equal((await readdir(path.join(root, "pages"))).length, 2);
    }
    assert.equal(mock.calls.length, 4);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
