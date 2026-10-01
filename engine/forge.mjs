#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, copyFile, lstat, mkdir, open, opendir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ingest } from "./ingest.mjs";
import { generateHtml } from "./generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "pages");
const PAGES_JSON = path.join(ROOT, "pages.json");
const DEFAULT_PORT = 8765;
const DEFAULT_CATEGORY = "炼金成品";
const INDEX_LOCK_TIMEOUT_MS = 5_000;
const SENSITIVE_STATIC_NAMES = new Set(["token", "forge-token", "forge.token", "dashboard-token", "dashboard.token"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".svg"]);
const EXTENSION_FRAGMENT_NAMES = new Set([
  "popup.html",
  "background.html",
  "content.html",
  "devtools.html",
  "options.html",
  "sidepanel.html",
  "service-worker.html",
  "service_worker.html",
]);

function usage() {
  return [
    "Usage:",
    '  node engine/forge.mjs [--engine=codex|claude|ollama] [--ingest-only] "想法/URL/图片路径"',
    "  node engine/forge.mjs import <dir> [--category=名] [--copy|--link] [--exclude=glob,glob]",
    "  node engine/forge.mjs serve [--port=8765]",
    "  node engine/forge.mjs --self-test",
  ].join("\n");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function classifyInput(input) {
  const value = String(input || "").trim();
  if (/^https?:\/\//i.test(value)) return "url";
  // Check relative-to-ROOT first, then absolute/cwd-relative path.
  for (const candidate of [path.resolve(ROOT, value), path.resolve(value)]) {
    if (IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase()) && (await fileExists(candidate))) return "image";
  }
  return "text";
}

export function parseArgs(argv) {
  const parsed = {
    command: "",
    engine: "codex",
    ingestOnly: false,
    input: "",
    importDir: "",
    importCategory: "",
    importCopy: true,
    importExclude: "",
    port: DEFAULT_PORT,
    selfTest: false,
    help: false,
  };
  const rest = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--ingest-only") parsed.ingestOnly = true;
    else if (arg === "--self-test") parsed.selfTest = true;
    else if (arg === "--copy") parsed.importCopy = true;
    else if (arg === "--link") parsed.importCopy = false;
    else if (arg.startsWith("--engine=")) parsed.engine = arg.slice("--engine=".length);
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--category=")) parsed.importCategory = arg.slice("--category=".length).trim();
    else if (arg.startsWith("--exclude=")) parsed.importExclude = arg.slice("--exclude=".length).trim();
    else rest.push(arg);
  }
  if (rest[0] === "serve") {
    parsed.command = "serve";
    rest.shift();
  } else if (rest[0] === "import") {
    parsed.command = "import";
    rest.shift();
    parsed.importDir = rest.shift() || "";
  }
  if (rest.length) parsed.input = rest.join(" ");
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error(`Invalid --port value: ${parsed.port}`);
  }
  if (!["codex", "claude", "ollama"].includes(parsed.engine)) {
    throw new Error(`Invalid --engine value: ${parsed.engine}`);
  }
  return parsed;
}

function slugify(input, fallback = "page") {
  const slug = String(input || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html, fallback) {
  const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return decodeBasicEntities(title || fallback || "未命名页面").replace(/\s+/g, " ").trim();
}

function extractTags(html) {
  const tags = new Set();
  const pattern = /<([a-z0-9:-]+)\b(?=[^>]*class\s*=\s*["'][^"']*\btag\b[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const text = decodeBasicEntities(match[2]).replace(/<[^>]+>/g, "").replace(/^#\s*/, "").trim();
    if (text) tags.add(text);
  }
  return [...tags].slice(0, 8);
}

async function uniquePagePath(baseSlug) {
  await mkdir(PAGES_DIR, { recursive: true });
  let slug = baseSlug;
  let filePath = path.join(PAGES_DIR, `${slug}.html`);
  let i = 2;
  while (await fileExists(filePath)) {
    slug = `${baseSlug}-${i}`;
    filePath = path.join(PAGES_DIR, `${slug}.html`);
    i += 1;
  }
  return { slug, filePath };
}

async function writeNewPage(baseSlug, html, { pagesDir = PAGES_DIR } = {}) {
  await mkdir(pagesDir, { recursive: true });
  for (let i = 1; i < 10_000; i += 1) {
    const slug = i === 1 ? baseSlug : `${baseSlug}-${i}`;
    const filePath = path.join(pagesDir, `${slug}.html`);
    try {
      await writeFile(filePath, html, { encoding: "utf8", flag: "wx" });
      return { slug, filePath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate a unique page filename for: ${baseSlug}`);
}

async function readPagesJson(indexPath = PAGES_JSON) {
  try {
    const text = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("pages.json must be an array.");
    return parsed.map(normalizePageEntry);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writePagesJson(list, indexPath = PAGES_JSON) {
  const directory = path.dirname(indexPath);
  const temporaryPath = path.join(directory, `.${path.basename(indexPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(list.map(normalizePageEntry), null, 2)}\n`, "utf8");
  await rename(temporaryPath, indexPath);
}

function normalizePageEntry(entry) {
  return {
    ...entry,
    category: String(entry?.category || DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireIndexLock(indexPath) {
  const lockPath = `${indexPath}.lock`;
  const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return { lockPath, handle };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await removeAbandonedIndexLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for pages index lock: ${lockPath}`);
      await wait(25 + Math.floor(Math.random() * 25));
    }
  }
}

async function removeAbandonedIndexLock(lockPath) {
  let snapshot;
  try {
    snapshot = await lstat(lockPath);
    let metadata;
    try {
      metadata = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      // An empty or partial lock may still belong to a live process paused
      // between exclusive creation and metadata write. Fail closed.
      return false;
    }
    if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) return false;
    try {
      process.kill(metadata.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") return false;
    }
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }

  try {
    const current = await lstat(lockPath);
    if (current.dev !== snapshot.dev || current.ino !== snapshot.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

export async function updatePagesIndex(update, { indexPath = PAGES_JSON } = {}) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const lock = await acquireIndexLock(indexPath);
  try {
    const current = await readPagesJson(indexPath);
    const next = await update(current);
    if (!Array.isArray(next)) throw new Error("pages index update must return an array.");
    await writePagesJson(next, indexPath);
    return next;
  } finally {
    await lock.handle.close();
    try {
      await unlink(lock.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function appendPageIndex(entry) {
  await updatePagesIndex((list) => {
    const withoutSameEntry = list.filter((item) => {
      if (entry.htmlPath) return item.htmlPath !== entry.htmlPath;
      return item.slug !== entry.slug;
    });
    return [...withoutSameEntry, entry];
  });
}

async function appendPageIndexes(entries) {
  if (!entries.length) return;
  await updatePagesIndex((list) => {
    const entryKey = (item) => item.htmlPath ? `path:${item.htmlPath}` : `slug:${item.slug}`;
    const byIdentity = new Map(list.map((item) => [entryKey(item), item]));
    for (const entry of entries) byIdentity.set(entryKey(entry), entry);
    return [...byIdentity.values()];
  });
}

function sourceFromRecord(record) {
  if (record.sourceUrl) return record.sourceUrl;
  if (record.type === "image") return record.archivedImage || record.imagePath || "本地图片";
  return "本地文本";
}

// IdeaForge is macOS-only for the auto-open feature (uses `open`).
// On other platforms the file is still generated; open it manually.
async function openFile(filePath) {
  if (process.platform !== "darwin") {
    console.warn(`[IdeaForge] auto-open not supported on ${process.platform}. File saved to: ${filePath}`);
    return;
  }
  const child = spawn("open", [filePath], { stdio: "ignore" });
  child.unref();
}

export async function forge(input, { engine = "codex", ingestOnly = false, shouldOpen = true } = {}) {
  const type = await classifyInput(input);
  const record = await ingest(input, type);
  if (ingestOnly) return { mode: "ingest-only", record };

  const html = await generateHtml(record, engine);
  const title = extractTitle(html, record.title);
  const { slug, filePath } = await writeNewPage(slugify(title, slugify(record.title, "page")), html);

  const entry = {
    slug,
    title,
    type: record.type,
    source: sourceFromRecord(record),
    tags: extractTags(html),
    category: DEFAULT_CATEGORY,
    createdAt: new Date().toISOString().slice(0, 10),
    htmlPath: `pages/${slug}.html`,
  };
  await appendPageIndex(entry);
  if (shouldOpen) await openFile(filePath);
  return { mode: "generated", record, entry, htmlPath: filePath };
}

function globToRegExp(glob) {
  const escaped = String(glob || "")
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function buildExcludeMatchers(excludeText) {
  return String(excludeText || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({ raw: item, re: globToRegExp(item) }));
}

function isExcluded(relativePath, basename, matchers) {
  const normalized = relativePath.split(path.sep).join("/");
  return matchers.some((matcher) => matcher.re.test(basename) || matcher.re.test(normalized));
}

function inferCategory(filePath, importRoot, rootName, forcedCategory) {
  if (forcedCategory) return forcedCategory;
  const relative = path.relative(importRoot, filePath);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length > 1) return parts[0];
  return rootName;
}

function stripHtml(text) {
  return decodeBasicEntities(String(text || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function safeFilePart(input, fallback = "page") {
  const cleaned = String(input || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

async function* walkHtmlFiles(dir) {
  const entries = await opendir(dir);
  for await (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkHtmlFiles(filePath);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".html") {
      yield filePath;
    }
  }
}

function primaryCopyTarget(category, baseName) {
  const safeCategory = safeFilePart(category, DEFAULT_CATEGORY);
  const targetDir = path.join(PAGES_DIR, safeCategory);
  const safeBase = safeFilePart(baseName, "page");
  const fileName = `${safeBase}.html`;
  return {
    targetDir,
    safeBase,
    absolute: path.join(targetDir, fileName),
    relative: `pages/${safeCategory}/${fileName}`,
  };
}

async function availableCopyTarget(primary, usedPaths) {
  if (!usedPaths.has(primary.relative) && !(await fileExists(primary.absolute))) return primary;
  let i = 2;
  while (i <= 9999) {
    const fileName = `${primary.safeBase}-${i}.html`;
    const relative = path.posix.join(path.posix.dirname(primary.relative), fileName);
    const absolute = path.join(primary.targetDir, fileName);
    if (!usedPaths.has(relative) && !(await fileExists(absolute))) {
      return { targetDir: primary.targetDir, absolute, relative };
    }
    i += 1;
  }
  throw new Error(`availableCopyTarget: could not find a free filename for "${primary.safeBase}" after 9999 attempts`);
}

// 外来 html 的 .tag 类语义不可控（常被用作状态徽章），严格清洗：
// 滤掉含标点/空格的长短语，只留短词，分类打头，最多 5 个。
function sanitizeImportTags(html, category) {
  const NOISE = /[·:：,，。;；/、\s]/;
  const cleaned = [];
  for (const t of extractTags(html)) {
    const s = t.trim();
    if (!s || s.length > 8 || NOISE.test(s)) continue;
    cleaned.push(s);
    if (cleaned.length >= 4) break;
  }
  return [...new Set([category, ...cleaned])].filter(Boolean).slice(0, 5);
}

export async function importPages(dir, { category = "", copy = true, exclude = "" } = {}) {
  if (!copy) console.warn("[import] --link indexes local paths only; HTTP dashboard browsers cannot open file:// links. Omit --link to copy portable HTML.");
  const importRoot = path.resolve(dir || "");
  const info = await stat(importRoot);
  const isSingleFile = info.isFile() && path.extname(importRoot).toLowerCase() === ".html";
  if (!info.isDirectory() && !isSingleFile) throw new Error(`Import path must be a directory or .html file: ${importRoot}`);

  const rootName = isSingleFile
    ? (path.basename(path.dirname(importRoot)) || DEFAULT_CATEGORY)
    : (path.basename(importRoot) || DEFAULT_CATEGORY);
  const matchers = buildExcludeMatchers(exclude);
  const existing = await readPagesJson();
  const existingPaths = new Set(existing.map((item) => item.htmlPath).filter(Boolean));
  const usedPaths = new Set(existingPaths);
  const imported = [];
  const categoryCounts = new Map();
  const skipped = {
    duplicate: 0,
    excluded: 0,
    fragment: 0,
    shell: 0,
    error: 0,
  };
  let scanned = 0;

  for await (const filePath of (isSingleFile ? [importRoot] : walkHtmlFiles(importRoot))) {
    scanned += 1;
    if (scanned % 200 === 0) {
      console.log(`[import] scanned ${scanned}, imported ${imported.length}, skipped ${Object.values(skipped).reduce((a, b) => a + b, 0)}`);
    }

    const basename = path.basename(filePath);
    const relativeToImportRoot = path.relative(importRoot, filePath);
    if (isExcluded(relativeToImportRoot, basename, matchers)) {
      skipped.excluded += 1;
      continue;
    }
    if (EXTENSION_FRAGMENT_NAMES.has(basename.toLowerCase())) {
      skipped.fragment += 1;
      continue;
    }

    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.size < 300) {
        skipped.shell += 1;
        continue;
      }

      const html = await readFile(filePath, "utf8");
      const pageCategory = inferCategory(filePath, importRoot, rootName, category);
      const title = extractTitle(html, path.basename(filePath, path.extname(filePath)));
      const tags = sanitizeImportTags(html, pageCategory);
      let htmlPath;
      if (copy) {
        const primary = primaryCopyTarget(pageCategory, path.basename(filePath, path.extname(filePath)));
        if (existingPaths.has(primary.relative) || usedPaths.has(primary.relative)) {
          skipped.duplicate += 1;
          continue;
        }
        const target = await availableCopyTarget(primary, usedPaths);
        htmlPath = target.relative;
        await mkdir(target.targetDir, { recursive: true });
        await copyFile(filePath, target.absolute);
      } else {
        htmlPath = path.resolve(filePath);
        if (existingPaths.has(htmlPath) || usedPaths.has(htmlPath)) {
          skipped.duplicate += 1;
          continue;
        }
      }

      usedPaths.add(htmlPath);
      imported.push({
        slug: slugify(path.basename(filePath, path.extname(filePath))),
        title,
        type: "html",
        source: copy ? path.resolve(filePath) : "本地 HTML",
        tags,
        category: pageCategory,
        createdAt: new Date().toISOString().slice(0, 10),
        htmlPath,
      });
      categoryCounts.set(pageCategory, (categoryCounts.get(pageCategory) || 0) + 1);
    } catch (error) {
      skipped.error += 1;
      console.warn(`[import] skipped ${filePath}: ${error.message}`);
    }
  }

  await appendPageIndexes(imported);

  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  console.log(`[import] done: imported ${imported.length}, skipped ${skippedTotal}, scanned ${scanned}`);
  for (const [name, value] of [...categoryCounts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans"))) {
    console.log(`[import] category ${name}: ${value}`);
  }
  return { imported: imported.length, skipped, scanned, categoryCounts: Object.fromEntries(categoryCounts) };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return `image/${ext.slice(1).replace("jpg", "jpeg")}`;
  return "application/octet-stream";
}

async function readRequestBody(req, limitBytes = 2 * 1024 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > limitBytes) throw new Error("Request body is too large.");
  }
  return body;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function isSensitiveStaticPath(relativePath) {
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith(".") || SENSITIVE_STATIC_NAMES.has(part.toLowerCase()));
}

function isAllowedStaticPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized === "index.html"
    || normalized === "pages.json"
    || normalized.startsWith("pages/")
    || normalized.startsWith("templates/");
}

function isAuthorized(req, token) {
  const supplied = req.headers["x-forge-token"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (isSensitiveStaticPath(relative) || !isAllowedStaticPath(relative)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Forbidden");
    return;
  }
  const filePath = path.resolve(ROOT, relative);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const [rootPath, resolvedFilePath] = await Promise.all([realpath(ROOT), realpath(filePath)]);
    const resolvedRelative = path.relative(rootPath, resolvedFilePath);
    if (!resolvedRelative || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative) || !isAllowedStaticPath(resolvedRelative)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Forbidden");
      return;
    }
    const info = await stat(resolvedFilePath);
    if (!info.isFile()) throw new Error("Not a file.");
    const body = await readFile(resolvedFilePath);
    res.writeHead(200, { "Content-Type": contentType(resolvedFilePath), "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export async function serve({
  port = DEFAULT_PORT,
  token = process.env.IDEAFORGE_DASHBOARD_TOKEN || randomBytes(32).toString("base64url"),
  forgePage = forge,
} = {}) {
  if (typeof token !== "string" || !token) throw new Error("Dashboard token must be a non-empty string.");
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/generate") {
        if (!isAuthorized(req, token)) {
          sendJson(res, 401, { error: "Missing or invalid X-Forge-Token." });
          return;
        }
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        if (!payload.input || !String(payload.input).trim()) throw new Error("Missing required field: input");
        const result = await forgePage(String(payload.input), {
          engine: payload.engine || "codex",
          ingestOnly: false,
          shouldOpen: false,
        });
        sendJson(res, 200, result.entry);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res);
        return;
      }
      res.writeHead(405);
      res.end("Method not allowed");
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`IdeaForge serving at http://127.0.0.1:${actualPort}/#forge-token=${encodeURIComponent(token)}`);
  return server;
}

async function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`self-test failed: ${message}`);
  };
  assert(parseArgs(["--engine=ollama", "--ingest-only", "hello"]).engine === "ollama", "engine parse");
  assert(parseArgs(["serve", "--port=9999"]).command === "serve", "serve command parse");
  assert(parseArgs(["import", "./x", "--category=资料", "--copy", "--exclude=popup.html"]).command === "import", "import command parse");
  assert(parseArgs(["a", "b"]).input === "a b", "input join parse");
  assert((await classifyInput("https://example.com")) === "url", "url classify");
  assert((await classifyInput("一句纯文字想法")) === "text", "text classify");
  console.log("forge self-test passed");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.selfTest) {
    await selfTest();
    return;
  }
  if (args.command === "serve") {
    await serve({ port: args.port });
    return;
  }
  if (args.command === "import") {
    if (!args.importDir) {
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    await importPages(args.importDir, {
      category: args.importCategory,
      copy: args.importCopy,
      exclude: args.importExclude,
    });
    return;
  }
  if (!args.input) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const result = await forge(args.input, { engine: args.engine, ingestOnly: args.ingestOnly });
  if (result.mode === "ingest-only") {
    console.log(JSON.stringify(result.record, null, 2));
  } else {
    console.log(`Generated: ${result.htmlPath}`);
    console.log(`Dashboard entry: ${result.entry.htmlPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[IdeaForge] ${error.message}`);
    process.exitCode = 1;
  });
}

export const __test__ = {
  slugify,
  extractTitle,
  extractTags,
  writeNewPage,
};
