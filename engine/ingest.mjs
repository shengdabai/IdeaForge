import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { runProcess } from "./run-process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INPUTS_DIR = path.join(ROOT, "inputs");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".svg"]);

export async function resolveImagePath(input) {
  const value = String(input || "").trim();
  // Preserve project-relative lookup before caller-relative lookup in both stages.
  for (const candidate of new Set([path.resolve(ROOT, value), path.resolve(value)])) {
    if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code)) throw error;
    }
  }
  return "";
}

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

function safePart(input, fallback = "input") {
  const cleaned = String(input || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  let bounded = "";
  // Timestamp, UUID and extension must also fit a 255-byte filename.
  for (const character of [...cleaned].slice(0, 64)) {
    if (Buffer.byteLength(bounded + character) > 180) break;
    bounded += character;
  }
  return bounded || fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function ensureInputsDir() {
  await mkdir(INPUTS_DIR, { recursive: true });
}

async function archiveRecord(record, label, { inputsDir = INPUTS_DIR } = {}) {
  await mkdir(inputsDir, { recursive: true });
  const file = path.join(inputsDir, `${timestampSlug(new Date(record.fetchedAt))}-${safePart(label)}-${randomUUID()}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
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

// The API key travels in a curl config read from stdin (`-K -`), so it never
// appears in the process table (`ps`) or in a crash report's argv.
export function firecrawlCurlInvocation(url, key, { endpoint = FIRECRAWL_SCRAPE_URL } = {}) {
  if (/[\r\n"]/u.test(String(key))) throw new Error("Firecrawl API key contains characters that cannot be passed safely.");
  const body = JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true });
  return {
    command: "curl",
    args: ["-sS", "--fail", "-K", "-", "-X", "POST", endpoint, "-H", "Content-Type: application/json", "--data", body],
    input: `header = "Authorization: Bearer ${key}"\n`,
  };
}

async function fetchWithFirecrawl(url, key) {
  if (/[\r\n]/.test(key)) throw new Error("Firecrawl API key must not contain line breaks.");
  const invocation = firecrawlCurlInvocation(url, key);
  const result = await runProcess(invocation.command, invocation.args, { input: invocation.input, timeoutMs: 90_000 });
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
    ["-sS", "-L", "--max-redirs", "5", "--fail", "--max-time", "30", "-A", "IdeaForge/1.0 (+local)", url],
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

export function ollamaBaseUrl() {
  const raw = String(process.env.OLLAMA_HOST || "").trim();
  if (!raw) return "http://127.0.0.1:11434";
  return /^https?:\/\//iu.test(raw) ? raw.replace(/\/+$/u, "") : `http://${raw.replace(/\/+$/u, "")}`;
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
  // The base64 image goes through stdin: as an argv entry it exceeds the 1 MiB
  // argument limit for any photo above ~700 KB and curl never starts (E2BIG).
  const result = await runProcess(
    "curl",
    ["-sS", "--fail", `${ollamaBaseUrl()}/api/generate`, "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { input: payload, timeoutMs: 120_000 },
  );
  const parsed = JSON.parse(result.stdout);
  return parsed.response || "";
}

async function ingestImage(input) {
  const imagePath = await resolveImagePath(input);
  if (!imagePath) throw new Error(`Image input is not an existing image file: ${input}`);
  await ensureInputsDir();
  const archivedImage = path.join(INPUTS_DIR, `${timestampSlug()}-${safePart(path.basename(imagePath), "image")}-${randomUUID()}${path.extname(imagePath)}`);
  await copyFile(imagePath, archivedImage, constants.COPYFILE_EXCL);

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
  fetchWithFirecrawl,
  archiveRecord,
  describeImageWithOllama,
};
