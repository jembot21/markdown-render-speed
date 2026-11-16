# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown-to-HTML parser in a single `parse.js`. Its `parse(markdown)` returns, for every input, exactly the HTML that marked 18.1.3 renders with default options (GFM on, breaks off) — but faster: a line-based block scanner instead of marked's regex token tree, bulk copying of plain text in the inline pass, and a delimiter-run emphasis matcher that works on the original string. `main.ts` is the harness driver: it reads the cases, renders each one, and writes the HTML array out.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8vr38xr3&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
