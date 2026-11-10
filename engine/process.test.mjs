import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./run-process.mjs";
import { engineInvocation, run } from "./engines.mjs";
import { __test__ as ingestInternals, firecrawlCurlInvocation, ollamaBaseUrl } from "./ingest.mjs";


function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function withEnv(overrides, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return Promise.resolve().then(callback).finally(restore);
}

test("runProcess decodes a multi-byte character that is split across pipe chunks", async () => {
  const script = `
    const bytes = Buffer.from("中文乱码测试");
    process.stdout.write(bytes.subarray(0, 4));
    setTimeout(() => { process.stdout.write(bytes.subarray(4)); }, 60);
  `;
  const result = await runProcess(process.execPath, ["-e", script], { timeoutMs: 10_000 });
  assert.equal(result.stdout, "中文乱码测试");
  assert.doesNotMatch(result.stdout, /�/u);
});

test("runProcess survives a child that exits before reading a large stdin payload", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(3)"], { input: "x".repeat(4 * 1024 * 1024), timeoutMs: 10_000 }),
    (error) => error.exitCode === 3 && /exited with code 3/u.test(error.message),
  );
});

test("runProcess names the signal when a child is terminated", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);"], { timeoutMs: 10_000 }),
    /terminated by SIGTERM/u,
  );
});

test("runProcess reports a spawn failure as non-retryable", async () => {
  await assert.rejects(
    runProcess("ideaforge-definitely-missing-binary", [], { timeoutMs: 1_000 }),
    (error) => error.spawnFailed === true && /Failed to start/u.test(error.message),
  );
});

test("runProcess enforces its timeout", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { timeoutMs: 200 }),
    /timed out after 0s/u,
  );
});

test("every engine receives the prompt on stdin, never as an argument", () => {
  const prompt = `<!DOCTYPE html>${"内容".repeat(1024 * 1024)}`; // > 1 MiB, beyond any argv limit
  for (const engine of ["codex", "claude", "ollama"]) {
    const invocation = engineInvocation(engine, prompt, { outputFile: "/tmp/last-message.txt" });
    assert.equal(invocation.input, prompt);
    assert.ok(invocation.args.every((arg) => arg.length < 256), `${engine} must not place the prompt in argv`);
  }
  assert.deepEqual(engineInvocation("codex", "p", { outputFile: "/tmp/o" }).args.slice(-3), ["--output-last-message", "/tmp/o", "-"]);
  assert.throws(() => engineInvocation("gpt", "p"), /Unknown engine/u);
});

test("Claude text generation disables built-in and configured MCP tools", () => {
  const { args } = engineInvocation("claude", "untrusted source content");
  const option = (name) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--tools"));
  assert.equal(option("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--mcp-config"));
  assert.deepEqual(JSON.parse(option("--mcp-config")), { mcpServers: {} });
  assert.equal(option("--disallowedTools"), "mcp__*");
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(option("--output-format"), "text");
});

test("run retries transient failures but stops at once when the CLI cannot start", async () => {
  let transientCalls = 0;
  await assert.rejects(
    run("ollama", "prompt", {
      attempt: async () => {
        transientCalls += 1;
        throw new Error("model busy");
      },
      maxAttempts: 3,
      baseDelayMs: 0,
    }),
    /failed after 3 attempts/u,
  );
  assert.equal(transientCalls, 3);

  let missingCalls = 0;
  await assert.rejects(
    run("claude", "prompt", {
      attempt: async () => {
        missingCalls += 1;
        throw Object.assign(new Error("Failed to start claude: spawn claude ENOENT"), { spawnFailed: true });
      },
      maxAttempts: 3,
      baseDelayMs: 0,
    }),
    /could not be started.*installed and on PATH/u,
  );
  assert.equal(missingCalls, 1);

  let successAfter = 0;
  const output = await run("codex", "prompt", {
    attempt: async () => {
      successAfter += 1;
      if (successAfter < 2) throw new Error("flaky");
      return "  <!DOCTYPE html>ok  ";
    },
    baseDelayMs: 0,
  });
  assert.equal(output, "<!DOCTYPE html>ok");
  assert.equal(successAfter, 2);
});

test("the Firecrawl key is passed through curl's stdin config instead of argv", () => {
  const invocation = firecrawlCurlInvocation("https://example.com/post", "fc-secret-key");
  assert.ok(!invocation.args.some((arg) => arg.includes("fc-secret-key")));
  assert.deepEqual(invocation.args.slice(0, 4), ["-sS", "--fail", "-K", "-"]);
  assert.equal(invocation.input, 'header = "Authorization: Bearer fc-secret-key"\n');
  assert.throws(() => firecrawlCurlInvocation("https://example.com", 'bad"key\n'), /cannot be passed safely/u);
});

test("ollamaBaseUrl honours OLLAMA_HOST with or without a scheme", async () => {
  await withEnv({ OLLAMA_HOST: undefined }, () => assert.equal(ollamaBaseUrl(), "http://127.0.0.1:11434"));
  await withEnv({ OLLAMA_HOST: "127.0.0.1:11500" }, () => assert.equal(ollamaBaseUrl(), "http://127.0.0.1:11500"));
  await withEnv({ OLLAMA_HOST: "http://gpu.local:11434/" }, () => assert.equal(ollamaBaseUrl(), "http://gpu.local:11434"));
});

test("image description sends a multi-megabyte image to Ollama through stdin", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-vision-test-"));
  let receivedBytes = 0;
  let receivedModel = "";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      receivedBytes = Buffer.from(body.images[0], "base64").length;
      receivedModel = body.model;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response: "一张测试图片" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const imagePath = path.join(temporary, "photo.png");
    const imageBytes = 1_500_000; // base64 of this exceeds the 1 MiB argv limit
    await writeFile(imagePath, Buffer.alloc(imageBytes, 7));
    const description = await withEnv(
      { OLLAMA_HOST: `127.0.0.1:${server.address().port}`, IDEAFORGE_VISION_MODEL: "test-vision" },
      () => ingestInternals.describeImageWithOllama(imagePath),
    );
    assert.equal(description, "一张测试图片");
    assert.equal(receivedBytes, imageBytes);
    assert.equal(receivedModel, "test-vision");
  } finally {
    await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("archive records with the same timestamp and title never overwrite each other", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-archive-test-"));
  try {
    const fetchedAt = "2026-10-31T01:02:03.004Z";
    const files = await Promise.all([
      ingestInternals.archiveRecord({ type: "text", rawContent: "first", fetchedAt }, "同名想法", { inputsDir: temporary }),
      ingestInternals.archiveRecord({ type: "text", rawContent: "second", fetchedAt }, "同名想法", { inputsDir: temporary }),
      ingestInternals.archiveRecord({ type: "text", rawContent: "third", fetchedAt }, "同名想法", { inputsDir: temporary }),
    ]);
    assert.equal(new Set(files).size, 3);
    assert.equal((await readdir(temporary)).length, 3);
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8").then((text) => JSON.parse(text).rawContent)));
    assert.deepEqual(contents.sort(), ["first", "second", "third"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a Firecrawl key that curl's config parser would unescape is refused", () => {
  assert.throws(() => firecrawlCurlInvocation("https://example.com", "fc-ba\\ckslash"), /cannot be passed safely/u);
});

test("an empty vision description is treated as a failure instead of empty page content", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-vision-empty-test-"));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response: "   " }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const imagePath = path.join(temporary, "photo.png");
    await writeFile(imagePath, Buffer.alloc(64, 3));
    await withEnv(
      { OLLAMA_HOST: `127.0.0.1:${server.address().port}`, IDEAFORGE_VISION_MODEL: "test-vision" },
      () => assert.rejects(ingestInternals.describeImageWithOllama(imagePath), /test-vision.*empty/u),
    );
  } finally {
    await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("htmlToText decodes numeric entities and keeps <br> line breaks", () => {
  const { title, rawContent } = ingestInternals.htmlToText(
    "<html><head><title>Tony&#8217;s &#x4E2D;&#x6587; &ldquo;q&rdquo;</title></head><body><p>line one<br>line two<br />line three</p><p>&#39;a&#39; &amp; &#x27;b&#x27; &#99999999;</p></body></html>",
  );
  assert.equal(title, "Tony’s 中文 “q”");
  assert.match(rawContent, /line one\nline two\nline three/u);
  assert.match(rawContent, /'a' & 'b' &#99999999;/u);
});
