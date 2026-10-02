import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test__, serve, updatePagesIndex } from "./forge.mjs";
import { injectProvenance } from "./forge.mjs";
import { validateLocalProfile } from "./generate.mjs";

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function requestStatus({ port, path: requestPath, host }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: requestPath, headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

test("dashboard generation requires its header token and static secrets are refused", async () => {
  let calls = 0;
  const token = "test-dashboard-token";
  const server = await serve({
    port: 0,
    token,
    forgePage: async () => {
      calls += 1;
      return { entry: { title: "generated", htmlPath: "pages/generated.html" } };
    },
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/.gitignore`)).status, 403);
    assert.equal((await fetch(`${base}/token`)).status, 403);
    assert.equal((await fetch(`${base}/package.json`)).status, 403);
    assert.equal((await fetch(`${base}/engine/prompt.md`)).status, 403);
    assert.equal((await fetch(`${base}/index.html`)).status, 200);

    const linkName = `security-test-${process.pid}-${Date.now()}.html`;
    const linkPath = new URL(`../pages/${linkName}`, import.meta.url);
    await mkdir(new URL("../pages/", import.meta.url), { recursive: true });
    await symlink(new URL("../engine/prompt.md", import.meta.url), linkPath);
    try {
      assert.equal((await fetch(`${base}/pages/${linkName}`)).status, 403);
    } finally {
      await rm(linkPath, { force: true });
    }

    const denied = await fetch(`${base}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "a valid prompt" }),
    });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);

    const allowed = await fetch(`${base}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forge-Token": token },
      body: JSON.stringify({ input: "a valid prompt" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
  } finally {
    await closeServer(server);
  }
});

test("dashboard reads its session token from the URL fragment and sends the auth header", async () => {
  const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../start-dashboard.command", import.meta.url), "utf8");
  assert.match(dashboard, /new URLSearchParams\(location\.hash\.slice\(1\)\)\.get\('forge-token'\)/);
  assert.match(dashboard, /history\.replaceState\(null,''\s*,location\.pathname\+location\.search\)/);
  assert.match(dashboard, /'X-Forge-Token':dashboardToken/);
  assert.match(launcher, /\^IdeaForge serving at /);
  assert.match(launcher, /open "\$DASHBOARD_URL"/);
  assert.doesNotMatch(launcher, /open "http:\/\/127\.0\.0\.1:\$PORT\//);
  assert.match(dashboard, /data\.error\|\|'生成失败，请检查本地服务日志。'/);
  assert.match(dashboard, /无法连接本地服务。请在终端运行/);
});

test("first-run profile validation fails before a template can be sent to an engine", () => {
  assert.throws(
    () => validateLocalProfile("What you do (role, industry, audience). 首次使用前,请把下面的内容全部替换"),
    /模板或内容过短/u,
  );
  const profile = "独立开发者，面向中文创作者开发本机优先的知识工具。当前目标是验证真实交付、付费和续费，偏好明确证据边界与一周内可以完成的小实验。";
  assert.equal(validateLocalProfile(profile), profile);
});

test("programmatic provenance links only a direct archive beneath inputs", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const record = {
    type: "url",
    sourceUrl: "https://example.com/$&$`$'?a=1&b=2",
    fetchedAt: "2026-10-02T06:00:00.000Z",
    archivePath: path.join(root, "inputs", "2026-source.json"),
  };
  const html = injectProvenance("<!DOCTYPE html><html><body><main>synthetic</main></body></html>", record);
  assert.match(html, /data-ideaforge-provenance/u);
  assert.match(html, /href="\.\.\/inputs\/2026-source\.json"/u);
  assert.match(html, /https:\/\/example\.com\/\$&amp;\$`\$&#39;\?a=1&amp;b=2/u);
  assert.match(html, /2026-10-02T06:00:00\.000Z/u);
  const literalBody = injectProvenance(
    '<!DOCTYPE html><html><body><script>const literal = "</body>";</script><main>final</main></body></html>',
    record,
  );
  assert.ok(literalBody.indexOf("data-ideaforge-provenance") > literalBody.indexOf("</script>"));

  const outside = injectProvenance("<!DOCTYPE html><html><body></body></html>", {
    ...record,
    sourceUrl: "javascript:alert(1)",
    archivePath: "/etc/passwd",
  });
  assert.doesNotMatch(outside, /javascript:/u);
  assert.doesNotMatch(outside, /etc\/passwd/u);
  assert.match(outside, /本机采集记录不可用/u);
  assert.throws(
    () => injectProvenance("<!DOCTYPE html><html></html>", record),
    /no closing <\/body>/u,
  );
  assert.throws(
    () => injectProvenance('<!DOCTYPE html><html><body><footer data-ideaforge-provenance></footer></body></html>', record),
    /reserved provenance marker/u,
  );
});

test("archive route serves a direct record but rejects a symlink outside inputs", async () => {
  const token = "archive-route-token";
  const inputsDir = new URL("../inputs/", import.meta.url);
  const directName = `trace-test-${process.pid}-${Date.now()}.json`;
  const directPath = new URL(`../inputs/${directName}`, import.meta.url);
  const linkName = `trace-link-${process.pid}-${Date.now()}.json`;
  const linkPath = new URL(`../inputs/${linkName}`, import.meta.url);
  await mkdir(inputsDir, { recursive: true });
  await writeFile(directPath, '{"synthetic":true}\n');
  await symlink(new URL("../templates/golden.html", import.meta.url), linkPath);
  const server = await serve({ port: 0, token });
  const { port } = server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/inputs/${directName}`)).status, 200);
    assert.equal(await requestStatus({ port, path: `/inputs/${directName}`, host: `localhost:${port}` }), 200);
    assert.equal(await requestStatus({ port, path: `/inputs/${directName}`, host: `hostile.example:${port}` }), 421);
    assert.equal((await fetch(`http://127.0.0.1:${port}/inputs/${linkName}`)).status, 403);
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/inputs/%2e%2e/engine/prompt.md`)).status, 200);
  } finally {
    await closeServer(server);
    await rm(directPath, { force: true });
    await rm(linkPath, { force: true });
  }
});

test("concurrent page writes allocate distinct filenames and preserve every index entry", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-forge-test-"));
  try {
    const pagesDir = path.join(temporary, "pages");
    const writes = await Promise.all(Array.from({ length: 24 }, () => __test__.writeNewPage("same-title", "<html></html>", { pagesDir })));
    assert.equal(new Set(writes.map((item) => item.slug)).size, 24);

    const indexPath = path.join(temporary, "pages.json");
    await Promise.all(Array.from({ length: 40 }, (_, i) => updatePagesIndex(async (current) => [
      ...current,
      { slug: `concurrent-${i}`, title: `Entry ${i}` },
    ], { indexPath })));
    const indexed = JSON.parse(await readFile(indexPath, "utf8"));
    assert.equal(indexed.length, 40);
    assert.equal(new Set(indexed.map((entry) => entry.slug)).size, 40);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an index lock left by a dead process is recovered", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-stale-lock-test-"));
  try {
    const indexPath = path.join(temporary, "pages.json");
    await writeFile(`${indexPath}.lock`, `${JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(0).toISOString() })}\n`);
    await updatePagesIndex((current) => [...current, { slug: "recovered", title: "Recovered" }], { indexPath });
    const indexed = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(indexed.map((entry) => entry.slug), ["recovered"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
