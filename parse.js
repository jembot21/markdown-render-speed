// parse.js — a dependency-free Markdown-to-HTML parser whose output is
// byte-identical to marked 18.1.3 with default options (gfm: true,
// breaks: false, pedantic: false), written as a single-pass scanner:
// blocks are recognised line by line, inline runs copy plain text in bulk,
// and emphasis is resolved with marked's delimiter-run rules.
//
// The exported parse(markdown) is a pure function of its input.

// ---------------------------------------------------------------- helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_ALL = /[&<>"']/g;
const ESCAPE_ALL_TEST = /[&<>"']/;
const ESCAPE_LOOSE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_LOOSE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ANY_PUNCT_ESCAPED = /\\([\p{P}\p{S}])/gu;

/** Escape &, <, >, " and ' (encode) or only those a browser would misread. */
function escapeHtml(s, encode) {
  if (encode) {
    return ESCAPE_ALL_TEST.test(s) ? s.replace(ESCAPE_ALL, (ch) => ESCAPES[ch]) : s;
  }
  return ESCAPE_LOOSE_TEST.test(s) ? s.replace(ESCAPE_LOOSE, (ch) => ESCAPES[ch]) : s;
}

/** Decode numeric character references; turn stray & into &amp;. */
function decodeRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return cp === 38 ? '&amp;' : String.fromCodePoint(cp);
  });
}

/** marked's cleanUrl: encodeURI, undoing the %25 doubling; null on error. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalise a link label the way reference definitions are keyed. */
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the first unbalanced close bracket, -2 if opens remain, else -1. */
function bracketBalance(s, open, close) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === open) depth++;
    else if (ch === close && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs in `s`, counting columns from `startCol` (tab stops of 4). */
function expandTabs(s, startCol) {
  if (!s.includes('\t')) return s;
  let col = startCol;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/** Remove trailing copies of `ch` from the end of `s`. */
function trimEndChar(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Drop trailing blank lines, but keep the text if at most one is dropped. */
function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join('\n');
}

const BLANK_LINE = /^[ \t]*$/;

/** Split a table row into cells (marked's splitCells behaviour). */
function splitCells(row, count) {
  const spaced = row.replace(/\|/g, (m, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ------------------------------------------------------- inline patterns

const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const RE_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const RE_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const RE_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RE_EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RE_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const RE_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const RE_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_ALNUM = /[\p{L}\p{N}]/u;

// Sticky twins of the hot inline patterns: matching at an index directly
// avoids slicing the source for every token attempt.
const RE_ESCAPE_S = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const RE_BR_S = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const RE_TAG_S = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const RE_AUTOLINK_S = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const RE_CODE_SPAN_S = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const RE_EM_LDELIM_S = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;
const RE_DEL_LDELIM_S = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;

// -------------------------------------------------------- block patterns

/** Tag names that open an HTML block (CommonMark list, as marked uses it). */
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const RE_DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const RE_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_BLOCK_HR_S = / {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/y;
const RE_NONSPACE = /[^ \n\t]/;

/** The line starting at index i (without its trailing newline). */
function lineAt(s, i) {
  const e = s.indexOf('\n', i);
  return e === -1 ? s.slice(i) : s.slice(i, e);
}

/** Whether any list begin-pattern could match this line (first-char gate). */
function beginPossible(line, back) {
  for (let p = 0; p < line.length && p <= back; p++) {
    const ch = line[p];
    if (ch === ' ') continue;
    return ch === '`' || ch === '~' || ch === '#' || ch === '>' || ch === '<' ||
      ch === '*' || ch === '+' || ch === '-' || ch === '_' || (ch >= '0' && ch <= '9');
  }
  return false;
}
const RE_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_TASK_BOX = /\[[ xX]\]/;

// -------------------------------------------------- emphasis pre-masking
// Before emphasis matching, marked works on a masked copy of the source:
// reference-link text collapses to a's (so emphasis cannot pair across a
// link boundary), backslash-escaped punctuation becomes '+', and inline
// links, code spans and tags are blanked to [aaa...] so the delimiters
// inside them are invisible. Masking is length-preserving.

function linkInText(ctx, e) {
  if (!e.includes('[')) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  for (const n of e.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  for (const n of e.matchAll(RE_REFLINK_SEARCH)) {
    const s = n[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))) {
      return true;
    }
  }
  return false;
}

function maskRef(ctx, r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(ctx, inner)) {
      return '[' + inner.replace(RE_REFLINK_SEARCH, (m) => maskRef(ctx, m)) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

function maskText(ctx, src) {
  let t = src;
  // Each step is the identity when its trigger characters are absent (and
  // the reference step is the identity when no definitions exist).
  if (t.includes('[') && ctx.hasLinks) {
    t = t.replace(RE_REFLINK_SEARCH, (m) => maskRef(ctx, m));
  }
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (m, g1, g2) =>
      g2 ? '+'.repeat(m.length)
         : g1 ? g1 + m.slice(g1.length, m.length - g1.length).replace(/`/g, '+') + g1
         : m);
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(RE_BLOCK_SKIP, (m, g1, g2) => {
      const o = g2 ? g2.length : 0;
      return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
    });
  }
  return t;
}

/** Last index at which a closer run for each delimiter char can start. */
function maskInfo(masked) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else last[ch] = s;
    }
    s = i - 1;
  }
  return { last, lastDel };
}

// ------------------------------------------------------------ link output

/**
 * Render a link or image token (marked's outputLink + renderer): the label
 * is parsed recursively with inLink set; if a nested link was emitted
 * inside a non-image link, the outer link fails and null is returned.
 */
function outputLink(ctx, labelSource, raw, href, title, textMode) {
  const isImage = raw.charAt(0) === '!';
  const label = labelSource.replace(/\\([\[\]])/g, '$1');
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = inlineParse(ctx, label, isImage ? true : textMode);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  if (textMode) return { html: inner, len: raw.length };
  const cleaned = cleanUrl(href);
  if (isImage) {
    if (cleaned === null) return { html: escapeHtml(inner, false), len: raw.length };
    let out = '<img src="' + escapeHtml(cleaned, false) + '" alt="' + escapeHtml(inner, false) + '"';
    if (title) out += ' title="' + escapeHtml(title, false) + '"';
    return { html: out + '>', len: raw.length };
  }
  if (cleaned === null) return { html: inner, len: raw.length };
  let out = '<a href="' + escapeHtml(cleaned, false) + '"';
  if (title) out += ' title="' + escapeHtml(title, false) + '"';
  return { html: out + '>' + inner + '</a>', len: raw.length };
}

/** Parse inline markup; linkParenPossible is scoped per call, as marked. */
function inlineParse(ctx, src, textMode) {
  const saved = ctx.linkParenPossible;
  ctx.linkParenPossible = saved && src.includes(')');
  const out = scanInline(ctx, src, textMode);
  ctx.linkParenPossible = saved;
  return out;
}

// --------------------------------------------------------- text scanning
// marked's inline text pattern consumes a run of plain text up to the
// next construct. The run boundaries matter (they decide where autolinks
// are attempted and what the previous character is for emphasis), so this
// scanner reproduces them exactly.

const EMAIL_CHARS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-");

function isAlnumAscii(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

/** At j: an email-shaped run (local-part chars) followed by '@'. */
function emailAhead(src, j) {
  let k = j;
  while (k < src.length && EMAIL_CHARS.has(src[k])) k++;
  return k > j && src[k] === '@';
}

/** At j: at least two spaces followed by a newline. */
function hardBreakAhead(src, j) {
  let k = j;
  while (src[k] === ' ') k++;
  return k - j >= 2 && src[k] === '\n';
}

const RE_TEXT_STOP = /[\\<!\[`*~_]/g;
const RE_TEXT_PROTO = /[hH][tT][tT][pP]|[fF][tT][pP]:\/\/|www\./g;
const RE_TEXT_SPACES = / {2,}\n/g;

/** End index (exclusive) of the plain-text token starting at pos. */
function textRun(src, pos) {
  const n = src.length;
  const c0 = src[pos];
  // A lone non-alphanumeric char right before mailto:/xmpp: is its own token.
  if (!isAlnumAscii(c0) && (src.startsWith('mailto:', pos + 1) || src.startsWith('xmpp:', pos + 1))) {
    return pos + 1;
  }
  let end = pos + 1;
  if (c0 === '`' || c0 === '~') {
    while (end < n && src[end] === c0) end++;
  }
  if (end >= n) return end;
  // Terminators that apply immediately after the first unit.
  const nc = src[end];
  if (nc === '`' || nc === '~') return end;
  if (nc === ' ' && hardBreakAhead(src, end)) return end;
  if (emailAhead(src, end)) return end;
  // First lookahead stop at or after end: a special char, or a protocol /
  // www prefix (checked with a regex scan instead of per-char tests).
  let stop = n;
  RE_TEXT_STOP.lastIndex = end;
  const sm = RE_TEXT_STOP.exec(src);
  if (sm) stop = sm.index;
  // Searches below only matter before `stop`, so they run on the bounded
  // slice up to it instead of scanning the rest of the document.
  const ahead = src.slice(end, stop);
  RE_TEXT_PROTO.lastIndex = 0;
  let pm;
  while ((pm = RE_TEXT_PROTO.exec(ahead)) !== null) {
    if (pm[0] === 'www.') {
      const prev = src[end + pm.index - 1];
      if (!(prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' ||
            prev === '\v' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
        continue;
      }
    }
    stop = end + pm.index;
    break;
  }
  // First consuming terminator: the run ends just after the char before
  // a hard break, a mailto:/xmpp: scheme, or an email-shaped run.
  let consume = Infinity;
  const aheadNl = src.slice(end, stop + 1);
  RE_TEXT_SPACES.lastIndex = 0;
  let hm;
  while ((hm = RE_TEXT_SPACES.exec(aheadNl)) !== null) {
    const idx = end + hm.index;
    if (idx - 1 >= end) { consume = idx; break; }
  }
  const aheadScheme = src.slice(end + 1, stop + 7);
  for (const scheme of ['mailto:', 'xmpp:']) {
    let from = 0;
    for (;;) {
      const p = aheadScheme.indexOf(scheme, from);
      if (p === -1) break;
      const abs = end + 1 + p;
      if (abs >= stop) break;
      if (!isAlnumAscii(src[abs - 1])) { consume = Math.min(consume, abs); break; }
      from = p + 1;
    }
  }
  let atFrom = end + 1;
  for (;;) {
    const at = src.indexOf('@', atFrom);
    if (at === -1) break;
    let s = at;
    while (s > 0 && EMAIL_CHARS.has(src[s - 1])) s--;
    if (s < at && s - 1 >= end) { consume = Math.min(consume, s); break; }
    atFrom = at + 1;
  }
  return Math.min(stop, consume);
}

// ------------------------------------------------------ autolinks / urls

function renderAutoLinkToken(text, href, textMode) {
  if (textMode) return text;
  const cleaned = cleanUrl(href);
  const content = escapeHtml(text, true);
  if (cleaned === null) return content;
  return '<a href="' + escapeHtml(cleaned, true) + '">' + content + '</a>';
}

function tryUrl(ctx, src, pos, textMode) {
  const m = RE_URL.exec(src.slice(pos));
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + m[0];
  } else {
    let cur = m[0];
    let prev;
    do {
      prev = cur;
      cur = RE_BACKPEDAL.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { html: renderAutoLinkToken(text, href, textMode), len: text.length };
}

// ------------------------------------------------------------- links

/** marked's checkParentForLink: a tag/autolink spilling past the label. */
function labelHasTagCrossing(fullSrc, label, labelOffset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = RE_CODE_SPAN.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = fullSrc.slice(labelOffset + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

function tryLink(ctx, src, pos, textMode) {
  if (ctx.linkParenPossible === false) return null;
  const rest = src.slice(pos);
  const m = RE_LINK.exec(rest);
  if (!m) return null;
  const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTagCrossing(rest, m[1], labelOffset)) return null;
  const href = m[2].trim();
  if (href.startsWith('<')) {
    if (!href.endsWith('>')) return null;
    const inner = trimEndChar(href.slice(0, -1), '\\');
    if ((href.length - inner.length) % 2 === 0) return null;
  } else {
    const bal = bracketBalance(m[2], '(', ')');
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const trimmedEnd = trimEndChar(m[0].slice(0, -1), '\\');
  if ((m[0].length - trimmedEnd.length) % 2 === 0) return null;
  let hrefOut = m[2].trim();
  if (hrefOut.startsWith('<')) hrefOut = hrefOut.slice(1, -1);
  const titleOut = m[3] ? m[3].slice(1, -1) : '';
  return outputLink(ctx, m[1], m[0],
    hrefOut.replace(ANY_PUNCT_ESCAPED, '$1'),
    titleOut.replace(ANY_PUNCT_ESCAPED, '$1'), textMode);
}

function tryReflink(ctx, src, pos, textMode) {
  const rest = src.slice(pos);
  const m = RE_REFLINK.exec(rest) || RE_NOLINK.exec(rest);
  if (!m) return null;
  const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTagCrossing(rest, m[1], labelOffset)) return null;
  const def = ctx.links[normLabel(m[2] || m[1])];
  if (!def) return 'text';
  return outputLink(ctx, m[1], m[0], def.href, def.title, textMode);
}

// ------------------------------------------------- emphasis / strikethrough

function tryEmStrong(ctx, src, pos, masked, info, prevChar, textMode) {
  RE_EM_LDELIM_S.lastIndex = pos;
  const m = RE_EM_LDELIM_S.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const rest = src.slice(pos);
  const delim = m[0][0];
  const sameBefore = prevChar === delim;
  let l = pos;
  while (l > 0 && masked[l - 1] === delim) l--;
  const beforeRun = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!RE_PUNCT.exec(beforeRun);
  let pc = prevChar;
  if (l < pos) pc = beforeRun;
  const pcIsPunct = l < pos ? beforeIsPunct : !!RE_PUNCT.exec(pc);
  if (m[4] && RE_ALNUM.test(pc)) return null;
  const punctAfter = m[1] || m[3] || '';
  if (punctAfter && pc && !pcIsPunct) return null;
  const k = [...m[0]].length - 1;
  let mid = k;
  let skipped = 0;
  const span = pos - l + k;
  const canClose = !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
  const lastIdx = info.last[delim];
  const q = pos + k;
  if (lastIdx < q) return null;
  const t2 = masked.slice(q);
  const limit = lastIdx - q;
  const re = delim === '*' ? RE_EM_RDELIM_AST : RE_EM_RDELIM_UND;
  re.lastIndex = 0;
  let s;
  while ((s = re.exec(t2)) !== null && !(s.index > limit)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let b = [...g].length;
    if (s[3] || s[4]) { mid += b; continue; }
    if (s[5] || s[6] || canClose) {
      if (sameBefore && (s[5] || s[6])) break;
      if (span % 3 && !((span + b) % 3)) { skipped += b; continue; }
    }
    mid -= b;
    if (mid > 0) continue;
    b = Math.min(b, b + mid + skipped);
    const firstLen = [...s[0]][0].length;
    const rawFull = rest.slice(0, k + s.index + firstLen + b);
    const innerText = Math.min(k, b) % 2 ? rawFull.slice(1, -1) : rawFull.slice(2, -2);
    const inner = inlineParse(ctx, innerText, textMode);
    const tag = Math.min(k, b) % 2 ? 'em' : 'strong';
    return { html: textMode ? inner : '<' + tag + '>' + inner + '</' + tag + '>', len: rawFull.length };
  }
  return null;
}

function tryDel(ctx, src, pos, masked, info, prevChar, textMode) {
  RE_DEL_LDELIM_S.lastIndex = pos;
  const m = RE_DEL_LDELIM_S.exec(src);
  if (!m) return null;
  const rest = src.slice(pos);
  if ((m[1] || '') && prevChar && !RE_PUNCT.exec(prevChar)) return null;
  const o = [...m[0]].length - 1;
  let mid = o;
  const d = pos + o;
  if (info.lastDel < d) return null;
  const t2 = masked.slice(d);
  const limit = info.lastDel - d;
  const re = RE_DEL_RDELIM;
  re.lastIndex = 0;
  let s;
  while ((s = re.exec(t2)) !== null && !(s.index > limit)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const gl = [...g].length;
    if (gl !== o) continue;
    if (s[3] || s[4]) { mid += gl; continue; }
    mid -= gl;
    if (mid > 0) continue;
    const use = Math.min(gl, gl + mid);
    const firstLen = [...s[0]][0].length;
    const rawFull = rest.slice(0, o + s.index + firstLen + use);
    const inner = inlineParse(ctx, rawFull.slice(o, rawFull.length - o), textMode);
    return { html: textMode ? inner : '<del>' + inner + '</del>', len: rawFull.length };
  }
  return null;
}

// -------------------------------------------------------- inline scanner

function scanInline(ctx, src, textMode) {
  // The emphasis mask is built lazily: many runs never attempt emphasis
  // (the delimiters sit inside code spans, links or plain words).
  let masked = null;
  let info = null;
  const ensureMask = () => {
    if (masked === null) {
      masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskText(ctx, src) : src;
      info = maskInfo(masked);
    }
  };
  const out = [];
  let textBuf = '';
  let prevChar = '';
  let prevWasText = false;
  const flushText = () => {
    if (textBuf === '') return;
    const raw = textBuf;
    textBuf = '';
    if (ctx.inRawBlock) out.push(raw);
    else if (textMode) out.push(decodeRefs(raw));
    else out.push(escapeHtml(decodeRefs(raw), false));
  };
  const emit = (html) => { flushText(); out.push(html); prevWasText = false; };

  let pos = 0;
  const n = src.length;
  while (pos < n) {
    const pc = prevWasText ? prevChar : '';
    const c = src[pos];
    if (c === '\\') {
      RE_ESCAPE_S.lastIndex = pos;
      const m = RE_ESCAPE_S.exec(src);
      if (m) { emit(textMode ? m[1] : escapeHtml(m[1], false)); pos += m[0].length; continue; }
      RE_BR_S.lastIndex = pos;
      const b = RE_BR_S.exec(src);
      if (b) { emit(textMode ? '' : '<br>'); pos += b[0].length; continue; }
    } else if (c === '<') {
      RE_TAG_S.lastIndex = pos;
      const m = RE_TAG_S.exec(src);
      if (m) {
        flushText();
        if (!ctx.inLink && RE_START_A_TAG.test(m[0])) ctx.inLink = true;
        else if (ctx.inLink && RE_END_A_TAG.test(m[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && RE_START_PRE_TAG.test(m[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && RE_END_PRE_TAG.test(m[0])) ctx.inRawBlock = false;
        out.push(m[0]);
        prevWasText = false;
        pos += m[0].length;
        continue;
      }
      RE_AUTOLINK_S.lastIndex = pos;
      const a = RE_AUTOLINK_S.exec(src);
      if (a) {
        const href = a[2] === '@' ? 'mailto:' + a[1] : a[1];
        emit(renderAutoLinkToken(a[1], href, textMode));
        pos += a[0].length;
        continue;
      }
    } else if (c === '[' || c === '!') {
      flushText();
      let tok = tryLink(ctx, src, pos, textMode);
      if (!tok) {
        const r = tryReflink(ctx, src, pos, textMode);
        if (r === 'text') {
          textBuf += c;
          pos += 1;
          prevWasText = false;
          continue;
        }
        tok = r;
      }
      if (tok) { emit(tok.html); pos += tok.len; continue; }
    } else if (c === '*' || c === '_') {
      flushText();
      ensureMask();
      const tok = tryEmStrong(ctx, src, pos, masked, info, pc, textMode);
      if (tok) { emit(tok.html); pos += tok.len; continue; }
      // An email autolink may start with '_' (its local-part charset).
      if (c === '_' && !ctx.inLink) {
        const u = tryUrl(ctx, src, pos, textMode);
        if (u) { emit(u.html); pos += u.len; continue; }
      }
    } else if (c === '`') {
      RE_CODE_SPAN_S.lastIndex = pos;
      const m = RE_CODE_SPAN_S.exec(src);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) text = text.slice(1, -1);
        emit(textMode ? text : '<code>' + escapeHtml(text, true) + '</code>');
        pos += m[0].length;
        continue;
      }
    } else if (c === '~') {
      flushText();
      ensureMask();
      const tok = tryDel(ctx, src, pos, masked, info, pc, textMode);
      if (tok) { emit(tok.html); pos += tok.len; continue; }
    } else {
      if (c === ' ') {
        RE_BR_S.lastIndex = pos;
        const b = RE_BR_S.exec(src);
        if (b) { emit(textMode ? '' : '<br>'); pos += b[0].length; continue; }
      }
      if (!ctx.inLink && (isAlnumAscii(c) || c === '.' || c === '_' || c === '+' || c === '-')) {
        const u = tryUrl(ctx, src, pos, textMode);
        if (u) { emit(u.html); pos += u.len; continue; }
      }
    }
    const runEnd = textRun(src, pos);
    textBuf += src.slice(pos, runEnd);
    if (src[runEnd - 1] !== '_') prevChar = src[runEnd - 1];
    prevWasText = true;
    pos = runEnd;
  }
  flushText();
  return out.join('');
}

// -------------------------------------------------------- block patterns

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_BLOCK_HTML = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const RE_BLOCKQUOTE = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const RE_QUOTE_START = /^ {0,3}>/;
const RE_QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;
const RE_LHEADING = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const RE_PARAGRAPH = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const RE_TABLE = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;

// --------------------------------------------------------- block parsing
// Block tokenising queues inline jobs in creation order; the jobs are
// rendered only after the whole document is blocked out, so link
// definitions are visible to every paragraph (marked's inlineQueue).

function pushJob(ctx, src) {
  const job = { src, html: '' };
  ctx.jobs.push(job);
  return job;
}

const regexCache = new Map();

/** Memoised RegExp construction (list patterns repeat a lot). */
function cachedRegex(key, build) {
  let re = regexCache.get(key);
  if (re === undefined) {
    re = build();
    regexCache.set(key, re);
  }
  return re;
}

/** Whether s ends with a blank line (marked's doubleBlankLine test). */
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

function tokSpace(rest) {
  const m = RE_NEWLINE.exec(rest);
  return m && m[0].length > 0 ? { type: 'space', raw: m[0] } : null;
}

function tokCode(rest) {
  const m = RE_BLOCK_CODE.exec(rest);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { type: 'code', raw, lang: undefined, text: raw.replace(RE_CODE_REMOVE_INDENT, '') };
}

/** Fence content with the opening line's indent compensation applied. */
function fenceText(raw, content) {
  const n = /^(\s+)(?:```)/.exec(raw);
  if (!n) return content;
  const comp = n[1].length;
  return content.split('\n').map((line) => {
    const o = /^\s+/.exec(line);
    return o ? line.slice(Math.min(o[0].length, comp)) : line;
  }).join('\n');
}

function tokFences(rest) {
  const m = RE_FENCES.exec(rest);
  if (!m) return null;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(ANY_PUNCT_ESCAPED, '$1') : m[2],
    text: fenceText(m[0], m[3] || ''),
  };
}

function tokHeading(ctx, rest) {
  const m = RE_HEADING.exec(rest);
  if (!m) return null;
  let text = m[2].trim();
  if (text.endsWith('#')) {
    const s = trimEndChar(text, '#');
    if (s === '' || /[ \t]$/.test(s)) text = s.trim();
  }
  const token = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[1].length, text };
  token.job = pushJob(ctx, text);
  return token;
}

function tokHr(rest) {
  const m = RE_BLOCK_HR.exec(rest);
  return m ? { type: 'hr', raw: trimEndChar(m[0], '\n') } : null;
}

function tokHtml(rest) {
  const m = RE_BLOCK_HTML.exec(rest);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { type: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}

function tokDef(rest) {
  const m = RE_DEF.exec(rest);
  if (!m) return null;
  if (!m[2].startsWith('<') && bracketBalance(m[2], '(', ')') !== -1) return null;
  return {
    type: 'def',
    raw: trimEndChar(m[0], '\n'),
    tag: normLabel(m[1]),
    href: m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT_ESCAPED, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_ESCAPED, '$1') : undefined,
  };
}

const RE_SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;

function tokLheading(ctx, rest) {
  // Cheap pre-filter: a setext heading needs an underline line before the
  // next blank line (the heading body cannot cross a blank line).
  let pos = rest.indexOf('\n');
  if (pos === -1) return null;
  let found = false;
  while (pos !== -1) {
    const start = pos + 1;
    const end = rest.indexOf('\n', start);
    const line = end === -1 ? rest.slice(start) : rest.slice(start, end);
    if (BLANK_LINE.test(line)) break;
    if (RE_SETEXT_LINE.test(line)) { found = true; break; }
    pos = end;
  }
  if (!found) return null;
  const m = RE_LHEADING.exec(rest);
  if (!m) return null;
  const text = m[1].trim();
  const token = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text };
  token.job = pushJob(ctx, text);
  return token;
}

function tokParagraph(ctx, rest) {
  const m = RE_PARAGRAPH.exec(rest);
  if (!m) return null;
  let text = m[1];
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const token = { type: 'paragraph', raw: m[0], text };
  token.job = pushJob(ctx, text);
  return token;
}

function tokText(ctx, rest) {
  const nl = rest.indexOf('\n');
  const raw = nl === -1 ? rest : rest.slice(0, nl);
  if (!raw) return null;
  const token = { type: 'text', raw, text: raw };
  token.job = pushJob(ctx, raw);
  return token;
}

const RE_TABLE_DELIM_LINE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function tokTable(ctx, rest) {
  // Cheap pre-filter: a table needs a delimiter line as its second line.
  const nl = rest.indexOf('\n');
  if (nl === -1) return null;
  const line2End = rest.indexOf('\n', nl + 1);
  const line2 = line2End === -1 ? rest.slice(nl + 1) : rest.slice(nl + 1, line2End);
  if (!RE_TABLE_DELIM_LINE.test(line2) || !/[:|]/.test(line2)) return null;
  const m = RE_TABLE.exec(rest);
  if (!m || !/[:|]/.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const alignParts = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = alignParts.map((part) =>
    /^ *-+: *$/.test(part) ? 'right' : /^ *:-+: *$/.test(part) ? 'center' : /^ *:-+ *$/.test(part) ? 'left' : null);
  const token = { type: 'table', raw: trimEndChar(m[0], '\n'), header: [], align, rows: [] };
  for (let i = 0; i < headerCells.length; i++) {
    const cell = { text: headerCells[i], header: true, align: align[i] };
    cell.job = pushJob(ctx, cell.text);
    token.header.push(cell);
  }
  const rowLines = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  for (const rowText of rowLines) {
    token.rows.push(splitCells(rowText, headerCells.length).map((text, p) => {
      const cell = { text, header: false, align: align[p] };
      cell.job = pushJob(ctx, text);
      return cell;
    }));
  }
  return token;
}

const M_SPACE = 1, M_CODE = 2, M_FENCES = 4, M_HEADING = 8, M_HR = 16,
  M_QUOTE = 32, M_LIST = 64, M_HTML = 128, M_DEF = 256, M_ALL = 511;

/** Which block tokenisers can possibly match when rest starts with c0. */
function dispatchMask(c0) {
  switch (c0) {
    case 35: return M_HEADING;                    // #
    case 96: case 126: return M_FENCES;           // ` ~
    case 62: return M_QUOTE;                      // >
    case 60: return M_HTML;                       // <
    case 91: return M_DEF;                         // [
    case 42: case 43: case 45: return M_HR | M_LIST; // * + -
    case 95: return M_HR;                          // _
    default:
      return c0 >= 48 && c0 <= 57 ? M_LIST : 0;    // digits
  }
}

function blockTokens(ctx, src, tokens, lastBlock) {
  let canMergePara = lastBlock;
  let rest = src;
  while (rest) {
    let tok;
    const c0 = rest.charCodeAt(0);
    if (c0 === 10) {
      // A blank line: only the space tokeniser can match.
      tok = tokSpace(rest);
      if (!tok) break;
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    const mask = c0 === 32 || c0 === 9 ? M_ALL : dispatchMask(c0);
    if ((mask & M_SPACE) !== 0 && (tok = tokSpace(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((mask & M_CODE) !== 0 && (tok = tokCode(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        prev.job.src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((mask & M_FENCES) !== 0 && (tok = tokFences(rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_HEADING) !== 0 && (tok = tokHeading(ctx, rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_HR) !== 0 && (tok = tokHr(rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_QUOTE) !== 0 && (tok = tokBlockquote(ctx, rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_LIST) !== 0 && (tok = tokList(ctx, rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_HTML) !== 0 && (tok = tokHtml(rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((mask & M_DEF) !== 0 && (tok = tokDef(rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        prev.job.src = prev.text;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) {
          ctx.links[tok.tag] = { href: tok.href, title: tok.title };
          ctx.hasLinks = true;
        }
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(ctx, rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokLheading(ctx, rest))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if (ctx.top && (tok = tokParagraph(ctx, rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (canMergePara && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.jobs.pop();
        prev.job.src = prev.text;
      } else tokens.push(tok);
      canMergePara = false;
      continue;
    }
    if ((tok = tokText(ctx, rest))) {
      rest = rest.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.jobs.pop();
        prev.job.src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    break;
  }
  ctx.top = true;
  return tokens;
}

function tokBlockquote(ctx, rest) {
  const m = RE_BLOCKQUOTE.exec(rest);
  if (!m) return null;
  let lines = trimEndChar(m[0], '\n').split('\n');
  let rawAcc = '';
  let textAcc = '';
  const tokens = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE_QUOTE_START.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(RE_QUOTE_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE_QUOTE_SETEXT, '\n    $1')
      .replace(RE_QUOTE_STRIP, '');
    rawAcc = rawAcc ? rawAcc + '\n' + h : h;
    textAcc = textAcc ? textAcc + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(ctx, u, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const b = lines.join('\n');
      const mergedSrc = last.raw + '\n' + b.replace(RE_QUOTE_STRIP, '');
      const f = tokBlockquote(ctx, mergedSrc);
      tokens[tokens.length - 1] = f;
      const y = mergedSrc.slice(f.raw.length).replace(/^\n/, '');
      const leftover = y ? y.split('\n').length : 0;
      const consumed = leftover ? lines.slice(0, -leftover) : lines;
      if (consumed.length > 0) rawAcc += '\n' + consumed.join('\n');
      textAcc = textAcc.slice(0, textAcc.length - last.text.length) + f.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE_QUOTE_START.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const b = last.raw + '\n' + lines.join('\n');
      const mergedList = tokList(ctx, b);
      tokens[tokens.length - 1] = mergedList;
      const extra = mergedList.raw.length > last.raw.length
        ? b.slice(last.raw.length + 1, mergedList.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        rawAcc += '\n' + y;
        textAcc += '\n' + y;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAcc, text: textAcc, tokens };
}

const LIST_TAG_ALT = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

function tokList(ctx, rest) {
  const gate = RE_LIST_START.exec(rest);
  if (!gate) return null;
  const bullet = gate[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false, items: [],
  };
  const bulletPat = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = cachedRegex('item:' + bulletPat,
    () => new RegExp('( {0,3}' + bulletPat + ')((?:[ \\t][^\\n]*)?(?:\\n|$))', 'y'));
  let off = 0;
  const consumed = () => off;
  let prevDoubleBlank = false;

  while (off < rest.length) {
    itemRe.lastIndex = off;
    const m = itemRe.exec(rest);
    RE_BLOCK_HR_S.lastIndex = off;
    if (!m || RE_BLOCK_HR_S.test(rest)) break;
    const itemStart = consumed();
    off += m[0].length;
    const bulletLen = m[1].length;
    const firstLine = m[2].split('\n', 1)[0];
    let curLine = firstLine.includes('\t') ? firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletLen)) : firstLine;
    let nextLine = lineAt(rest, off);
    let prevBlank = !curLine.trim();
    let indent = 0;
    let itemText = '';
    if (prevBlank) {
      indent = bulletLen + 1;
    } else {
      indent = curLine.search(/[^ \n\t]/);
      if (indent > 4) indent = 1;
      itemText = curLine.slice(indent);
      indent += bulletLen;
    }
    let itemDone = false;
    if (prevBlank && BLANK_LINE.test(nextLine)) {
      off += nextLine.length + 1;
      itemDone = true;
    }
    if (!itemDone) {
      const back = Math.max(0, Math.min(3, indent - 1));
      const nextBulletRe = cachedRegex('nb:' + back,
        () => new RegExp('^ {0,' + back + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
      const hrRe = cachedRegex('hr:' + back,
        () => new RegExp('^ {0,' + back + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
      const fencesRe = cachedRegex('fe:' + back,
        () => new RegExp('^ {0,' + back + '}(?:```|~~~)'));
      const headingRe = cachedRegex('he:' + back,
        () => new RegExp('^ {0,' + back + '}#{1,6}(?:\\s|$)'));
      const htmlRe = cachedRegex('ht:' + back,
        () => new RegExp('^ {0,' + back + '}(?:</?(?:' + LIST_TAG_ALT + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
      const quoteRe = cachedRegex('qu:' + back,
        () => new RegExp('^ {0,' + back + '}>'));
      while (off < rest.length) {
        const line = lineAt(rest, off);
        nextLine = line;
        const expanded = line.includes('\t') ? line.replace(/^[ \t]+/, (ws) => expandTabs(ws, 0)) : line;
        if (beginPossible(line, back) &&
            (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBulletRe.test(line) || hrRe.test(line))) break;
        if (expanded.search(RE_NONSPACE) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (prevBlank || curLine.replace(/\t/g, '    ').search(RE_NONSPACE) >= 4 ||
              (beginPossible(curLine, back) &&
               (fencesRe.test(curLine) || headingRe.test(curLine) || htmlRe.test(curLine) || hrRe.test(curLine)))) break;
          const hack = /^ {0,3}(?:=+|-+) *$/.test(line) && RE_LHEADING.test(curLine + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '') : line;
          itemText += '\n' + hack;
        }
        prevBlank = !line.trim();
        off += line.length + 1;
        curLine = expanded.slice(indent);
      }
    }
    const itemRaw = rest.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevDoubleBlank) list.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) prevDoubleBlank = true;
    }
    list.items.push({
      type: 'list_item', raw: itemRaw, task: RE_TASK.test(itemText),
      loose: false, text: itemText, tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = rest.slice(0, consumed()).trimEnd();

  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => /\n.*\n/.test(t.raw))) list.loose = true;
    }
  }

  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(RE_TASK_STRIP, '');
      first.raw = first.raw.replace(RE_TASK_STRIP, '');
      first.text = first.text.replace(RE_TASK_STRIP, '');
      for (let g = ctx.jobs.length - 1; g >= 0; g--) {
        if (RE_TASK.test(ctx.jobs[g].src)) {
          ctx.jobs[g].src = ctx.jobs[g].src.replace(RE_TASK_STRIP, '');
          break;
        }
      }
      const box = RE_TASK_BOX.exec(item.raw);
      if (box) {
        const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          first.raw = checkbox.raw + first.raw;
          first.text = checkbox.raw + first.text;
          first.checkboxPrefix = checkbox;
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// ------------------------------------------------------------- rendering

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function tableCellHtml(cell) {
  const tag = cell.header ? 'th' : 'td';
  return '<' + tag + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + cell.job.html + '</' + tag + '>\n';
}

function renderToken(ctx, t) {
  switch (t.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const body = t.text ? escapeHtml(t.text.replace(/\n$/, '') + '\n', true) : '';
      const word = t.lang ? /^\S*/.exec(t.lang)[0] : '';
      return word
        ? '<pre><code class="language-' + escapeHtml(word, false) + '">' + body + '</code></pre>\n'
        : '<pre><code>' + body + '</code></pre>\n';
    }
    case 'heading':
      return '<h' + t.depth + '>' + t.job.html + '</h' + t.depth + '>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(ctx, t.tokens) + '</blockquote>\n';
    case 'list': {
      const tag = t.ordered ? 'ol' : 'ul';
      const startAttr = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
      let inner = '';
      for (const item of t.items) inner += '<li>' + renderTokens(ctx, item.tokens) + '</li>\n';
      return '<' + tag + startAttr + '>\n' + inner + '</' + tag + '>\n';
    }
    case 'checkbox':
      return checkboxHtml(t.checked);
    case 'html':
      return t.text;
    case 'paragraph':
      return '<p>' + (t.checkboxPrefix ? checkboxHtml(t.checkboxPrefix.checked) : '') + t.job.html + '</p>\n';
    case 'text':
      return (t.checkboxPrefix ? checkboxHtml(t.checkboxPrefix.checked) : '') + t.job.html;
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (const cell of t.header) out += tableCellHtml(cell);
      out += '</tr>\n</thead>\n';
      if (t.rows.length > 0) {
        out += '<tbody>';
        for (const row of t.rows) {
          out += '<tr>\n';
          for (const cell of row) out += tableCellHtml(cell);
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderTokens(ctx, tokens) {
  let out = '';
  for (const t of tokens) out += renderToken(ctx, t);
  return out;
}

// ------------------------------------------------------------------ parse

/** Anything that could make inline parsing differ from plain text. */
const RE_INLINE_TRIGGER = /[*_~`\\<!\[@]| {2,}\n|[hH][tT][tT][pP]|[fF][tT][pP]:|www\.|mailto:|xmpp:/;

export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    jobs: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(ctx, src, [], false);
  for (let i = 0; i < ctx.jobs.length; i++) {
    ctx.inRawBlock = false;
    const job = ctx.jobs[i];
    // Jobs without any inline trigger render as one escaped text run.
    job.html = RE_INLINE_TRIGGER.test(job.src)
      ? inlineParse(ctx, job.src, false)
      : escapeHtml(decodeRefs(job.src), false);
  }
  return renderTokens(ctx, tokens);
}
