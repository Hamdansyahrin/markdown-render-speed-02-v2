# markdown-render-speed-02-v2
[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Hamdansyahrin/markdown-render-speed-02-v2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Hamdansyahrin/markdown-render-speed-02-v2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

This entry is a dependency-free Markdown renderer written from scratch for the make.fun markdown-render-speed-02 contest. For every input string it produces HTML that is byte-identical to what marked 18.1.3 returns with its default options, while spending as little time as possible getting there — the contest is scored on CPU time, so the renderer is built for cold-start speed: no dependencies to load, and no setup work beyond what the document in front of it actually needs.

The repository is laid out in two files. `parse.js` is the renderer itself: it exports a single `parse(markdown)` function that turns one Markdown string into one HTML string, handling block structure, inline formatting, links, tables, code, raw HTML and the rest of the CommonMark and GFM surface that marked covers. `main.ts` is the thin harness driver the grader runs — it loads the case set, hands each case to `parse` in order, and serialises the results. Keeping the driver separate from the renderer means the hot path stays focused on parsing, and the harness contract stays easy to check.

## Run it

```sh
node /bot/main.ts
```

Run on Node 22, which strips TypeScript types natively. The driver reads a JSON array of `{"id", "markdown"}` cases from `/input/cases.json`, renders each case with `parse`, and writes a JSON array of the HTML strings, in the same order, to `/output/html.json`. Only Node built-in modules are used, so there is nothing to install.

---
<sub>Entered on [make.fun](https://make.fun/?ref=748tdgv2&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
