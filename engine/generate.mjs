import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./engines.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function readProjectFile(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

async function readProfile() {
  try {
    return validateLocalProfile(await readFile(path.join(ROOT, "profile.local.md"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "首次生成前请先创建私有画像：cp profile.md profile.local.md，然后把占位说明替换为你的真实情况。",
    );
  }
}

export async function assertLocalProfileReady() {
  await readProfile();
}

export function validateLocalProfile(profile) {
  const text = String(profile || "").trim();
  const placeholderSignals = [
    "What you do (role, industry, audience)",
    "Your main projects / products / income streams",
    "首次使用前,请把下面的内容全部替换",
  ];
  if (text.length < 40 || placeholderSignals.some((signal) => text.includes(signal))) {
    throw new Error("profile.local.md 仍是模板或内容过短，请完成画像后再生成。");
  }
  return text;
}

export function stripHtmlFence(output) {
  let text = String(output || "").trim();
  const fence = text.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  const doctypeIndex = text.search(/<!DOCTYPE/i);
  if (doctypeIndex > 0) text = text.slice(doctypeIndex).trim();
  return text;
}

export function validateHtml(html) {
  const text = String(html || "").trim();
  if (!/^<!DOCTYPE\b/i.test(text)) {
    throw new Error("Generated output is not a full HTML document: it must start with <!DOCTYPE.");
  }
  if (!/<\/html>\s*$/i.test(text)) {
    throw new Error("Generated output is not a full HTML document: missing closing </html>.");
  }
  return text;
}

export async function buildPrompt(ingested) {
  if (!ingested?.rawContent?.trim()) throw new Error("Cannot build prompt from empty ingested content.");
  const [systemPrompt, profile, golden] = await Promise.all([
    readProjectFile("engine/prompt.md"),
    readProfile(),
    readProjectFile("templates/golden.html"),
  ]);

  return [
    systemPrompt.trim(),
    "\n\n---\n\n# 用户画像 profile.md\n",
    profile.trim(),
    "\n\n---\n\n# 视觉/结构黄金范本 templates/golden.html\n",
    golden.trim(),
    "\n\n---\n\n# 本次输入素材（已由采集层归一化）\n",
    JSON.stringify(
      {
        type: ingested.type,
        sourceUrl: ingested.sourceUrl,
        title: ingested.title,
        fetchedAt: ingested.fetchedAt,
        imagePath: ingested.imagePath,
        archivedImage: ingested.archivedImage,
      },
      null,
      2,
    ),
    "\n\n## rawContent\n",
    ingested.rawContent.trim(),
    "\n\n---\n\n请只输出最终单文件 HTML，不要输出解释、Markdown 围栏或额外文本。",
  ].join("");
}

export async function generateHtml(ingested, engineName = "codex") {
  const prompt = await buildPrompt(ingested);
  const output = await run(engineName, prompt);
  return validateHtml(stripHtmlFence(output));
}

export const __test__ = {
  stripHtmlFence,
  validateHtml,
};
