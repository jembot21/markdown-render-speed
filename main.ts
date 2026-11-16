// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from cases.json in the input directory, renders each
// case's markdown with parse() from ./parse.js, and writes the HTML
// strings, in the cases' order, as a JSON array to html.json in the
// output directory. The directories come from MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR when set, and default to /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const parsed: unknown = JSON.parse(raw);
// The file is an array of cases; tolerate a wrapping object just in case.
const cases: Case[] = Array.isArray(parsed)
  ? (parsed as Case[])
  : ((parsed as { cases?: Case[] }).cases ?? []);

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
