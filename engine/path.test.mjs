import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("provenance regression runs from a project path with Chinese, spaces and percent", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ideaforge-path-"));
  try {
    const root = path.join(temporary, "中文 workspace %");
    const engine = path.join(root, "engine");
    await mkdir(engine, { recursive: true });
    await Promise.all(["forge.mjs", "forge.test.mjs", "ingest.mjs", "generate.mjs", "engines.mjs"].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), path.join(engine, name))));
    let result;
    try {
      result = execFileSync(process.execPath, ["--test", "--test-name-pattern=programmatic provenance", "engine/forge.test.mjs"], {
        cwd: root, env: { HOME: temporary, PATH: process.env.PATH }, encoding: "utf8", timeout: 15_000,
      });
    } catch (error) {
      assert.fail(`Unicode-path provenance test failed:\n${error.stdout || error.message}`);
    }
    assert.match(result, /pass 1/);
    assert.match(result, /fail 0/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
