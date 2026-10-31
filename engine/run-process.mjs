import { spawn } from "node:child_process";

const KILL_GRACE_MS = 5_000;

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Run a child process to completion and collect its output.
 *
 * - stdout/stderr are collected as Buffers and decoded once at the end, so a
 *   multi-byte UTF-8 character split across two pipe chunks is never corrupted.
 * - `input` is written to stdin; an EPIPE from a child that exits before
 *   reading it is swallowed (the exit code carries the real failure).
 * - On timeout the child receives SIGTERM, then SIGKILL after a grace period.
 * - Exit by signal is reported by name instead of "code null".
 */
export function runProcess(command, args, { input, timeoutMs, env, stripAnsiOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
    } catch (error) {
      reject(Object.assign(new Error(`Failed to start ${command}: ${error.message}`), { code: error.code, spawnFailed: true }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    let killTimer = null;

    const finish = (callback) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callback();
    };

    const timer = timeoutMs
      ? setTimeout(() => {
        if (done) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        finish(() => reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.stdin.on("error", () => {
      // The child closed stdin early (EPIPE). Its exit status reports the cause.
    });
    child.on("error", (error) => {
      finish(() => reject(Object.assign(new Error(`Failed to start ${command}: ${error.message}`), { code: error.code, spawnFailed: true })));
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      finish(() => {
        const decode = (chunks) => {
          const text = Buffer.concat(chunks).toString("utf8");
          return stripAnsiOutput ? stripAnsi(text).trim() : text;
        };
        const stdout = decode(stdoutChunks);
        const stderr = decode(stderrChunks);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const reason = code === null ? `was terminated by ${signal || "a signal"}` : `exited with code ${code}`;
        const detail = stderr.trim();
        reject(Object.assign(new Error(`${command} ${reason}${detail ? `: ${detail}` : ""}`), { exitCode: code, signal, stdout, stderr }));
      });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const __test__ = { stripAnsi };
