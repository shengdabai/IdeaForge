import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INPUTS_DIR = path.join(ROOT, "inputs");

function runProcess(command, args, { input, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function safePart(input, fallback = "input") {
  const cleaned = String(input || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function ensureInputsDir() {
  await mkdir(INPUTS_DIR, { recursive: true });
}

async function archiveRecord(record, label) {
  await ensureInputsDir();
  const file = path.join(INPUTS_DIR, `${timestampSlug(new Date(record.fetchedAt))}-${safePart(label)}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export async function readFirecrawlKey() {
  const candidates = [
    process.env.FIRECRAWL_API_KEY,
    process.env.FIRECRAWL_KEY,
    process.env.FC_API_KEY,
  ].filter(Boolean);
  if (candidates[0]) return candidates[0];

  const envPath = path.join(homedir(), ".config", "firecrawl", ".env");
  try {
    const env = parseEnvFile(await readFile(envPath, "utf8"));
    return env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY || env.FC_API_KEY || "";
  } catch {
    return "";
  }
}

function isWechatUrl(url) {
  try {
    return new URL(url).hostname.includes("mp.weixin.qq.com");
  } catch {
    return false;
  }
}

async function fetchWithFirecrawl(url, key) {
  const body = JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true });
  const result = await runProcess(
    "curl",
    [
      "-sS",
      "--fail",
      "-X",
      "POST",
      "https://api.firecrawl.dev/v1/scrape",
      "-H",
      `Authorization: Bearer ${key}`,
      "-H",
      "Content-Type: application/json",
      "--data",
      body,
    ],
    { timeoutMs: 90_000 },
  );
  const parsed = JSON.parse(result.stdout);
  const data = parsed.data || parsed;
  const rawContent = data.markdown || data.content || data.html || "";
  if (!rawContent.trim()) throw new Error("Firecrawl returned empty content.");
  return {
    title: data.metadata?.title || data.title || new URL(url).hostname,
    rawContent,
  };
}

function decodeBasicEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function htmlToText(html) {
  const title = decodeBasicEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const rawContent = decodeBasicEntities(body)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, rawContent };
}

async function fetchWithCurl(url) {
  const result = await runProcess(
    "curl",
    ["-sS", "-L", "--fail", "--max-time", "30", "-A", "IdeaForge/1.0 (+local)", url],
    { timeoutMs: 45_000 },
  );
  const extracted = htmlToText(result.stdout);
  if (!extracted.rawContent) throw new Error("curl fetched the URL but no readable text was extracted.");
  return {
    title: extracted.title || new URL(url).hostname,
    rawContent: extracted.rawContent,
  };
}

async function ingestUrl(input) {
  const url = new URL(input).toString();
  const key = await readFirecrawlKey();
  let fetched;
  const firecrawlRequired = isWechatUrl(url);
  if (key) {
    try {
      fetched = await fetchWithFirecrawl(url, key);
    } catch (error) {
      if (firecrawlRequired) {
        throw new Error(`WeChat/mp.weixin.qq.com links require Firecrawl, but Firecrawl failed: ${error.message}`);
      }
      fetched = await fetchWithCurl(url);
      fetched.rawContent = `Firecrawl failed, curl fallback used. Firecrawl error: ${error.message}\n\n${fetched.rawContent}`;
    }
  } else if (firecrawlRequired) {
    throw new Error("WeChat/mp.weixin.qq.com links require Firecrawl, but no key was found at ~/.config/firecrawl/.env.");
  } else {
    fetched = await fetchWithCurl(url);
  }

  const record = {
    type: "url",
    sourceUrl: url,
    title: fetched.title,
    rawContent: fetched.rawContent,
    fetchedAt: new Date().toISOString(),
  };
  record.archivePath = await archiveRecord(record, fetched.title || new URL(url).hostname);
  return record;
}

async function describeImageWithOllama(imagePath) {
  const model = process.env.IDEAFORGE_VISION_MODEL || process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:7b";
  const imageBase64 = await readFile(imagePath, "base64");
  const payload = JSON.stringify({
    model,
    prompt:
      "请用中文读取这张图片：1) 描述画面内容；2) 尽量提取图片中的文字/OCR；3) 如果有图表，请说明结构和结论。",
    images: [imageBase64],
    stream: false,
  });
  const result = await runProcess(
    "curl",
    ["-sS", "--fail", "http://127.0.0.1:11434/api/generate", "-H", "Content-Type: application/json", "--data", payload],
    { timeoutMs: 120_000 },
  );
  const parsed = JSON.parse(result.stdout);
  return parsed.response || "";
}

async function ingestImage(input) {
  const imagePath = path.resolve(input);
  await ensureInputsDir();
  const archivedImage = path.join(INPUTS_DIR, `${timestampSlug()}-${safePart(path.basename(imagePath), "image")}${path.extname(imagePath)}`);
  await copyFile(imagePath, archivedImage);

  let rawContent = "";
  try {
    rawContent = await describeImageWithOllama(imagePath);
  } catch (error) {
    rawContent = [
      "图片采集说明：本地多模态 Ollama 读取失败，已保留图片路径供生成层参考。",
      `原图路径：${imagePath}`,
      `归档路径：${archivedImage}`,
      `失败原因：${error.message}`,
    ].join("\n");
  }

  const record = {
    type: "image",
    title: path.basename(imagePath),
    rawContent: rawContent.trim(),
    imagePath,
    archivedImage,
    fetchedAt: new Date().toISOString(),
  };
  record.archivePath = await archiveRecord(record, path.basename(imagePath));
  return record;
}

async function ingestText(input) {
  const rawContent = String(input || "").trim();
  if (!rawContent) throw new Error("Text input is empty.");
  const title = rawContent.split(/\r?\n/)[0].slice(0, 60);
  const record = {
    type: "text",
    title,
    rawContent,
    fetchedAt: new Date().toISOString(),
  };
  record.archivePath = await archiveRecord(record, title);
  return record;
}

export async function ingest(input, type) {
  if (!input || !String(input).trim()) throw new Error("Input is empty.");
  switch (type) {
    case "url":
      return ingestUrl(String(input).trim());
    case "image":
      return ingestImage(String(input).trim());
    case "text":
      return ingestText(String(input));
    default:
      throw new Error(`Unsupported ingest type "${type}". Expected url, image, or text.`);
  }
}

export const __test__ = {
  htmlToText,
  parseEnvFile,
  safePart,
};
