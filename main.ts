// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from /input/cases.json (a JSON array of
// { "id", "markdown" } objects), renders each one with parse() from
// ./parse.js, and writes the resulting HTML strings, in the cases'
// order, as a JSON array to /output/html.json.
//
// The work is deliberately plain: one read, one pass over the cases
// into a preallocated array, one serialisation, one write. parse()
// keeps no state between calls, so the output depends only on the
// input file.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

interface CaseInput {
  id: string;
  markdown: string;
}

const raw = readFileSync('/input/cases.json', 'utf8');
const cases = JSON.parse(raw) as CaseInput[];

const results: string[] = new Array<string>(cases.length);
for (let idx = 0; idx < cases.length; idx++) {
  results[idx] = parse(cases[idx].markdown);
}

writeFileSync('/output/html.json', JSON.stringify(results));
