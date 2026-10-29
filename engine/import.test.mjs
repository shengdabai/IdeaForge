import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function withImportFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ideaforge-import-fixture-"));
  try {
    await mkdir(path.join(root, "engine"));
    await Promise.all(["forge.mjs", "ingest.mjs", "generate.mjs", "engines.mjs"].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), path.join(root, "engine", name))));
    const { importPages } = await import(pathToFileURL(path.join(root, "engine", "forge.mjs")).href);
    const source = async (name, title, filename = "same.html") => {
      const directory = path.join(root, name);
      await mkdir(directory);
      const file = path.join(directory, filename);
      const html = `<!DOCTYPE html><html><title>${title}</title><body>${"Synthetic content. ".repeat(30)}</body></html>`;
      await writeFile(file, html);
      return { file, html };
    };
    await run({ root, importPages, source });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("import preserves different same-named sources and skips a repeat of each source", async () => {
  await withImportFixture(async ({ root, importPages, source }) => {
    const first = await source("one", "First source");
    const second = await source("two", "Second source");
    const options = { category: "archive" };
    assert.equal((await importPages(first.file, options)).imported, 1);
    assert.equal((await importPages(second.file, options)).imported, 1);
    assert.equal((await importPages(first.file, options)).skipped.duplicate, 1);
    assert.equal((await importPages(second.file, options)).skipped.duplicate, 1);
    const entries = JSON.parse(await readFile(path.join(root, "pages.json"), "utf8"));
    assert.equal(entries.length, 2);
    for (const original of [first, second]) {
      const entry = entries.find((item) => item.source === original.file);
      assert.ok(entry);
      assert.equal(await readFile(path.join(root, entry.htmlPath), "utf8"), original.html);
      assert.equal(await readFile(original.file, "utf8"), original.html);
    }
  });
});

test("same-named Chinese imports leave byte space for collision suffixes", async () => {
  await withImportFixture(async ({ root, importPages, source }) => {
    const filename = `${"文".repeat(83)}.html`;
    const originals = await Promise.all([source("one", "First", filename), source("two", "Second", filename)]);
    for (const original of originals) {
      assert.equal((await importPages(original.file, { category: "archive" })).imported, 1);
    }
    const entries = JSON.parse(await readFile(path.join(root, "pages.json"), "utf8"));
    assert.equal(entries.length, 2);
    for (const original of originals) {
      const entry = entries.find((item) => item.source === original.file);
      assert.ok(Buffer.byteLength(path.basename(entry.htmlPath)) <= 255);
      assert.equal(await readFile(path.join(root, entry.htmlPath), "utf8"), original.html);
    }
  });
});

test("concurrent imports allocate exclusive files and keep every distinct source", async () => {
  await withImportFixture(async ({ root, importPages, source }) => {
    const originals = await Promise.all(Array.from({ length: 12 }, (_, i) => source(`source-${i}`, `Source ${i}`)));
    const results = await Promise.all(originals.map(({ file }) => importPages(file, { category: "archive" })));
    assert.equal(results.reduce((sum, result) => sum + result.imported, 0), originals.length);
    const entries = JSON.parse(await readFile(path.join(root, "pages.json"), "utf8"));
    assert.equal(entries.length, originals.length);
    assert.equal(new Set(entries.map((entry) => entry.htmlPath)).size, originals.length);
    for (const original of originals) {
      const entry = entries.find((item) => item.source === original.file);
      assert.ok(entry);
      assert.equal(await readFile(path.join(root, entry.htmlPath), "utf8"), original.html);
    }
  });
});

test("dot-only import categories cannot escape pages or create inaccessible dotfiles", async () => {
  await withImportFixture(async ({ root, importPages, source }) => {
    for (const [i, category] of [".", "..", "...", ".hidden", "-..", "--.hidden"].entries()) {
      const original = await source(`source-${i}`, `Source ${i}`);
      assert.equal((await importPages(original.file, { category })).imported, 1);
    }
    const entries = JSON.parse(await readFile(path.join(root, "pages.json"), "utf8"));
    for (const entry of entries) {
      assert.equal(path.relative(path.join(root, "pages"), path.resolve(root, entry.htmlPath)).startsWith(".."), false);
      assert.ok(entry.htmlPath.split("/").every((part) => !part.startsWith(".")));
      assert.match(await readFile(path.join(root, entry.htmlPath), "utf8"), /Synthetic content/);
    }
    assert.ok((await readdir(root)).every((name) => !name.endsWith(".html")));
  });
});
