import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stripHtmlFence, validateHtml } from "./generate.mjs";
import { __test__ as forgeInternals, serve } from "./forge.mjs";

const execFileAsync = promisify(execFile);
const engineDir = path.dirname(new URL(import.meta.url).pathname);

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("model output with text after </html> still validates as a full document", () => {
  const document = "<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>";
  assert.equal(validateHtml(stripHtmlFence(`Sure, here it is:\n\`\`\`html\n${document}\n\`\`\`\nLet me know if you want changes.`)), document);
  assert.equal(validateHtml(stripHtmlFence(`${document}\n\n注：以上为完整页面。`)), document);
  assert.equal(validateHtml(stripHtmlFence(`\`\`\`html\n${document}\n\`\`\``)), document);
  assert.throws(() => validateHtml(stripHtmlFence("<!DOCTYPE html><html><body>unterminated")), /missing closing <\/html>/u);
  assert.throws(() => validateHtml(stripHtmlFence("Here is a summary instead of a page.")), /must start with <!DOCTYPE/u);
});

test("generate payload validation rejects malformed requests with a 400 status", () => {
  const { parseGeneratePayload } = forgeInternals;
  assert.deepEqual(parseGeneratePayload('{"input":"  一个想法 ","engine":"Ollama"}'), { input: "一个想法", engine: "ollama" });
  assert.deepEqual(parseGeneratePayload('{"input":"x"}'), { input: "x", engine: "codex" });
  for (const [body, pattern] of [
    ["{not json", /valid JSON/u],
    ["[]", /JSON object/u],
    ['{"input":"   "}', /Missing required field: input/u],
    ['{"input":"x","engine":"gpt-4"}', /Unknown engine "gpt-4"/u],
  ]) {
    assert.throws(() => parseGeneratePayload(body), (error) => error.statusCode === 400 && pattern.test(error.message));
  }
});

test("the dashboard server answers bad generate requests with 4xx and keeps split UTF-8 bodies intact", async () => {
  const received = [];
  const token = "payload-token";
  const server = await serve({
    port: 0,
    token,
    forgePage: async (input, options) => {
      received.push({ input, options });
      return { entry: { title: input, htmlPath: "pages/x.html" } };
    },
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { "Content-Type": "application/json", "X-Forge-Token": token };
  try {
    assert.equal((await fetch(`${base}/generate`, { method: "POST", headers, body: "{oops" })).status, 400);
    assert.equal((await fetch(`${base}/generate`, { method: "POST", headers, body: JSON.stringify({ input: "x", engine: "gpt" }) })).status, 400);
    assert.equal((await fetch(`${base}/generate`, { method: "POST", headers, body: JSON.stringify({ engine: "codex" }) })).status, 400);
    assert.equal((await fetch(`${base}/generate`, { method: "POST", headers, body: "x".repeat(2 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.equal(received.length, 0);

    const text = "平台经济为什么是终极掠食者？".repeat(40);
    const body = Buffer.from(JSON.stringify({ input: text, engine: "ollama" }));
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/generate", method: "POST", headers: { ...headers, "Content-Length": body.length } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      const cut = 12; // inside the first 3-byte character after {"input":"
      assert.match(body.subarray(0, cut).toString("utf8"), /\uFFFD$/u, "the cut must split a multi-byte character");
      request.write(body.subarray(0, cut));
      setTimeout(() => request.end(body.subarray(cut)), 50);
    });
    assert.equal(status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].input, text);
    assert.equal(received[0].options.engine, "ollama");
  } finally {
    await closeServer(server);
  }
});

test("the CLI entry point runs through a symlink and can be imported without a script path", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-bin-test-"));
  try {
    const linkPath = path.join(temporary, "forge");
    await symlink(path.join(engineDir, "forge.mjs"), linkPath);
    const { stdout } = await execFileAsync(process.execPath, [linkPath, "--self-test"], { timeout: 20_000 });
    assert.match(stdout, /forge self-test passed/u);

    const importOnly = await execFileAsync(
      process.execPath,
      ["-e", `import(${JSON.stringify(new URL("./forge.mjs", import.meta.url).href)}).then(() => console.log("imported-ok"))`],
      { timeout: 20_000 },
    );
    assert.match(importOnly.stdout, /imported-ok/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the dashboard labels its controls, announces status, and blocks double submission", async () => {
  const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(dashboard, /<label for="inp" class="sr-only">/u);
  assert.match(dashboard, /<label for="engine" class="sr-only">/u);
  assert.match(dashboard, /id="status" role="status" aria-live="polite"/u);
  assert.match(dashboard, /class="chev" aria-hidden="true"/u);
  assert.match(dashboard, /goEl\.disabled=true;/u);
  assert.match(dashboard, /finally\{\s*goEl\.disabled=false;/u);
  assert.match(dashboard, /focus-visible\{outline:/u);
});

test("generate payload input must be a string", () => {
  const { parseGeneratePayload } = forgeInternals;
  for (const body of ['{"input":{"a":1}}', '{"input":123}', '{"input":["x"]}', '{"input":true}']) {
    assert.throws(() => parseGeneratePayload(body), (error) => error.statusCode === 400 && /input must be a string/u.test(error.message), body);
  }
});

test("static pages are served with correct image content types", async () => {
  const pagesDir = new URL("../pages/", import.meta.url);
  const stamp = `${process.pid}-${Date.now()}`;
  const svgPath = new URL(`../pages/mime-test-${stamp}.svg`, import.meta.url);
  const jpgPath = new URL(`../pages/mime-test-${stamp}.jpg`, import.meta.url);
  await mkdir(pagesDir, { recursive: true });
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await serve({ port: 0, token: "mime-token" });
  const { port } = server.address();
  try {
    const svg = await fetch(`http://127.0.0.1:${port}/pages/mime-test-${stamp}.svg`);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    const jpg = await fetch(`http://127.0.0.1:${port}/pages/mime-test-${stamp}.jpg`);
    assert.equal(jpg.headers.get("content-type"), "image/jpeg");
  } finally {
    await closeServer(server);
    await rm(svgPath, { force: true });
    await rm(jpgPath, { force: true });
  }
});

test("dashboard card links percent-encode path segments so % and # in file names stay reachable", async () => {
  const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const source = dashboard.match(/function hrefFor\(htmlPath\)\{[\s\S]*?\n\}/u)?.[0];
  assert.ok(source, "hrefFor must exist in index.html");
  const hrefFor = new Function(`${source}; return hrefFor;`)();
  assert.equal(hrefFor("pages/分类/100%完成#1.html"), "pages/%E5%88%86%E7%B1%BB/100%25%E5%AE%8C%E6%88%90%231.html");
  assert.equal(decodeURIComponent(hrefFor("pages/分类/100%完成#1.html")), "pages/分类/100%完成#1.html");
  assert.equal(hrefFor("templates/golden.html"), "templates/golden.html");
  assert.equal(hrefFor("/abs/a b.html"), "file:///abs/a%20b.html");
  assert.equal(hrefFor("https://example.com/x?y=1"), "https://example.com/x?y=1");
  assert.equal(hrefFor(""), "#");
});
