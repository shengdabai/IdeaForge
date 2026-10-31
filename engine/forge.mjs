#!/usr/bin/env node
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ingest, resolveImagePath } from "./ingest.mjs";
import { assertLocalProfileReady, generateHtml } from "./generate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "pages");
const PAGES_JSON = path.join(ROOT, "pages.json");
const INPUTS_DIR = path.join(ROOT, "inputs");
const DEFAULT_PORT = 8765;
const DEFAULT_CATEGORY = "炼金成品";
const INDEX_LOCK_TIMEOUT_MS = 5_000;
// A lock file that is empty or unparseable is only treated as abandoned once it
// is older than this. A live writer fills the metadata microseconds after the
// exclusive create, so anything this old without valid metadata is debris.
const UNREADABLE_LOCK_MAX_AGE_MS = 60_000;
// Written into every index lock: a lock with this process's PID but another nonce was
// left by an earlier process that had the same PID (e.g. a restarted container).
const LOCK_NONCE = randomBytes(12).toString("hex");
// Index locks this process created but could not remove (e.g. EBUSY), by lock path.
// Nobody holds them any more, so the next update here takes them over instead of
// waiting on itself until the timeout.
const leftoverIndexLocks = new Map();
const SENSITIVE_STATIC_NAMES = new Set(["token", "forge-token", "forge.token", "dashboard-token", "dashboard.token"]);
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
    "  node engine/forge.mjs import <dir> [--category=名] [--copy(默认，复制进 pages/)|--link(登记原路径)] [--exclude=glob,glob]",
    "  node engine/forge.mjs serve [--port=8765]",
    "  node engine/forge.mjs --self-test",
  ].join("\n");
}

export async function classifyInput(input) {
  const value = String(input || "").trim();
  if (/^https?:\/\//i.test(value)) return "url";
  if (await resolveImagePath(value)) return "image";
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

async function writeNewPage(requestedSlug, html, { pagesDir = PAGES_DIR } = {}) {
  // The static server refuses reserved names (secrets.html, credentials.html, id_rsa*),
  // so never give a generated page one. A prefix also covers the id_rsa* prefix rule.
  const baseSlug = isSensitiveStaticPath(`${requestedSlug}.html`) ? `page-${requestedSlug}` : requestedSlug;
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
  try {
    await writeFile(temporaryPath, `${JSON.stringify(list.map(normalizePageEntry), null, 2)}\n`, "utf8");
    await rename(temporaryPath, indexPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
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
  let lastHolder = "unknown";
  while (true) {
    const leftover = leftoverIndexLocks.get(lockPath);
    if (leftover) {
      // Claimed synchronously, so only one caller in this process takes it over.
      leftoverIndexLocks.delete(lockPath);
      if (await isOwnLeftoverLock(lockPath, leftover)) {
        console.warn(`[IdeaForge] taking over this process's leftover pages index lock: ${lockPath}`);
        return { lockPath, handle: null, identity: leftover };
      }
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let identity;
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce: LOCK_NONCE, createdAt: new Date().toISOString() })}\n`, "utf8");
        const info = await handle.stat();
        identity = { dev: info.dev, ino: info.ino };
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return { lockPath, handle, identity };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const verdict = await inspectIndexLock(lockPath);
      lastHolder = verdict.reason;
      if (verdict.gone) continue;
      if (verdict.abandoned && (await removeIndexLockIfUnchanged(lockPath, verdict.snapshot))) {
        console.error(`[IdeaForge] reclaimed abandoned index lock (${verdict.reason}): ${lockPath}`);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for pages index lock (${lastHolder}): ${lockPath}`);
      }
      await wait(25 + Math.floor(Math.random() * 25));
    }
  }
}

async function isOwnLeftoverLock(lockPath, identity) {
  try {
    const current = await lstat(lockPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    return metadata?.pid === process.pid && metadata?.nonce === LOCK_NONCE;
  } catch {
    return false;
  }
}

function runPs(args) {
  return new Promise((resolve) => {
    execFile("/bin/ps", args, { env: { ...process.env, LC_ALL: "C" }, timeout: 2_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

// ps etime is [[dd-]hh:]mm:ss
function parseElapsedSeconds(text) {
  const match = String(text || "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// Is a live PID provably NOT the process that created this lock?
// Proof 1: its command line does not mention node at all (the engine always runs under node).
// Proof 2: it started after the lock was created (the PID was reused).
// Anything we cannot prove (ps failed, a node process older than the lock) is treated
// as the rightful owner and is never stolen, however old the lock is.
async function liveHolderIsForeign(pid, lockCreatedAtMs) {
  if (pid === process.pid) return { foreign: false, why: "held by this process" };
  const command = await runPs(["-ww", "-o", "command=", "-p", String(pid)]);
  if (!command) return { foreign: false, why: `pid ${pid} alive, command line unknown` };
  if (!/\bnode\b/.test(command)) return { foreign: true, why: `pid ${pid} alive but is not a node process` };
  const elapsed = parseElapsedSeconds(await runPs(["-o", "etime=", "-p", String(pid)]));
  if (elapsed !== null && Number.isFinite(lockCreatedAtMs)) {
    const startedAtMs = Date.now() - elapsed * 1000;
    // etime has 1 s resolution; allow 2 s of slack before calling it a reused PID.
    if (startedAtMs > lockCreatedAtMs + 2_000) {
      return { foreign: true, why: `pid ${pid} started after the lock was created (pid reused)` };
    }
  }
  return { foreign: false, why: `pid ${pid} alive (node)` };
}

async function inspectIndexLock(lockPath) {
  let snapshot;
  try {
    snapshot = await lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { abandoned: false, gone: true, reason: "lock vanished" };
    return { abandoned: false, reason: `lock unreadable: ${error.code || error.message}` };
  }
  const ageMs = Date.now() - snapshot.mtimeMs;
  let metadata = null;
  try {
    metadata = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { abandoned: false, gone: true, reason: "lock vanished" };
  }
  const pid = metadata && Number.isSafeInteger(metadata.pid) && metadata.pid > 0 ? metadata.pid : null;
  if (pid === null) {
    // Empty/partial/garbage lock: it may belong to a writer paused between the
    // exclusive create and the metadata write, so only reclaim it once clearly old.
    if (ageMs > UNREADABLE_LOCK_MAX_AGE_MS) {
      return { abandoned: true, snapshot, reason: `unreadable lock older than ${Math.round(UNREADABLE_LOCK_MAX_AGE_MS / 1000)}s` };
    }
    return { abandoned: false, snapshot, reason: `unreadable lock, age ${Math.round(ageMs / 1000)}s` };
  }
  if (pid === process.pid && metadata.nonce !== LOCK_NONCE) {
    return { abandoned: true, snapshot, reason: `pid ${pid} is this process, but an earlier process with that pid wrote the lock` };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { abandoned: true, snapshot, reason: `owner pid ${pid} is dead` };
    if (error.code !== "EPERM") return { abandoned: false, snapshot, reason: `cannot probe pid ${pid}: ${error.code}` };
    // EPERM: alive but owned by another user; fall through to the foreign check.
  }
  const createdAtMs = Date.parse(metadata.createdAt);
  const holder = await liveHolderIsForeign(pid, Number.isFinite(createdAtMs) ? createdAtMs : snapshot.mtimeMs);
  return { abandoned: holder.foreign, snapshot, reason: holder.why };
}

async function removeIndexLockIfUnchanged(lockPath, snapshot) {
  try {
    const current = await lstat(lockPath);
    if (current.dev !== snapshot.dev || current.ino !== snapshot.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

// Temp files are only written while the index lock is held, so a temp file seen
// while we hold the lock was left by a writer that died mid-write. Remove those
// whose writer PID is dead; report any other one on stderr and leave it alone.
async function cleanOrphanTempFiles(indexPath) {
  const directory = path.dirname(indexPath);
  const prefix = `.${path.basename(indexPath)}.`;
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const pid = Number(name.slice(prefix.length).split(".")[0]);
    if (pid === process.pid) continue;
    const fullPath = path.join(directory, name);
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        dead = error.code === "ESRCH";
      }
    }
    if (!dead) {
      console.error(`[IdeaForge] warning: index temp file not removed (writer pid ${pid} not proven dead): ${fullPath}`);
      continue;
    }
    try {
      await unlink(fullPath);
      console.error(`[IdeaForge] removed orphan index temp file left by dead pid ${pid}: ${fullPath}`);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`[IdeaForge] could not remove orphan temp file ${fullPath}: ${error.message}`);
    }
  }
}

export async function updatePagesIndex(update, { indexPath = PAGES_JSON } = {}) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const lock = await acquireIndexLock(indexPath);
  let written = false;
  try {
    await cleanOrphanTempFiles(indexPath);
    const current = await readPagesJson(indexPath);
    const next = await update(current);
    if (!Array.isArray(next)) throw new Error("pages index update must return an array.");
    await writePagesJson(next, indexPath);
    written = true;
    return next;
  } finally {
    if (lock.handle) await lock.handle.close();
    try {
      await unlink(lock.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        // A lock left behind blocks later writers, so never drop this silently. Do not throw:
        // that would replace the body's own result or error (a 500 for a page that is already
        // indexed). Remember the lock instead, so the next update in this process takes it over.
        leftoverIndexLocks.set(lock.lockPath, lock.identity);
        const reason = error.code || error.message;
        console.warn(written
          ? `[IdeaForge] warning: pages index was written, but its lock file could not be removed (${reason}); this process takes it over on its next update: ${lock.lockPath}`
          : `[IdeaForge] warning: could not remove pages index lock after a failed update (${reason}); this process takes it over on its next update: ${lock.lockPath}`);
      }
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

// Append-only: existing entries (and any extra fields on them, e.g. stale or remap
// markers) are never replaced or collapsed. A new entry whose identity already
// exists in the index read under the lock is skipped, as is a copied page whose
// source is already registered in the same category. Returns the entries added
// and the skipped copies of an already registered source.
async function appendPageIndexes(entries) {
  const added = [];
  const duplicateCopies = [];
  if (!entries.length) return { added, duplicateCopies };
  await updatePagesIndex((list) => {
    const entryKey = (item) => item.htmlPath ? `path:${item.htmlPath}` : `slug:${item.slug}`;
    const present = new Set(list.map(entryKey));
    const sources = new Set(list.map(importedSourceIdentity).filter(Boolean));
    for (const entry of entries) {
      const key = entryKey(entry);
      if (present.has(key)) continue;
      const source = entry.htmlPath?.startsWith("pages/") ? importedSourceIdentity(entry) : null;
      if (source && sources.has(source)) {
        duplicateCopies.push(entry);
        continue;
      }
      present.add(key);
      if (source) sources.add(source);
      added.push(entry);
    }
    return [...list, ...added];
  });
  return { added, duplicateCopies };
}

function sourceFromRecord(record) {
  if (record.sourceUrl) return record.sourceUrl;
  if (record.type === "image") return record.archivedImage || record.imagePath || "本地图片";
  return "本地文本";
}

function archiveReference(record) {
  if (!record?.archivePath) return "";
  const absolute = path.resolve(record.archivePath);
  const relative = path.relative(INPUTS_DIR, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return "";
  }
  return `inputs/${relative}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function injectProvenance(html, record) {
  const sourceHtml = String(html);
  if (!/<\/body>/iu.test(sourceHtml)) {
    throw new Error("Generated HTML has no closing </body>; provenance could not be attached.");
  }
  if (/data-ideaforge-provenance/iu.test(sourceHtml)) {
    throw new Error("Generated HTML already contains a reserved provenance marker.");
  }
  const archivePath = archiveReference(record);
  const sourceUrl = /^https?:\/\//iu.test(String(record?.sourceUrl || "")) ? record.sourceUrl : "";
  const source = sourceUrl || (record?.type === "image" ? "本地图片" : "本地文本");
  const sourceMarkup = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">原始网址</a>`
    : `<span>${escapeHtml(source)}</span>`;
  const archiveMarkup = archivePath
    ? `<a href="../${escapeHtml(archivePath)}">本机采集记录</a>`
    : "<span>本机采集记录不可用</span>";
  const block = `<footer data-ideaforge-provenance style="margin:3rem auto 1rem;max-width:72rem;padding:1rem;border-top:1px solid currentColor;font:14px/1.6 system-ui,sans-serif;opacity:.78"><strong>来源记录</strong> · ${sourceMarkup} · ${archiveMarkup} · <time datetime="${escapeHtml(record?.fetchedAt || "")}">${escapeHtml(record?.fetchedAt || "采集时间未知")}</time></footer>`;
  const bodyMatches = [...sourceHtml.matchAll(/<\/body>/giu)];
  const insertionPoint = bodyMatches.at(-1).index;
  return `${sourceHtml.slice(0, insertionPoint)}${block}${sourceHtml.slice(insertionPoint)}`;
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
  if (!ingestOnly) await assertLocalProfileReady();
  const record = await ingest(input, type);
  if (ingestOnly) return { mode: "ingest-only", record };

  const html = injectProvenance(await generateHtml(record, engine), record);
  const title = extractTitle(html, record.title);
  const { slug, filePath } = await writeNewPage(slugify(title, slugify(record.title, "page")), html);

  const entry = {
    slug,
    title,
    type: record.type,
    source: sourceFromRecord(record),
    archivePath: archiveReference(record) || undefined,
    fetchedAt: record.fetchedAt || undefined,
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

function safeFilePart(input, fallback = "page") {
  const cleaned = String(input || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/g, "");
  let bounded = "";
  // Leave byte space for the extension and collision suffix on 255-byte filesystems.
  for (const character of [...cleaned].slice(0, 96)) {
    if (Buffer.byteLength(bounded + character) > 180) break;
    bounded += character;
  }
  return bounded || fallback;
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

async function copyToAvailableTarget(source, primary, usedPaths) {
  await mkdir(primary.targetDir, { recursive: true });
  for (let i = 1; i <= 9999; i += 1) {
    const fileName = i === 1 ? `${primary.safeBase}.html` : `${primary.safeBase}-${i}.html`;
    const relative = path.posix.join(path.posix.dirname(primary.relative), fileName);
    const absolute = path.join(primary.targetDir, fileName);
    if (usedPaths.has(relative)) continue;
    try {
      await copyFile(source, absolute, constants.COPYFILE_EXCL);
      return { targetDir: primary.targetDir, absolute, relative };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not copy "${primary.safeBase}" to a free filename after 9999 attempts.`);
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

// Which original file an imported entry stands for, per category: copy entries keep
// the original path in `source`, --link entries register that path as `htmlPath`.
function importedSourceIdentity(item) {
  if (item?.type !== "html" || typeof item.htmlPath !== "string") return null;
  if (item.htmlPath.startsWith("pages/")) {
    return typeof item.source === "string" ? JSON.stringify([item.source, item.category]) : null;
  }
  return path.isAbsolute(item.htmlPath) ? JSON.stringify([item.htmlPath, item.category]) : null;
}

// Default (copy) mode copies the HTML into pages/<category>/ so the archive is
// self-contained; --link registers the original absolute path instead.
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
  const sourceIdentity = (source, category) => JSON.stringify([source, category]);
  const copiedSources = new Set(existing.map(importedSourceIdentity).filter(Boolean));
  const imported = [];
  const copiedFiles = new Map();
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
    const pageCategory = inferCategory(filePath, importRoot, rootName, category);
    const primary = copy ? primaryCopyTarget(pageCategory, path.basename(filePath, path.extname(filePath))) : null;
    if (isSensitiveStaticPath(relativeToImportRoot || basename)
      || (primary && isSensitiveStaticPath(primary.relative))
      || isExcluded(relativeToImportRoot, basename, matchers)) {
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
      const title = extractTitle(html, path.basename(filePath, path.extname(filePath)));
      const tags = sanitizeImportTags(html, pageCategory);
      let htmlPath;
      if (copy) {
        const identity = sourceIdentity(path.resolve(filePath), pageCategory);
        if (copiedSources.has(identity)) {
          skipped.duplicate += 1;
          continue;
        }
        const target = await copyToAvailableTarget(filePath, primary, usedPaths);
        htmlPath = target.relative;
        copiedFiles.set(htmlPath, target.absolute);
        copiedSources.add(identity);
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
    } catch (error) {
      skipped.error += 1;
      console.error(`[import] failed ${filePath}: ${error.message}`);
    }
  }

  const { added, duplicateCopies } = await appendPageIndexes(imported);
  // Entries another writer registered between our scan and taking the lock; a copy
  // of a source that a concurrent import registered first is removed again.
  skipped.duplicate += imported.length - added.length;
  for (const entry of duplicateCopies) {
    await unlink(copiedFiles.get(entry.htmlPath)).catch((error) => {
      console.error(`[import] could not remove duplicate copy ${entry.htmlPath}: ${error.message}`);
    });
  }
  for (const entry of added) {
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
  }

  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  console.log(`[import] done: imported ${added.length}, skipped ${skippedTotal}, scanned ${scanned}`);
  for (const [name, value] of [...categoryCounts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans"))) {
    console.log(`[import] category ${name}: ${value}`);
  }
  return { imported: added.length, skipped, scanned, categoryCounts: Object.fromEntries(categoryCounts) };
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

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function readRequestBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onAborted = () => onError(requestError(400, "Request body was interrupted."));
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limitBytes) {
        onError(requestError(413, "Request body is too large."));
        // Drain the remaining upload so the client can receive the 413 response.
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      req.removeListener("error", onError);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    // An aborted upload may emit an error afterwards; retain its one-shot handler.
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function parseGeneratePayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw requestError(400, "Invalid JSON request body.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof payload.input !== "string" || !payload.input.trim()) {
    throw requestError(400, "Missing or invalid required field: input must be a non-empty string.");
  }
  const engine = payload.engine === undefined ? "codex" : payload.engine;
  if (!["codex", "claude", "ollama"].includes(engine)) {
    throw requestError(400, "Invalid engine. Expected codex, claude, or ollama.");
  }
  return { input: payload.input, engine };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function isSensitiveStaticPath(relativePath) {
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith(".")
    || SENSITIVE_STATIC_NAMES.has(part.toLowerCase())
    || /^(?:auth\.json|(?:credentials|secrets)(?:\..*)?|id_rsa.*)$/i.test(part)
    || /\.(?:key|pem)$/i.test(part));
}

// DNS-rebinding / cross-site guard (ported from the live engine): every request,
// GET included, must address the loopback listener by its own host:port, and any
// Origin / Sec-Fetch-Site header must say same-origin. The one exception is a
// top-level document navigation (a user clicking a link from another local tool):
// read-only GETs are already protected by CORS and /generate by the header token.
function isTrustedLocalRequest(req) {
  // A wrong Host is answered with 421 by the request handler, so it is not rejected here.
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) return false;
  const isDocumentNavigation = req.method === "GET"
    && req.headers["sec-fetch-mode"] === "navigate"
    && req.headers["sec-fetch-dest"] === "document";
  if (isDocumentNavigation) return true;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host.toLowerCase()}`) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function isInputArchivePath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return /^inputs\/[^/]+\.json$/iu.test(normalized);
}

function isAllowedStaticPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized === "index.html"
    || normalized === "pages.json"
    || normalized.startsWith("pages/")
    || normalized.startsWith("templates/")
    || isInputArchivePath(normalized);
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
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw requestError(400, "Invalid URL encoding.");
  }
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
    const inputRouteChangedClass = isInputArchivePath(relative) && !isInputArchivePath(resolvedRelative);
    if (!resolvedRelative || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)
      || isSensitiveStaticPath(resolvedRelative) || !isAllowedStaticPath(resolvedRelative) || inputRouteChangedClass) {
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
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { error: "Only trusted loopback requests are allowed" });
      return;
    }
    try {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const host = String(req.headers.host || "").toLowerCase();
      if (!new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]).has(host)) {
        res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Misdirected request");
        return;
      }
      if (!req.url.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
        throw requestError(400, "Invalid request target.");
      }
      const origin = req.headers.origin;
      const site = req.headers["sec-fetch-site"];
      const isDocumentNavigation = req.method === "GET"
        && req.headers["sec-fetch-mode"] === "navigate"
        && req.headers["sec-fetch-dest"] === "document";
      if (!isDocumentNavigation && ((origin !== undefined && origin !== `http://${host}`)
        || (site !== undefined && site !== "same-origin" && site !== "none"))) {
        throw requestError(403, "Only same-origin local requests are allowed.");
      }
      if (req.method === "POST" && req.url === "/generate") {
        if (!isAuthorized(req, token)) {
          sendJson(res, 401, { error: "Missing or invalid X-Forge-Token." });
          return;
        }
        const body = await readRequestBody(req);
        const payload = parseGeneratePayload(body);
        const result = await forgePage(payload.input, {
          engine: payload.engine,
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
      sendJson(res, error.statusCode || 500, { error: error.message });
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
  assert(parseArgs(["import", "./x"]).importCopy === true, "import defaults to copy (into pages/)");
  assert(parseArgs(["import", "./x", "--copy"]).importCopy === true, "--copy keeps copying");
  assert(parseArgs(["import", "./x", "--link"]).importCopy === false, "--link opts out (register original path)");
  assert(parseArgs(["serve"]).port === 8765, "default port 8765");
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
    const result = await importPages(args.importDir, {
      category: args.importCategory,
      copy: args.importCopy,
      exclude: args.importExclude,
    });
    if (result.skipped.error > 0) {
      console.error(`[IdeaForge] import finished with ${result.skipped.error} error(s); see messages above.`);
      process.exitCode = 1;
    }
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
  archiveReference,
  readRequestBody,
};
