import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test__, serve, updatePagesIndex } from "./forge.mjs";

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
