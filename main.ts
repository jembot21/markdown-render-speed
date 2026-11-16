// Driver for the markdown-render-speed-02 harness: read every case from
// cases.json in the input directory, render each case's markdown with
// parse() from ./parse.js, and write the resulting HTML strings, in the
// same order, as a JSON array to html.json in the output directory.
// Outside the harness container the directories come from the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const out = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
