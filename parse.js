// parse.js — a dependency-free Markdown renderer whose output is byte-identical
// to marked 18.1.3 with default options (gfm: true, breaks: false, pedantic: false).
//
// Structure: a block-structure pass (containers, then leaves) builds a small
// tree; link reference definitions are harvested as paragraphs close; a second
// pass parses inline content (delimiter-stack emphasis, bracket-stack links)
// and renders HTML with marked's exact escaping and formatting conventions.

'use strict';

// ---------------------------------------------------------------------------
// Character classes and small helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const PUNCT_RE = /[\p{P}\p{S}]/u;

function isWsCh(ch) {
  // ch may be undefined at a string boundary; the spec treats boundaries as
  // whitespace for flanking purposes.
  if (ch === undefined) return true;
  const c = ch.charCodeAt(0);
  if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return true;
  return /\s/.test(ch);
}

function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (ASCII_PUNCT.has(ch)) return true;
  if (ch.charCodeAt(0) < 128) return false;
  return PUNCT_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Escaping. Marked escapes text with a "no-encode" rule: an ampersand that
// begins something shaped like a character reference is left alone, the rest
// are escaped. Attribute values (href/title) use the same preservation, and
// never decode anything. Running text is different again: numeric references
// are decoded, and once one has been decoded inside the same text run, later
// named references whose name contains an underscore lose their protection.
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeFull(s) {
  return s.replace(/&|<|>|"|'/g, (c) => ESCAPES[c]);
}

// Does s at index i (which holds '&') begin a preserved reference shape?
// Returns the length of the reference including '&' and ';', or 0.
function preservedRefLen(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c = s[j];
  if (c === '#') {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      let digits = 0;
      while (j < n && digits <= 6 && isHexDigit(s[j])) { j++; digits++; }
      if (digits >= 1 && digits <= 6 && j < n && s[j] === ';') return j - i + 1;
      return 0;
    }
    let digits = 0;
    while (j < n && digits <= 7 && isDigit(s[j])) { j++; digits++; }
    if (digits >= 1 && digits <= 7 && j < n && s[j] === ';') return j - i + 1;
    return 0;
  }
  // named: one or more word characters then ';'
  let k = j;
  while (k < n && isWordCh(s[k])) k++;
  if (k > j && k < n && s[k] === ';') return k - i + 1;
  return 0;
}

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isHexDigit(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
function isWordCh(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
}

// Escape an attribute value (href, title): preserve reference shapes verbatim.
function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const len = preservedRefLen(s, i);
      if (len > 0) { out += s.slice(i, i + len); i += len; }
      else { out += '&amp;'; i++; }
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c]; i++;
    } else {
      // copy a plain run quickly
      let j = i + 1;
      while (j < n) {
        const d = s[j];
        if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Try to read a numeric character reference at s[i] === '&'. Returns
// { len, text } where text is the decoded character (already output-safe:
// callers escape it if it is one of & < > " '), or null when the reference
// shape is invalid (too many digits, bad digits, missing ';').
function readNumericRef(s, i) {
  const n = s.length;
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  let value;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) {
    j++;
    let digits = 0;
    value = 0;
    while (j < n && digits <= 6 && isHexDigit(s[j])) {
      value = value * 16 + parseInt(s[j], 16);
      j++; digits++;
    }
    if (digits < 1 || digits > 6 || j >= n || s[j] !== ';') return null;
  } else {
    let digits = 0;
    value = 0;
    while (j < n && digits <= 7 && isDigit(s[j])) {
      value = value * 10 + (s[j].charCodeAt(0) - 48);
      j++; digits++;
    }
    if (digits < 1 || digits > 7 || j >= n || s[j] !== ';') return null;
  }
  let text;
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    text = '\uFFFD';
  } else {
    text = String.fromCodePoint(value);
  }
  return { len: j - i + 1, text };
}

// Escape one maximal text run for HTML output, applying marked's entity
// behaviour: numeric references decode (and arm the underscore rule), named
// reference shapes pass through unless disarmed, other specials escape.
function escapeTextRun(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let afterNumeric = false;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const num = readNumericRef(s, i);
      if (num) {
        const t = num.text;
        out += (t.length === 1 && ESCAPES[t]) ? ESCAPES[t] : t;
        i += num.len;
        afterNumeric = true;
        continue;
      }
      const len = preservedRefLen(s, i);
      if (len > 0) {
        const body = s.slice(i + 1, i + len - 1);
        if (afterNumeric && body.indexOf('_') !== -1) out += '&amp;' + body + ';';
        else out += s.slice(i, i + len);
        i += len;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c];
      if (c === '<') afterNumeric = false;
      i++;
      continue;
    }
    // Plain stretch: copy until the next special character. Inline
    // delimiter characters (* _ ~ [ ] ` ! \) disarm the underscore
    // rule — marked re-segments its text tokens at those points.
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      if (d === '*' || d === '_' || d === '~' || d === '[' || d === ']' ||
          d === '`' || d === '!' || d === '\\') afterNumeric = false;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Marked cleans link destinations with encodeURI, then restores '%' (so
// existing percent escapes and bare percent signs survive untouched).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Resolve backslash escapes (backslash + ASCII punctuation -> the punctuation
// character itself; any other backslash stays). Used for link destinations,
// titles and labels.
function unescapeStr(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Normalise a reference label for lookup: collapse whitespace, fold case.
// Labels compare RAW (backslash escapes are not resolved first), and the
// fold is full Unicode case folding for the common special cases.
function normaliseLabel(s) {
  return s.replace(/\s+/g, ' ').replace(/^ | $/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Line-scan state for block parsing. s = line text, i = offset of the next
// unconsumed character, v = virtual space columns remaining from a partially
// consumed tab (when v > 0, i points AT that tab), col = current column.
// ---------------------------------------------------------------------------

function lsNew(s) { return { s, i: 0, v: 0, col: 0 }; }

// A whitespace-only line made of spaces plus one final tab whose expanded
// width is exactly 4 columns (e.g. "\t", " \t", "   \t").
function isTabRowLine(s) {
  if (!/^[ ]*\t$/.test(s)) return false;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') w++;
    else w += 4 - (w % 4);
  }
  return w === 4;
}
function lsClone(st) { return { s: st.s, i: st.i, v: st.v, col: st.col, baseCol: st.baseCol, baseColFence: st.baseColFence, leadOrig: st.leadOrig, leadAlt: st.leadAlt, leadAltFence: st.leadAltFence }; }
function lsPeek(st) { return st.v > 0 ? ' ' : st.s[st.i]; }
function lsRest(st) {
  return st.v > 0 ? ' '.repeat(st.v) + st.s.slice(st.i + 1) : st.s.slice(st.i);
}
function lsAdvanceCol(st) {
  if (st.v > 0) { st.v--; st.col++; if (st.v === 0) st.i++; return; }
  const c = st.s[st.i];
  if (c === '\t') {
    const w = 4 - (st.col % 4);
    if (w === 1) { st.i++; st.col++; } else { st.v = w - 1; st.col++; }
  } else { st.i++; st.col++; }
}
function lsAdvanceChar(st) {
  if (st.v > 0) { st.col += st.v; st.v = 0; st.i++; return; }
  const c = st.s[st.i];
  if (c === '\t') st.col += 4 - (st.col % 4); else st.col++;
  st.i++;
}
function lsIsBlank(st) {
  const s = st.s;
  let i = st.i + (st.v > 0 ? 1 : 0);
  for (; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
// Consume exactly `cols` columns of indentation; non-destructive on failure.
function lsMatchIndent(st, cols) {
  const save = lsClone(st);
  let need = cols;
  while (need > 0) {
    const c = lsPeek(st);
    if (c === ' ' || c === '\t') { lsAdvanceCol(st); need--; }
    else { Object.assign(st, save); return false; }
  }
  return true;
}
// Count columns of leading indentation available at st (does not modify st).
function lsIndentCols(st) {
  const t = lsClone(st);
  let n = 0;
  for (;;) {
    const c = lsPeek(t);
    if (c === ' ') { lsAdvanceCol(t); n++; }
    else if (c === '\t' && t.v === 0) { n += 4 - (t.col % 4); lsAdvanceChar(t); }
    else break;
  }
  return n;
}
// Skip up to `max` columns of indentation; returns columns skipped. A tab
// whose full width would overshoot max is left unconsumed.
function lsSkipIndent(st, max) {
  let used = 0;
  for (;;) {
    if (st.v > 0) {
      if (used + 1 > max) break;
      lsAdvanceCol(st); used++; continue;
    }
    const c = st.s[st.i];
    if (c === ' ') {
      if (used + 1 > max) break;
      lsAdvanceCol(st); used++;
    } else if (c === '\t') {
      const w = 4 - (st.col % 4);
      if (used + w > max) break;
      lsAdvanceChar(st); used += w;
    } else break;
  }
  return used;
}

// ---------------------------------------------------------------------------
// Tables (GFM). Cells are split on unescaped pipes; a leading/trailing pipe
// (after trimming the line) does not create an empty edge cell.
// ---------------------------------------------------------------------------

function splitCells(line) {
  const t = line.trim();
  const dropFirst = t.charAt(0) === '|';
  let dropLast = false;
  if (t.length > (dropFirst ? 1 : 0) && t.charAt(t.length - 1) === '|') {
    let bs = 0;
    let k = t.length - 2;
    while (k >= 0 && t[k] === '\\') { bs++; k--; }
    dropLast = bs % 2 === 0;
  }
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\' && i + 1 < t.length && t[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < t.length && t[i + 1] === '\\') {
      cur += c + t[i + 1];
      i += 2;
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  let res = cells.map((s) => s.trim());
  if (dropFirst && res.length) res.shift();
  if (dropLast && res.length) res.pop();
  return res;
}

// If `delimLine` is a valid delimiter row for `headerLine`, return the align
// array; otherwise null.
function tableAligns(headerLine, delimLine) {
  if (headerLine.indexOf('|') === -1 && delimLine.indexOf('|') === -1) return null;
  const dcells = splitCells(delimLine);
  if (dcells.length === 0) return null;
  const aligns = [];
  for (const c of dcells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.charAt(0) === ':';
    const right = c.charAt(c.length - 1) === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  const hcells = splitCells(headerLine);
  if (hcells.length !== dcells.length) return null;
  return { header: hcells, aligns };
}

// ---------------------------------------------------------------------------
// Link reference definitions. A definition is scanned over the "content
// stream": the current line's remaining content plus the content of following
// lines after re-applying the currently open containers.
// ---------------------------------------------------------------------------

function scanDefinition(stream) {
  const s = stream;
  const n = s.length;
  let p = 0;
  const skipWs = () => { while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++; };
  skipWs();
  if (s[p] !== '[') return null;
  // label: to the first unescaped ']', no unescaped '[' inside
  let j = p + 1;
  let label = '';
  let ok = false;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { label += c + s[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { ok = true; break; }
    label += c;
    j++;
  }
  if (!ok || label.length === 0 || label.length > 999) return null;
  p = j + 1;
  if (s[p] !== ':') return null;
  p++;
  skipWs();
  // destination
  let dest = '';
  if (s[p] === '<') {
    let k = p + 1;
    let inner = '';
    let closed = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n) { inner += c + s[k + 1]; k += 2; continue; }
      if (c === '\n') return null;
      if (c === '>') { closed = true; break; }
      inner += c;
      k++;
    }
    if (!closed) return null;
    dest = inner;
    p = k + 1;
  } else {
    let depth = 0;
    let k = p;
    let inner = '';
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && ASCII_PUNCT.has(s[k + 1])) { inner += c + s[k + 1]; k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      inner += c;
      k++;
    }
    if (inner.length === 0 || depth !== 0) return null;
    dest = inner;
    p = k;
  }
  const afterDest = p;
  // Optional title: separated by whitespace (the whitespace may include one
  // newline run), then only trailing spaces up to the line end.
  const tryTitle = (from) => {
    let q = from;
    while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
    if (q === from) return undefined; // no whitespace -> no title possible
    const open = s[q];
    if (open !== '"' && open !== "'" && open !== '(') return undefined;
    const close = open === '(' ? ')' : open;
    let k = q + 1;
    let inner = '';
    let closed = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n) { inner += c + s[k + 1]; k += 2; continue; }
      if (open === '(' && c === '(') return null;
      if (c === close) { closed = true; break; }
      inner += c;
      k++;
    }
    if (!closed) return null;
    let r = k + 1;
    while (r < n && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r < n && s[r] !== '\n') return null;
    return { title: inner, end: r };
  };
  const withTitle = tryTitle(afterDest);
  let end;
  let title = null;
  if (withTitle) {
    title = withTitle.title;
    end = withTitle.end;
  } else {
    // No (usable) title: the rest of the destination's line must be blank.
    // This also covers a following line that starts with a quoted string
    // which is not a clean title (junk after it): the definition then ends
    // at the destination's line and the string becomes its own paragraph.
    let r = afterDest;
    while (r < n && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r < n && s[r] !== '\n') return null;
    end = r;
  }
  let lines = 1;
  for (let k = 0; k < end; k++) if (s[k] === '\n') lines++;
  const normLabel = normaliseLabel(label);
  if (normLabel === '') return null;
  return {
    label: normLabel,
    href: unescapeStr(dest),
    title: title === null ? null : unescapeStr(title),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Block parser: container matching, then leaf continuation or new blocks.
// ---------------------------------------------------------------------------

let S = null; // { lines, pos, stack, defs, prevBlank }

// Marked carries an "inside an <a> element" state across the whole
// document: an inline <a ...> open tag suppresses bare autolinks (not
// angle autolinks, not markdown links) until a </a> tag appears, even
// across block boundaries. Link/image text is sub-lexed, so state set
// inside it is rolled back when the link forms.
let anchorOpen = false;

function tip() { return S.stack[S.stack.length - 1]; }
function addBlock(node) {
  const tp = tip();
  // New content inside an item means any earlier blank line was internal
  // to the item, not a separator after it.
  if (tp.t === 'item') tp.blankAfter = false;
  tp.kids.push(node);
  return node;
}
function openBlock(node) { addBlock(node); S.stack.push(node); return node; }

function closeBlock(cause) {
  const b = S.stack.pop();
  if (b.t === 'code') {
    b.text = b.text.replace(/\n+$/, '');
    if (b.text) b.text += '\n';
  } else if (b.t === 'fence') {
    // A trailing blank content line loses its newline: the newline just
    // before the closing fence (or EOF) is a terminator, not content.
    if (b.text === '\n' || b.text.endsWith('\n\n')) b.text = b.text.slice(0, -1);
  } else if (b.t === 'html') {
    // Trailing newline: present when more content follows in the same
    // context; absent at container boundaries, and at a blank line unless
    // the block sits inside a list item.
    let tail = '\n';
    if (cause === 'blank') { tail = ''; b.blankClosed = true; }
    else if (cause === 'mismatch') tail = '';
    else if (cause === 'eof') tail = b.topLevel && S.srcEndsWithNewline ? '\n' : '';
    b.text = b.lines.join('\n') + tail;
  }
  return b;
}
function closeDownTo(depth, cause) {
  while (S.stack.length > depth) closeBlock(cause);
}

// Match the open containers (blockquote prefixes, list-item indentation)
// against the line state. Returns the number of stack entries matched,
// counting the document at index 0. Leaf blocks stop the walk.
function matchContainers(st) {
  const stack = S.stack;
  let d = 1;
  let consuming = 0;
  let lastStart = 0;
  let quoteStart = -1;
  while (d < stack.length) {
    const b = stack[d];
    if (b.t === 'list') { d++; continue; }
    if (b.t === 'quote') {
      const save = lsClone(st);
      const startCol = st.col;
      lsSkipIndent(st, 3);
      if (lsPeek(st) === '>') {
        lsAdvanceChar(st);
        const pc = lsPeek(st);
        if (pc === ' ' || pc === '\t') lsAdvanceCol(st);
        consuming++;
        lastStart = startCol;
        quoteStart = startCol;
        d++;
        continue;
      }
      Object.assign(st, save);
      return d;
    }
    if (b.t === 'item') {
      if (lsIsBlank(st)) {
        st.i = st.s.length;
        st.v = 0;
        consuming++;
        lastStart = st.col;
        d++;
        continue;
      }
      const startCol = st.col;
      if (lsMatchIndent(st, b.indent)) {
        consuming++;
        lastStart = startCol;
        d++;
        continue;
      }
      return d;
    }
    // a leaf block: it is the tip, nothing more to match
    if (consuming >= 2) st.baseCol = lastStart;
    if (quoteStart >= 0) st.baseColFence = quoteStart;
    return d;
  }
  if (consuming >= 2) st.baseCol = lastStart;
  if (quoteStart >= 0) st.baseColFence = quoteStart;
  return d;
}

// Marked builds container content strings with tabs in the leading
// whitespace run expanded to spaces at their columns within the current
// container string: with two or more containers open, the column count
// restarts at the first container's content edge (st.baseCol). Rewrite
// st's line accordingly.
function expandLeadTab(st) {
  if (st.v > 0) return;
  const s = st.s;
  let i = st.i;
  let col = st.col;
  let out = '';
  let changed = false;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; col++; i++; continue; }
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
      changed = true;
      continue;
    }
    break;
  }
  if (changed) {
    st.s = s.slice(0, st.i) + out + s.slice(i);
    // With two or more containers matched, marked renders a leading tab
    // as if its column restarted where the last container's match began
    // (st.baseCol). Structure decisions keep the original columns; only
    // harvested text swaps the run — see restText.
    if (st.baseCol) {
      let col2 = st.col - st.baseCol;
      let outAlt = '';
      for (let k = st.i; k < s.length; k++) {
        const c = s[k];
        if (c === ' ') { outAlt += ' '; col2++; continue; }
        if (c === '\t') {
          const w = 4 - (col2 % 4);
          outAlt += ' '.repeat(w);
          col2 += w;
          continue;
        }
        break;
      }
      if (outAlt !== out) { st.leadOrig = out; st.leadAlt = outAlt; }
    }
    // Fence content uses a different frame: columns restart where the
    // last blockquote's match began (marked re-lexes quote content);
    // with no quote in the stack the original columns stand.
    if (st.baseColFence) {
      let col3 = st.col - st.baseColFence;
      let outAltF = '';
      for (let k = st.i; k < s.length; k++) {
        const c = s[k];
        if (c === ' ') { outAltF += ' '; col3++; continue; }
        if (c === '\t') {
          const w = 4 - (col3 % 4);
          outAltF += ' '.repeat(w);
          col3 += w;
          continue;
        }
        break;
      }
      if (outAltF !== out) { st.leadOrig = out; st.leadAltFence = outAltF; }
    }
  }
}

// lsRest for fence content lines: the baseColFence-adjusted leading run,
// including the case where a tab was consumed as a quote's space and
// only its virtual remainder is left in the state.
function restTextFence(st) {
  if (st.v > 0 && st.baseColFence !== undefined) {
    const tabCol = st.col - 1;
    const wF = 4 - ((tabCol - st.baseColFence) % 4);
    return ' '.repeat(Math.max(0, wF - 1)) + st.s.slice(st.i + 1);
  }
  const r = lsRest(st);
  if (st.leadAltFence !== undefined && r.startsWith(st.leadOrig)) {
    return st.leadAltFence + r.slice(st.leadOrig.length);
  }
  return r;
}

// lsRest for harvested block text (paragraph lines, fence content): swaps
// in the baseCol-adjusted leading whitespace run when there is one.
function restText(st) {
  const r = lsRest(st);
  if (st.leadAlt !== undefined && r.startsWith(st.leadOrig)) {
    return st.leadAlt + r.slice(st.leadOrig.length);
  }
  return r;
}

// Like contentOfLine, but matches only the first `depth` stack entries
// (deeper containers are ignored rather than making the match fail).
function contentOfLineUpTo(idx, depth) {
  if (idx >= S.lines.length) return null;
  const st = lsNew(S.lines[idx]);
  const saved = S.stack;
  S.stack = saved.slice(0, depth);
  const matched = matchContainers(st);
  S.stack = saved;
  if (matched !== depth) return null;
  if (matched > 1) expandLeadTab(st);
  return lsRest(st);
}

// Content of lines[idx] after applying the currently open containers; depth
// stack entries must match. Returns null when containers do not match or the
// content line is blank.
function contentOfLine(idx, depth) {
  if (idx >= S.lines.length) return null;
  const st = lsNew(S.lines[idx]);
  const matched = matchContainers(st);
  if (matched !== depth) return null;
  if (matched > 1) expandLeadTab(st);
  if (lsIsBlank(st)) return null;
  return lsRest(st);
}

function buildDefStream(firstContent) {
  let stream = firstContent;
  let len = firstContent.length;
  for (let k = 1; k <= 12; k++) {
    const c = contentOfLine(S.pos + k, S.stack.length);
    if (c === null) break;
    stream += '\n' + c;
    len += c.length;
    if (len > 6000) break;
  }
  return stream;
}

function handleBlankLine(matched) {
  // Looseness bookkeeping only counts blank lines that are blank at the
  // level of the deepest open list item: a line like `  >` inside an item
  // is blank inside its blockquote, but it is not a blank line in the
  // item's own content, so it must not loosen the list.
  let gate = true;
  for (let d = S.stack.length - 1; d >= 1; d--) {
    if (S.stack[d].t === 'item') {
      const c = contentOfLineUpTo(S.pos, d + 1);
      gate = c === null || /^[ \t]*$/.test(c);
      break;
    }
  }
  // An item that has produced no content yet is ended by a blank line:
  // content can no longer start inside it afterwards.
  if (tip().t === 'item' && tip().kids.length === 0) {
    if (gate) tip().blankAfter = true;
    closeBlock('blank');
  }
  let target = Math.min(matched, S.stack.length);
  if (tip().t === 'para') target = Math.min(target, S.stack.length - 1);
  if (gate) {
    const from = Math.min(target, S.stack.length - 1);
    for (let d = from; d < S.stack.length; d++) S.stack[d].blankAfter = true;
    if (target >= S.stack.length) {
      // Nothing closes: the blank follows the tip container's last block.
      const tp2 = tip();
      if (tp2.kids && tp2.kids.length) tp2.kids[tp2.kids.length - 1].blankAfter = true;
    }
  }
  closeDownTo(target, 'blank');
  S.prevBlank = true;
}

// --- leaf-start detectors (all take a state cloned/skipped to content) ---

function countRun(st, ch) {
  const t = lsClone(st);
  let run = 0;
  while (lsPeek(t) === ch) { lsAdvanceChar(t); run++; }
  return run;
}

function tryATX(st) {
  const t = lsClone(st);
  let level = 0;
  while (level < 7 && lsPeek(t) === '#') { lsAdvanceChar(t); level++; }
  if (level === 0 || level > 6) return null;
  const rest = lsRest(t);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  let content = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/[ \t]+#+$/, '');
  return { t: 'head', level, text: content, kids: null, blankAfter: false };
}

function isHrLine(rest) {
  let ch = null;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '*' && c !== '-' && c !== '_') return false;
    if (ch === null) ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

const HTML_TYPE7_RE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;

// Returns the HTML block type (1-7) starting at st, or 0. Type 7 (a lone
// complete tag on the line) never interrupts a paragraph.
function detectHtmlBlock(st, forInterrupt) {
  const rest = lsRest(st);
  if (rest.charAt(0) !== '<') return 0;
  const m1 = /^<(script|pre|style|textarea)(?=[\s/>]|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest);
  if (m6 && HTML_BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  if (!forInterrupt && HTML_TYPE7_RE.test(rest)) return 7;
  return 0;
}

function htmlEndReached(node) {
  const text = node.lines.join('\n');
  switch (node.htmlType) {
    case 1: {
      const lower = text.toLowerCase();
      const needle = '</' + node.tagName;
      let idx = lower.indexOf(needle);
      while (idx !== -1) {
        const after = lower.charAt(idx + needle.length);
        if (after === '' || after === '>' || after === ' ' || after === '\t' || after === '\n') return true;
        idx = lower.indexOf(needle, idx + 1);
      }
      return false;
    }
    case 2: return text.indexOf('-->') !== -1;
    case 3: return text.indexOf('?>') !== -1;
    case 4: return text.indexOf('>') !== -1;
    case 5: return text.indexOf(']]>') !== -1;
    default: return false;
  }
}

function parseListMarker(st) {
  const t = lsClone(st);
  const c = lsPeek(t);
  let ordered = false;
  let num = 0;
  let delim = null;
  let markerWidth = 0;
  if (c === '-' || c === '+' || c === '*') {
    delim = c;
    markerWidth = 1;
    lsAdvanceChar(t);
  } else if (c >= '0' && c <= '9') {
    let digits = '';
    while (digits.length < 10) {
      const d = lsPeek(t);
      if (d >= '0' && d <= '9') { digits += d; lsAdvanceChar(t); } else break;
    }
    if (digits.length > 9) return null;
    const d = lsPeek(t);
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    num = parseInt(digits, 10);
    delim = d;
    markerWidth = digits.length + 1;
    lsAdvanceChar(t);
  } else return null;
  const after = lsPeek(t);
  let contentIndent;
  let contentEmpty = false;
  if (after === undefined || lsIsBlank(t)) {
    contentIndent = markerWidth + 1;
    contentEmpty = true;
    t.i = t.s.length;
    t.v = 0;
  } else if (after === ' ' || after === '\t') {
    const sp = lsIndentCols(t);
    if (sp >= 1 && sp <= 4) {
      contentIndent = markerWidth + sp;
      for (let k = 0; k < sp; k++) lsAdvanceCol(t);
    } else {
      contentIndent = markerWidth + 1;
      lsAdvanceCol(t);
    }
  } else return null;
  return { ordered, num, delim, markerWidth, contentIndent, contentEmpty, endSt: t };
}

function handleListMarker(m, st, baseIndent) {
  let tp = tip();
  const sameList = (L) => L.t === 'list' && L.ordered === m.ordered && L.delim === m.delim;
  if (tp.t === 'list' && !sameList(tp)) { closeBlock('other'); tp = tip(); }
  if (tp.t !== 'list') {
    openBlock({
      t: 'list', ordered: m.ordered, start: m.ordered ? m.num : null,
      delim: m.delim, kids: [], blankAfter: false,
    });
  }
  openBlock({ t: 'item', indent: baseIndent + m.contentIndent, kids: [], blankAfter: false });
  Object.assign(st, m.endSt);
}

function setextLevel(st) {
  const t = lsClone(st);
  lsSkipIndent(t, 3);
  const rest = lsRest(t);
  const c = rest.charAt(0);
  if (c !== '=' && c !== '-') return 0;
  let i = 0;
  while (rest[i] === c) i++;
  if (!/^[ \t]*$/.test(rest.slice(i))) return 0;
  return c === '=' ? 1 : 2;
}

// Would this line start a block that interrupts an open paragraph?
// allowEmptyList: an empty list item cannot interrupt a paragraph, except
// as a sibling item of a list the paragraph's item belongs to.
// siblingList: the line exits an open list, so any list marker on it is a
// sibling item (the ordered start==1 rule does not apply).
// paraInItem: the paragraph sits directly in a list item and the line
// matched its containers; a nested list then interrupts with any start.
function startsInterruptPara(st, forTable, allowEmptyList, siblingList, paraInItem) {
  if (lsIndentCols(st) >= 4) return false;
  const t = lsClone(st);
  lsSkipIndent(t, 3);
  const c = lsPeek(t);
  if (c === undefined) return false;
  if (c === '>') return true;
  if (c === '#') return tryATX(t) !== null;
  if (c === '`' || c === '~') {
    if (countRun(t, c) < 3) return false;
    if (c === '`') {
      const t2 = lsClone(t);
      for (let k = 0; k < 3; k++) lsAdvanceChar(t2);
      let guard = 0;
      while (lsPeek(t2) === '`') { lsAdvanceChar(t2); if (++guard > 100) break; }
      if (lsRest(t2).indexOf('`') !== -1) return false;
    }
    return true;
  }
  if (c === '<') return detectHtmlBlock(t, true) !== 0;
  if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
    if (isHrLine(lsRest(t))) return true;
    const m = parseListMarker(t);
    if (m && !m.contentEmpty && (forTable || siblingList || paraInItem || !m.ordered || m.num === 1)) return true;
    if (m && m.contentEmpty && allowEmptyList) return true;
    return false;
  }
  return false;
}

function isFenceClose(st, fence) {
  const t = lsClone(st);
  lsSkipIndent(t, 3);
  let run = 0;
  while (lsPeek(t) === fence.ch) { lsAdvanceChar(t); run++; }
  if (run < fence.len) return false;
  return lsIsBlank(t);
}

// Open new blocks for the current line; st is positioned after the matched
// containers. Advances S.pos past every line consumed.
function openNewBlocks(st) {
  for (;;) {
    const entryRest = lsRest(st);
    const indent = lsIndentCols(st);
    const save = lsClone(st);
    const skipped = lsSkipIndent(st, 3);
    const c = lsPeek(st);

    if (c === '>') {
      if (tip().t === 'list') closeBlock('other');
      lsAdvanceChar(st);
      const pc = lsPeek(st);
      if (pc === ' ' || pc === '\t') lsAdvanceCol(st);
      openBlock({ t: 'quote', kids: [], blankAfter: false });
      continue;
    }
    if (indent >= 4) {
      if (tip().t === 'list') closeBlock('other');
      Object.assign(st, save);
      lsMatchIndent(st, 4);
      openBlock({ t: 'code', text: lsRest(st) + '\n', blankAfter: false });
      S.pos++;
      return;
    }
    if (c === '`' || c === '~') {
      const run = countRun(st, c);
      if (run >= 3) {
        const t2 = lsClone(st);
        for (let k = 0; k < run; k++) lsAdvanceChar(t2);
        const info = lsRest(t2).trim();
        if (c === '~' || info.indexOf('`') === -1) {
          if (tip().t === 'list') closeBlock('other');
          for (let k = 0; k < run; k++) lsAdvanceChar(st);
          openBlock({
            t: 'fence', ch: c, len: run, indent: skipped,
            lang: info === '' ? null : unescapeStr(info.split(/\s+/)[0]),
            text: '', blankAfter: false,
          });
          S.pos++;
          return;
        }
      }
    }
    if (c === '#') {
      const h = tryATX(st);
      if (h) {
        if (tip().t === 'list') closeBlock('other');
        addBlock(h);
        S.pos++;
        return;
      }
    }
    if (c === '<') {
      const htmlType = detectHtmlBlock(st);
      if (htmlType !== 0) {
        if (tip().t === 'list') closeBlock('other');
        const node = {
          t: 'html', htmlType, lines: [entryRest], sealed: false, blankAfter: false,
          inItem: S.stack.some((b) => b.t === 'item'),
          topLevel: S.stack.every((b) => b.t === 'doc'),
        };
        if (htmlType === 1) {
          const m1 = /^<(script|pre|style|textarea)/i.exec(entryRest.trimStart());
          node.tagName = m1 ? m1[1].toLowerCase() : '';
        }
        if (htmlType >= 1 && htmlType <= 5 && htmlEndReached(node)) node.sealed = true;
        openBlock(node);
        S.pos++;
        return;
      }
    }
    if (isHrLine(lsRest(st))) {
      if (tip().t === 'list') closeBlock('other');
      addBlock({ t: 'hr', kids: null, blankAfter: false });
      S.pos++;
      return;
    }
    {
      const m = parseListMarker(st);
      if (m) {
        handleListMarker(m, st, skipped);
        continue;
      }
    }
    {
      const nextContent = contentOfLine(S.pos + 1, S.stack.length);
      if (nextContent !== null) {
        const ta = tableAligns(entryRest, nextContent);
        if (ta) {
          if (tip().t === 'list') closeBlock('other');
          const node = { t: 'table', header: ta.header, aligns: ta.aligns, rows: [], blankAfter: false };
          addBlock(node);
          S.stack.push(node);
          S.pos += 2;
          return;
        }
      }
    }
    if (c === '[') {
      const def = scanDefinition(buildDefStream(lsRest(st)));
      if (def) {
        if (tip().t === 'list') closeBlock('other');
        if (!S.defs.has(def.label)) S.defs.set(def.label, def);
        addBlock({ t: 'def', kids: null, blankAfter: false });
        S.pos += def.lines;
        return;
      }
    }
    if (entryRest === '') { S.pos++; return; }
    if (tip().t === 'list') closeBlock('other');
    openBlock({ t: 'para', text: entryRest, blankAfter: false });
    S.pos++;
    return;
  }
}

function processLine() {
  const st = lsNew(S.lines[S.pos]);
  const stack = S.stack;
  const matched = matchContainers(st);
  if (matched > 1) expandLeadTab(st);
  let tp = tip();
  let tipIsLeaf = tp.t === 'para' || tp.t === 'fence' || tp.t === 'code' || tp.t === 'html' || tp.t === 'table';
  let ancOk = tipIsLeaf ? matched === stack.length - 1 : matched === stack.length;
  const blank = lsIsBlank(st);

  // A sealed HTML block (types 1-5) is closed by this line's arrival; whether
  // its text gains a trailing newline depends on this line being blank —
  // and only a truly empty line (no whitespace at all) counts as blank
  // for this; a whitespace-only line still earns the newline.
  if (tp.t === 'html' && tp.sealed) {
    closeBlock(blank && lsRest(st) === '' ? 'blank' : ancOk ? 'other' : 'mismatch');
    tp = tip();
    tipIsLeaf = tp.t === 'para' || tp.t === 'fence' || tp.t === 'code' || tp.t === 'html' || tp.t === 'table';
    ancOk = tipIsLeaf ? matched === S.stack.length - 1 : matched === S.stack.length;
  }

  if (tp.t === 'fence') {
    // A fence inside a list item holds its containers open: content lines
    // are consumed even when they do not match the item indentation. (In
    // a blockquote the lines still need their `>` prefix.) The closing
    // fence is recognised on the container-matched state when there is
    // one, otherwise on the raw line.
    const holdable = tp.text.length > 0 && S.stack.slice(matched, S.stack.length - 1)
      .every((b) => b.t === 'list' || b.t === 'item');
    if (!ancOk && !holdable) {
      closeBlock('other');
      closeDownTo(matched, 'mismatch');
      tp = tip();
      tipIsLeaf = tp.t === 'para' || tp.t === 'fence' || tp.t === 'code' || tp.t === 'html' || tp.t === 'table';
      ancOk = tipIsLeaf ? matched === S.stack.length - 1 : matched === S.stack.length;
      // fall through: the line is processed normally below
    } else {
    let closeSt = st;
    if (!ancOk) {
      closeSt = lsNew(S.lines[S.pos]);
      lsSkipIndent(closeSt, 3);
    }
    if (isFenceClose(closeSt, tp)) {
      closeBlock('other');
      if (!ancOk) closeDownTo(matched, 'mismatch');
    } else if (ancOk) {
      // backtick fences give back up to the fence's own indentation
      // (a tab the strip reaches is consumed whole); tilde fences keep
      // their content lines verbatim — a marked asymmetry
      if (tp.ch === '`') {
        let k = tp.indent || 0;
        while (k > 0) {
          if (st.v > 0) { lsAdvanceCol(st); k--; continue; }
          const pc = st.s[st.i];
          if (pc === ' ') { lsAdvanceCol(st); k--; }
          else if (pc === '\t') { lsAdvanceChar(st); break; }
          else break;
        }
      }
      tp.text += restTextFence(st) + '\n';
    } else {
      tp.text += S.lines[S.pos] + '\n';
    }
    S.prevBlank = false;
    S.pos++;
    return;
    }
  }
  if (ancOk && tp.t === 'code') {
    if (lsMatchIndent(st, 4)) {
      tp.text += lsRest(st) + '\n';
      S.prevBlank = false;
      S.pos++;
      return;
    }
    if (blank) {
      tp.text += '\n';
      S.prevBlank = false;
      S.pos++;
      return;
    }
    closeBlock('other');
    tp = tip();
  }
  if (ancOk && tp.t === 'html') {
    if (blank) {
      if (tp.htmlType >= 6) {
        closeBlock('blank');
        handleBlankLine(matched);
      } else {
        tp.lines.push('');
        S.prevBlank = false;
      }
      S.pos++;
      return;
    }
    tp.lines.push(lsRest(st));
    if (tp.htmlType >= 1 && tp.htmlType <= 5 && htmlEndReached(tp)) tp.sealed = true;
    S.prevBlank = false;
    S.pos++;
    return;
  }
  if (ancOk && tp.t === 'table') {
    if (lsIsBlank(st) && !isTabRowLine(st.s)) {
      // A blank line ends the table — except a line of spaces ending in
      // a single tab (expanded width exactly 4), which marked counts as
      // a row of empty cells.
      closeBlock('other');
      handleBlankLine(matched);
      S.pos++;
      return;
    }
    if ((lsIndentCols(st) >= 4 && !isTabRowLine(st.s)) || startsInterruptPara(st, true)) {
      // An indented (>= 4) line is an indented code block, not a row.
      closeBlock('other');
      tp = tip();
    } else {
      const cells = splitCells(lsRest(st));
      while (cells.length < tp.header.length) cells.push('');
      cells.length = tp.header.length;
      tp.rows.push(cells);
      S.prevBlank = false;
      S.pos++;
      return;
    }
  }

  if (blank) {
    // A whitespace-only final line still joins an open paragraph when it
    // sits inside a container, or when the source does not end with a
    // newline (marked's paragraph capture keeps it in those cases).
    if (ancOk && tp.t === 'para' && S.pos === S.lines.length - 1 &&
        lsRest(st).length > 0 &&
        (S.stack.length > 2 || !S.srcEndsWithNewline)) {
      tp.text += '\n' + restText(st);
      S.prevBlank = false;
      S.pos++;
      return;
    }
    handleBlankLine(matched);
    S.pos++;
    return;
  }

  if (tp.t === 'para') {
    if (ancOk) {
      const lvl = setextLevel(st);
      if (lvl !== 0) {
        tp.text = tp.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        tp.t = 'head';
        tp.level = lvl;
        closeBlock('other');
        S.prevBlank = false;
        S.pos++;
        return;
      }
      const nextContent = contentOfLine(S.pos + 1, S.stack.length - 1);
      if (nextContent !== null) {
        const ta = tableAligns(lsRest(st), nextContent);
        if (ta) {
          closeBlock('other');
          const node = { t: 'table', header: ta.header, aligns: ta.aligns, rows: [], blankAfter: false };
          addBlock(node);
          S.stack.push(node);
          S.prevBlank = false;
          S.pos += 2;
          return;
        }
      }
      if (!startsInterruptPara(st, false, false, false,
          S.stack.length >= 2 && S.stack[S.stack.length - 2].t === 'item')) {
        tp.text += '\n' + restText(st);
        S.prevBlank = false;
        S.pos++;
        return;
      }
      closeBlock('other');
    } else {
      const allowEmpty = S.stack.slice(matched).some((b) => b.t === 'item');
      const siblingList = allowEmpty;
      if (!startsInterruptPara(st, false, allowEmpty, siblingList)) {
        // A setext underline on a lazy line still converts the paragraph
        // when the line leaves a list item (marked re-lexes item content);
        // in a blockquote it does not. Thematic breaks still win.
        const firstUnmatched = S.stack[matched];
        if (firstUnmatched && firstUnmatched.t === 'item' && !isHrLine(lsRest(st))) {
          const lvl = setextLevel(st);
          if (lvl !== 0) {
            tp.text = tp.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            tp.t = 'head';
            tp.level = lvl;
            closeBlock('other');
            S.prevBlank = false;
            S.pos++;
            return;
          }
        }
        // A table may still start on a lazy line (its header is the lazy
        // line, the delimiter row follows on the next line).
        const header = lsRest(st);
        let nextContent = contentOfLine(S.pos + 1, S.stack.length - 1);
        if (nextContent === null && S.pos + 1 < S.lines.length) {
          const st2 = lsNew(S.lines[S.pos + 1]);
          lsSkipIndent(st2, 3);
          if (!lsIsBlank(st2)) nextContent = lsRest(st2);
        }
        const ta = nextContent !== null ? tableAligns(header, nextContent) : null;
        if (ta) {
          closeBlock('other');
          const node = { t: 'table', header: ta.header, aligns: ta.aligns, rows: [], blankAfter: false };
          addBlock(node);
          S.stack.push(node);
          S.prevBlank = false;
          S.pos += 2;
          return;
        }
        // Lazy continuation. Marked shows two quirks here: a first lazy
        // line indented 4+ loses those 4 columns, and inside a blockquote
        // a setext-shaped lazy line after the first gains 4 spaces.
        let appendText = restText(st);
        const lineCount = tp.text.split('\n').length;
        if (firstUnmatched && firstUnmatched.t === 'item' && lineCount >= 2 && lsIndentCols(st) >= 4) {
          // A lazy line falling 4+ columns short of an item's content
          // indent, after a proper continuation line, loses its
          // leading whitespace entirely.
          appendText = appendText.replace(/^[ \t]+/, '');
        }
        if (lineCount === 1 && lsIndentCols(st) >= 4) {
          const st3 = lsClone(st);
          lsMatchIndent(st3, 4);
          appendText = lsRest(st3);
        } else if (firstUnmatched && firstUnmatched.t === 'quote' &&
                   lineCount >= 2 && setextLevel(st) !== 0) {
          const st3 = lsClone(st);
          lsSkipIndent(st3, 3);
          appendText = '    ' + lsRest(st3);
        }
        tp.text += '\n' + appendText;
        S.prevBlank = false;
        S.pos++;
        return;
      }
    }
  } else if (tipIsLeaf) {
    // A leaf whose containers no longer match simply ends.
    closeDownTo(matched, ancOk ? 'other' : 'mismatch');
  }

  closeDownTo(matched, ancOk ? 'other' : 'mismatch');
  S.prevBlank = false;
  openNewBlocks(st);
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function subtreeEndsBlank(b) {
  if (b.blankAfter) return true;
  if (b.kids && b.kids.length) return subtreeEndsBlank(b.kids[b.kids.length - 1]);
  return false;
}

function listIsLoose(L) {
  const items = L.kids;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const notLastItem = i < items.length - 1;
    if (item.blankAfter && notLastItem) return true;
    for (let j = 0; j < item.kids.length; j++) {
      if (subtreeEndsBlank(item.kids[j]) && (j < item.kids.length - 1 || notLastItem)) return true;
    }
  }
  return false;
}

const CHECKBOX = {
  ' ': '<input disabled="" type="checkbox"> ',
  x: '<input checked="" disabled="" type="checkbox"> ',
  X: '<input checked="" disabled="" type="checkbox"> ',
};

function renderItem(item, list, notLast) {
  const tight = list.tight;
  let out = '<li>';
  let firstBlockSeen = false;
  for (const kid of item.kids) {
    if (kid.t === 'def') continue;
    if (kid.t === 'para') {
      let text = kid.text;
      let pre = '';
      if (!firstBlockSeen) {
        const m = /^\[( |x|X)\] /.exec(text);
        if (m && text.length > 4) {
          pre = CHECKBOX[m[1]];
          text = text.slice(4);
        }
      }
      firstBlockSeen = true;
      if (tight) out += pre + renderInline(text, S.defs);
      else out += '<p>' + pre + renderInline(text, S.defs) + '</p>\n';
    } else {
      firstBlockSeen = true;
      // An HTML block closed by a blank line keeps its trailing
      // newline when a sibling item follows in the same list.
      out += (kid.t === 'html' && kid.blankClosed && notLast) ? kid.text + '\n' : renderBlock(kid);
    }
  }
  out += '</li>\n';
  return out;
}

function renderList(L) {
  // Marked trims the end of the last item's content: trailing whitespace
  // on its final paragraph disappears (earlier items keep theirs).
  const lastItem = L.kids[L.kids.length - 1];
  if (lastItem && lastItem.kids.length) {
    let b = lastItem;
    while (b.kids && b.kids.length) {
      const k = b.kids[b.kids.length - 1];
      if (k.t === 'def') { b = null; break; }
      b = k;
    }
    if (b && b.t === 'para') b.text = b.text.replace(/\s+$/, '');
  }
  L.tight = !listIsLoose(L);
  let out;
  if (L.ordered) {
    out = '<ol' + (L.start !== 1 ? ' start="' + L.start + '"' : '') + '>\n';
  } else {
    out = '<ul>\n';
  }
  for (let ix = 0; ix < L.kids.length; ix++) out += renderItem(L.kids[ix], L, ix < L.kids.length - 1);
  out += L.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderTable(b) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < b.header.length; i++) {
    out += '<th' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
      renderInline(b.header[i], S.defs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (b.rows.length) {
    out += '<tbody>';
    for (const row of b.rows) {
      out += '<tr>\n';
      for (let i = 0; i < row.length; i++) {
        out += '<td' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
          renderInline(row[i], S.defs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

function renderBlock(b) {
  switch (b.t) {
    case 'doc':
    case 'quote': {
      const inner = b.kids.map(renderBlock).join('');
      return b.t === 'doc' ? inner : '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'para': return '<p>' + renderInline(b.text, S.defs) + '</p>\n';
    case 'head': return '<h' + b.level + '>' + renderInline(b.text, S.defs) + '</h' + b.level + '>\n';
    case 'code': return '<pre><code>' + escapeFull(b.text) + '</code></pre>\n';
    case 'fence':
      return '<pre><code' + (b.lang ? ' class="language-' + escapeAttr(b.lang) + '"' : '') + '>' +
        escapeFull(b.text) + '</code></pre>\n';
    case 'html': return b.text;
    case 'hr': return '<hr>\n';
    case 'def': return '';
    case 'table': return renderTable(b);
    case 'list': return renderList(b);
    default: return '';
  }
}

function parseDocument(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  let lines = norm.split('\n');
  if (norm.endsWith('\n')) lines.pop();
  if (lines.length === 0) lines = [''];
  S = {
    lines,
    pos: 0,
    stack: [{ t: 'doc', kids: [], blankAfter: false }],
    defs: new Map(),
    prevBlank: false,
    srcEndsWithNewline: norm.endsWith('\n'),
  };
  anchorOpen = false;
  while (S.pos < S.lines.length) processLine();
  closeDownTo(1, 'eof');
  return renderBlock(S.stack[0]);
}

// ---------------------------------------------------------------------------
// Inline parsing. A single scan produces a node list; emphasis is resolved
// with the CommonMark delimiter-stack algorithm; links/images with a bracket
// stack. Text is accumulated into runs so character references are decoded
// per maximal run at render time.
// ---------------------------------------------------------------------------

const SCHEME_AUTO_RE = /^(?:https?:\/\/|ftp:\/\/)/i;
const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[\w-]*[A-Za-z0-9]/;
const EMAIL_LOCAL_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'.split(''));

// A bare email match at text[i], or null. The match is void when the
// character right after it is '-' or '_' (it would extend the domain).
function matchEmailAt(text, i, underscoreCloses) {
  const em = EMAIL_RE.exec(text.slice(i, i + 320));
  if (!em) return null;
  const after = text[i + em[0].length];
  // The match is void when a word character or '-' follows (the regex
  // would have consumed it) — except a '_' run that closes an open
  // underscore emphasis span: marked sub-lexes emphasis content, so the
  // email there ends cleanly at the delimiter.
  if (after === '-') return null;
  if (after === '_' && !underscoreCloses) return null;
  return { len: em[0].length, text: em[0] };
}
const ANGLE_SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const ANGLE_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const INLINE_TAG_RE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>)/;
const INLINE_COMMENT_RE = /^<!--(?:>|->|[\s\S]*?-->)/;
const INLINE_PI_RE = /^<\?[\s\S]*?\?>/;
const INLINE_DECL_RE = /^<![A-Z][\s\S]*?>/;
const INLINE_CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;

function trimAutolink(raw) {
  for (;;) {
    const em = /&[A-Za-z0-9]+;$/.exec(raw);
    if (em) { raw = raw.slice(0, raw.length - em[0].length); continue; }
    const last = raw.charAt(raw.length - 1);
    if (last !== '' && '?!.,:*_~;\'"'.indexOf(last) !== -1) { raw = raw.slice(0, -1); continue; }
    if (last === ')') {
      // A trailing ')' is dropped only when it is unmatched under stack
      // matching (earlier unmatched ')' characters do not count against
      // it): x)](y) keeps its final ')', x)](y)) drops one.
      let depth = 0;
      let lastMatched = false;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '(') depth++;
        else if (raw[i] === ')') {
          if (depth > 0) { depth--; if (i === raw.length - 1) lastMatched = true; }
        }
      }
      if (!lastMatched) { raw = raw.slice(0, -1); continue; }
    }
    return raw;
  }
}

// Try an extended (bare) autolink at text[i]. Returns { len, href, text, raw }
// or null. kind: 'scheme' | 'www' | 'email'.
// A bare autolink is cut at the first '(' that no ')' in the match
// closes.
function truncateUnclosedParen(raw) {
  const stack = [];
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (c === '(') stack.push(k);
    else if (c === ')' && stack.length > 0) stack.pop();
  }
  return stack.length > 0 ? raw.slice(0, stack[0]) : raw;
}

// Would the ']' at rb close a link/image for the nearest active
// bracket opener? A bare autolink stops before such a ']' (the link
// wins and the autolink inside its text is suppressed), but runs
// straight through a ']' that forms nothing.
function bracketWillForm(text, brackets, defs, rb) {
  let op = null;
  for (let k = brackets.length - 1; k >= 0; k--) {
    if (brackets[k].active) { op = brackets[k]; break; }
  }
  if (!op) return false;
  const slice = text.slice(op.srcStart, rb);
  if (text[rb + 1] === '(') {
    return parseLinkDest(text, rb + 1) !== null && linkTextOk(slice);
  }
  if (text[rb + 1] === '[') {
    const lend = text.indexOf(']', rb + 2);
    if (lend === -1) return false;
    const lab = text.slice(rb + 2, lend) || slice;
    return defs.has(normaliseLabel(lab));
  }
  return defs.has(normaliseLabel(slice));
}

function matchBareAutolink(text, i, allowWww, capCtx, underscoreCloses) {
  const rest = text.slice(i, i + 400);
  if (rest.startsWith('mailto:')) {
    const em = matchEmailAt(text, i + 7, underscoreCloses); // mailto:
    if (em) {
      const full = 'mailto:' + em.text;
      return { len: 7 + em.len, href: full, text: full, raw: full };
    }
    return null;
  }
  if (rest.startsWith('xmpp:')) {
    const em = matchEmailAt(text, i + 5, underscoreCloses); // xmpp:
    if (em) {
      let len = 5 + em.len;
      let full = 'xmpp:' + em.text;
      if (text[i + len] === '/') {
        const res = /^[A-Za-z0-9@.]+/.exec(text.slice(i + len + 1, i + len + 200));
        if (res && res[0].length > 0) {
          full += '/' + res[0];
          len += 1 + res[0].length;
        }
      }
      return { len, href: full, text: full, raw: full };
    }
    return null;
  }
  const sm = SCHEME_AUTO_RE.exec(rest);
  if (sm) {
    let j = sm[0].length;
    while (j < rest.length) {
      const c = rest[j];
      if (c === '<' || c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === ']' && capCtx && bracketWillForm(text, capCtx.brackets, capCtx.defs, i + j)) break;
      j++;
    }
    let raw = trimAutolink(truncateUnclosedParen(rest.slice(0, j)));
    if (raw.length <= sm[0].length) return null;
    return { len: raw.length, href: raw, text: raw, raw };
  }
  if (rest.slice(0, 4) === 'www.') {
    if (!allowWww) return null;
    let j = 4;
    while (j < rest.length) {
      const c = rest[j];
      if (c === '<' || c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === ']' && capCtx && bracketWillForm(text, capCtx.brackets, capCtx.defs, i + j)) break;
      j++;
    }
    let raw = trimAutolink(truncateUnclosedParen(rest.slice(0, j)));
    if (raw.length <= 4) return null;
    return { len: raw.length, href: 'http://' + raw, text: raw, raw };
  }
  if (i === 0 || !EMAIL_LOCAL_CHARS.has(text[i - 1])) {
    const em = matchEmailAt(text, i, underscoreCloses); // bare email
    if (em) return { len: em.len, href: 'mailto:' + em.text, text: em.text, raw: em.text };
  }
  return null;
}

// Validate link/image text the way marked's link pattern does: backtick
// runs in the text pair up in order (1st with 2nd, 3rd with 4th, ...);
// an unpaired run is tolerated only when it is the very end of the text.
function linkTextOk(s) {
  const runs = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c !== '`') { i++; continue; }
    let run = 0;
    while (s[i + run] === '`') run++;
    runs.push({ at: i, len: run });
    i += run;
  }
  if (runs.length % 2 === 0) return true;
  const last = runs[runs.length - 1];
  return last.at + last.len === n;
}

// Marked's bracket matching requires the text between an opener and
// its ']' to have balanced square brackets (escapes and code spans
// don't count). An opener whose text is unbalanced cannot close here.
function bracketTextBalanced(s) {
  let depth = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 0;
      while (s[i + run] === '`') run++;
      // Skip a complete code span; an unmatched run swallows the rest.
      let j = i + run;
      let closed = false;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 0;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { closed = true; j += r2; break; }
          j += r2;
        } else j++;
      }
      i = closed ? j : n;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth < 0) return false;
    }
    i++;
  }
  return depth === 0;
}

// Parse the "(destination title)" part of an inline link starting at
// text[j] === '('. Returns { href, title, end } or null.
function parseLinkDest(text, j) {
  const n = text.length;
  let p = j + 1;
  const skipWs = () => {
    let q = p;
    while (q < n && (text[q] === ' ' || text[q] === '\t' || text[q] === '\n')) q++;
    const had = q > p;
    p = q;
    return had;
  };
  skipWs();
  let dest;
  if (text[p] === '<') {
    let k = p + 1;
    let inner = '';
    let closed = false;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n) { inner += c + text[k + 1]; k += 2; continue; }
      if (c === '\n') return null;
      if (c === '>') { closed = true; break; }
      inner += c;
      k++;
    }
    if (!closed) return null;
    dest = inner;
    p = k + 1;
  } else {
    let depth = 0;
    const start = p;
    let k = p;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n && ASCII_PUNCT.has(text[k + 1])) { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c < ' ') break;
      k++;
    }
    dest = text.slice(start, k);
    p = k;
  }
  const hadWs = skipWs();
  let title = null;
  const tc = text[p];
  if (tc === '"' || tc === "'" || tc === '(') {
    if (!hadWs && tc === '(') {
      // "(dest(title))" without separation is not a title; the '(' belongs
      // to nothing valid here, so fail unless dest itself ended cleanly.
      return null;
    }
    const close = tc === '(' ? ')' : tc;
    let k = p + 1;
    let inner = '';
    let closed = false;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n) { inner += c + text[k + 1]; k += 2; continue; }
      if (tc === '(' && c === '(') return null;
      if (c === close) { closed = true; break; }
      inner += c;
      k++;
    }
    if (!closed) return null;
    title = inner;
    p = k + 1;
    skipWs();
  }
  if (text[p] !== ')') return null;
  return { href: unescapeStr(dest), title: title === null ? null : unescapeStr(title), end: p + 1 };
}

// The delimiter-stack emphasis algorithm (CommonMark), restricted to
// delimiters at index >= bottom in the delims list.
// Marked refuses an emphasis pairing whose span ends with an emphasis
// element of the OTHER kind (em vs strong) immediately followed by a word
// character: *a **b**in* keeps the outer stars literal, while
// *a **b** in* and *a **b**. x* pair normally.
function emAdjacencyBlocked(nodes, opener, closer, use) {
  // The block only guards em (single) pairings; strong pairings over a
  // span ending in an emphasis element are fine (**a *b*two*** pairs).
  if (use !== 1) return false;
  const ci = nodes.indexOf(closer);
  const oi = nodes.indexOf(opener);
  if (ci - oi < 3) return false;
  // Walk back over spent delimiter nodes (n === 0 renders as nothing).
  let li = ci - 1;
  while (li > oi && nodes[li].t === 'delim' && nodes[li].n === 0) li--;
  const lastN = nodes[li];
  if (!lastN || lastN.t !== 'text') return false;
  let pi = li - 1;
  while (pi > oi && nodes[pi].t === 'delim' && nodes[pi].n === 0) pi--;
  const prevN = nodes[pi];
  if (!prevN || (prevN.t !== 'em' && prevN.t !== 'strong')) return false;
  // Same-strength inner span: the block applies only when the opener
  // would be partially consumed (**a *b*other* ...**), not for a plain
  // full-length pairing (*a *b*other* ...*).
  if ((prevN.t === 'strong' ? 2 : 1) === use && opener.n <= use) return false;
  // The block applies only when the inner span uses the same delimiter
  // character as the span being considered (*a **b**in* is blocked, but
  // _a **b**not_ and *a __b__in* pair normally).
  if (prevN.ch !== closer.ch) return false;
  // The inner span must be immediately preceded by whitespace: a text
  // node ending in a space/tab/newline. *foo**bar**baz* (no space before
  // the inner span) pairs fine; *a **b**in* does not.
  let bi = pi - 1;
  while (bi > oi && nodes[bi].t === 'delim' && nodes[bi].n === 0) bi--;
  if (bi <= oi) return false;
  const before = nodes[bi];
  if (before.t !== 'text') return false;
  let lastCh = '';
  for (let q = before.parts.length - 1; q >= 0; q--) {
    const p = before.parts[q];
    if (typeof p === 'string') { if (p.length) { lastCh = p.charAt(p.length - 1); break; } }
    else { lastCh = p.e || ''; break; }
  }
  if (!isWsCh(lastCh)) return false;
  for (const p of lastN.parts) {
    if (typeof p === 'string') {
      if (p.length === 0) continue;
      return /[\p{L}\p{N}]/u.test(p.charAt(0));
    }
    return /[\p{L}\p{N}]/u.test(p.e || '');
  }
  return false;
}

// The raw source of the inline run currently being processed (for
// content checks in processEmphasis), and the source ranges of link
// texts that failed the backtick validation.
let emSrcText = null;
let emFailedTexts = null;

// Marked quirk: inside a link text that failed the backtick
// validation (so the bracket stays literal), an emphasis pairing
// whose own content-plus-closer also fails that validation does not
// form either.
function emContentBlocked(opener, closer) {
  if (emSrcText === null || !emFailedTexts || emFailedTexts.length === 0) return false;
  if (opener.pos === undefined || closer.pos === undefined) return false;
  for (const range of emFailedTexts) {
    if (opener.pos >= range[0] && opener.pos < range[1]) {
      const span = emSrcText.slice(opener.pos + opener.origN, closer.pos + closer.origN);
      return !linkTextOk(span);
    }
  }
  return false;
}

function processEmphasis(nodes, delims, bottom) {
  let closerIdx = bottom;
  while (closerIdx < delims.length) {
    const closer = delims[closerIdx];
    if (!closer.canClose || closer.n === 0) { closerIdx++; continue; }
    let openerIdx = -1;
    let use = 0;
    // Marked's odd-match (rule of 3) behaviour: a pairing whose lengths
    // sum to a multiple of 3 is passed over while a farther clean opener
    // exists, but it is used as a fallback when no clean opener remains.
    const oddBlocked = [];
    for (let k = closerIdx - 1; k >= bottom; k--) {
      const o = delims[k];
      if (o.ch !== closer.ch || !o.canOpen || o.n === 0) continue;
      const u = o.n >= 2 && closer.n >= 2 ? 2 : 1;
      if ((o.n + closer.n) % 3 === 0 &&
          !(o.n % 3 === 0 && closer.n % 3 === 0)) {
        // With the flanking precondition met, the odd-match block is
        // absolute. Without it, an em (use 1) pairing is only deferred
        // in favour of a farther clean opener; a strong pairing is not.
        if (o.canClose || closer.canOpen) continue;
        if (u === 2) { /* fall through and pair now */ }
        else { oddBlocked.push({ k, u }); continue; }
      }
      if (emAdjacencyBlocked(nodes, o, closer, u)) continue;
      if (emContentBlocked(o, closer)) continue;
      openerIdx = k;
      use = u;
      break;
    }
    if (openerIdx === -1) {
      for (const cand of oddBlocked) {
        if (emAdjacencyBlocked(nodes, delims[cand.k], closer, cand.u)) continue;
        if (emContentBlocked(delims[cand.k], closer)) continue;
        openerIdx = cand.k;
        use = cand.u;
        break;
      }
    }
    if (openerIdx === -1) { closerIdx++; continue; }
    const opener = delims[openerIdx];
    const oi = nodes.indexOf(opener);
    const ci = nodes.indexOf(closer);
    const kids = nodes.splice(oi + 1, ci - oi - 1);
    // Marked quirk: a strong pairing that leaves exactly one closer
    // character over, over a span ending in [emphasis][text], keeps that
    // character inside the span (**a *b*two*** -> strong with a trailing
    // literal star inside).
    if (use === 2 && closer.n - use === 1 && kids.length >= 2 && openerIdx === bottom) {
      let li = kids.length - 1;
      while (li > 0 && kids[li].t === 'delim' && kids[li].n === 0) li--;
      let pi = li - 1;
      while (pi > 0 && kids[pi].t === 'delim' && kids[pi].n === 0) pi--;
      const lastK = kids[li];
      const prevK = kids[pi];
      if (lastK.t === 'text' && (prevK.t === 'em' || prevK.t === 'strong')) {
        lastK.parts.push(closer.ch);
        closer.n -= 1;
      }
    }
    nodes.splice(oi + 1, 0, { t: use === 2 ? 'strong' : 'em', kids, ch: opener.ch });
    opener.n -= use;
    closer.n -= use;
    delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
    let cIdx = openerIdx + 1;
    if (opener.n === 0) { delims.splice(openerIdx, 1); cIdx = openerIdx; }
    if (closer.n === 0) delims.splice(cIdx, 1);
    closerIdx = cIdx;
  }
}

// Strikethrough span starting at text[i] === '~', marked style: opener and
// closer runs have the same length, no '~' may touch the outside of
// either, and any '~~' pairs inside the content must be balanced (so
// nested strikethrough works: the outer span extends past an inner pair).
// Is the character at k in s escaped (preceded by an odd run of
// backslashes)?
function tildeEscaped(s, k) {
  let n = 0;
  while (k - n - 1 >= 0 && s[k - n - 1] === '\\') n++;
  return n % 2 === 1;
}

function delContentOk(content) {
  if (content.length === 0) return false;
  if (/\s/.test(content.charAt(0)) || /\s/.test(content.charAt(content.length - 1))) return false;
  // A trailing bare tilde means the would-be closer pair sits inside a
  // longer run, which marked never uses; an escaped one is content.
  if (content.endsWith('~')) {
    let runStart = content.length - 1;
    while (runStart > 0 && content[runStart - 1] === '~') runStart--;
    if (!tildeEscaped(content, runStart)) return false;
  }
  // Runs of exactly two unescaped tildes inside must pair up (they form
  // nested spans when the content is re-parsed); longer runs and
  // escaped tildes are plain content.
  let pairs = 0;
  for (let k = 0; k < content.length; k++) {
    const c = content[k];
    if (c === '\\') { k++; continue; }
    if (c !== '~') continue;
    let run = 0;
    while (content[k + run] === '~') run++;
    if (run === 2) pairs++;
    k += run - 1;
  }
  return pairs % 2 === 0;
}

function tryDelSpan(text, i) {
  if (i > 0 && text[i - 1] === '~') return null;
  if (text[i + 1] === '~') {
    if (text[i + 2] === '~') return null;
    let j = i + 2;
    for (;;) {
      j = text.indexOf('~~', j);
      if (j === -1) return null;
      // the closer pair must be a maximal run of exactly two, unless the
      // tilde before it is escaped (then that tilde is content)
      if (text[j + 2] === '~' || (text[j - 1] === '~' && !tildeEscaped(text, j - 1))) { j++; continue; }
      const content = text.slice(i + 2, j);
      if (delContentOk(content)) return { len: j + 2 - i, content };
      j++;
    }
  }
  let j = i + 1;
  for (;;) {
    j = text.indexOf('~', j);
    if (j === -1) return null;
    if (text[j + 1] === '~' || text[j - 1] === '~') { j++; continue; }
    const content = text.slice(i + 1, j);
    if (delContentOk(content)) return { len: j + 1 - i, content };
    j++;
  }
}

// Convert bare autolink nodes inside a freshly formed link's children
// back to plain text (marked never nests those inside link text; angle
// autolinks, however, do nest).
function suppressAutolinks(kids) {
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    if (node.t === 'auto' && !node.angle) kids[i] = { t: 'text', parts: [node.raw] };
    else if (node.kids) suppressAutolinks(node.kids);
  }
}

function containsLink(kids) {
  for (const k of kids) {
    if (k.t === 'link') return true;
    if (k.kids && containsLink(k.kids)) return true;
  }
  return false;
}

// Does this link text leave a backtick run unmatched (code-span
// matching)? Marked then treats emphasis openers after the link as
// inert until the next code span — a quirk of its regex scanner.
function textPoison(s) {
  let k = 0;
  while (k < s.length) {
    if (s[k] === '\\') { k += 2; continue; }
    if (s[k] !== '`') { k++; continue; }
    let run = 0;
    while (s[k + run] === '`') run++;
    let closeEnd = -1;
    for (let j = k + run; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] !== '`') continue;
      let r = 0;
      while (s[j + r] === '`') r++;
      if (r === run) { closeEnd = j + r; break; }
      j += r - 1;
    }
    if (closeEnd === -1) return true;
    k = closeEnd;
  }
  return false;
}

function parseInlineNodes(text, defs, inLink) {
  const savedSrcText = emSrcText;
  const savedFailed = emFailedTexts;
  emSrcText = text;
  const failedTexts = [];
  emFailedTexts = failedTexts;
  const nodes = [];
  const delims = [];
  const brackets = [];
  let buf = [];
  let i = 0;
  const n = text.length;
  let prevWasTextChar = false;
  // Marked quirk: after a link whose text leaves a backtick run
  // unmatched, emphasis and strikethrough constructs that are followed
  // by a code span turn inert. Tracked by position; applied post-scan.
  let poisonFrom = -1;
  const codeStarts = [];
  const delSpans = [];

  const flushBuf = () => {
    if (buf.length) { nodes.push({ t: 'text', parts: buf }); buf = []; }
  };
  const addRaw = (s) => {
    if (!s) return;
    const last = buf[buf.length - 1];
    if (typeof last === 'string') buf[buf.length - 1] = last + s;
    else buf.push(s);
    prevWasTextChar = true;
  };
  const emit = (node) => { flushBuf(); nodes.push(node); prevWasTextChar = false; };

  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        emit({ t: 'html', s: '<br>' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        buf.push({ e: nx });
        prevWasTextChar = true;
        i += 2;
        continue;
      }
      addRaw('\\');
      i++;
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run++;
      // find a closing run of exactly the same length
      let j = i + run;
      let closeAt = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r = 0;
          while (text[j + r] === '`') r++;
          if (r === run) { closeAt = j; break; }
          j += r;
        } else j++;
      }
      // With a bracket open, a span whose closing run lies past the
      // bracket's ']' must not swallow that ']' when the bracket text
      // is link-shaped (its backtick runs pair up the marked way) —
      // marked matches the link first, so the backticks stay literal.
      if (closeAt !== -1 && brackets.length > 0) {
        const rb = text.indexOf(']', i + run);
        if (rb !== -1 && closeAt > rb) {
          const op = brackets[brackets.length - 1];
          if (op) {
            const slice = text.slice(op.srcStart, rb);
            let runs = 0;
            for (let k = 0; k < slice.length; k++) {
              if (slice[k] === '\\') { k++; continue; }
              if (slice[k] === '`') { runs++; while (slice[k + 1] === '`') k++; }
            }
            // The suppression applies only when that ']' really does
            // close a link or image for this opener — a dest that
            // parses, or a reference that resolves.
            let willForm = false;
            if (runs > 0 && runs % 2 === 0) {
              if (text[rb + 1] === '(') {
                willForm = parseLinkDest(text, rb + 1) !== null;
              } else if (text[rb + 1] === '[') {
                const lend = text.indexOf(']', rb + 2);
                if (lend !== -1) {
                  const lab = text.slice(rb + 2, lend) || slice;
                  willForm = defs.has(normaliseLabel(lab));
                }
              } else {
                willForm = defs.has(normaliseLabel(slice));
              }
            }
            if (willForm) closeAt = -1;
          }
        }
      }
      if (closeAt === -1) {
        addRaw(text.slice(i, i + run));
        i += run;
        continue;
      }
      let content = text.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charAt(0) === ' ' &&
          content.charAt(content.length - 1) === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      codeStarts.push(i);
      emit({ t: 'code', s: content });
      i = closeAt + run;
      continue;
    }

    if (c === '<') {
      const rest = text.slice(i, i + 600);
      if (!inLink) {
        const am = ANGLE_SCHEME_RE.exec(rest);
        if (am) {
          emit({ t: 'auto', href: am[1], text: am[1], raw: am[0], angle: true });
          i += am[0].length;
          continue;
        }
        const em = ANGLE_EMAIL_RE.exec(rest);
        if (em) {
          emit({ t: 'auto', href: 'mailto:' + em[1], text: em[1], raw: em[0], angle: true });
          i += em[0].length;
          continue;
        }
      }
      const tag = INLINE_TAG_RE.exec(rest) || INLINE_COMMENT_RE.exec(rest) ||
        INLINE_PI_RE.exec(rest) || INLINE_DECL_RE.exec(rest) || INLINE_CDATA_RE.exec(rest);
      if (tag) {
        emit({ t: 'html', s: tag[0] });
        if (/^<a(?=[\s/>])/i.test(tag[0]) && !/^<a\/>$/i.test(tag[0])) anchorOpen = true;
        else if (/^<\/a(?=[\s>])/i.test(tag[0])) anchorOpen = false;
        i += tag[0].length;
        continue;
      }
      addRaw('<');
      i++;
      continue;
    }

    if (!inLink && !anchorOpen && (c === 'w' || c === 'W' || c === 'h' || c === 'H' || c === 'f' || c === 'F' ||
        c === 'm' || c === 'M' || EMAIL_LOCAL_CHARS.has(c))) {
      const prev = i > 0 ? text[i - 1] : undefined;
      const allowWww = i === 0 || prev === '(' || isWsCh(prev) || !prevWasTextChar;
      const underscoreCloses = delims.some((d) => d.ch === '_' && d.canOpen && d.n > 0);
      const auto = matchBareAutolink(text, i, allowWww, brackets.some((b) => b.active) ? { brackets, defs } : null, underscoreCloses);
      if (auto) {
        emit({ t: 'auto', href: auto.href, text: auto.text, raw: auto.raw });
        i += auto.len;
        continue;
      }
    }

    if (c === '!' && text[i + 1] === '[') {
      flushBuf();
      const node = { t: 'bracket', s: '![' };
      nodes.push(node);
      brackets.push({ node, isImage: true, active: true, srcStart: i + 2, delimLen: delims.length, anchor: anchorOpen });
      prevWasTextChar = false;
      i += 2;
      continue;
    }

    if (c === '[') {
      flushBuf();
      const node = { t: 'bracket', s: '[' };
      nodes.push(node);
      brackets.push({ node, isImage: false, active: true, srcStart: i + 1, delimLen: delims.length, anchor: anchorOpen });
      prevWasTextChar = false;
      i++;
      continue;
    }

    if (c === ']') {
      let opIdx = -1;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active && bracketTextBalanced(text.slice(brackets[k].srcStart, i))) { opIdx = k; break; }
      }
      if (opIdx === -1) {
        addRaw(']');
        i++;
        continue;
      }
      const opener = brackets[opIdx];
      flushBuf();
      let formed = null;
      let endPos = -1;
      const after = i + 1;
      if (text[after] === '(') {
        const pd = parseLinkDest(text, after);
        if (pd) { formed = pd; endPos = pd.end; }
      }
      let labelBracketSeen = false;
      if (!formed && text[after] === '[') {
        // full or collapsed reference
        let k = after + 1;
        let label = '';
        let closed = false;
        while (k < n) {
          const ch = text[k];
          if (ch === '\\' && k + 1 < n) { label += ch + text[k + 1]; k += 2; continue; }
          if (ch === '[') break;
          if (ch === ']') { closed = true; break; }
          label += ch;
          k++;
        }
        if (closed) {
          labelBracketSeen = true;
          const lookup = label === '' ? text.slice(opener.srcStart, i) : label;
          const def = defs.get(normaliseLabel(lookup));
          if (def) {
            formed = { href: def.href, title: def.title };
            endPos = k + 1;
          }
        }
      }
      if (!formed && !labelBracketSeen) {
        const lookup = text.slice(opener.srcStart, i);
        const def = defs.get(normaliseLabel(lookup));
        if (def) {
          formed = { href: def.href, title: def.title };
          endPos = i + 1;
        }
      }
      // Marked's link-text pattern only accepts code spans whose content
      // is backtick-free: a text holding a nested or unclosed backtick
      // run cannot form a link or image at all.
      if (formed && !linkTextOk(text.slice(opener.srcStart, i))) {
        failedTexts.push([opener.srcStart, endPos]);
        formed = null;
      }
      if (!formed) {
        brackets.splice(opIdx, 1);
        addRaw(']');
        i++;
        continue;
      }
      // Form the link/image: resolve emphasis inside the text first.
      processEmphasis(nodes, delims, opener.delimLen);
      delims.length = opener.delimLen;
      const nodeIdx = nodes.indexOf(opener.node);
      const kids = nodes.splice(nodeIdx + 1, nodes.length - nodeIdx - 1);
      nodes.splice(nodeIdx, 1);
      anchorOpen = opener.anchor;
      if (!opener.isImage) suppressAutolinks(kids);
      nodes.push({
        t: opener.isImage ? 'img' : 'link',
        href: formed.href, title: formed.title, kids,
      });
      if (poisonFrom === -1 && textPoison(text.slice(opener.srcStart, i))) poisonFrom = endPos;
      brackets.length = opIdx;
      if (!opener.isImage) {
        for (const b of brackets) if (!b.isImage) b.active = false;
      }
      prevWasTextChar = false;
      i = endPos;
      continue;
    }

    if (c === '*' || c === '_') {
      let run = 0;
      while (text[i + run] === c) run++;

      const prevC = i > 0 ? text[i - 1] : undefined;
      const nextC = i + run < n ? text[i + run] : undefined;
      const leftFlank = !isWsCh(nextC) &&
        (!isPunctCh(nextC) || isWsCh(prevC) || isPunctCh(prevC));
      const rightFlank = !isWsCh(prevC) &&
        (!isPunctCh(prevC) || isWsCh(nextC) || isPunctCh(nextC));
      let canOpen;
      let canClose;
      if (c === '*') {
        canOpen = leftFlank;
        canClose = rightFlank;
      } else {
        canOpen = leftFlank && (!rightFlank || isPunctCh(prevC));
        canClose = rightFlank && (!leftFlank || isPunctCh(nextC));
      }
      flushBuf();
      const node = { t: 'delim', ch: c, n: run, canOpen, canClose, pos: i, origN: run };
      nodes.push(node);
      delims.push(node);
      prevWasTextChar = false;
      i += run;
      continue;
    }

    if (c === '~') {
      const span = tryDelSpan(text, i);
      if (span) {
        flushBuf();
        const delNode = { t: 'del', kids: parseInlineNodes(span.content, defs, inLink) };
        // A link formed inside a strikethrough span still counts as a
        // formed link for bracket deactivation: earlier '[' openers die.
        if (containsLink(delNode.kids)) {
          for (const b of brackets) if (!b.isImage) b.active = false;
        }
        nodes.push(delNode);
        delSpans.push({ node: delNode, pos: i, len: span.len });
        prevWasTextChar = false;
        i += span.len;
        continue;
      }
      flushBuf();
      nodes.push({ t: 'text', parts: ['~'] });
      prevWasTextChar = false;
      i++;
      continue;
    }

    if (c === '\n') {
      // hard break when the run so far ends with 2+ raw spaces
      let sp = 0;
      const lastPiece = buf[buf.length - 1];
      if (typeof lastPiece === 'string') {
        let k = lastPiece.length - 1;
        while (k >= 0 && lastPiece[k] === ' ') { sp++; k--; }
      }
      if (sp >= 2) {
        if (sp === lastPiece.length) buf.pop();
        else buf[buf.length - 1] = lastPiece.slice(0, lastPiece.length - sp);
        emit({ t: 'html', s: '<br>' });
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      addRaw('\n');
      i++;
      continue;
    }

    addRaw(c);
    i++;
  }
  flushBuf();
  if (poisonFrom >= 0 && codeStarts.length > 0) {
    const followedBySpan = (pos) => codeStarts.some((cs) => cs > pos);
    for (let k = delims.length - 1; k >= 0; k--) {
      const d = delims[k];
      if (d.pos > poisonFrom && followedBySpan(d.pos)) delims.splice(k, 1);
    }
    for (const ds of delSpans) {
      if (ds.pos > poisonFrom && followedBySpan(ds.pos)) {
        const idx = nodes.indexOf(ds.node);
        if (idx !== -1) {
          nodes[idx] = { t: 'text', parts: [text.slice(ds.pos, ds.pos + ds.len)] };
        }
      }
    }
  }
  processEmphasis(nodes, delims, 0);
  emSrcText = savedSrcText;
  emFailedTexts = savedFailed;
  return nodes;
}

// ---------------------------------------------------------------------------
// Inline rendering. Consecutive text pieces (including unmatched delimiter
// characters and stray brackets) form one entity-decoding run.
// ---------------------------------------------------------------------------

function escapeTextRunWithState(s, state) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const num = readNumericRef(s, i);
      if (num) {
        const t = num.text;
        out += (t.length === 1 && ESCAPES[t]) ? ESCAPES[t] : t;
        i += num.len;
        state.afterNumeric = true;
        continue;
      }
      const len = preservedRefLen(s, i);
      if (len > 0) {
        const body = s.slice(i + 1, i + len - 1);
        if (state.afterNumeric && body.indexOf('_') !== -1) out += '&amp;' + body + ';';
        else out += s.slice(i, i + len);
        i += len;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c];
      if (c === '<') state.afterNumeric = false;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      if (d === '*' || d === '_' || d === '~' || d === '[' || d === ']' ||
          d === '`' || d === '!' || d === '\\') state.afterNumeric = false;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

const DISARM_CHARS = new Set(['*', '_', '~', '[', ']', '`', '!', '\\', '<']);

function escapePieces(pieces) {
  const state = { afterNumeric: false };
  let out = '';
  let buf = '';
  const flushBuf = () => {
    if (buf) {
      out += escapeTextRunWithState(buf, state);
      buf = '';
    }
  };
  for (const p of pieces) {
    if (typeof p === 'string') { buf += p; continue; }
    flushBuf();
    out += ESCAPES[p.e] || p.e;
    if (DISARM_CHARS.has(p.e)) state.afterNumeric = false;
  }
  flushBuf();
  return out;
}

function altText(nodes) {
  const pieces = [];
  const walk = (ns) => {
    for (const node of ns) {
      switch (node.t) {
        case 'text':
          for (const p of node.parts) pieces.push(p);
          break;
        case 'delim':
          if (node.n > 0) pieces.push(node.ch.repeat(node.n));
          break;
        case 'bracket':
          pieces.push(node.s);
          break;
        case 'code':
          pieces.push(node.s);
          break;
        case 'html':
          if (node.s !== '<br>') pieces.push(node.s);
          break;
        case 'auto':
          pieces.push(node.text);
          break;
        case 'em':
        case 'strong':
        case 'del':
        case 'link':
        case 'img':
          walk(node.kids);
          break;
        default:
          break;
      }
    }
  };
  walk(nodes);
  return escapePieces(pieces);
}

function renderNodes(nodes, defs) {
  let out = '';
  let run = null;
  const flush = () => {
    if (run) {
      out += escapePieces(run);
      run = null;
    }
  };
  const feed = (pieces) => {
    if (!run) run = [];
    for (const p of pieces) run.push(p);
  };
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        feed(node.parts);
        break;
      case 'delim':
        if (node.n > 0) feed([node.ch.repeat(node.n)]);
        break;
      case 'bracket':
        feed([node.s]);
        break;
      case 'code':
        flush();
        out += '<code>' + escapeFull(node.s) + '</code>';
        break;
      case 'html':
        flush();
        out += node.s;
        break;
      case 'auto':
        flush();
        out += '<a href="' + escapeFull(cleanUrl(node.href)) + '">' + escapeFull(node.text) + '</a>';
        break;
      case 'em':
        flush();
        out += '<em>' + renderNodes(node.kids, defs) + '</em>';
        break;
      case 'strong':
        flush();
        out += '<strong>' + renderNodes(node.kids, defs) + '</strong>';
        break;
      case 'del':
        flush();
        out += '<del>' + renderNodes(node.kids, defs) + '</del>';
        break;
      case 'link':
        flush();
        out += '<a href="' + escapeAttr(cleanUrl(node.href)) + '"' +
          (node.title !== null ? ' title="' + escapeAttr(node.title) + '"' : '') + '>' +
          renderNodes(node.kids, defs) + '</a>';
        break;
      case 'img':
        flush();
        out += '<img src="' + escapeAttr(cleanUrl(node.href)) + '" alt="' + altText(node.kids) + '"' +
          (node.title !== null ? ' title="' + escapeAttr(node.title) + '"' : '') + '>';
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

function renderInline(text, defs) {
  return renderNodes(parseInlineNodes(text, defs, false), defs);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  return parseDocument(markdown == null ? '' : String(markdown));
}
