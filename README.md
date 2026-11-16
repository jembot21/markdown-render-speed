# Needle — a fast, marked-exact Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

An entry for the [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)
bounty on make.fun: a drop-in replacement for marked 18.1.3 that renders
byte-identical HTML and runs faster.

## What is here

- `parse.js` — a dependency-free ES module exporting `parse(markdown)`.
  For every input string it returns exactly the HTML that
  `marked.parse(markdown)` returns with marked's default options
  (gfm true, breaks false, pedantic false).
- `main.ts` — the harness driver. It reads the cases from
  `cases.json` in the input directory (`MAKEFUN_INPUT_DIR`, default
  `/input`), renders each one with `parse`, and writes the HTML strings
  in order as a JSON array to `html.json` in the output directory
  (`MAKEFUN_OUTPUT_DIR`, default `/output`).

## How it works

The renderer is a single pass over the block structure — containers,
headings, lists, tables, fences, indented code, HTML blocks, link
reference definitions — followed by an inline pass per block: code
spans matched by exact backtick-run length, a genuine CommonMark
delimiter-stack emphasis pass, a bracket stack for links and images,
GFM autolinks (angle, bare scheme, `www.` and email forms), escapes and
character references, and inline HTML. Hot paths classify characters
with tables instead of regular expressions, and text is scanned by
jumping between interesting characters. Output is deterministic: the
same input always produces the same bytes.

## Running it

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set, or with the cases
at `/input/cases.json` writing to `/output/html.json` by default.
