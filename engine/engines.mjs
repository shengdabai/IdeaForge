import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_ENGINE = "codex";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 900;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeEngineName(engineName) {
  const name = (engineName || DEFAULT_ENGINE).trim().toLowerCase();
  if (!["codex", "claude", "ollama"].includes(name)) {
    throw new Error(`Unknown engine "${engineName}". Expected one of: codex, claude, ollama.`);
  }
  return name;
}

function runProcess(command, args, { input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const cleanStdout = stripAnsi(stdout).trim();
      const cleanStderr = stripAnsi(stderr).trim();
      if (code === 0) {
        resolve({ stdout: cleanStdout, stderr: cleanStderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}${cleanStderr ? `: ${cleanStderr}` : ""}`));
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runCodex(prompt) {
  const dir = await mkdtemp(path.join(tmpdir(), "ideaforge-codex-"));
  const outputFile = path.join(dir, "last-message.txt");
  try {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--output-last-message",
      outputFile,
      "-",
    ];
    const result = await runProcess("codex", args, { input: prompt });
    try {
      const finalMessage = (await readFile(outputFile, "utf8")).trim();
      if (finalMessage) return finalMessage;
    } catch {
      // Fall back to stdout below. Codex versions before --output-last-message may not write the file.
    }
    if (!result.stdout) {
      throw new Error("codex returned no stdout and no final-message file.");
    }
    return result.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runClaude(prompt) {
  console.error(
    "[IdeaForge] Warning: claude -p may use the independent Claude Code/API budget from 2026-06-15. Default engine remains codex.",
  );
  const args = ["-p", "--output-format", "text", "--no-session-persistence", prompt];
  const result = await runProcess("claude", args);
  if (!result.stdout) throw new Error("claude returned empty output.");
  return result.stdout;
}

async function runOllama(prompt) {
  const model = process.env.IDEAFORGE_OLLAMA_MODEL || process.env.OLLAMA_MODEL || "qwen3-coder:30b";
  const args = ["run", model, "--hidethinking", prompt];
  const result = await runProcess("ollama", args);
  if (!result.stdout) throw new Error(`ollama model "${model}" returned empty output.`);
  return result.stdout;
}

async function runOnce(engineName, prompt) {
  if (!prompt || !String(prompt).trim()) throw new Error("Prompt is empty.");
  switch (normalizeEngineName(engineName)) {
    case "codex":
      return runCodex(prompt);
    case "claude":
      return runClaude(prompt);
    case "ollama":
      return runOllama(prompt);
    default:
      throw new Error(`Unsupported engine: ${engineName}`);
  }
}

export async function run(engineName = DEFAULT_ENGINE, prompt) {
  const engine = normalizeEngineName(engineName);
  const errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const output = await runOnce(engine, prompt);
      const text = String(output || "").trim();
      if (!text) throw new Error(`${engine} returned empty output.`);
      return text;
    } catch (error) {
      errors.push(`attempt ${attempt}: ${error.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Engine "${engine}" failed after ${MAX_ATTEMPTS} attempts:\n${errors.join("\n")}`);
}

export const __test__ = {
  normalizeEngineName,
  stripAnsi,
};
