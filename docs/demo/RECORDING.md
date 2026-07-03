# Demo GIF — recording script / 录制分镜

Target artifact: **`assets/demo.gif`** (referenced by the README first screen).
Length: **30–60 s**. Goal: show that two different-vendor agents talk *in-session*, hands-off.

> Recording needs two live subscription sessions (a real Claude Code + a real Codex),
> so it's produced by the maintainer. This file is the shot list + settings, not the asset.
> 录制需要两个真实订阅会话(真 Claude Code + 真 Codex),由维护者出片。此文件是分镜 + 参数,不是产物本身。

## Shot list / 分镜

Two terminals **side by side** the whole time (left = Claude Code, right = Codex).

| # | Shot | What the viewer sees |
|---|------|----------------------|
| 1 | **Launch** (~0–8 s) | Left: `abg claude` starting; right: `abg codex` starting and attaching. Both panes settle into a ready prompt. Establishes "two real agents, one bridge." |
| 2 | **Task split prompt** (~8–20 s) | In the **left/Claude** pane, type one prompt, e.g. *"Propose a task split with Codex for &lt;small task&gt;, then have Codex implement its part while you review."* Show Claude sending the proposed division of labor across to Codex. |
| 3 | **Codex completion pushes Claude** (~20–40 s) | Right/Codex works and finishes; its completion **pushes into the left/Claude session on its own** (no human relay). Highlight the message arriving in Claude's pane. |
| 4 | **Claude reply injects Codex** (~40–55 s) | Claude posts a short review/reply; it **injects into the right/Codex thread** as a new turn. End on both panes showing the round-trip closed. |

Keep it to **one** small, fast task so the whole loop fits in a minute. Trim dead air between turns.

## Tooling / 工具

- **[vhs](https://github.com/charmbracelet/vhs)** — scripted terminal recording → GIF, reproducible. Best if the flow can be scripted; note it can't drive two *interactive* agent TUIs in one tape, so for the live agents prefer a screen recorder.
- **CleanShot X** (macOS) or **Kap** — record the two-terminal screen region, export to GIF. Simplest for the real two-session flow.

## Export settings / 导出参数

- Width ≤ **1200 px** (README renders it inline; keep the file small).
- Target **< 8 MB** so it loads fast on GitHub. Drop to ~10–12 fps and trim length if larger.
- Save to `assets/demo.gif`, then remove the `<!-- TODO: assets/demo.gif … -->` comment in both READMEs and drop in `![AgentBridge demo](assets/demo.gif)`.
