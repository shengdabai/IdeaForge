<div align="center">

# 🔥 IdeaForge

**Turn any idea, link, or image into a self-contained, visual knowledge page — locally, with the AI engine of your choice.**

把一句想法、一个链接、一张图片,一键炼成自包含、可视化的 HTML 深度页 —— 全本地、可检索、个性化。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Local-first](https://img.shields.io/badge/local--first-yes-orange)
![Engines](https://img.shields.io/badge/engines-codex%20%7C%20claude%20%7C%20ollama-8a2be2)

</div>

---

## What is this? · 这是什么

Most "summarizers" hand you a wall of text. **IdeaForge forges a page.**

Feed it a thought, a URL, or an image. It researches, structures, and renders a **single self-contained HTML file** — dark editorial design, numbered sections, cards, comparison tables, timelines, key-insight callouts, a floating table of contents — and then ends with one section nobody else writes: **"What this means for *you*"**, grounded in a profile *you* control.

Everything lives on your disk as plain files you own. A built-in dashboard indexes thousands of pages with full-text search, category folding, and pagination — no account, no lock-in. Generated pages are fully self-contained and work offline forever. (Cloud engines `codex`/`claude` and the optional Firecrawl URL fetcher do send content to those services — choose `ollama` for a 100% local pipeline. See [Engines](#engines--引擎).)

> 普通"总结工具"丢给你一堵文字墙。**IdeaForge 锻造一张页面。**
>
> 喂给它一个想法、一个网址或一张图,它会做深度分析、自动组织结构,产出**一份自包含的单文件 HTML**(深色编辑风、分节编号、卡片、对比表、时间线、关键洞察、悬浮目录),并以一个别人不会写的板块收尾 —— **「结合你的处境,能做什么」**,而这取决于一份**你自己掌控**的画像。
>
> 一切都以你拥有的本地文件存在。内置 dashboard 为成千上万张页面提供全文搜索、分类折叠和分页,无账号、无锁定。生成的页面完全自包含、永久离线可用。(注:`codex`/`claude` 云端引擎与可选的 Firecrawl 抓取会把内容发给对应服务;想要 100% 本地流程请用 `ollama`。)

---

## Why it's different · 为什么不一样

| | IdeaForge | Generic summarizer |
|---|---|---|
| **Output** | A designed, self-contained HTML page | A block of text |
| **Personalization** | Every page ends with advice tailored to *your* `profile.md` | Generic takeaways |
| **Storage** | Local files you own (Markdown/HTML/JSON) | A SaaS database |
| **Engine** | Your choice: `codex` / `claude` / `ollama` (offline) | Whatever the vendor picks |
| **Dependencies** | Zero external CDN in output — works offline forever | Often phones home |
| **Lock-in** | None. It's just files. | High |

The killer feature is **`profile.md`** — a short description of who you are and what you're building. The engine injects it into every generation, so the closing "what to do next" section speaks to *your* real projects and constraints instead of vague platitudes.

> 杀手锏是 **`profile.md`** —— 一份关于"你是谁、你在做什么"的简短画像。引擎每次生成都会注入它,让结尾的"接下来该做什么"贴合**你**的真实项目与约束,而不是空话套话。

---

## Quick start · 快速开始

```bash
# 1. Clone
git clone https://github.com/<your-name>/IdeaForge.git
cd IdeaForge

# 2. Make it yours — edit profile.md with your real situation (this is the magic)
#    编辑 profile.md,填上你自己的真实画像(这是个性化的来源)
$EDITOR profile.md

# 3. Forge a page from a thought / URL / image
node engine/forge.mjs "Why is platform economics the ultimate predator?"
node engine/forge.mjs https://example.com/some-article
node engine/forge.mjs ./inputs/some-screenshot.png

# 4. Browse everything in the dashboard
node engine/forge.mjs serve         # then open http://127.0.0.1:8765
```

**Install the global `forge` command (optional):**

```bash
bash install.sh        # installs ~/.local/bin/forge
forge "any idea, from any directory"
forge serve
forge import ./my-old-html-folder --category=archive
```

On macOS you can also **double-click `start-dashboard.command`** to launch the server and open the dashboard in one step.

---

## How it works · 工作原理

```
input (text | image | url)
  → ① ingest      fetch article / read image / take text   → normalized content
  → ② prompt      inject profile.md + golden template + content
  → ③ generate    call your chosen engine → self-contained HTML
  → ④ index       write pages/<slug>.html + append pages.json
  → ⑤ dashboard   new card appears, searchable & clickable
```

Three clean layers, each swappable:

- **`ingest.mjs`** — URL (Firecrawl if you set a key, else `curl` + readability), image (local multimodal model), or raw text.
- **`generate.mjs` + `prompt.md`** — assembles the three-part prompt (style contract + deep-analysis task + your profile) and validates the model returns a full HTML document.
- **`engines.mjs`** — the adapter that talks to `codex`, `claude`, or `ollama`, with retry/backoff.

---

## Commands · 命令

```bash
forge "an idea"                          # text → page
forge https://...                        # url  → page
forge ./image.png                        # image → page
forge --engine=ollama "an idea"          # pick the engine
forge --ingest-only https://...          # debug: just show what was fetched
forge serve [--port=8765]                # start the dashboard server
forge import <dir> [--category=name] [--copy] [--exclude=glob,glob]
```

**Bulk import existing HTML** into the searchable index:

- without `--copy`: registers the original file path (nothing is moved or deleted)
- with `--copy`: copies into `pages/<category>/` and indexes the copy
- auto-skips browser-extension fragments and shells smaller than 300 bytes

---

## Engines · 引擎

| Engine | Cost | Notes |
|---|---|---|
| **`codex`** | ChatGPT plan | **Default.** Calls your local Codex CLI. |
| **`ollama`** | Free / offline | Local fallback, e.g. `qwen3-coder:30b`. Override with `IDEAFORGE_OLLAMA_MODEL`. |
| **`claude`** | ⚠️ see note | Calls `claude -p` (headless). **Not the default** — headless/print usage may bill against a separate Claude Code / API quota at API rates. |

> 引擎可一键切换。默认 `codex`;`ollama` 离线零成本兜底;`claude` 实现但非默认(headless 计费提醒见上)。

**What leaves your machine:** `codex` and `claude` send your prompt (which includes your profile + ingested content) to those CLIs' backends; `ingest` sends a URL to Firecrawl **only if** you've configured a key (otherwise it uses plain `curl`). `ollama` runs entirely offline. API keys are **never** stored in this repo — the engine reads them from your environment / local config only.

> 隐私边界:`codex`/`claude` 会把 prompt(含画像 + 采集内容)发给对应后端;`ingest` 仅在你配置了 key 时才用 Firecrawl,否则走本地 `curl`;`ollama` 全程离线。密钥只从你的环境/本地配置读取,绝不写入本仓库。

---

## Personalization · 个性化

Open [`profile.md`](profile.md) and describe:

- **Identity** — what you do, your audience, your stage
- **What you're building** — projects, products, channels
- **Stack & habits** — languages, deploy targets, constraints
- **Thinking preferences** — how you like insight framed

The sharper the profile, the more valuable the closing takeaways. Keep a private copy as `profile.local.md` (git-ignored) if you don't want your real details in your fork's history.

> 画像越准,启发越值钱。若不想真实细节进 fork 的 git 历史,把私有版本存为 `profile.local.md`(已被 .gitignore 排除)。

---

## Design philosophy · 设计哲学

- **Local-first.** Your knowledge is files you own, not rows in someone's database.
- **Self-contained output.** Every generated page inlines its CSS/JS — no external CDN, readable in 10 years, offline.
- **One source of truth.** Markdown/HTML/JSON on disk; platforms are just render targets.
- **No over-engineering.** No accounts, no sync, no DB. JSON is enough.

This repo ships the **engine and a golden reference template** — your generated pages and personal index stay local and are git-ignored by default.

> 本仓库只包含**引擎与一个黄金范本**;你生成的页面与个人索引默认留在本地、被 git 忽略。

---

## Project layout · 目录结构

```
IdeaForge/
├── engine/            # the CLI engine (ingest / generate / engines / prompt)
├── templates/
│   └── golden.html    # visual & structural reference for every generated page
├── index.html         # the dashboard (reads pages.json)
├── profile.md         # YOUR profile — edit this first
├── install.sh         # installs the global `forge` command
├── start-dashboard.command   # macOS double-click launcher
└── SPEC.md            # full system design spec
```

---

## License · 许可

[MIT](LICENSE) — do anything, just keep the notice.

<div align="center">
<sub>Built to be forked. 为 fork 而生。</sub>
</div>
