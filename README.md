# IdeaForge

Turn any idea, link, or image into a self-contained, visual knowledge page — locally, with the AI engine of your choice (codex/claude/ollama). 把想法/链接/图片一键炼成自包含可视化 HTML 深度页,全本地、可检索、个性化。

## Business Context

- **Category:** AI workflow infrastructure
- **Audience:** AI builders, creators, independent developers, and small teams that want repeatable local AI workflows.
- **Repository status:** Public repository. Keep examples, docs, and issues free of credentials, private data, and machine-specific paths.

## What This Project Is For

- Turn any idea, link, or image into a self-contained, visual knowledge page — locally, with the AI engine of your choice (codex/claude/ollama). 把想法/链接/图片一键炼成自包含可视化 HTML 深度页,全本地、可检索、个性化.
- Package repeatable AI workflows into reusable local assets.
- Reduce one-off prompt work with versioned skills, guardrails, and handoff files.

## Where It Fits

This repository is part of a broader AI local-workbench operating model: reusable skills, local automation, auditable configuration, and repeatable delivery workflows.

## Technical Overview

- **Primary language:** JavaScript
- **Detected stack:** JavaScript, Node.js
- **Default branch:** `main`
- **Visibility:** `PUBLIC`
- **License:** MIT License

## Repository Map

- `LICENSE`
- `README.md`
- `SECURITY.md`
- `SPEC.md`
- `engine`
- `index.html`
- `install.sh`
- `package.json`
- `profile.md`
- `start-dashboard.command`
- `templates`

## Quick Start

```bash
# 1. Clone
git clone https://github.com/shengdabai/IdeaForge.git
cd IdeaForge

# 2. Create a private, git-ignored profile and edit it
#    创建被 git 忽略的私有画像，再填写真实情况
cp profile.md profile.local.md
$EDITOR profile.local.md

# 3. Forge a page from a thought / URL / image
node engine/forge.mjs "Why is platform economics the ultimate predator?"
node engine/forge.mjs https://example.com/some-article
node engine/forge.mjs ./inputs/some-screenshot.png

# 4. Browse everything in the dashboard
node engine/forge.mjs serve         # open the complete local URL printed by the command
```

`profile.md` is the public template; step 2 is required. Generation stops before ingest or any model call
when `profile.local.md` is missing, still contains template prompts, or is too short.

> 第 2 步是必需的：真实信息只写入 `profile.local.md`（已被 `.gitignore` 排除）；缺少或未完成时，系统会在采集和模型调用前停止。

| Command | Purpose |
|---|---|
| `npm install` | Install project dependencies. |
| `npm run test` | `node engine/forge.mjs --self-test && node --test engine/*.test.mjs` (CLI self-test, then the regression suite; CI runs the same `npm test`) |

### Dashboard access token

`forge serve` binds only to `127.0.0.1` and prints a complete Dashboard URL for that server session. Open that exact URL: its `#forge-token=...` fragment is never sent as an HTTP request, is removed from the address bar immediately, and is used only as the `X-Forge-Token` header for `POST /generate`.

The token is generated afresh on every `serve` invocation unless you set `IDEAFORGE_DASHBOARD_TOKEN` in your shell. It is never written beneath the project or served as a static file, and the Dashboard keeps it in memory only: after a page refresh, reopen the printed URL to generate again. Requests for dotfiles and reserved token filenames are refused by the static server.

On macOS you can also **double-click `start-dashboard.command`** to launch the server and open the dashboard in one step; its terminal window shows the server output and the Dashboard URL.

### Importing existing HTML

```bash
node engine/forge.mjs import <dir> [--category=name] [--copy|--link] [--exclude=glob,glob]
```

- default (or `--copy`): copies HTML into `pages/<category>/` so the HTTP dashboard can open it; original files remain untouched
- explicit `--link`: only registers the original file path for local-file workflows; browsers cannot open these `file://` links from the HTTP dashboard, and the command prints a warning saying so
- duplicates are skipped: a copy import skips a source already registered in the same category, whether it was copied or linked; `--link` skips a path that is already registered
- HTML copies are self-contained-file imports; external relative images/styles are not copied automatically
- auto-skips browser-extension fragments and shells smaller than 300 bytes

## Operating Notes

- Keep real credentials out of the repository. Use local environment files, GitHub repository secrets, or the deployment platform secret manager.
- If a `.env.example` file exists, treat it as documentation only; never commit filled-in `.env` files.
- Before publishing screenshots, demos, or client examples, remove private names, internal paths, account IDs, and API endpoints.
- The `Repository Hygiene` workflow is a lightweight guardrail, not a replacement for product-specific tests.

## Delivery Checklist

- [ ] README describes the user, business outcome, and operating boundary.
- [ ] Setup or preview commands are current and do not rely on private machine state.
- [ ] No real secrets, private user data, or machine-local state are tracked.
- [ ] Screenshots, demos, or sample outputs are safe to share publicly when the repository is public.
- [ ] Product-specific tests or smoke checks are documented before production use.

## Roadmap

- Tighten the fastest path from clone to useful demo.
- Add project-specific screenshots, sample outputs, or a short walkthrough where useful.
- Promote repeated manual steps into scripts, tests, or documented workflows.
- Keep security, privacy, and licensing boundaries explicit as the project evolves.

## Maintainer Notes

Maintained by [Tony Sheng](https://github.com/shengdabai). This README is written as a business-facing handoff: it should help a future collaborator, client, or reviewer understand why the repository exists, how to inspect it, and what must be true before it is reused or shipped.
