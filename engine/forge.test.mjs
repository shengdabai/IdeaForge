import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import test from "node:test";
import fsPromises, { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

test("the launcher shows server output and the Dashboard URL in its own terminal", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-launcher-test-"));
  try {
    const bin = path.join(temporary, "bin");
    const opened = path.join(temporary, "opened.txt");
    await mkdir(path.join(temporary, "engine"));
    await mkdir(bin);
    await copyFile(new URL("../start-dashboard.command", import.meta.url), path.join(temporary, "start-dashboard.command"));
    const url = "http://127.0.0.1:8765/#forge-token=synthetic-launcher-token";
    // A stand-in server: prints its URL and one log line, then exits shortly after.
    await writeFile(path.join(temporary, "engine", "forge.mjs"),
      `console.log(${JSON.stringify(`IdeaForge serving at ${url}`)});\nconsole.error("synthetic server log line");\nsetTimeout(() => {}, 800);\n`);
    const stub = async (name, body) => {
      await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(path.join(bin, name), 0o755);
    };
    await stub("lsof", "exit 1");
    await stub("open", `printf '%s\\n' "$1" >> "${opened}"`);
    await stub("mktemp", `f="${path.join(temporary, "launcher.log")}"; : > "$f"; printf '%s\\n' "$f"`);
    const { stdout } = await promisify(execFile)("/bin/bash", [path.join(temporary, "start-dashboard.command")], {
      env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      timeout: 15_000,
    });
    assert.match(stdout, /synthetic server log line/);
    assert.ok(stdout.includes(`Dashboard URL: ${url}`), stdout);
    assert.equal(await readFile(opened, "utf8"), `${url}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

test("a lock carrying this process's pid but not its nonce is reclaimed at once", async (t) => {
  t.mock.method(console, "error", () => {});
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-own-pid-lock-test-"));
  try {
    const indexPath = path.join(temporary, "pages.json");
    // Same pid, left by an earlier process (e.g. a restarted container): missing or foreign nonce.
    for (const [i, extra] of [{}, { nonce: "an-earlier-process" }].entries()) {
      await writeFile(`${indexPath}.lock`, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), ...extra })}\n`);
      const started = Date.now();
      await updatePagesIndex((current) => [...current, { slug: `reclaimed-${i}`, title: "Reclaimed" }], { indexPath });
      assert.ok(Date.now() - started < 2_000, "must not wait for the lock timeout");
    }
    const indexed = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(indexed.map((entry) => entry.slug), ["reclaimed-0", "reclaimed-1"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// forge.mjs imports unlink from node:fs/promises as a named binding. Replacing the
// builtin export and calling syncBuiltinESMExports() makes that binding see the stub.
async function withFailingLockUnlink(code, run, { times = Infinity } = {}) {
  const realUnlink = fsPromises.unlink;
  let failures = 0;
  fsPromises.unlink = async (target, ...rest) => {
    if (String(target).endsWith(".lock") && failures < times) {
      failures += 1;
      const error = new Error(`${code}: stubbed unlink failure, unlink '${target}'`);
      error.code = code;
      throw error;
    }
    return realUnlink(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fsPromises.unlink = realUnlink;
    syncBuiltinESMExports();
  }
}

test("a lock-cleanup failure after a failed update keeps the original error and only warns", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-lock-unlink-test-"));
  const warn = t.mock.method(console, "warn", () => {});
  try {
    const indexPath = path.join(temporary, "pages.json");
    const original = new Error("update failed");
    await withFailingLockUnlink("EPERM", () =>
      assert.rejects(
        updatePagesIndex(() => {
          throw original;
        }, { indexPath }),
        (error) => error === original,
      ));
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /could not remove pages index lock after a failed update \(EPERM\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a lock-cleanup failure after a successful write is not an error and the next update takes the lock over", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-lock-unlink-test-"));
  const warn = t.mock.method(console, "warn", () => {});
  try {
    const indexPath = path.join(temporary, "pages.json");
    const result = await withFailingLockUnlink("EBUSY", () =>
      updatePagesIndex((current) => [...current, { slug: "kept", title: "Kept" }], { indexPath }), { times: 1 });
    assert.deepEqual(result.map((entry) => entry.slug), ["kept"]);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /pages index was written, but its lock file could not be removed \(EBUSY\)/);
    await readFile(`${indexPath}.lock`, "utf8"); // still there

    const started = Date.now();
    await Promise.all(["next-0", "next-1", "next-2"].map((slug) =>
      updatePagesIndex((current) => [...current, { slug, title: "Next" }], { indexPath })));
    assert.ok(Date.now() - started < 2_000, "must not wait on its own leftover lock until the timeout");
    const indexed = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(indexed.map((entry) => entry.slug).sort(), ["kept", "next-0", "next-1", "next-2"]);
    await assert.rejects(readFile(`${indexPath}.lock`, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a lock that is already gone (ENOENT) is not an error", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-lock-unlink-test-"));
  try {
    const indexPath = path.join(temporary, "pages.json");
    const result = await withFailingLockUnlink("ENOENT", () =>
      updatePagesIndex((current) => [...current, { slug: "fine", title: "Fine" }], { indexPath }));
    assert.deepEqual(result.map((entry) => entry.slug), ["fine"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
