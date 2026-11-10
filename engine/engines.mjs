import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./run-process.mjs";

const DEFAULT_ENGINE = "codex";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 900;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const ENGINE_ENV = { NO_COLOR: "1", TERM: "dumb" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEngineName(engineName) {
  const name = (engineName || DEFAULT_ENGINE).trim().toLowerCase();
  if (!["codex", "claude", "ollama"].includes(name)) {
    throw new Error(`Unknown engine "${engineName}". Expected one of: codex, claude, ollama.`);
  }
  return name;
}

/**
 * Build the CLI invocation for an engine. The prompt is always delivered on
 * stdin: it embeds the golden template plus the ingested article, so it can
 * exceed the kernel argv limits (1 MiB total on macOS, 128 KiB per argument on
 * Linux) when passed as a command-line argument.
 */
export function engineInvocation(engineName, prompt, { outputFile = "" } = {}) {
  switch (normalizeEngineName(engineName)) {
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          ...(outputFile ? ["--output-last-message", outputFile] : []),
          "-",
        ],
        input: prompt,
      };
    case "claude":
      // Generation needs only the supplied prompt. Source articles must not be
      // able to invoke local commands, read files, or use configured MCP tools.
      return {
        command: "claude",
        args: ["-p", "--output-format", "text", "--no-session-persistence",
          "--tools", "", "--disallowedTools", "mcp__*",
          "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
        input: prompt,
      };
    case "ollama": {
      const model = process.env.IDEAFORGE_OLLAMA_MODEL || process.env.OLLAMA_MODEL || "qwen3-coder:30b";
      return { command: "ollama", args: ["run", model, "--hidethinking"], input: prompt, model };
    }
    default:
      throw new Error(`Unsupported engine: ${engineName}`);
  }
}

function runEngineProcess(invocation) {
  return runProcess(invocation.command, invocation.args, {
    input: invocation.input,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: ENGINE_ENV,
    stripAnsiOutput: true,
  });
}

async function runCodex(prompt) {
  const dir = await mkdtemp(path.join(tmpdir(), "ideaforge-codex-"));
  const outputFile = path.join(dir, "last-message.txt");
  try {
    const result = await runEngineProcess(engineInvocation("codex", prompt, { outputFile }));
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
  const result = await runEngineProcess(engineInvocation("claude", prompt));
  if (!result.stdout) throw new Error("claude returned empty output.");
  return result.stdout;
}

async function runOllama(prompt) {
  const invocation = engineInvocation("ollama", prompt);
  const result = await runEngineProcess(invocation);
  if (!result.stdout) throw new Error(`ollama model "${invocation.model}" returned empty output.`);
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

export async function run(engineName = DEFAULT_ENGINE, prompt, { attempt: runAttempt = runOnce, maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
  const engine = normalizeEngineName(engineName);
  const errors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = await runAttempt(engine, prompt);
      const text = String(output || "").trim();
      if (!text) throw new Error(`${engine} returned empty output.`);
      return text;
    } catch (error) {
      errors.push(`attempt ${attempt}: ${error.message}`);
      // A CLI that cannot even start (not installed, not on PATH) will not
      // appear on the next attempt; retrying only delays the real message.
      if (error?.spawnFailed) {
        throw new Error(`Engine "${engine}" could not be started. Is the "${engine}" CLI installed and on PATH?\n${errors.join("\n")}`);
      }
      if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Engine "${engine}" failed after ${maxAttempts} attempts:\n${errors.join("\n")}`);
}

export const __test__ = {
  normalizeEngineName,
};
