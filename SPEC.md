# 想法工坊 · 系统设计 SPEC（v1）

> 这份 SPEC 记录系统的设计意图与边界，方便贡献者理解"为什么这样设计"。
> 实现时若发现设计缺陷，先记录理由再调整，不要静默改设计。

## 0. 一句话产品定义
把一个「想法」——几句文字 / 一张图 / 一个网页链接——一键变成**一张深度、专业、可视化、并结合用户画像（profile.md）给出启发的本地 HTML 页面**，全部文件存在本地，可浏览、可检索。

## 1. 核心流程（pipeline）
```
输入(text | image | url)
  → ① 归一化采集 ingest：抓网页正文 / OCR或读图 / 直接收文字
  → ② 组装 prompt：注入 profile.md + golden 模板风格规范 + 采集到的原始内容
  → ③ 调用生成引擎（可切换）产出 self-contained HTML
  → ④ 落盘 pages/<slug>.html + 更新 index（pages.json）
  → ⑤ dashboard 首页自动出现新卡片，可点开
```

## 2. 目录结构（已建好骨架，不要改动命名）
```
IdeaForge/
  index.html          # dashboard 首页（读 pages.json 动态渲染）
  profile.md          # 用户画像（用户维护，引擎只读注入）
  SPEC.md             # 本文件
  pages.json          # 页面索引（引擎读写）
  templates/
    golden.html       # 黄金范本（产出页的视觉/结构基准）
  pages/              # 生成的成品页（运行时生成，不入库）
  inputs/             # 用户丢进来的原始素材（图片、临时文本）存档
  engine/
    forge.mjs         # 主引擎 CLI（Codex 实现）
    ingest.mjs        # 采集层：url/image/text → 纯文本（Codex 实现）
    generate.mjs      # 生成层：组 prompt + 调模型 + 取 HTML（Codex 实现）
    engines.mjs       # 引擎适配器：codex / claude / ollama 可切换（Codex 实现）
    prompt.md         # 生成用的系统提示词模板（Codex 起草，Claude review）
```

## 3. CLI 接口（forge.mjs）
```bash
# 文字想法
node engine/forge.mjs "平台经济为什么是终极捕食者"

# 网页链接（自动判断是 URL）
node engine/forge.mjs https://example.com/article

# 图片
node engine/forge.mjs ./inputs/某张图.png

# 选引擎（默认 codex）
node engine/forge.mjs --engine=codex|claude|ollama "..."

# 仅采集不生成（调试用）
node engine/forge.mjs --ingest-only https://...
```
- 自动判别输入类型：以 `http(s)://` 开头 → url；存在的图片文件路径 → image；否则 → text。
- 生成成功后打印成品 HTML 绝对路径，并 `open` 它（macOS）。

## 4. 采集层 ingest.mjs
- **url**：优先用 firecrawl（若有 API key，读 `~/.config/firecrawl/.env`）抓 markdown；
  无 key 时回退到 `curl` + 简单 readability 提取。微信链接(mp.weixin.qq.com)必须走 firecrawl。
- **image**：用本地多模态读图（优先 ollama 的多模态模型；不可用则把图片路径标注交给生成层让模型读）。
  采集层只需产出"图片描述 + 可提取的文字"。
- **text**：原样作为素材。
- 统一输出结构：`{ type, sourceUrl?, title, rawContent, fetchedAt }`，原始素材存档到 `inputs/`。

## 5. 生成层 generate.mjs + prompt.md
组 prompt 的三段式：
1. **风格契约**：产出必须是单文件自包含 HTML（内联 CSS/JS，无外部依赖），视觉与结构对齐 `templates/golden.html`：深色编辑风、分节带序号 eyebrow、卡片/对比表/时间线/三栏等可视化组件、右侧 TOC 圆点、响应式。
2. **任务**：对采集内容做"全面专业化深度分析"，结构自适应内容（背景→原理→机制→演变→对策→关键洞察）。
3. **个性化**：读取 `profile.md`，最后必出一个 **「结合你的处境，能做什么」** 板块，每条 = 洞察 + 「动作：…」。

输出处理：模型回 HTML，剥掉可能的 ```html 围栏，校验以 `<!DOCTYPE` 开头、含 `</html>`，再落盘。

## 6. 引擎适配器 engines.mjs（关键 · 计费敏感）
> ⚠️ **2026-06-15 起 `claude -p` / headless 走独立 $200 额度、按 API 价计费。本系统默认 `codex` 引擎。**
- `codex`（默认）：调本机 codex（exec/MCP），用 ChatGPT 账号额度。具体调用方式 Codex 你最清楚，按本机可用方式实现，封装成 `generate(prompt) → text`。
- `claude`：`claude -p`（headless）。实现但**不设为默认**，README 标注计费风险。
- `ollama`：本机 `ollama`（如 `qwen3-coder:30b` 等本地模型），离线兜底，零成本。
- 三者统一接口 `async function run(engineName, prompt): Promise<string>`，失败重试 3 次带退避，全部失败抛清晰错误。

## 7. 索引 pages.json
每条：`{ slug, title, type, source, tags:[], createdAt, htmlPath }`。
引擎每次生成后 append。dashboard 读它渲染卡片（按时间倒序）。

## 8. dashboard index.html
- 顶部：标题 + 一个输入框（贴文字/URL）+「生成」按钮 + 引擎下拉。
- 主体：页面卡片网格（标题、标签、来源、时间、缩略图可选），点击打开对应 HTML。
- 纯前端读取 `pages.json`。**注意**：浏览器直接 file:// 读本地 json 有 CORS 限制 →
  提供一个 `forge serve`（起本地静态服务 + 一个 POST /generate 接口接输入框），Codex 实现这个轻量本地服务。

## 9. 验收标准（Codex 自测 + Claude review 依据）
- [ ] `node engine/forge.mjs "测试想法"` 能产出一个合格 HTML 到 pages/ 并打开。
- [ ] `node engine/forge.mjs <一个真实URL>` 全流程跑通。
- [ ] 产出页视觉/结构与 golden.html 同档次（不是裸文本）。
- [ ] 每个产出页都含「结合你的处境」个性化板块。
- [ ] pages.json 正确更新，dashboard 能列出并打开。
- [ ] 默认引擎是 codex；claude 引擎带计费警告；ollama 可离线兜底。
- [ ] 全程无外部 CDN 依赖，纯本地可用。
- [ ] 错误处理完善：网络失败/模型失败/空内容都有清晰提示，不静默吞错。

## 10. 不做（v1 范围外，避免过度设计）
- 不做账号/多用户、不做云同步、不做数据库（json 足够）。
- 不做复杂编辑器；产出页就是最终物，要改直接编辑 HTML。
- 不追求完美 OCR；图片支持做到"能用"即可。
