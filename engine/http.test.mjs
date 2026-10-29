import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { __test__, serve } from "./forge.mjs";

async function withServer(run) {
  const received = [];
  const token = "synthetic-http-token";
  const server = await serve({ port: 0, token, forgePage: async (input, options) => {
    received.push({ input, options });
    return { entry: { title: "Synthetic", htmlPath: "pages/synthetic.html" } };
  } });
  try {
    await run({ base: `http://127.0.0.1:${server.address().port}`, token, received });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function requestStatus(base, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, base), { method, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

test("request body keeps UTF-8 characters split across network chunks", async () => {
  const expected = JSON.stringify({ input: "中文素材 🔥" });
  const bytes = Buffer.from(expected);
  async function* chunks() {
    for (const byte of bytes) yield Buffer.from([byte]);
  }
  assert.equal(await __test__.readRequestBody(Readable.from(chunks())), expected);
});

test("interrupted upload rejects without an unhandled follow-up stream error", async () => {
  const stream = new PassThrough();
  const rejected = assert.rejects(__test__.readRequestBody(stream), /interrupted/i);
  stream.emit("aborted");
  stream.emit("error", new Error("Synthetic connection reset"));
  await rejected;
  stream.destroy();
});

test("request body limit counts bytes rather than Unicode characters", async () => {
  assert.equal(await __test__.readRequestBody(Readable.from([Buffer.from("中")] ), 3), "中");
  await assert.rejects(__test__.readRequestBody(Readable.from([Buffer.from("中文")]), 3),
    (error) => error.statusCode === 413);
});

test("malformed URL escapes return a client error and leave the server available", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/pages/%E0%A4`)).status, 400);
    assert.equal((await fetch(`${base}/index.html`)).status, 200);
  });
});

test("generation rejects malformed payloads before invoking the engine", async () => {
  await withServer(async ({ base, token, received }) => {
    for (const body of ["{", "null", "[]", '"text"', "{}",
      JSON.stringify({ input: {} }), JSON.stringify({ input: ["idea"] }),
      JSON.stringify({ input: "   " }), JSON.stringify({ input: "idea", engine: "unknown" }),
      JSON.stringify({ input: "idea", engine: {} }), JSON.stringify({ input: "idea", engine: "" })]) {
      const response = await fetch(`${base}/generate`, {
        method: "POST", headers: { "X-Forge-Token": token }, body,
      });
      assert.equal(response.status, 400, body);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal(received.length, 0);
    const response = await fetch(`${base}/generate`, {
      method: "POST", headers: { "X-Forge-Token": token },
      body: JSON.stringify({ input: "中文素材", engine: "ollama" }),
    });
    assert.equal(response.status, 200);
    assert.equal(received[0].input, "中文素材");
    assert.equal(received[0].options.engine, "ollama");
  });
});

test("generation reports an oversized body as 413 without invoking the engine", async () => {
  await withServer(async ({ base, token, received }) => {
    const response = await fetch(`${base}/generate`, {
      method: "POST", headers: { "X-Forge-Token": token },
      body: JSON.stringify({ input: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/i);
    assert.equal(received.length, 0);
  });
});

test("cross-site requests cannot read archives or trigger generation", async () => {
  await withServer(async ({ base, token, received }) => {
    for (const headers of [{ Origin: "https://hostile.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      assert.equal((await fetch(`${base}/index.html`, { headers })).status, 403);
      assert.equal((await fetch(`${base}/generate`, {
        method: "POST", headers: { ...headers, "X-Forge-Token": token },
        body: JSON.stringify({ input: "synthetic idea" }),
      })).status, 403);
    }
    assert.equal(received.length, 0);
    assert.equal((await fetch(`${base}/index.html`, { headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  });
});

test("top-level document GET navigations can open read-only pages from another site", async () => {
  await withServer(async ({ base, received }) => {
    for (const site of ["same-site", "cross-site"]) {
      const headers = {
        "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
      };
      for (const pathname of ["/", "/index.html", "/templates/golden.html"]) {
        assert.equal(await requestStatus(base, pathname, { headers }), 200, `${site}: ${pathname}`);
      }
      assert.equal(await requestStatus(base, "/generate", { headers }), 403);
      assert.equal(await requestStatus(base, "/engine/forge.mjs", { headers }), 403);
    }
    assert.equal(received.length, 0);
  });
});

test("navigation headers do not allow embedded, non-GET, or cross-site generation requests", async () => {
  await withServer(async ({ base, token, received }) => {
    for (const site of ["same-site", "cross-site"]) {
      const navigation = {
        "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
      };
      for (const headers of [
        { ...navigation, "Sec-Fetch-Mode": "cors" },
        { ...navigation, "Sec-Fetch-Mode": "no-cors" },
        { ...navigation, "Sec-Fetch-Dest": "iframe" },
        { ...navigation, "Sec-Fetch-Dest": "empty" },
        { "Sec-Fetch-Site": site },
      ]) {
        assert.equal(await requestStatus(base, "/index.html", { headers }), 403);
      }
      assert.equal(await requestStatus(base, "/index.html", { method: "HEAD", headers: navigation }), 403);
      assert.equal(await requestStatus(base, "/generate", {
        method: "POST", headers: { ...navigation, "X-Forge-Token": token },
      }), 403);
    }
    for (const supplied of [undefined, "synthetic-invalid-token"]) {
      const headers = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
      if (supplied) headers["X-Forge-Token"] = supplied;
      assert.equal(await requestStatus(base, "/generate", { method: "POST", headers }), 401);
    }
    assert.equal(received.length, 0);
  });
});

test("static routes reject sensitive filenames and symlinks into hidden files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ideaforge-static-fixture-"));
  let server;
  try {
    await mkdir(path.join(root, "engine"));
    await mkdir(path.join(root, "pages"));
    await Promise.all(["forge.mjs", "ingest.mjs", "generate.mjs", "engines.mjs"].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), path.join(root, "engine", name))));
    await writeFile(path.join(root, "pages", ".private-note"), "Synthetic private fixture");
    await symlink(".private-note", path.join(root, "pages", "visible.html"));
    for (const name of ["auth.json", "credentials.json", "secrets.json", "sample.pem", "sample.key", "id_rsa_test"]) {
      await writeFile(path.join(root, "pages", name), "Synthetic credential fixture");
    }
    const fixture = await import(pathToFileURL(path.join(root, "engine", "forge.mjs")).href);
    server = await fixture.serve({ port: 0, token: "synthetic-static-token" });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of ["visible.html", "auth.json", "credentials.json", "secrets.json", "sample.pem", "sample.key", "id_rsa_test"]) {
      const response = await fetch(`${base}/pages/${name}`);
      assert.equal(response.status, 403, name);
      assert.doesNotMatch(await response.text(), /Synthetic/);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
