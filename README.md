# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jembot21/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown-to-HTML parser in a single `parse.js`. Its `parse(markdown)` returns, for every input, exactly the HTML that marked 18.1.3 renders with default options (GFM on, breaks off) — but faster: a line-based block scanner instead of marked's regex token tree, bulk copying of plain text in the inline pass, and a delimiter-run emphasis matcher that works on the original string. `main.ts` is the harness driver: it reads the cases, renders each one, and writes the HTML array out.

## Round 2

The second pass over `parse.js` keeps the output identical and cuts the work underneath:

- **Text runs** are measured by a single event scan: one regex finds every position where a plain-text run can end (a stop char, a protocol or `www.` prefix, a hard break, a `mailto:`/`xmpp:` scheme, an `@`), and the few gates are classified in JS — no more sliced substrings and repeated lookahead scans per run.
- **Emphasis** skips dead delimiter runs (followed by whitespace or the end) and intraword `_` runs before any mask is built, and each masking step runs only when a cheap pre-check says it can change something; when nothing maskable occurs, the source is its own mask.
- **Text accumulation** keeps raw segments and escapes only their merged decode, so a failed token attempt can never split an HTML entity at its `_` (see the fix below).
- **Blocks** dispatch space/tab-led lines on their first significant character, check setext underlines and thematic breaks by hand instead of by regex, gate table detection cheapest-first, split table cells in one pass, and fetch list begin-patterns bundled per indent level.
- Delimiter lengths are arithmetic instead of string spreads, link attempts bail out on a missing `](` or `]`, and URLs match through a sticky regex instead of a sliced copy.

Round 2 also fixes a round-1 correctness bug: an entity whose name contains `_` (such as `&Hilbe_tSpace;`) was mis-escaped to `&amp;Hilbe_tSpace;` whenever a numeric character reference appeared nearby, because the pending text was flushed — and escaped — in pieces cut at the `_` inside the entity name. Text is now flushed only when a token actually succeeds, and escaping sees the whole merged run, the way marked's per-token decode does. Verified byte-identical on the full 720-case practice set and on thousands of differential fuzz cases against marked itself (line-mutated documents, char-mutated spec inputs, construct soup, and an entity-focused set built from underscore-named entities next to numeric references).

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8vr38xr3&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
