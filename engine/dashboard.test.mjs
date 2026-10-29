import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { serve } from "./forge.mjs";

async function dashboardContext() {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script, "Dashboard must contain its script");
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: "", addEventListener() {} });
        return elements.get(id);
      },
    },
    location: { hash: "", pathname: "/", search: "" },
    URLSearchParams,
    // Do not fetch real data or render a browser DOM in these URL behavior tests.
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(script, context);
  return context;
}

test("dashboard links open local filenames containing URL punctuation", async () => {
  const context = await dashboardContext();
  const category = `link-test-${process.pid}-资料 #100%`;
  const directory = new URL(`../pages/${encodeURIComponent(category)}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const server = await serve({ port: 0, token: "synthetic-link-test" });
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    for (const filename of ["复盘#1.html", "literal%20name.html", "问答 & notes.html", "查询?.html"]) {
      await writeFile(new URL(encodeURIComponent(filename), directory), `<!DOCTYPE html><title>${filename}</title>`);
      context.inputPath = `pages/${category}/${filename}`;
      const href = vm.runInContext("hrefFor(inputPath)", context);
      const target = new URL(href, base);
      assert.equal(target.hash, "");
      assert.equal(target.search, "");
      const response = await fetch(target);
      assert.equal(response.status, 200, `Must open ${filename}`);
      assert.equal(await response.text(), `<!DOCTYPE html><title>${filename}</title>`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard link encoding preserves explicit URLs and absolute local paths", async () => {
  const context = await dashboardContext();
  for (const url of ["https://example.com/a?q=one#two", "file:///tmp/notes%20one.html"]) {
    context.inputPath = url;
    assert.equal(vm.runInContext("hrefFor(inputPath)", context), url);
  }
  context.inputPath = "/tmp/资料 #100%/literal%20name.html";
  const target = new URL(vm.runInContext("hrefFor(inputPath)", context));
  assert.equal(target.protocol, "file:");
  assert.equal(decodeURIComponent(target.pathname), context.inputPath);
  assert.equal(target.hash, "");
  context.inputPath = "";
  assert.equal(vm.runInContext("hrefFor(inputPath)", context), "#");
});
