// Needle round 3 — a from-scratch Markdown renderer whose parse() returns
// byte-for-byte the HTML that marked 18.1.3 (default options: gfm true,
// breaks false, pedantic false) produces, written as a hand-rolled scanner
// instead of a regex cascade so the common README-shaped documents render
// in a fraction of the time.
//
// Layout of this file:
//   1. small string helpers (escaping, character classes)
//   2. HTML entity decoding (named references + numeric references)
//   3. block parsing: a line scanner driving a stack of open containers
//   4. inline parsing: an event-scan over the text with a delimiter stack
//   5. rendering: tokens -> the exact HTML strings the reference emits
//
// Nothing is cached between parse() calls: every call re-parses its input
// from scratch, so results never depend on earlier calls.

// ---------------------------------------------------------------- helpers

const ESCAPABLE = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']);

function isAsciiPunct(cp) {
  return (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e);
}

// Whitespace as the inline grammar sees it (Unicode whitespace, like the
// reference's \s-based tests but resolved through a fast ASCII path first).
function isSpaceCp(cp) {
  if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0xa0) return true;
  if (cp < 0xa0) return false;
  return /\s/.test(String.fromCodePoint(cp));
}

// Unicode punctuation for the flanking rules: ASCII punctuation, else
// the Unicode P (punctuation) and S (symbol) categories.
const PUNCT_US_RE = /[\p{P}\p{S}]/u;
function isPunctCp(cp) {
  if (isAsciiPunct(cp)) return true;
  if (cp < 0xa1) return false;
  return PUNCT_US_RE.test(String.fromCodePoint(cp));
}

// The reference's escaping, shared by text and attribute values: a
// valid numeric character reference (1-7 decimal digits, or 1-6 hex
// digits after #x/#X) is special — in text it is decoded to its
// character (which is then escaped if it needs it), in attribute
// values it passes through verbatim. A named-looking reference
// (&word;) always passes through verbatim, decoded or not. Any other
// '&' becomes &amp;. Code content uses the plain full escape instead.
const ESCAPE_RE =
  /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(\w+));|&|<|>|"|'/g;

function escapeChar(m) {
  switch (m) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return '&#39;';
  }
}

// The character a numeric reference stands for, escaped for output.
function escapeDecodedCp(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    cp = 0xfffd;
  } else if (cp >= 0x80 && cp <= 0x9f) {
    cp = C1_REMAP[cp - 0x80] || cp;
  }
  switch (cp) {
    case 0x26: return '&amp;';
    case 0x3c: return '&lt;';
    case 0x3e: return '&gt;';
    case 0x22: return '&quot;';
    case 0x27: return '&#39;';
    default: return String.fromCodePoint(cp);
  }
}

// The raw character a numeric reference stands for (plain-text views).
function decodeCp(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '�';
  }
  if (cp >= 0x80 && cp <= 0x9f) cp = C1_REMAP[cp - 0x80] || cp;
  return String.fromCodePoint(cp);
}

function escapeWithDecode(s, decode) {
  if (!/[&<>"']/.test(s)) return s;
  ESCAPE_RE.lastIndex = 0;
  return s.replace(ESCAPE_RE, (m, dec, hex, name) => {
    if (name !== undefined) return m; // named-looking: verbatim
    if (dec !== undefined || hex !== undefined) {
      if (!decode) return m; // attribute values keep the reference
      return escapeDecodedCp(
        dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16));
    }
    return escapeChar(m);
  });
}

function escapeHtmlText(s) { return escapeTextRun(s, null); }

function escapeAttr(s) { return escapeWithDecode(s, false); }

// Escape a text run with the reference's armed-entity quirk: within
// one run, decoding a numeric character reference "arms" the
// escaper, and the NEXT named reference whose name contains '_'
// then has its '&' escaped after all (later ones are verbatim
// again). The arm clears at a literal '<' and at the given reset
// offsets (delimiter-run boundaries inside the merged run). With no
// numeric reference present the arm can never be set and the plain
// escaper above applies.
function escapeTextRun(s, resets) {
  if (!/[&<>"']/.test(s)) return s;
  if (!s.includes('&#')) return escapeWithDecode(s, true);
  NUMERIC_REF_RE.lastIndex = 0;
  if (!NUMERIC_REF_RE.test(s)) return escapeWithDecode(s, true);
  let out = '';
  let armed = false;
  let i = 0;
  let r = 0;
  const n = s.length;
  const isDigit = cp => cp >= 0x30 && cp <= 0x39;
  const isHex = cp => isDigit(cp) || (cp >= 0x41 && cp <= 0x46) ||
    (cp >= 0x61 && cp <= 0x66);
  const isWord = cp => isDigit(cp) || (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
  while (i < n) {
    while (resets && r < resets.length && resets[r] <= i) {
      armed = false; r++;
    }
    const c = s[i];
    if (c === '&') {
      if (s[i + 1] === '#') {
        // numeric character reference?
        let j = i + 2;
        let cp = -1;
        let end = -1;
        if (s[j] === 'x' || s[j] === 'X') {
          let k = j + 1;
          while (k < n && k - j <= 6 && isHex(s.charCodeAt(k))) k++;
          if (k > j + 1 && s[k] === ';') {
            cp = parseInt(s.slice(j + 1, k), 16); end = k + 1;
          }
        } else {
          let k = j;
          while (k < n && k - j < 7 && isDigit(s.charCodeAt(k))) k++;
          if (k > j && s[k] === ';') {
            cp = parseInt(s.slice(j, k), 10); end = k + 1;
          }
        }
        if (end !== -1) {
          out += escapeDecodedCp(cp);
          armed = true;
          i = end;
          continue;
        }
      } else {
        // named reference?
        let k = i + 1;
        while (k < n && isWord(s.charCodeAt(k))) k++;
        if (k > i + 1 && s[k] === ';') {
          const name = s.slice(i + 1, k);
          if (armed && name.includes('_')) {
            out += '&amp;' + name + ';';
            armed = false;
          } else {
            out += s.slice(i, k + 1);
          }
          i = k + 1;
          continue;
        }
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<') { out += '&lt;'; armed = false; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const cc = s[j];
      if (cc === '&' || cc === '<' || cc === '>' || cc === '"' ||
          cc === "'") break;
      if (resets && r < resets.length && resets[r] === j) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

const NUMERIC_REF_RE = /&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g;

// Decode only the numeric character references in s (plain-text view
// of a text run; named references stay as written).
function decodeNumericRefs(s) {
  if (!s.includes('&#')) return s;
  NUMERIC_REF_RE.lastIndex = 0;
  return s.replace(NUMERIC_REF_RE, (m, dec, hex) =>
    decodeCp(dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16)));
}

// Code content (spans and blocks): every special character is escaped,
// with no reference pass-through of any kind.
function escapeCodeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&|<|>|"|'/g, escapeChar);
}

// ------------------------------------------------------------- entities
// Named character references, stored as "name:hex" pairs (a second
// codepoint, where the reference expands to two characters, follows a
// dot). Parsed once at module load into NAMED_ENTITIES.
const ENTITY_SPEC_A =
  'quot:22 amp:26 AMP:26 apos:27 lt:3c LT:3c gt:3e GT:3e nbsp:a0 iexcl:a1 ' +
  'cent:a2 pound:a3 curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 copy:a9 COPY:a9 ' +
  'ordf:aa laquo:ab not:ac shy:ad reg:ae REG:ae macr:af deg:b0 plusmn:b1 ' +
  'sup2:b2 sup3:b3 acute:b4 micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ' +
  'ordm:ba raquo:bb frac14:bc frac12:bd frac34:be iquest:bf Agrave:c0 ' +
  'Aacute:c1 Acirc:c2 Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 ' +
  'Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb Igrave:cc Iacute:cd Icirc:ce ' +
  'Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 ' +
  'Ouml:d6 times:d7 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db Uuml:dc ' +
  'Yacute:dd THORN:de szlig:df agrave:e0 aacute:e1 acirc:e2 atilde:e3 ' +
  'auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea ' +
  'euml:eb igrave:ec iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ' +
  'ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6 divide:f7 oslash:f8 ' +
  'ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd thorn:fe yuml:ff ' +
  'Amacr:100 amacr:101 Abreve:102 abreve:103 Aogon:104 aogon:105 ' +
  'Cacute:106 cacute:107 Ccirc:108 ccirc:109 Cdot:10a cdot:10b ' +
  'Ccaron:10c ccaron:10d Dcaron:10e dcaron:10f Dstrok:110 dstrok:111 ' +
  'Emacr:112 emacr:113 Ebreve:114 ebreve:115 Edot:116 edot:117 ' +
  'Eogon:118 eogon:119 Ecaron:11a ecaron:11b Gcirc:11c gcirc:11d ' +
  'Gbreve:11e gbreve:11f Gdot:120 gdot:121 Gcedil:122 gcedil:123 ' +
  'Hcirc:124 hcirc:125 Hstrok:126 hstrok:127 Itilde:128 itilde:129 ' +
  'Imacr:12a imacr:12b Ibreve:12c ibreve:12d Iogon:12e iogon:12f ' +
  'Idot:130 imath:131 IJlig:132 ijlig:133 Jcirc:134 jcirc:135 ' +
  'Kcedil:136 kcedil:137 kgreen:138 Lacute:139 lacute:13a Lcedil:13b ' +
  'lcedil:13c Lcaron:13d lcaron:13e Lmidot:13f lmidot:140 Lstrok:141 ' +
  'lstrok:142 Nacute:143 nacute:144 Ncedil:145 ncedil:146 Ncaron:147 ' +
  'ncaron:148 napos:149 Neng:14a neng:14b Omacr:14c omacr:14d ' +
  'Obreve:14e obreve:14f Odblac:150 odblac:151 OElig:152 oelig:153 ' +
  'Racute:154 racute:155 Rcedil:156 rcedil:157 Rcaron:158 rcaron:159 ' +
  'Sacute:15a sacute:15b Scirc:15c scirc:15d Scedil:15e scedil:15f ' +
  'Scaron:160 scaron:161 Tcedil:162 tcedil:163 Tcaron:164 tcaron:165 ' +
  'Tstrok:166 tstrok:167 Utilde:168 utilde:169 Umacr:16a umacr:16b ' +
  'Ubreve:16c ubreve:16d Uring:16e uring:16f Udblac:170 udblac:171 ' +
  'Uogon:172 uogon:173 Ycirc:174 ycirc:175 Yuml:178 Zacute:179 ' +
  'zacute:17a Zdot:17b zdot:17c Zcaron:17d zcaron:17e longs:17f ' +
  'fnof:192 Circ:2c6 caron:2c7 Breve:2d8 dot:2d9 dblac:2dd ogon:2db ' +
  'tilde:2dc cedilla:2db ensp:2002 emsp:2003 thinsp:2009 zwnj:200c ' +
  'zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018 ' +
  'rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 ' +
  'Dagger:2021 bull:2022 hellip:2026 lsaquo:2039 rsaquo:203a oline:203e ' +
  'frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trademark:2122 ' +
  'TRADE:2122 alefsym:2135 forall:2200 exist:2203 empty:2205 nabla:2207 ' +
  'isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 ' +
  'radic:221a prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 ' +
  'cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248 ' +
  'ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 ' +
  'sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22a5 sdor:22c5 ' +
  'sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b lang:27e8 ' +
  'rang:27e9 loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666 ' +
  'Alpha:391 alpha:3b1 Beta:392 beta:3b2 Gamma:393 gamma:3b3 Delta:394 ' +
  'delta:3b4 Epsilon:395 epsilon:3b5 Zeta:396 zeta:3b6 Eta:397 eta:3b7 ' +
  'Theta:398 theta:3b8 Iota:399 iota:3b9 Kappa:39a kappa:3ba Lambda:39b ' +
  'lambda:3bb Mu:39c mu:3bc Nu:39d nu:3bd Xi:39e xi:3be Omicron:39f ' +
  'omicron:3bf Pi:3a0 pi:3c0 Rho:3a1 rho:3c1 Sigma:3a3 sigma:3c3 ' +
  'Tau:3a4 tau:3c4 Upsilon:3a5 upsilon:3c5 Phi:3a6 phi:3c6 Chi:3a7 ' +
  'chi:3c7 Psi:3a8 psi:3c8 Omega:3a9 omega:3c9 sigmaf:3c2 thetasym:3d1 ' +
  'upsih:3d2 piv:3d6 bull2:2022 prime:2032 Prime:2033';

const NAMED_ENTITIES = (() => {
  const out = {};
  for (const spec of [ENTITY_SPEC_A]) {
    for (const pair of spec.split(' ')) {
      if (!pair) continue;
      const colon = pair.indexOf(':');
      const name = pair.slice(0, colon);
      const codes = pair.slice(colon + 1).split('.');
      out[name] = String.fromCodePoint(...codes.map(h => parseInt(h, 16)));
    }
  }
  return out;
})();

// Decode one entity body (the text between & and ;) to its string, or
// return null when it is not a valid reference.
function decodeEntityBody(body) {
  if (body.charCodeAt(0) === 0x23) { // '#'
    let cp;
    if (body.length > 1 && (body[1] === 'x' || body[1] === 'X')) {
      if (!/^[0-9a-fA-F]+$/.test(body.slice(1))) return null;
      cp = parseInt(body.slice(2), 16);
    } else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      cp = parseInt(body.slice(1), 10);
    }
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    if (cp >= 0x80 && cp <= 0x9f) cp = C1_REMAP[cp - 0x80] || cp;
    return String.fromCodePoint(cp);
  }
  const v = NAMED_ENTITIES[body];
  return v === undefined ? null : v;
}

// Windows-1252 replacements for numeric references in the C1 range.
const C1_REMAP = {
  0: 0x20ac, 2: 0x201a, 3: 0x0192, 4: 0x201e, 5: 0x2026, 6: 0x2020,
  7: 0x2021, 8: 0x02c6, 9: 0x2030, 10: 0x0160, 11: 0x2039, 12: 0x0152,
  14: 0x017d, 17: 0x2018, 18: 0x2019, 19: 0x201c, 20: 0x201d, 21: 0x2022,
  22: 0x2013, 23: 0x2014, 24: 0x02dc, 25: 0x2122, 26: 0x0161, 27: 0x203a,
  28: 0x0153, 30: 0x017e, 31: 0x0178,
};

// Scan s for a valid entity starting at index i (s[i] === '&'); returns
// { value, end } with end just past the ';', or null.
function matchEntity(s, i) {
  const semi = s.indexOf(';', i + 1);
  if (semi === -1 || semi - i > 32) {
    // A handful of legacy names are honoured without a semicolon.
    return matchLegacyEntity(s, i);
  }
  const body = s.slice(i + 1, semi);
  if (body.length === 0) return null;
  const v = decodeEntityBody(body);
  if (v === null) return matchLegacyEntity(s, i);
  return { value: v, end: semi + 1 };
}

const LEGACY_ENTITIES = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"',
  QUOT: '"', apos: undefined, nbsp: ' ', copy: '©', COPY: '©',
  reg: '®', REG: '®', not: '¬', deg: '°', plusmn: '±', sup1: '¹',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  times: '×', divide: '÷', cent: '¢', pound: '£', yen: '¥',
  curren: '¤', sect: '§', para: '¶', middot: '·', cedil: '¸',
  ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»', iexcl: '¡',
  iquest: '¿', micro: 'µ', macr: '¯', acute: '´', uml: '¨',
  shy: '­', brvbar: '¦', AElig: 'Æ', aelig: 'æ', Eacute: 'É',
  eacute: 'é', Aacute: 'Á', aacute: 'á', Ouml: 'Ö', ouml: 'ö',
  Uuml: 'Ü', uuml: 'ü', szlig: 'ß', agrave: 'à', egrave: 'è',
  oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', Ntilde: 'Ñ',
  auml: 'ä', euml: 'ë', iuml: 'ï',
};

function matchLegacyEntity(s, i) {
  // Try the longest legacy name that is a prefix of what follows '&'.
  for (let len = 6; len >= 2; len--) {
    const name = s.substr(i + 1, len);
    const v = LEGACY_ENTITIES[name];
    if (v !== undefined) return { value: v, end: i + 1 + len };
  }
  return null;
}

// ---------------------------------------------------------- block layer
//
// Line-by-line parsing with an explicit stack of open blocks. Container
// blocks (blockquote, list item) re-match their markers on every line;
// leaf blocks (paragraph, fenced/indented code, HTML block, table) sit on
// top of the stack and decide how a line is consumed. Rendering (and with
// it inline parsing) happens afterwards, so link reference definitions
// are all known before any link is resolved — forward references work.

// Does this block's subtree end with an indented code block whose
// trailing blank lines were trimmed at finalize time?
function endsWithTrimmedBlank(b) {
  const ch = b.children;
  if (!ch || ch.length === 0) return false;
  const last = ch[ch.length - 1];
  if (last.type === 'code' && last.indented) return last._trailingBlanks > 0;
  return endsWithTrimmedBlank(last);
}

function mkBlock(type, parent) {
  const b = { type, children: [], parent: parent || null };
  if (parent) {
    // A block resuming in an item that saw a blank line at its own
    // level: if the item already has a block, the blank sat between
    // two of its blocks, which makes the list loose. A preceding
    // indented code block whose trailing blank lines were trimmed
    // counts the same way (the blanks were absorbed as its content
    // instead of passing through the blank-line handler).
    if (parent.type === 'item' &&
        (parent._sawBlank || endsWithTrimmedBlank(parent))) {
      if (parent.children.length > 0) parent._blankBetween = true;
      parent._sawBlank = false;
    }
    // A block landing deeper inside an outer item shows that any
    // blank that item saw was internal to its subtree, not a
    // separator at the item's own level.
    for (let a = parent.parent; a; a = a.parent) {
      if (a.type === 'item') a._sawBlank = false;
    }
    parent.children.push(b);
  }
  return b;
}

// A position inside a line: pos = char index, col = visual column,
// virt = columns still owed by a partially consumed tab.
function newLineState() { return { pos: 0, col: 0, virt: 0 }; }

function tabWidth(col) { return 4 - (col % 4); }

// Columns of whitespace available from st in line (no mutation). A
// partially consumed tab (virt > 0) contributes exactly its remaining
// columns — the tab character itself is then behind us.
function countIndent(line, st) {
  let { pos, col, virt } = st;
  let n = 0;
  if (virt > 0) { n += virt; col += virt; pos++; }
  while (pos < line.length) {
    const c = line.charCodeAt(pos);
    if (c === 0x20) { n++; col++; pos++; }
    else if (c === 0x09) { const w = tabWidth(col); n += w; col += w; pos++; }
    else break;
  }
  return n;
}

// Consume exactly n columns of whitespace (caller checked availability).
function advCols(line, st, n) {
  while (n > 0) {
    if (st.virt > 0) {
      const take = Math.min(st.virt, n);
      st.virt -= take; st.col += take; n -= take;
      if (st.virt === 0) st.pos++; // step past the split tab
      continue;
    }
    const c = line.charCodeAt(st.pos);
    if (c === 0x20) { st.pos++; st.col++; n--; }
    else if (c === 0x09) {
      const w = tabWidth(st.col);
      if (w <= n) { st.pos++; st.col += w; n -= w; }
      else { st.virt = w - n; st.col += n; n = 0; }
    } else break;
  }
}

// Consume up to n columns of whitespace; returns how many were consumed.
function advSomeCols(line, st, n) {
  const avail = countIndent(line, st);
  const take = Math.min(avail, n);
  advCols(line, st, take);
  return take;
}

// The line's content from st, materialising a split tab's leftover as
// spaces.
function restOfLine(line, st) {
  if (st.virt > 0) return ' '.repeat(st.virt) + line.slice(st.pos + 1);
  return line.slice(st.pos);
}

function isBlankRest(line, st) {
  return /^[ \t]*$/.test(restOfLine(line, st));
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HR_RE = /^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const BULLET_RE = /^([-+*])([ \t]+|$)/;
const ORDERED_RE = /^(\d{1,9})([.)])([ \t]+|$)/;

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont ' +
  'blockquote body caption center col colgroup dd details dialog dir ' +
  'div dl dt fieldset figcaption figure footer form frame frameset h1 h2 ' +
  'h3 h4 h5 h6 head header hr html iframe legend li link main menu ' +
  'menuitem nav noframes ol optgroup option p param search section ' +
  'summary table tbody td tfoot th thead title tr track ul').split(' '));

// Returns { kind, endTag } when the line (at st, indent <= 3) starts an
// HTML block, else null. kind 1..7 follow the usual block conditions;
// endTag is the string that ends types 1-5 (null for 6/7: blank line).
function htmlBlockStart(line, st) {
  if (countIndent(line, st) > 3) return null;
  const rest = restOfLine(line, st).replace(/^[ \t]+/, '');
  if (rest.charCodeAt(0) !== 0x3c) return null; // '<'
  let m;
  if ((m = /^<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(rest))) {
    return { kind: 1, endTag: '</' + m[1].toLowerCase() };
  }
  if (rest.startsWith('<!--')) return { kind: 2, endTag: '-->' };
  if (rest.startsWith('<?')) return { kind: 3, endTag: '?>' };
  if ((m = /^<![A-Z]/.exec(rest))) return { kind: 4, endTag: '>' };
  if (rest.startsWith('<![CDATA[')) return { kind: 5, endTag: ']]>' };
  if ((m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(rest)) &&
      HTML_BLOCK_TAGS.has(m[1].toLowerCase())) {
    return { kind: 6, endTag: null };
  }
  // Type 7: a complete open or closing tag alone on the line. A
  // closing tag takes no attributes, so it has its own shape.
  if (rest.startsWith('</')) {
    if (/^<\/[a-zA-Z][a-zA-Z0-9-]*[ \t]*>[ \t]*$/.test(rest)) {
      const tag = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)[1].toLowerCase();
      if (!HTML_BLOCK_TAGS.has(tag)) return { kind: 7, endTag: null };
    }
    return null;
  }
  if (/^<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.test(rest)) {
    const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)[1].toLowerCase();
    if (!HTML_BLOCK_TAGS.has(tag)) return { kind: 7, endTag: null };
  }
  return null;
}

// Try a list marker at st (indent <= 3). Returns marker info or null.
function listMarker(line, st) {
  if (countIndent(line, st) > 3) return null;
  const save = { ...st };
  advSomeCols(line, st, 3);
  const rest = restOfLine(line, st);
  let m, kind, bulletChar = null, delimiter = null, start = null, width;
  if ((m = BULLET_RE.exec(rest))) {
    kind = 'bullet'; bulletChar = m[1]; width = 1;
  } else if ((m = ORDERED_RE.exec(rest))) {
    kind = 'ordered'; start = parseInt(m[1], 10); delimiter = m[2];
    width = m[1].length + 1;
  } else { Object.assign(st, save); return null; }
  const after = rest.slice(width);
  const afterBlank = /^[ \t]*$/.test(after);
  // Columns of whitespace following the marker.
  let spaces = 0;
  if (!afterBlank) {
    const st2 = { pos: st.pos + width, col: st.col + width, virt: 0 };
    spaces = countIndent(line, st2);
  }
  // Content indent, measured from the position listMarker was called
  // at: the indent skipped before the marker, then marker + following
  // spaces when 1..4, else marker + 1.
  const skipped = st.col - save.col;
  const contentIndent = skipped +
    ((afterBlank || spaces > 4) ? width + 1 : width + spaces);
  Object.assign(st, save);
  return { kind, bulletChar, delimiter, start, width, contentIndent, afterBlank, spaces, skipped };
}

// Split a table row into raw cell strings. An escaped pipe (\|) is a
// literal pipe in the cell text and never splits; a pipe after an
// escaped backslash (\\|) does split. Pipes inside code spans DO split
// — the reference resolves this purely at the row level.
function splitRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const s = line;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\\') { cur += '\\\\'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // Drop the empty artefacts of a leading / trailing pipe.
  const trimmed = s.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed.startsWith('|') && cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0 &&
      cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

// A delimiter row: cells of dashes with optional alignment colons.
// A row of nothing but dashes is a setext underline, never a delimiter.
function delimiterAligns(line) {
  if (!line.includes('-')) return null;
  if (/^[ \t]*-+[ \t]*$/.test(line)) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

// A "chunk line" is a line consisting of a single <...> stretch:
// up to three leading spaces, then '<', at least one non-'>'
// character, and a final '>' as the line's last character. A
// paragraph containing such a line interacts with a following
// setext underline in a special way (see the setext branch).
function isChunkLine(s) {
  const t = s.replace(/^ {0,3}/, '');
  return t.length >= 3 && t[0] === '<' && t[t.length - 1] === '>' &&
    t.indexOf('>', 1) === t.length - 1;
}

function lastChunkLineIdx(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChunkLine(lines[i])) return i;
  }
  return -1;
}

function blockParse(src) {
  const doc = mkBlock('document', null);
  doc.refs = new Map();
  const srcEndsNl = src.endsWith('\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // Index of the last line holding any non-space/tab character.
  doc.lastContentLi = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (/[^ \t]/.test(lines[k])) { doc.lastContentLi = k; break; }
  }

  const stack = [doc];
  const tip = () => stack[stack.length - 1];
  let lastLineBlank = false;
  let lazyCodeParent = null;

  // The line's rest after stripping block b's container markers
  // (outermost first, mirroring the phase-1 match), or null when
  // the line does not belong to b's container stream at all.
  function streamRest(b, lineText) {
    const chain = [];
    for (let a = b.parent; a && a.type !== 'document'; a = a.parent) {
      if (a.type === 'blockquote' || a.type === 'item') chain.push(a);
    }
    chain.reverse();
    const st = newLineState();
    for (const c of chain) {
      if (c.type === 'blockquote') {
        const save = { ...st };
        advSomeCols(lineText, st, 3);
        if (restOfLine(lineText, st).charCodeAt(0) === 0x3e &&
            st.virt === 0) {
          st.pos++; st.col++;
          if (lineText[st.pos] === ' ') { st.pos++; st.col++; }
          else if (lineText[st.pos] === '\t') {
            const w = tabWidth(st.col - save.col);
            if (w <= 1) { st.pos++; st.col++; }
            else { st.virt = w - 1; st.col++; }
          }
        } else return null;
      } else if (isBlankRest(lineText, st)) {
        advSomeCols(lineText, st,
          Math.min(c.indent, countIndent(lineText, st)));
      } else if (countIndent(lineText, st) >= c.indent) {
        advCols(lineText, st, c.indent);
      } else return null;
    }
    return restOfLine(lineText, st);
  }

  // True when the block sits directly in the document stream (no
  // blockquote or list item among its ancestors).
  function inDocStream(b) {
    for (let a = b.parent; a; a = a.parent) {
      if (a.type === 'blockquote' || a.type === 'item') return false;
    }
    return true;
  }

  // The block's innermost container: 'blockquote', 'item', or null
  // for the document stream itself.
  function innermostContainer(b) {
    for (let a = b.parent; a; a = a.parent) {
      if (a.type === 'blockquote' || a.type === 'item') return a.type;
    }
    return null;
  }

  function finalize(b) {
    if (b.type === 'paragraph') finalizeParagraph(b, doc);
    else if (b.type === 'code') finalizeCode(b);
    else if (b.type === 'html') {
      // Whether an HTML block's text ends with a newline is decided
      // by the block's own container stream (the document itself, or
      // the text of the enclosing quote/item): the reference lexes
      // each container's text separately, so what counts is the next
      // line of THAT stream. For a block closed by its end tag
      // (kinds 1-5): the newline appears when the next stream line
      // exists and is not empty, or when the block's line is the
      // stream's last real line and the stream text ends with a
      // newline (a trailing empty stream line, or — for the document
      // stream only — a final newline in the source). A block that
      // ends at a blank line (kinds 6/7) takes the newline only when
      // it runs to the end of the document stream with one.
      let addNl = false;
      if (b.endTag) {
        // Walk the block's own container stream past its last line.
        const rests = [];
        for (let k = b.endLi + 1; k < lines.length; k++) {
          const r = streamRest(b, lines[k]);
          if (r === null) break;
          rests.push(r);
        }
        const inner = innermostContainer(b);
        if (rests.length === 0) {
          // The block's line is the stream's last: only the
          // document stream can still add its final newline. An
          // item stream may still gain one from a following
          // sibling item; finalizeList patches that in (the
          // sibling does not exist yet at this point).
          addNl = inner === null && srcEndsNl;
          if (inner === 'item') b._itemEndNl = true;
        } else if (rests[0] !== '') {
          addNl = true;
        } else if (rests.length === 1) {
          // One trailing empty stream line. In an item it is the
          // blank separator before a sibling item (patched in by
          // finalizeList when the item itself ends blank);
          // elsewhere the newline survives unless the stream is
          // the document and the source adds yet another one.
          if (inner === 'item') b._itemEndNl = true;
          else addNl = !(inner === null && srcEndsNl);
        }
      } else if (b.endLi + 1 >= lines.length) {
        addNl = inDocStream(b) && srcEndsNl && !b._endedByBlank;
      }
      b._addNl = addNl;
      b.text = b.lines.join('\n');
      delete b.lines;
    }
    else if (b.type === 'list') finalizeList(b);
    // Whether this block "ends on a blank line". For an item this is
    // exactly "a blank line at the item's own level arrived after its
    // last block and no new block followed" (the _sawBlank flag); for
    // other blocks it is their own last line or their last child's.
    if (b.type === 'item') {
      b._endsBlank = !!b._sawBlank;
    } else {
      const kids = b.children;
      b._endsBlank = !!b._llb ||
        (kids && kids.length ? !!kids[kids.length - 1]._endsBlank : false);
    }
  }

  // Close every block from the tip down to (not including) stack[idx].
  function closeDownTo(idx) {
    while (stack.length - 1 > idx) {
      const b = stack.pop();
      finalize(b);
    }
  }

  function openBlock(type, parent) {
    const b = mkBlock(type, parent || tip());
    stack.push(b);
    return b;
  }

  // Before adding a non-item block, an exposed list on the stack top is
  // finished (lists only ever hold items).
  function popExposedList() {
    if (tip().type === 'list') { const l = stack.pop(); finalize(l); }
  }

  // Would this line match every open container? (A light mirror of
  // the phase-1 matching, used to peek at the line after a blank.)
  function matchesAllContainers(lineText) {
    const s = newLineState();
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.type === 'blockquote') {
        const save = { ...s };
        advSomeCols(lineText, s, 3);
        if (restOfLine(lineText, s).charCodeAt(0) === 0x3e && s.virt === 0) {
          s.pos++; s.col++;
          if (lineText[s.pos] === ' ') { s.pos++; s.col++; }
          else if (lineText[s.pos] === '\t') advCols(lineText, s, 1);
        } else { Object.assign(s, save); return false; }
      } else if (b.type === 'item') {
        if (isBlankRest(lineText, s)) { /* matches trivially */ }
        else if (countIndent(lineText, s) >= b.indent) {
          advCols(lineText, s, b.indent);
        } else return false;
      } else if (b.type === 'code' && b.indented) {
        if (isBlankRest(lineText, s)) { /* matches trivially */ }
        else if (countIndent(lineText, s) >= 4) advCols(lineText, s, 4);
        else return false;
      }
    }
    return true;
  }

  // The text of a line as a lazy continuation would see it: the
  // open containers strip their share (an item strips its indent
  // or as much of it as the line has), without failing.
  function lazyContent(lineText, contentFn) {
    const s = newLineState();
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.type === 'paragraph' || b.type === 'table') break;
      if (b.type === 'blockquote') {
        const save = { ...s };
        advSomeCols(lineText, s, 3);
        if (restOfLine(lineText, s).charCodeAt(0) === 0x3e && s.virt === 0) {
          s.pos++; s.col++;
          if (lineText[s.pos] === ' ') { s.pos++; s.col++; }
          else if (lineText[s.pos] === '\t') advCols(lineText, s, 1);
        } else Object.assign(s, save);
      } else if (b.type === 'item') {
        advCols(lineText, s, Math.min(b.indent, countIndent(lineText, s)));
      } else if (b.type === 'code' && b.indented) {
        if (countIndent(lineText, s) >= 4) advCols(lineText, s, 4);
      }
    }
    return contentFn(lineText, s);
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const st = newLineState();
    lazyCodeParent = null;

    // --- phase 1: match open containers -------------------------------
    let matchedIdx = 0; // stack index of last matched container
    let expandTabs = false;
    // Column where the innermost stripped container's line begins:
    // tab stops in the remaining content are measured from there,
    // not from the start of the raw line.
    let tabOrigin = 0;
    // The stack level this line "belongs" to when it is blank: the
    // first container after whose marker the rest of the line is
    // already blank. A blank line inside a blockquote (its rest only
    // becomes blank once the quote marker is stripped) does not count
    // as a blank line for the containers outside the quote.
    let blankLevel = isBlankRest(line, st) ? 0 : -1;
    let i = 1;
    for (; i < stack.length; i++) {
      const b = stack[i];
      if (b.type === 'blockquote') {
        const save = { ...st };
        advSomeCols(line, st, 3);
        if (restOfLine(line, st).charCodeAt(0) === 0x3e && st.virt === 0) {
          tabOrigin = save.col;
          st.pos++; st.col++;
          if (line[st.pos] === ' ') { st.pos++; st.col++; }
          else if (line[st.pos] === '\t') {
            // The tab after a '>' is measured in the quote line's
            // own coordinates, not the raw line's: consume one
            // column of it at that width.
            const w = tabWidth(st.col - save.col);
            if (w <= 1) { st.pos++; st.col++; }
            else { st.virt = w - 1; st.col++; }
          }
          expandTabs = true;
          matchedIdx = i;
          if (blankLevel === -1 && isBlankRest(line, st)) blankLevel = i;
        } else { Object.assign(st, save); break; }
      } else if (b.type === 'item') {
        if (isBlankRest(line, st)) { matchedIdx = i; }
        else if (countIndent(line, st) >= b.indent) {
          advCols(line, st, b.indent); expandTabs = true; matchedIdx = i;
          if (blankLevel === -1 && isBlankRest(line, st)) blankLevel = i;
        } else break;
      } else if (b.type === 'code' && b.indented) {
        if (isBlankRest(line, st)) { matchedIdx = i; }
        else if (countIndent(line, st) >= 4) {
          advCols(line, st, 4); matchedIdx = i;
        } else break;
      } else {
        // list, paragraph, fenced code, html: no marker to match.
        matchedIdx = i;
      }
    }
    const allMatched = matchedIdx === stack.length - 1;
    if (blankLevel === -1) blankLevel = matchedIdx;
    const curTip = tip();

    // The line's content from a position. When a blockquote or list
    // item marker was stripped from this line, leading tabs in what
    // remains expand to spaces up to the next tab stop: the reference
    // extracts container content as text, so such a tab lands on its
    // visual column instead of surviving as a tab character.
    const content = (ln, s) => {
      const r = restOfLine(ln, s);
      if (expandTabs && s.virt === 0 && r.charCodeAt(0) === 0x09) {
        let col = s.col - tabOrigin, k = 0, out = '';
        while (r.charCodeAt(k) === 0x09) {
          const w = tabWidth(col);
          out += ' '.repeat(w); col += w; k++;
        }
        return out + r.slice(k);
      }
      return r;
    };

    // --- leaf continuations --------------------------------------------
    // A fenced block inside a list item keeps consuming lines that
    // fail the item's indent (the item's text is captured whole, and
    // the fence's lines come with it). This lazy consumption stops
    // at a sibling item marker and at a would-be closing fence, and
    // it never crosses an unmatched blockquote.
    function fenceContentLazy() {
      const fIdx = stack.length - 1;
      // Lazy consumption starts only once the fence holds a real
      // content line: a fence whose first line fails the item's
      // indent ends the fence (and the item) instead.
      let hasContent = false;
      for (const l of curTip.lines) {
        if (/[^ \t]/.test(l)) { hasContent = true; break; }
      }
      if (!hasContent) return false;
      let hasItem = false;
      for (let si = 1; si < fIdx; si++) {
        if (stack[si].type === 'item') { hasItem = true; break; }
      }
      if (!hasItem) return false;
      for (let si = matchedIdx + 1; si < fIdx; si++) {
        const t = stack[si].type;
        if (t !== 'item' && t !== 'list') return false;
      }
      // A sibling item marker for any enclosing list ends the fence.
      const st2 = newLineState();
      for (let si = 1; si < fIdx; si++) {
        const b = stack[si];
        if (b.type === 'blockquote') {
          const save = { ...st2 };
          advSomeCols(line, st2, 3);
          if (restOfLine(line, st2).charCodeAt(0) === 0x3e && st2.virt === 0) {
            st2.pos++; st2.col++;
            if (line[st2.pos] === ' ') { st2.pos++; st2.col++; }
            else if (line[st2.pos] === '\t') advCols(line, st2, 1);
          } else return false;
        } else if (b.type === 'item') {
          if (isBlankRest(line, st2)) continue;
          // A line that fails this item's indent sits outside the
          // item entirely: no deeper sibling marker is possible, so
          // stop the walk and let the fence take the line.
          if (countIndent(line, st2) < b.indent) break;
          advCols(line, st2, b.indent);
        } else if (b.type === 'list') {
          const lm = listMarker(line, { ...st2 });
          if (lm && sameListKind(b, lm)) return false;
        }
      }
      // A line that could close the fence ends the item instead.
      const indent = countIndent(line, st);
      if (indent <= 3) {
        const rest = restOfLine(line, st).replace(/^[ \t]+/, '');
        const m = FENCE_RE.exec(rest);
        if (m && m[1][0] === curTip.fenceChar &&
            m[1].length >= curTip.fenceLen && /^[ \t]*$/.test(m[2])) {
          return false;
        }
      }
      return true;
    }

    // A blank line does not start a fence's content inside a list
    // item: while the fence is still empty, the blank is fence
    // content only when the next non-blank line belongs to the
    // fence (matches every container); otherwise it acts as an
    // ordinary separator and the fence is left unterminated.
    let fenceBlankBarred = false;
    if (curTip.type === 'code' && curTip.fenceChar &&
        isBlankRest(line, st)) {
      let inItem = false;
      for (let a = curTip.parent; a; a = a.parent) {
        if (a.type === 'item') { inItem = true; break; }
      }
      if (inItem) {
        let hasContent = false;
        for (const l of curTip.lines) {
          if (/[^ \t]/.test(l)) { hasContent = true; break; }
        }
        if (!hasContent) {
          fenceBlankBarred = true;
          for (let j = li + 1; j < lines.length; j++) {
            if (/^[ \t]*$/.test(lines[j])) continue;
            if (matchesAllContainers(lines[j])) fenceBlankBarred = false;
            break;
          }
        }
      }
    }

    if (curTip.type === 'code' && curTip.fenceChar && !fenceBlankBarred &&
        (allMatched || fenceContentLazy())) {
      // Fenced code: content line, or the closing fence.
      const indent = countIndent(line, st);
      const rest = restOfLine(line, st);
      const m = allMatched && indent <= 3 &&
        FENCE_RE.exec(rest.replace(/^[ \t]+/, ''));
      if (m && m[1][0] === curTip.fenceChar &&
          m[1].length >= curTip.fenceLen && /^[ \t]*$/.test(m[2]) &&
          !(curTip.fenceChar === '`' && m[2].includes('`'))) {
        stack.pop(); finalize(curTip);
      } else {
        // Backtick fences drop up to the fence's own indent from
        // content lines; tilde fences keep the content exactly as
        // the containers leave it. When no container stripped this
        // line, the drop counts leading whitespace *characters* (a
        // tab counts once, however wide it renders); on a stripped
        // line it counts columns off the line state instead.
        if (curTip.fenceChar === '`') {
          const st2 = { ...st };
          if (!expandTabs && st.virt === 0) {
            let n = curTip.fenceIndent;
            while (n > 0 &&
                   (line[st2.pos] === ' ' || line[st2.pos] === '\t')) {
              st2.col += line[st2.pos] === '\t' ? tabWidth(st2.col) : 1;
              st2.pos++; n--;
            }
          } else {
            advSomeCols(line, st2, curTip.fenceIndent);
          }
          curTip.lines.push(content(line, st2));
        } else {
          curTip.lines.push(content(line, st));
        }
      }
      lastLineBlank = false;
      continue;
    }
    if (allMatched && curTip.type === 'html') {
      if (curTip.endTag === null && isBlankRest(line, st)) {
        curTip._endedByBlank = true;
        stack.pop(); finalize(curTip);
        // The blank still counts for the containers it fell in:
        // open items at or below its level saw it, exactly as the
        // blank-line handler below would have marked them.
        for (let si = Math.max(1, blankLevel); si < stack.length; si++) {
          if (stack[si].type === 'item') stack[si]._sawBlank = true;
        }
        const d = tip();
        if (d.type === 'item' && d._beganBlank && d.children.length === 0) {
          stack.pop(); finalize(d);
        }
        lastLineBlank = true;
        continue;
      }
      const text = content(line, st);
      curTip.lines.push(text);
      curTip.endLi = li;
      if (curTip.endTag && text.toLowerCase().includes(curTip.endTag)) {
        stack.pop(); finalize(curTip);
      }
      lastLineBlank = false;
      continue;
    }
    if (allMatched && curTip.type === 'code' && curTip.indented) {
      if (isBlankRest(line, st)) {
        // A blank line inside indented code keeps whatever spaces it
        // has beyond the four-column indent.
        const st2 = { ...st };
        advSomeCols(line, st2, 4);
        curTip.lines.push(content(line, st2));
      } else {
        curTip.lines.push(content(line, st));
      }
      lastLineBlank = isBlankRest(line, st);
      continue;
    }
    if (!allMatched && curTip.type === 'code' && curTip.indented &&
        curTip._lazyStart && !isBlankRest(line, st)) {
      // A lazy continuation of the indented code block: simulate
      // the unmatched containers' strips (as for a lazy paragraph
      // line); if four or more columns of indent remain after
      // them, the line still belongs to the code block.
      const st2 = { ...st };
      let stopped = false;
      for (let si = matchedIdx + 1; si < stack.length - 1; si++) {
        const c = stack[si];
        if (c.type === 'blockquote') {
          const save = { ...st2 };
          advSomeCols(line, st2, 3);
          if (restOfLine(line, st2).charCodeAt(0) === 0x3e &&
              st2.virt === 0) {
            st2.pos++; st2.col++;
            if (line[st2.pos] === ' ') { st2.pos++; st2.col++; }
            else if (line[st2.pos] === '\t') {
              const w = tabWidth(st2.col - save.col);
              if (w <= 1) { st2.pos++; st2.col++; }
              else { st2.virt = w - 1; st2.col++; }
            }
          } else Object.assign(st2, save);
        } else if (c.type === 'item') {
          if (countIndent(line, st2) >= c.indent) {
            advCols(line, st2, c.indent);
          } else {
            advCols(line, st2, countIndent(line, st2));
          }
        } else if (c.type === 'code' && c.indented) {
          if (countIndent(line, st2) >= 4) advCols(line, st2, 4);
          else { stopped = true; break; }
        }
      }
      if (!stopped && countIndent(line, st2) >= 4) {
        advCols(line, st2, 4);
        curTip.lines.push(content(line, st2));
        curTip.endLi = li;
        lastLineBlank = false;
        continue;
      }
    }

    // --- blank line ------------------------------------------------------
    if (isBlankRest(line, st)) {
      // A whitespace-only line as the very last line of the input is
      // absorbed into an open paragraph as a trailing line of spaces
      // when it is unterminated in the paragraph's own stream: the
      // document stream is unterminated when the source has no final
      // newline, while a blockquote's text never terminates its last
      // line. A paragraph inside a list item never absorbs.
      const rest = restOfLine(line, st);
      if (allMatched && tip().type === 'paragraph' && rest.length > 0 &&
          li === lines.length - 1) {
        let inItem = false;
        let inQuote = false;
        for (let a = tip().parent; a; a = a.parent) {
          if (a.type === 'item') inItem = true;
          if (a.type === 'blockquote') inQuote = true;
        }
        if (!inItem && (inQuote || !srcEndsNl)) {
          tip().lines.push(content(line, st));
          tip().endLi = li;
          lastLineBlank = false;
          continue;
        }
      }
      closeDownTo(matchedIdx);
      if (tip().type === 'table' && rest.includes('\t')) {
        // A whitespace-only line containing a tab whose expansion
        // stays within four columns is a table row of empty cells,
        // not the end of the table.
        let col = 0, narrow = true;
        for (const ch of rest) {
          col = ch === '\t' ? col + (4 - (col % 4)) : col + 1;
          if (col > 4) { narrow = false; break; }
        }
        if (narrow) {
          const t = tip();
          const rowText = allMatched ? content(line, st) : lazyContent(line, content);
          const cells = splitRow(rowText);
          while (cells.length < t.header.length) cells.push('');
          t.rows.push(cells.slice(0, t.header.length));
          lastLineBlank = false;
          continue;
        }
      }
      if (tip().type === 'table') { const tb = stack.pop(); finalize(tb); }
      if (tip().type === 'paragraph') {
        const p = stack.pop(); p._llb = true; finalize(p);
      }
      if (tip().type === 'html' && tip().endTag === null) {
        const h = stack.pop(); h._endedByBlank = true; finalize(h);
      }
      // Every open item at or below this blank line's own level saw
      // the blank inside its span.
      for (let si = Math.max(1, blankLevel); si < stack.length; si++) {
        if (stack[si].type === 'item') stack[si]._sawBlank = true;
      }
      const d = tip();
      if (d.type === 'item' && d._beganBlank && d.children.length === 0) {
        // An item whose first line was the bare marker ends, empty,
        // at a blank line; its list stays open for a possible sibling.
        stack.pop(); finalize(d);
      }
      lastLineBlank = true;
      continue;
    }

    // --- unmatched containers -------------------------------------------
    // A paragraph is continued by lazy lines; a table is not (its
    // rows must match every open container) — except a table that
    // itself started from a lazy header line, whose rows may be
    // lazy as well.
    const lazyOk = (curTip.type === 'paragraph' ||
      (curTip.type === 'table' && curTip._lazyStart)) && !allMatched;
    if (!allMatched && !lazyOk) closeDownTo(matchedIdx);

    // --- table start by paragraph interruption ---------------------------
    // The paragraph's last line becomes the header when this line is a
    // delimiter row with the same number of cells. Checked before other
    // block starts so a delimiter row that also looks like a list item
    // still makes a table; a pure-dash row is a setext underline instead
    // (delimiterAligns rejects those). The delimiter line must match
    // every open container: a lazy line never starts a table.
    if (allMatched && tip().type === 'paragraph' &&
        countIndent(line, st) <= 3) {
      const aligns = delimiterAligns(restOfLine(line, st));
      if (aligns) {
        const p = tip();
        const headerLine = p.lines[p.lines.length - 1];
        const header = splitRow(headerLine);
        if (header.length === aligns.length) {
          p.lines.pop();
          stack.pop(); finalize(p);
          const tb = openBlock('table');
          tb.header = header; tb.align = aligns; tb.rows = [];
          lastLineBlank = false;
          continue;
        }
      }
    }

    // --- phase 2: block starts -------------------------------------------
    // When the line did not match every open container but a paragraph
    // is open (a would-be lazy continuation), a block start that fires
    // first closes everything the line failed to match.
    let startPrepared = false;
    const prepareStart = () => {
      if (!startPrepared && !allMatched) closeDownTo(matchedIdx);
      startPrepared = true;
    };
    let consumed = false;
    if (tip().type !== 'table' &&
        !(tip().type === 'code' && tip().fenceChar)) {
      let again = true;
      while (again && !consumed) {
        again = false;
        const t = tip();
        const indent = countIndent(line, st);
        const rest = restOfLine(line, st);
        const trimmed = indent > 0 ? rest.replace(/^[ \t]+/, '') : rest;

        // Block quote.
        if (indent <= 3 && trimmed.charCodeAt(0) === 0x3e) {
          prepareStart();
          if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
          popExposedList();
          tabOrigin = st.col;
          const st2 = { ...st };
          advSomeCols(line, st2, 3);
          st2.pos++; st2.col++;
          if (line[st2.pos] === ' ') { st2.pos++; st2.col++; }
          else if (line[st2.pos] === '\t') {
            // As in phase 1: the tab's width is measured in the
            // quote line's own coordinates.
            const w = tabWidth(st2.col - st.col);
            if (w <= 1) { st2.pos++; st2.col++; }
            else { st2.virt = w - 1; st2.col++; }
          }
          Object.assign(st, st2);
          expandTabs = true;
          openBlock('blockquote');
          again = true; continue;
        }
        // ATX heading.
        if (indent <= 3 && trimmed.charCodeAt(0) === 0x23) {
          const m = ATX_RE.exec(trimmed);
          if (m) {
            prepareStart();
            popExposedList();
            if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
            const h = openBlock('heading');
            h.level = m[1].length;
            let content = m[2] || '';
            content = content.replace(/[ \t]+$/, '');
            if (/^#+$/.test(content)) content = '';
            else content = content.replace(/[ \t]#+$/, '');
            h.text = content.replace(/^[ \t]+|[ \t]+$/g, '');
            stack.pop();
            consumed = true; break;
          }
        }
        // Fenced code.
        if (indent <= 3 && (trimmed[0] === '`' || trimmed[0] === '~')) {
          const m = FENCE_RE.exec(trimmed);
          if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
            prepareStart();
            popExposedList();
            if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
            const c = openBlock('code');
            c.fenceChar = m[1][0]; c.fenceLen = m[1].length;
            c.fenceIndent = indent;
            c.lang = unescapeBackslashes(
              (m[2] || '').trim().split(/[ \t]+/)[0]) || null;
            c.lines = [];
            consumed = true; break;
          }
        }
        // HTML block (types 1-6 interrupt a paragraph; 7 does not).
        const hb = htmlBlockStart(line, st);
        if (hb && (hb.kind !== 7 || t.type !== 'paragraph')) {
          prepareStart();
          popExposedList();
          if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
          const h = openBlock('html');
          h.endTag = hb.endTag; h.kind = hb.kind;
          h.lines = [content(line, st)];
          h.endLi = li;
          if (hb.endTag && h.lines[0].toLowerCase().includes(hb.endTag)) {
            stack.pop(); finalize(h);
          }
          consumed = true; break;
        }
        // Setext heading (needs a matched paragraph, never lazy).
        // Definitions at the paragraph's start are extracted first,
        // exactly as when a paragraph is finalised; a paragraph left
        // empty by that does not become a heading at all.
        if (t.type === 'paragraph' && allMatched && indent <= 3 &&
            !t._noSetext) {
          const m = SETEXT_RE.exec(trimmed);
          // A definitions-only paragraph followed by a line that
          // is also a list marker ('- ', '-'): the marker wins —
          // the definitions end the paragraph and the list starts
          // (the setext conversion would leave nothing behind
          // anyway), so the setext branch is skipped for it.
          let skipSetext = false;
          if (m && listMarker(line, st)) {
            let rest = t.lines.join('\n');
            skipSetext = true;
            for (;;) {
              const d = parseOneDefinition(rest);
              if (!d) break;
              rest = d.rest;
            }
            if (!/^[ \t\n]*$/.test(rest)) skipSetext = false;
          }
          if (m && !skipSetext) {
            // A chunk line (a lone <...> line) inside the paragraph
            // blocks or splits the conversion: an '=' underline
            // never converts and just joins the paragraph; a '-'
            // underline converts only the lines after the last
            // chunk line, and when there are none it splits the
            // chunk line into its own paragraph and the underline
            // line is reprocessed on its own.
            const ci2 = lastChunkLineIdx(t.lines);
            if (ci2 !== -1) {
              if (m[1][0] === '=') {
                t.lines.push(restOfLine(line, st));
                t.endLi = li;
                consumed = true; break;
              }
              const seg = t.lines.slice(ci2 + 1);
              if (seg.length > 0) {
                const p = stack.pop();
                p.lines = t.lines.slice(0, ci2 + 1);
                finalize(p);
                const rem = extractDefinitions(seg.join('\n'), doc.refs);
                if (/^[ \t\n]*$/.test(rem)) {
                  const np = openBlock('paragraph');
                  np.lines = [restOfLine(line, st)];
                  np.endLi = li;
                } else {
                  const h = mkBlock('heading', p.parent);
                  h.level = 2;
                  h.text = rem.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
                }
                consumed = true; break;
              }
              if (ci2 > 0) {
                const chunkText = t.lines[ci2];
                const p = stack.pop();
                p.lines = t.lines.slice(0, ci2);
                finalize(p);
                const cp = mkBlock('paragraph', p.parent);
                cp.lines = [chunkText];
                cp.endLi = li;
                cp._noSetext = true;
                stack.push(cp);
              } else {
                t._noSetext = true;
              }
              li--; // reprocess the underline line
              consumed = true; break;
            }
            const p = stack.pop();
            const rem = extractDefinitions(p.lines.join('\n'), doc.refs);
            const idx = p.parent.children.indexOf(p);
            if (/^[ \t\n]*$/.test(rem)) {
              p.parent.children.splice(idx, 1);
              p.removed = true;
              const np = openBlock('paragraph');
              np.lines = [restOfLine(line, st)];
              np.endLi = li;
            } else {
              const h = mkBlock('heading', p.parent);
              p.parent.children.splice(idx, 1);
              h.level = m[1][0] === '=' ? 1 : 2;
              // A setext heading's text loses the first line's leading
              // indentation (a plain paragraph would keep it).
              h.text = rem.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            }
            consumed = true; break;
          }
        }
        // Thematic break.
        if (indent <= 3 && HR_RE.test(trimmed)) {
          prepareStart();
          popExposedList();
          if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
          openBlock('thematicBreak');
          stack.pop();
          consumed = true; break;
        }
        // List item.
        const lm = listMarker(line, st);
        if (lm) {
          const paraOpen = tip().type === 'paragraph' && allMatched;
          // A paragraph sitting directly in a list item is interrupted
          // by any list marker; a top-level (or quoted) paragraph only
          // by a bullet or by an ordered marker starting at 1.
          const itemPara = paraOpen && tip().parent &&
            tip().parent.type === 'item';
          // A paragraph holding only link definitions blocks
          // nothing: the definitions end it, and the list starts.
          let defsPara = false;
          if (paraOpen && lm.afterBlank) {
            let rest = tip().lines.join('\n');
            defsPara = true;
            for (;;) {
              const d = parseOneDefinition(rest);
              if (!d) break;
              rest = d.rest;
            }
            if (!/^[ \t\n]*$/.test(rest)) defsPara = false;
          }
          const interrupts = !paraOpen || defsPara ||
            (!lm.afterBlank &&
             (lm.kind === 'bullet' || lm.start === 1 || itemPara));
          if (interrupts) {
            prepareStart();
            if (tip().type === 'paragraph') { const p = stack.pop(); finalize(p); }
            // Sibling item of the same list? That is only possible
            // when the previous item failed to match this line and was
            // already closed, leaving the list itself on top. An item
            // that is still open means this marker sits at its content
            // position and starts a nested list instead.
            let list = null;
            const topB = tip();
            if (topB.type === 'list' && sameListKind(topB, lm)) list = topB;
            if (!list) {
              popExposedList();
              list = openBlock('list');
              list.listKind = lm.kind; list.bulletChar = lm.bulletChar;
              list.delimiter = lm.delimiter; list.start = lm.start;
              list.loose = false;
            }
            const item = openBlock('item', list);
            item.indent = lm.contentIndent;
            item._markerCol = lm.skipped;
            item._beganBlank = lm.afterBlank;
            expandTabs = true;
            // Position st at the item's content (the marker characters
            // themselves are not whitespace, so step over them directly).
            advSomeCols(line, st, 3);
            st.pos += lm.width; st.col += lm.width;
            // Consume the whitespace up to the content indent, capped by
            // what is actually there.
            const want = lm.contentIndent - lm.width;
            advSomeCols(line, st, want);
            again = true; continue;
          }
        }
        break;
      }
    }

    if (consumed) { lastLineBlank = false; continue; }

    // A block start that leaves only whitespace behind (an empty list
    // item, a bare quote marker) ends the line's work.
    if (isBlankRest(line, st) && tip().type !== 'paragraph') {
      lastLineBlank = false;
      continue;
    }

    // --- fresh table start --------------------------------------------------
    if (tip().type !== 'table' && tip().type !== 'paragraph') {
      // This line is the header, the next one the delimiter row.
      // The delimiter row must belong to the same containers as
      // the header line: a lazy delimiter never starts a table.
      if (li + 1 < lines.length && matchesAllContainers(lines[li + 1])) {
        const headerLine = restOfLine(line, st);
        const aligns = delimiterAligns(
          lines[li + 1].replace(/^[ \t]{0,3}/, ''));
        if (aligns) {
          const header = splitRow(headerLine);
          if (header.length === aligns.length) {
            popExposedList();
            const tb = openBlock('table');
            tb.header = header; tb.align = aligns; tb.rows = [];
            li++; // consume the delimiter line
            lastLineBlank = false;
            continue;
          }
        }
      }
    }

    // --- table rows ---------------------------------------------------------
    if (tip().type === 'table') {
      const t = tip();
      if (startsAnotherBlock(line, st, t._lazyStart)) {
        stack.pop(); finalize(t);
        li--; // reprocess this line as a fresh block line
        continue;
      }
      const rowText = allMatched ? content(line, st) : lazyContent(line, content);
      if (!allMatched && countIndent(rowText, { pos: 0, col: 0, virt: 0 }) >= 4) {
        // A lazy row line that is still indented by four or more
        // after the containers' strips is not a row: it becomes an
        // indented code block inside the table's containers.
        stack.pop(); finalize(t);
        lazyCodeParent = t.parent;
        // fall through to the indented-code handling below
      } else {
        const cells = splitRow(rowText);
        while (cells.length < t.header.length) cells.push('');
        t.rows.push(cells.slice(0, t.header.length));
        lastLineBlank = false;
        continue;
      }
    }

    // --- indented code -------------------------------------------------------
    if (countIndent(line, st) >= 4) {
      // A paragraph that holds only link definitions does not
      // block an indented code block: the definitions end it —
      // unless this line could be the last definition's title,
      // which may sit on its own line.
      if (tip().type === 'paragraph') {
        let rest = tip().lines.join('\n');
        let lastTitle = null;
        let defsOnly = true;
        for (;;) {
          const d = parseOneDefinition(rest);
          if (!d) break;
          lastTitle = d.title;
          rest = d.rest;
        }
        if (!/^[ \t\n]*$/.test(rest)) defsOnly = false;
        if (defsOnly) {
          const fc = restOfLine(line, st).replace(/^[ \t]+/, '')[0];
          const titleish = fc === '"' || fc === "'" || fc === '(';
          if (!titleish || lastTitle !== null) {
            const p = stack.pop(); finalize(p);
          }
        }
      }
      if (tip().type !== 'paragraph') {
        popExposedList();
        const c = openBlock('code');
        c.indented = true; c.lang = null; c.lines = [];
        // A code block that takes over from a lazy table inside
        // containers the line did not match may keep taking lazy
        // continuation lines.
        if (lazyCodeParent !== null && c.parent === lazyCodeParent) {
          c._lazyStart = true;
        }
        const st2 = { ...st };
        advCols(line, st2, 4);
        c.lines.push(content(line, st2));
        lastLineBlank = false;
        continue;
      }
    }

    // --- paragraph text -------------------------------------------------------
    if (tip().type === 'paragraph') {
      // A lazy '=' setext line inside a list item leaves an empty
      // line behind in the paragraph text (see below): when another
      // line joins the paragraph, the empty line comes first.
      if (tip()._eqLazyBreak) {
        tip().lines.push('');
        tip()._eqLazyBreak = false;
      }
      if (!allMatched) {
        // A lazy continuation line: the reference keeps it verbatim
        // in the text of the containers it failed to match, so the
        // deeper containers still strip their share from it (an
        // item strips its indent, a quote its marker), and if four
        // or more columns of indent then remain, it loses four.
        const st2 = { ...st };
        let failItem = null;
        for (let si = matchedIdx + 1; si < stack.length - 1; si++) {
          const c = stack[si];
          if (c.type === 'blockquote') {
            const save = { ...st2 };
            advSomeCols(line, st2, 3);
            if (restOfLine(line, st2).charCodeAt(0) === 0x3e &&
                st2.virt === 0) {
              st2.pos++; st2.col++;
              if (line[st2.pos] === ' ') { st2.pos++; st2.col++; }
              else if (line[st2.pos] === '\t') {
                const w = tabWidth(st2.col - save.col);
                if (w <= 1) { st2.pos++; st2.col++; }
                else { st2.virt = w - 1; st2.col++; }
              }
            } else Object.assign(st2, save);
          } else if (c.type === 'item') {
            if (countIndent(line, st2) >= c.indent) {
              advCols(line, st2, c.indent);
            } else if (si === stack.length - 2) {
              failItem = c;
              break;
            } else {
              // An outer item the line cannot fully enter still
              // contributes the indent it has: the reference clamps
              // each container's dedent to the line's own indent.
              advCols(line, st2, countIndent(line, st2));
            }
          } else if (c.type === 'code' && c.indented) {
            if (countIndent(line, st2) >= 4) advCols(line, st2, 4);
            else break;
          }
        }
        // If the line could not even enter the item that holds the
        // paragraph, it is no lazy continuation when it falls three
        // or more columns short of the item's content indent, or
        // when it is indented by four or more from the item's
        // marker: the containers close and the line is reprocessed
        // (it may become an indented code block or a fresh block).
        if (failItem) {
          let inQuote = false;
          for (let a = failItem.parent; a; a = a.parent) {
            if (a.type === 'blockquote') { inQuote = true; break; }
          }
          const iS = countIndent(line, st2);
          const cS = failItem.indent;
          const lS = failItem._markerCol ?? 0;
          if (!inQuote &&
              ((iS > lS && cS - iS >= 3 && (iS >= 4 || iS - lS >= 3)) ||
               iS - lS >= 4)) {
            closeDownTo(matchedIdx);
            li--;
            continue;
          }
        }
        // The four-column loss applies to a leading run of indented
        // lazy lines: the paragraph's first lazy line decides (by
        // its own in-stream indent) whether the run is dedented.
        // The run ends at the first line that is not dedented: an
        // empty line is inserted before that line, and no later
        // line of the paragraph is dedented again.
        const p = tip();
        const simIndent = countIndent(line, st2);
        if (p._lazyDedent === undefined) p._lazyDedent = simIndent >= 4;
        if (p._lazyDedent && !p._dedentDone) {
          if (simIndent >= 4) {
            advCols(line, st2, 4);
            p._inDedent = true;
          } else if (p._inDedent) {
            p.lines.push('');
            p._dedentDone = true;
          }
        }
        let txt = content(line, st2);
        // A lazy line that is itself a table header (the next line
        // is a delimiter row) ends the paragraph instead: the
        // table starts in the paragraph's place inside its
        // containers, and its rows may be lazy as well.
        if (txt.includes('|') && li + 1 < lines.length) {
          const nextTxt = lazyContent(lines[li + 1], content);
          const aligns = delimiterAligns(nextTxt);
          if (aligns) {
            const header = splitRow(txt);
            if (header.length === aligns.length) {
              stack.pop(); finalize(p);
              const tb = openBlock('table');
              tb.header = header; tb.align = aligns; tb.rows = [];
              tb._lazyStart = true;
              li++; // consume the delimiter line
              lastLineBlank = false;
              continue;
            }
          }
        }
        // A lazy '=' underline converts the paragraph to a
        // heading when the paragraph's innermost container is a
        // list item and its last line is no longer than the
        // item's indent (a longer line keeps the underline as
        // paragraph text instead).
        {
          const m = SETEXT_RE.exec(txt);
          if (m && m[1][0] === '=') {
            let item = null;
            for (let a = p.parent; a; a = a.parent) {
              if (a.type === 'item') { item = a; break; }
              if (a.type === 'blockquote') break;
            }
            const lastLine = p.lines[p.lines.length - 1];
            if (item && lastLine !== undefined &&
                lastLine.length <= item.indent) {
              stack.pop();
              const rem = extractDefinitions(p.lines.join('\n'), doc.refs);
              const idx = p.parent.children.indexOf(p);
              if (/^[ \t\n]*$/.test(rem)) {
                p.parent.children.splice(idx, 1);
                p.removed = true;
                const np = openBlock('paragraph');
                np.lines = [txt];
                np.endLi = li;
              } else {
                const h = mkBlock('heading', p.parent);
                p.parent.children.splice(idx, 1);
                h.level = 1;
                h.text = rem.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
              }
              lastLineBlank = false;
              continue;
            }
          }
        }
        // A lazy line inside a blockquote. A setext-looking lazy
        // line that is not the first lazy line of the paragraph is
        // indented by four spaces: it stays paragraph text and
        // never becomes a heading.
        let inQuote = false;
        for (let a = p.parent; a; a = a.parent) {
          if (a.type === 'blockquote') { inQuote = true; break; }
        }
        if (inQuote) {
          p._lazyLines = (p._lazyLines || 0) + 1;
          if (p._lazyLines >= 2 && SETEXT_RE.test(txt)) {
            txt = '    ' + txt;
          }
        }
        tip().lines.push(txt);
        tip().endLi = li;
        // A lazy '=' underline line inside a list item: the item's
        // text gains an empty line after it (applied when the next
        // line joins the paragraph, above).
        if (/^ {0,3}=+[ \t]*$/.test(txt)) {          for (let a = p.parent; a; a = a.parent) {
            if (a.type === 'item') { p._eqLazyBreak = true; break; }
          }
        }
      } else {
        // A matched continuation line of a paragraph whose
        // innermost container is a list item loses four columns
        // when it is indented by four or more in the item's stream
        // (the item's text is dedented once more for such lines).
        const p = tip();
        p._lazyLines = 0;
        if (p._inDedent && !p._dedentDone) {
          // A matched line also ends a dedented lazy run, with the
          // same separating empty line.
          p.lines.push('');
          p._dedentDone = true;
        }
        let deduct = false;
        if (countIndent(line, st) >= 4) {
          for (let a = p.parent; a; a = a.parent) {
            if (a.type === 'item') { deduct = true; break; }
            if (a.type === 'blockquote') break;
          }
        }
        if (deduct) {
          const st2 = { ...st };
          advCols(line, st2, 4);
          p.lines.push(content(line, st2));
        } else {
          p.lines.push(content(line, st));
        }
        p.endLi = li;
      }
    } else {
      popExposedList();
      const p = openBlock('paragraph');
      p.lines = [content(line, st)];
      p.endLi = li;
    }
    lastLineBlank = false;
  }

  closeDownTo(0);
  return doc;
}

function sameListKind(list, lm) {
  if (list.listKind !== lm.kind) return false;
  if (lm.kind === 'bullet') return list.bulletChar === lm.bulletChar;
  return list.delimiter === lm.delimiter;
}

// Does this line begin some other block (used to end a table body)?
function startsAnotherBlock(line, st, lazyTable) {
  const indent = countIndent(line, st);
  const rest = restOfLine(line, st);
  const trimmed = indent > 0 ? rest.replace(/^[ \t]+/, '') : rest;
  // A table that started lazily keeps taking indented lines as
  // rows; a matched table ends at an indented code block.
  if (indent >= 4 && !lazyTable) return true; // indented code block
  if (indent <= 3) {
    if (trimmed.charCodeAt(0) === 0x3e) return true;
    if (trimmed[0] === '`' || trimmed[0] === '~') {
      if (FENCE_RE.test(trimmed)) return true;
    }
    if (trimmed.charCodeAt(0) === 0x23 && ATX_RE.test(trimmed)) return true;
    if (HR_RE.test(trimmed)) return true;
    if (htmlBlockStart(line, st)) return true;
    if (listMarker(line, { ...st })) return true;
  }
  return false;
}

function finalizeCode(c) {
  if (c.indented) {
    // Trailing blank lines of an indented block are trimmed, but
    // they still separate the block from whatever follows in an
    // enclosing list item (they count for looseness).
    let trailing = 0;
    while (c.lines.length && /^[ \t]*$/.test(c.lines[c.lines.length - 1])) {
      c.lines.pop();
      trailing++;
    }
    c._trailingBlanks = trailing;
  } else if (c.lines.length && c.lines[c.lines.length - 1] === '') {
    // A fenced block whose content ends on an empty line loses
    // exactly one trailing empty line.
    c.lines.pop();
  }
  c.text = c.lines.length ? c.lines.join('\n') + '\n' : '';
  delete c.lines;
}

function finalizeList(list) {
  const items = list.children;
  list.loose = items.some((it, idx) =>
    it._blankBetween || (idx < items.length - 1 && !!it._endsBlank));
  // An HTML block that ends a non-last item's stream takes a
  // trailing newline when a blank line followed the item itself
  // (that blank is part of the item's captured text).
  for (let idx = 0; idx < items.length - 1; idx++) {
    if (!items[idx]._endsBlank) continue;
    let b = items[idx];
    while (b.children && b.children.length > 0 &&
           b.children[b.children.length - 1].type !== 'list') {
      b = b.children[b.children.length - 1];
    }
    if (b.type === 'html' && b._itemEndNl) b._addNl = true;
  }
  // The last item's final paragraph loses the trailing
  // whitespace of a setext-shaped last line.
  if (items.length > 0) {
    let b = items[items.length - 1];
    while (b.children && b.children.length > 0 &&
           b.children[b.children.length - 1].type !== 'list') {
      b = b.children[b.children.length - 1];
    }
    if (b.type === 'paragraph' && b._setextTail && b.text) {
      b.text = b.text.replace(/[ \t]+$/, '');
    }
  }
}

// Extract leading link reference definitions from a paragraph; registers
// them on the document and leaves the remaining text on the block. A
// paragraph that held only definitions is removed from its parent.
function finalizeParagraph(p, doc) {
  let text = p.lines.join('\n');
  // A paragraph inside a list item with no content lines after it
  // in the input loses the trailing spaces of its last line.
  if (p.endLi !== undefined && p.endLi === doc.lastContentLi &&
      /[ \t]$/.test(text)) {
    let inItem = false;
    for (let a = p.parent; a; a = a.parent) {
      if (a.type === 'item') { inItem = true; break; }
    }
    if (inItem) text = text.replace(/[ \t]+$/, '');
  }
  text = extractDefinitions(text, doc.refs);
  if (/^[ \t\n]*$/.test(text)) {
    const parent = p.parent;
    if (parent) {
      const idx = parent.children.indexOf(p);
      if (idx !== -1) parent.children.splice(idx, 1);
    }
    p.removed = true;
  } else {
    p.text = text;
    // A setext-shaped last line with trailing whitespace in an
    // item paragraph: the whitespace survives unless the item
    // turns out to be the last of its list (patched there).
    const nl = text.lastIndexOf('\n');
    const tail = nl === -1 ? text : text.slice(nl + 1);
    if (/^ {0,3}(=+|-+)[ \t]+$/.test(tail)) {
      for (let a = p.parent; a; a = a.parent) {
        if (a.type === 'item') { p._setextTail = true; break; }
      }
    }
  }
  delete p.lines;
}

// Parse as many "[label]: dest title" definitions as sit at the start of
// text; returns the unconsumed remainder.
function extractDefinitions(text, refs) {
  let rest = text;
  for (;;) {
    const parsed = parseOneDefinition(rest);
    if (!parsed) break;
    const key = normalizeLabel(parsed.label);
    if (!refs.has(key)) refs.set(key, { href: parsed.href, title: parsed.title });
    rest = parsed.rest;
  }
  return rest;
}

// Reference labels match case-insensitively with full case folding
// (ß folds to ss, the Latin ligatures to their letters) and with
// whitespace runs collapsed. Backslash escapes are NOT resolved:
// the label matches exactly as written, on both sides.
function normalizeLabel(label) {
  return label.replace(/[ \t\n]+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Parse one definition at the very start of s. Returns
// { label, href, title, rest } or null.
function parseOneDefinition(s) {
  let i = 0;
  // Up to three leading spaces are part of the block indentation; the
  // paragraph text keeps them, so skip them here.
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (s[i] !== '[') return null;
  // Label: up to the unescaped ']', no unescaped '[' inside.
  let j = i + 1, label = '';
  for (;;) {
    if (j >= s.length) return null;
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      label += s[j] + s[j + 1]; j += 2; continue;
    }
    if (c === '[') return null;
    if (c === ']') break;
    label += c; j++;
  }
  if (label.trim() === '') return null;
  j++; // past ']'
  if (s[j] !== ':') return null;
  j++;
  // A tab in the gap before the destination, on the colon's own
  // line, invalidates the definition (a tab after a newline is
  // fine).
  for (let t = j; t < s.length; t++) {
    const c = s[t];
    if (c === '\t') return null;
    if (c !== ' ') break;
  }
  // Whitespace (at most one blank line's worth).
  const ws = skipDefWhitespace(s, j);
  if (ws === -1) return null;
  j = ws;
  // Destination.
  let href;
  if (s[j] === '<') {
    const close = s.indexOf('>', j + 1);
    if (close === -1) return null;
    href = s.slice(j + 1, close);
    if (href.includes('\n') || href.includes('<')) return null;
    j = close + 1;
  } else {
    const d = parseBareDestination(s, j);
    if (d === null) return null;
    href = d.value; j = d.end;
  }
  // Optional title, which must be separated by whitespace and be the
  // last thing on its line.
  const afterDest = j;
  const ws2 = skipDefWhitespace(s, j, true);
  let title = null;
  if (ws2 !== -1 && ws2 !== j) {
    const t = parseLinkTitle(s, ws2);
    if (t) {
      // After the title only spaces/tabs may precede the line end.
      let k = t.end;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length || s[k] === '\n') { title = t.value; j = k; }
    }
  }
  if (title === null) {
    // No title: the destination must end the line.
    let k = afterDest;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k < s.length && s[k] !== '\n') return null;
    j = k;
  }
  if (s[j] === '\n') j++;
  return { label, href: unescapeBackslashes(href), title, rest: s.slice(j) };
}

// Skip spaces/tabs/newlines in a definition, failing (-1) on a blank
// line. With allowTitleGap, at least the caller checks progress.
function skipDefWhitespace(s, i) {
  let newlines = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { newlines++; if (newlines > 1) return -1; i++; }
    else if (c === ' ' || c === '\t') i++;
    else break;
  }
  return i;
}

function unescapeBackslashes(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// A bare (non-<>) link destination starting at i: no spaces or control
// characters, balanced parentheses. Returns { value, end } or null.
function parseBareDestination(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      j += 2; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    j++;
  }
  if (j === i || depth !== 0) return null;
  return { value: s.slice(i, j), end: j };
}

// A link title at i: "..." or '...' or (...). Returns { value, end }.
function parseLinkTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1, value = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      value += s[j + 1]; j += 2; continue;
    }
    if (c === close) return { value, end: j + 1 };
    if (open === '(' && c === '(') return null;
    value += c; j++;
  }
  return null;
}

// --------------------------------------------------------- inline layer
//
// Inline parsing works on one block's text at a time. The scanner walks
// the text once, splitting it at "event" characters; everything between
// events accumulates in a raw text buffer. Entities are decoded into
// that buffer the moment they are met, and the buffer is flushed
// (escaped, exactly once) only at a real token boundary — never in the
// middle of a would-be token — so an entity whose name contains an
// event character (the underscore in &Hilbe_tSpace;) can never be
// split apart by a neighbouring construct that later fails.

const INLINE_EVENT_RE =
  /[\\`\[\]!*_~<@\n]|[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ff][Tt][Pp]:\/\/|www\.|mailto:|xmpp:/g;

function isEmailLocalChar(cp) {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) || cp === 0x2e || cp === 0x5f ||
    cp === 0x25 || cp === 0x2b || cp === 0x2d;
}

function isEmailDomainChar(cp) {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) || cp === 0x2e || cp === 0x2d || cp === 0x5f;
}

// Validate an extended-autolink email given the local part and the raw
// domain run scanned after '@'. The run is shortened label by label
// (regex-style backtracking) until it validates: a trailing '-' or '_'
// invalidates only the last label, so when@atlas.example.com_ links
// as when@atlas.example and leaves .com_ as text.
function validateEmail(local, run) {
  if (!local || !run) return null;
  let dom = run;
  while (dom.endsWith('.')) dom = dom.slice(0, -1);
  if (!dom) return null;
  const last = dom[dom.length - 1];
  if (last === '-' || last === '_') return null;
  const labels = dom.split('.');
  if (labels.length < 2) return null;
  for (const lab of labels) if (lab === '') return null;
  return local + '@' + dom;
}

function matchEmail(local, run) {
  let r = run;
  for (;;) {
    const addr = validateEmail(local, r);
    if (addr) return addr;
    const dot = r.lastIndexOf('.');
    if (dot === -1) return null;
    r = r.slice(0, dot);
  }
}

// Post-process an extended-autolink candidate: drop trailing
// punctuation, drop a trailing entity-looking &...; entirely, balance
// parentheses (an unmatched ')' at the end is dropped; an unmatched
// '(' truncates the link just before it).
function trimAutolink(cand) {
  for (let guard = 0; guard < 20; guard++) {
    const before = cand;
    const amp = cand.lastIndexOf('&');
    if (amp !== -1 && /^&[#A-Za-z0-9]+;$/.test(cand.slice(amp))) {
      cand = cand.slice(0, amp);
    }
    while (cand.length && '?!.,:*_~;'.includes(cand[cand.length - 1])) {
      cand = cand.slice(0, -1);
    }
    // Unclosed '(': cut just before the first '(' that has no ')'
    // anywhere after it in the candidate.
    const lastClose = cand.lastIndexOf(')');
    const openCut = cand.indexOf('(', lastClose + 1);
    if (openCut !== -1) cand = cand.slice(0, openCut);
    // Trailing ')': drop it while it is an excess close — one that
    // no still-unmatched '(' before it pairs with in a left-to-right
    // scan. (A trailing ')' that does pair with an earlier '(' is
    // kept, however the counts balance out globally.)
    while (cand.endsWith(')')) {
      let depth = 0, excess = false;
      for (let k = 0; k < cand.length; k++) {
        if (cand[k] === '(') depth++;
        else if (cand[k] === ')') {
          if (depth > 0) depth--;
          else if (k === cand.length - 1) excess = true;
        }
      }
      if (!excess) break;
      cand = cand.slice(0, -1);
    }
    if (cand === before) break;
  }
  return cand;
}

const TAG_RE =
  /<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>/y;
const CLOSE_TAG_RE = /<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>/y;
const AUTOLINK_SCHEME_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/y;
const AUTOLINK_EMAIL_RE =
  /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

function codePointBefore(s, i) {
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.codePointAt(i - 2);
  }
  return c;
}

// Parse the "(destination title)" part of an inline link starting at
// the '('. Returns { href, title, end } or null.
function parseInlineLink(text, openIdx) {
  const n = text.length;
  let k = openIdx + 1;
  const skipWs = () => {
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  };
  skipWs();
  if (text[k] === ')') return { href: '', title: null, end: k + 1 };
  let href;
  if (text[k] === '<') {
    let e = k + 1, ok = false;
    while (e < n) {
      const c = text[e];
      if (c === '\\' && e + 1 < n && isAsciiPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
      if (c === '<' || c === '\n') return null;
      if (c === '>') { ok = true; break; }
      e++;
    }
    if (!ok) return null;
    href = unescapeBackslashes(text.slice(k + 1, e));
    k = e + 1;
  } else {
    const d = parseBareDestination(text, k);
    if (!d) return null;
    href = unescapeBackslashes(d.value);
    k = d.end;
  }
  const beforeWs = k;
  skipWs();
  let title = null;
  if (k > beforeWs && k < n &&
      (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const t = parseLinkTitle(text, k);
    if (!t) return null;
    title = t.value;
    k = t.end;
    skipWs();
  }
  if (text[k] !== ')') return null;
  return { href, title, end: k + 1 };
}

// Find the ']' closing a reference label starting at `from` (just past
// the opening '['). Labels contain no unescaped '[' or ']'.
function findLabelEnd(text, from) {
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === '\\' && k + 1 < text.length &&
        isAsciiPunct(text.charCodeAt(k + 1))) { k++; continue; }
    if (c === '[') return -1;
    if (c === ']') return k;
  }
  return -1;
}

// The reference matches a link label with a lenient backtick scan:
// a backtick run pairs with the NEXT backtick run (of any length)
// as one opaque chunk; a run with no later partner is tolerated
// only when it sits at the very end of the label. Returns the index
// of the ']' that ends the label, or -1 when the label is invalid
// or unterminated.
function lenientLabelEnd(text, from) {
  const n = text.length;
  let depth = 0;
  let k = from;
  while (k < n) {
    const c = text[k];
    if (c === '\\' && k + 1 < n &&
        isAsciiPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
    if (c === '`') {
      let e = k;
      while (e < n && text[e] === '`') e++;
      const nxt = text.indexOf('`', e);
      if (nxt === -1) {
        // Dangling run: the label must end immediately after it.
        return (text[e] === ']' && depth === 0) ? e : -1;
      }
      let e2 = nxt;
      while (e2 < n && text[e2] === '`') e2++;
      k = e2;
      continue;
    }
    if (c === '<') {
      // A tag-like span is opaque to the scan.
      const nx = text[k + 1];
      if (nx !== undefined && /[A-Za-z/!?]/.test(nx)) {
        const gt = text.indexOf('>', k + 1);
        if (gt !== -1) { k = gt + 1; continue; }
      }
      k++;
      continue;
    }
    if (c === '[') { depth++; k++; continue; }
    if (c === ']') {
      if (depth === 0) return k;
      depth--; k++; continue;
    }
    k++;
  }
  return -1;
}

// Bounded form of the lenient label scan: does the label text in
// [from, closeIdx) chunk cleanly — every backtick run paired with
// the next run, except a dangling run at the very end?
function labelBackticksOk(text, from, closeIdx) {
  let depth = 0;
  let k = from;
  while (k < closeIdx) {
    const c = text[k];
    if (c === '\\' && k + 1 < closeIdx &&
        isAsciiPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
    if (c === '`') {
      let e = k;
      while (e < closeIdx && text[e] === '`') e++;
      const nxt = text.indexOf('`', e);
      if (nxt === -1 || nxt >= closeIdx) {
        // Dangling run: only as the label's last token, and only
        // when it is at least two backticks long (a lone trailing
        // backtick invalidates the label).
        return e === closeIdx && e - k >= 2;
      }
      let e2 = nxt;
      while (e2 < text.length && text[e2] === '`') e2++;
      k = e2;
      continue;
    }
    if (c === '<') {
      const nx = text[k + 1];
      if (nx !== undefined && /[A-Za-z/!?]/.test(nx)) {
        const gt = text.indexOf('>', k + 1);
        if (gt !== -1 && gt < closeIdx) { k = gt + 1; continue; }
      }
      k++;
      continue;
    }
    if (c === '[') { depth++; k++; continue; }
    if (c === ']') { if (depth > 0) depth--; k++; continue; }
    k++;
  }
  return true;
}

// Poison rule: a link whose label contains a lenient backtick chunk
// whose opening run does not begin a real (strict) code span leaves
// a mark on the rest of the paragraph — see where it is applied.
function labelHasPoisonChunk(label) {
  const n = label.length;
  const strictOpen = new Set();
  let s = 0;
  while (s < n) {
    const c = label[s];
    if (c === '\\' && s + 1 < n &&
        isAsciiPunct(label.charCodeAt(s + 1))) { s += 2; continue; }
    if (c !== '`') { s++; continue; }
    let e = s;
    while (e < n && label[e] === '`') e++;
    const L = e - s;
    let cIdx = e, closeEnd = -1;
    while (cIdx < n) {
      const idx = label.indexOf('`', cIdx);
      if (idx === -1) break;
      let e2 = idx;
      while (e2 < n && label[e2] === '`') e2++;
      if (e2 - idx === L) { closeEnd = e2; break; }
      cIdx = e2;
    }
    if (closeEnd !== -1) { strictOpen.add(s); s = closeEnd; }
    else s = e;
  }
  let k = 0;
  while (k < n) {
    const c = label[k];
    if (c === '\\' && k + 1 < n &&
        isAsciiPunct(label.charCodeAt(k + 1))) { k += 2; continue; }
    if (c !== '`') { k++; continue; }
    let e = k;
    while (e < n && label[e] === '`') e++;
    const nxt = label.indexOf('`', e);
    if (nxt === -1) break; // dangling run: not a chunk
    if (!strictOpen.has(k)) return true;
    let e2 = nxt;
    while (e2 < n && label[e2] === '`') e2++;
    k = e2;
  }
  return false;
}

function parseInlines(text, refs, state) {
  const nodes = [];
  const brackets = [];
  const n = text.length;
  let buf = '';
  let i = 0;
  // Count of '_' delimiter runs seen so far that could still open
  // emphasis (a later closer has not consumed them). An email whose
  // domain run ends in '_' only keeps that '_' when no opener waits:
  // when one does, the '_' belongs to the emphasis, not the address.
  let usOpen = 0;
  // Position just past a "poison" link (an inline link/image whose
  // label holds a lenient backtick chunk that is not a real code
  // span). After such a link, any emphasis delimiter that still has
  // a backtick somewhere after it in this text stays inert.
  let poisonFrom = -1;

  function flush() {
    if (buf) { nodes.push({ k: 'text', s: buf }); buf = ''; }
  }

  // Is there a '_' run at or after `from` that could close emphasis:
  // preceded by a word character and not followed by one (an
  // intraword run can neither open nor close)?
  function closerAhead(from) {
    const isWord = cp =>
      (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) || cp >= 0xa1;
    let q = from;
    while (q < n) {
      q = text.indexOf('_', q);
      if (q === -1) return false;
      let e = q + 1;
      while (e < n && text[e] === '_') e++;
      const prev = q > 0 ? text.charCodeAt(q - 1) : 0;
      const after = e < n ? text.charCodeAt(e) : 0;
      if (isWord(prev) && !isWord(after)) return true;
      q = e;
    }
    return false;
  }

  function lookupRef(rawLabel) {
    return refs.get(normalizeLabel(rawLabel)) || null;
  }

  // Would a code span whose closing run starts at closeStart swallow
  // the ']' that ends the innermost open bracket's label (per the
  // lenient label scan)? Spans may not cross that point. A label end
  // the scan has already passed belongs to some earlier construct
  // and does not count.
  function crossesLabelEnd(closeStart, spanStart) {
    const top = brackets[brackets.length - 1];
    const L = lenientLabelEnd(text, top.srcStart);
    return L !== -1 && L >= spanStart && closeStart >= L;
  }

  // A failed inline-link attempt leaves the label's emphasis
  // delimiters inert: they render literally, though code spans and
  // other constructs in the label still tokenize.
  function suppressEmphasis(b) {
    for (let k = b.idx + 1; k < nodes.length; k++) {
      const nd = nodes[k];
      if (nd.k === 'delim') { nd.open = false; nd.close = false; }
    }
  }

  // Attempt to form a link/image at the ']' at position closeIdx, where
  // b is the innermost open bracket. Returns the index just past the
  // whole construct, or 0 when nothing forms.
  function tryFormLink(b, closeIdx) {
    // The inline and full-reference forms need the label to satisfy
    // the reference's lenient backtick scan (chunked backtick runs,
    // a dangling run only at the very end). The shortcut-reference
    // fallback accepts the raw label regardless.
    const labelOk = labelBackticksOk(text, b.srcStart, closeIdx);
    let end = -1, href = null, title = null;
    let inlineFormed = false;
    if (labelOk && text[closeIdx + 1] === '(') {
      const p = parseInlineLink(text, closeIdx + 1);
      if (p) {
        href = p.href; title = p.title; end = p.end;
        inlineFormed = true;
      }
    }
    if (end === -1 && labelOk && text[closeIdx + 1] === '[') {
      const close2 = findLabelEnd(text, closeIdx + 2);
      if (close2 !== -1) {
        const lab2 = text.slice(closeIdx + 2, close2);
        const ref = lookupRef(lab2 === ''
          ? text.slice(b.srcStart, closeIdx) : lab2);
        if (ref) {
          href = ref.href; title = ref.title; end = close2 + 1;
        } else {
          // A complete second label that resolves nowhere kills the
          // whole construct: no shortcut-reference fallback.
          return 0;
        }
      }
    }
    if (end === -1) {
      const ref = lookupRef(text.slice(b.srcStart, closeIdx));
      if (ref) { href = ref.href; title = ref.title; end = closeIdx + 1; }
    }
    if (end === -1) {
      // An inline-link attempt ('(' right after the ']') that forms
      // nothing — bad label, bad destination, no reference — leaves
      // the label's emphasis delimiters inert.
      if (text[closeIdx + 1] === '(') suppressEmphasis(b);
      return 0;
    }
    flush();
    const children = nodes.splice(b.idx + 1);
    processEmphasis(children, text);
    // Bare (extended) autolinks never form inside a link's text: any
    // that were scanned while this bracket was open become plain
    // text again. Angle-bracket autolinks are unaffected — they do
    // nest.
    deautolink(children);
    // Drop this bracket and any brackets opened inside it.
    while (brackets.length && brackets[brackets.length - 1] !== b) {
      brackets.pop();
    }
    brackets.pop();
    if (b.image) {
      nodes[b.idx] = {
        k: 'img', src: href, title, alt: plainText(children),
      };
    } else {
      nodes[b.idx] = { k: 'link', href, title, children };
      // A formed link deactivates every earlier link bracket.
      for (const ob of brackets) if (!ob.image) ob.active = false;
    }
    if (inlineFormed && poisonFrom === -1 &&
        labelHasPoisonChunk(text.slice(b.srcStart, closeIdx))) {
      poisonFrom = end;
    }
    return end;
  }

  while (i < n) {
    INLINE_EVENT_RE.lastIndex = i;
    const m = INLINE_EVENT_RE.exec(text);
    const j = m ? m.index : n;
    if (j > i) { buf += text.slice(i, j); i = j; }
    if (!m) break;
    const tok = m[0];
    const c0 = tok.charCodeAt(0);

    if (tok.length > 1) {
      // Extended autolink: scheme://..., www...., mailto:..., xmpp:...
      if (tok === 'mailto:' || tok === 'xmpp:') {
        // Inside a raw <a> element no bare autolink forms at all.
        if (state.inLink) { buf += tok; i += tok.length; continue; }
        // The address is parsed immediately after the prefix: a local
        // part, '@', a domain. A mailto link is exactly that much; an
        // xmpp link may add one /resource segment.
        let j = i + tok.length;
        const l0 = j;
        while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
        let end = -1;
        if (j > l0 && text[j] === '@') {
          let k = j + 1;
          while (k < n && isEmailDomainChar(text.charCodeAt(k))) k++;
          if (usOpen > 0) {
            let t = k;
            while (t > j + 1 && text[t - 1] === '_') t--;
            if (t < k) k = t;
          }
          const localPart = text.slice(l0, j);
          const addr = matchEmail(localPart, text.slice(j + 1, k));
          if (addr) end = j + 1 + (addr.length - localPart.length - 1);
        }
        if (end !== -1 && tok === 'xmpp:' && text[end] === '/') {
          let k = end + 1;
          while (k < n && text[k] !== '/' && text[k] !== '<' &&
                 !isSpaceCp(text.codePointAt(k))) k++;
          if (k > end + 1) end = k;
        }
        if (end !== -1) {
          flush();
          const label = text.slice(i, end);
          nodes.push({ k: 'autolink', href: label, s: label });
          i = end;
          continue;
        }
        buf += tok;
        i += tok.length;
        continue;
      }
      let ok = !state.inLink;
      if (tok === 'www.' && i > 0) {
        const prev = text[i - 1];
        if (!(prev === ' ' || prev === '\t' || prev === '\n' ||
              prev === '(' || prev === '[' || prev === '*' ||
              prev === '_' || prev === '~')) ok = false;
      }
      if (ok) {
        let e = i;
        // A ']' that could close an *active* bracket ends the run:
        // the bracket gets its chance to form a link first (and the
        // autolink is then suppressed inside it, as the reference
        // does). Brackets deactivated by an inner link no longer
        // count — a ']' next to them is ordinary URL text.
        const anyActive = brackets.some(b => b.active);
        while (e < n) {
          const cp = text.charCodeAt(e);
          if (cp === 0x3c || isSpaceCp(cp)) break;
          if (cp === 0x5d && anyActive) break;
          e++;
        }
        const cand = trimAutolink(text.slice(i, e));
        if (cand.length > tok.length) {
          // A www. link's first domain character must be a letter,
          // digit or dash (an '_' or other punctuation there means
          // no link at all).
          if (tok === 'www.') {
            const fc = cand.charCodeAt(4);
            const fok = (fc >= 0x30 && fc <= 0x39) ||
              (fc >= 0x41 && fc <= 0x5a) || (fc >= 0x61 && fc <= 0x7a) ||
              fc === 0x2d;
            if (!fok) { buf += tok; i += tok.length; continue; }
          }
          // A scheme link's host must start with a letter, digit,
          // '_' or '-' (a leading '.' or other punctuation means
          // no link at all).
          if (tok.endsWith('://')) {
            const fc = cand.charCodeAt(tok.length);
            const fok = (fc >= 0x30 && fc <= 0x39) ||
              (fc >= 0x41 && fc <= 0x5a) || (fc >= 0x61 && fc <= 0x7a) ||
              fc === 0x5f || fc === 0x2d;
            if (!fok) { buf += tok; i += tok.length; continue; }
          }
          let href = cand;
          if (tok === 'www.') href = 'http://' + cand;
          flush();
          nodes.push({ k: 'autolink', href, s: cand });
          i += cand.length;
          continue;
        }
      }
      buf += tok;
      i += tok.length;
      continue;
    }

    switch (c0) {
      case 0x5c: { // backslash
        const nx = text[i + 1];
        if (nx === '\n') {
          // A backslash break also fails when only whitespace
          // follows it: the backslash and the rest stay literal.
          let j = i + 2;
          while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
          if (j >= n) {
            buf += '\\\n' + text.slice(i + 2, j);
            i = j;
          } else {
            flush();
            nodes.push({ k: 'br' });
            i = j;
          }
        } else if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
          // An escaped character is a literal of its own: it must not
          // merge with neighbouring text for escaping purposes (an
          // escaped '&' is &amp;, never the start of a reference).
          flush();
          nodes.push({ k: 'text', s: nx, literal: true });
          i += 2;
        } else {
          buf += '\\';
          i += 1;
        }
        break;
      }
      case 0x60: { // backtick: code span
        let e = i;
        while (e < n && text[e] === '`') e++;
        const runLen = e - i;
        let closeStart = -1, closeEnd = -1, k = e;
        while (k < n) {
          const idx = text.indexOf('`', k);
          if (idx === -1) break;
          let e2 = idx;
          while (e2 < n && text[e2] === '`') e2++;
          if (e2 - idx === runLen) { closeStart = idx; closeEnd = e2; break; }
          k = e2;
        }
        if (closeStart === -1) {
          buf += text.slice(i, e);
          i = e;
        } else if (brackets.length &&
                   crossesLabelEnd(closeStart, i)) {
          // Inside a bracket, a span may not swallow the ']' that
          // ends the label: the reference matches the label first,
          // with its own lenient backtick chunking.
          buf += text.slice(i, e);
          i = e;
        } else {
          let content = text.slice(e, closeStart).replace(/\n/g, ' ');
          if (content.length >= 2 && content[0] === ' ' &&
              content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
            content = content.slice(1, -1);
          }
          flush();
          nodes.push({ k: 'code', s: content });
          i = closeEnd;
        }
        break;
      }
      case 0x40: { // '@': possible extended email autolink
        if (state.inLink) { buf += '@'; i += 1; break; }
        // The local part is the run of local-part characters ending
        // at the '@' in the source. '_' belongs to that class but is
        // also an event character, so the run may reach back across
        // '_' delimiter nodes and into the previous text node; those
        // nodes are absorbed when the address validates.
        let s0 = buf.length;
        while (s0 > 0 && isEmailLocalChar(buf.charCodeAt(s0 - 1))) s0--;
        let localLen = buf.length - s0;
        const absorbed = []; // { idx, take, partial }, from the end
        if (s0 === 0) {
          let ni = nodes.length - 1;
          let cont = true;
          while (cont && ni >= 0) {
            const nd = nodes[ni];
            if (nd.k === 'delim' && nd.ch === '_') {
              absorbed.push({ idx: ni, take: nd.n, partial: false });
              localLen += nd.n; ni--;
            } else if (nd.k === 'text' && !nd.literal) {
              let t0 = nd.s.length;
              while (t0 > 0 && isEmailLocalChar(nd.s.charCodeAt(t0 - 1))) {
                t0--;
              }
              const take = nd.s.length - t0;
              if (take === 0) break;
              absorbed.push({ idx: ni, take, partial: t0 > 0 });
              localLen += take;
              cont = t0 === 0; ni--;
            } else break;
          }
        }
        let formed = false;
        if (localLen > 0) {
          let e = i + 1;
          while (e < n && isEmailDomainChar(text.charCodeAt(e))) e++;
          const eRun = e;
          // A trailing '_' run belongs to a waiting emphasis opener,
          // not to the address: the email chunk ends before it.
          let cut = 0;
          if (usOpen > 0) {
            let t = e;
            while (t > i + 1 && text[t - 1] === '_') t--;
            cut = e - t;
            if (t < e) e = t;
          }
          const domain = text.slice(i + 1, e);
          // Leading '_' delimiter runs absorbed into the local part
          // may be emphasis openers rather than address characters:
          // when an opener is waiting (usOpen > 0) and a closing '_'
          // exists — the cut trailing run, or a later closer — the
          // address without them wins if it validates.
          let leadEntries = 0;
          let leadChars = 0;
          if (usOpen > 0) {
            for (let ai = absorbed.length - 1; ai >= 0; ai--) {
              const nd = nodes[absorbed[ai].idx];
              if (nd && nd.k === 'delim' && nd.ch === '_') {
                leadEntries++; leadChars += absorbed[ai].take;
              } else break;
            }
          }
          let addr = null;
          let useAbsorbed = absorbed;
          let useLocalLen = localLen;
          if (leadChars > 0 && (cut > 0 || closerAhead(eRun))) {
            const bareLocal = text.slice(i - localLen + leadChars, i);
            addr = matchEmail(bareLocal, domain);
            if (addr) {
              useAbsorbed = absorbed.slice(0, absorbed.length - leadEntries);
              useLocalLen = localLen - leadChars;
            } else {
              addr = matchEmail(text.slice(i - localLen, i), domain);
            }
          } else {
            addr = matchEmail(text.slice(i - localLen, i), domain);
          }
          if (addr) {
            const domLen = addr.length - useLocalLen - 1;
            buf = buf.slice(0, s0);
            for (const sg of useAbsorbed) {
              if (sg.partial) {
                const nd = nodes[sg.idx];
                nd.s = nd.s.slice(0, nd.s.length - sg.take);
              } else {
                nodes.splice(sg.idx, 1);
              }
            }
            flush();
            nodes.push({ k: 'autolink', href: 'mailto:' + addr, s: addr });
            i = i + 1 + domLen;
            formed = true;
          }
        }
        if (!formed) { buf += '@'; i += 1; }
        break;
      }
      case 0x3c: { // '<': autolink, comment, tag, or literal
        let done = false;
        if (text.startsWith('<!--', i)) {
          // The comment runs to the first --> found from just after
          // the opening dashes (the closer may overlap them, so
          // <!--> and <!---> are complete comments). No validation
          // of the content: a -- inside is fine.
          const end = text.indexOf('-->', i + 2);
          if (end !== -1) {
            flush();
            nodes.push({ k: 'html', s: text.slice(i, end + 3) });
            i = end + 3; done = true;
          }
        } else if (text.startsWith('<![CDATA[', i)) {
          const end = text.indexOf(']]>', i + 9);
          if (end !== -1) {
            flush();
            nodes.push({ k: 'html', s: text.slice(i, end + 3) });
            i = end + 3; done = true;
          }
        } else if (text.startsWith('<?', i)) {
          const end = text.indexOf('?>', i + 2);
          if (end !== -1) {
            flush();
            nodes.push({ k: 'html', s: text.slice(i, end + 2) });
            i = end + 2; done = true;
          }
        } else if (/^<![A-Z]/.test(text.slice(i, i + 3))) {
          const end = text.indexOf('>', i + 2);
          if (end !== -1) {
            flush();
            nodes.push({ k: 'html', s: text.slice(i, end + 1) });
            i = end + 1; done = true;
          }
        }
        if (!done) {
          AUTOLINK_SCHEME_RE.lastIndex = i;
          const sm = AUTOLINK_SCHEME_RE.exec(text);
          if (sm) {
            flush();
            nodes.push({
              k: 'link', href: sm[1] + ':' + sm[2], title: null,
              children: [{ k: 'text', s: sm[1] + ':' + sm[2] }],
            });
            i += sm[0].length;
            done = true;
          }
        }
        if (!done) {
          AUTOLINK_EMAIL_RE.lastIndex = i;
          const em = AUTOLINK_EMAIL_RE.exec(text);
          if (em) {
            flush();
            nodes.push({
              k: 'link', href: 'mailto:' + em[1], title: null,
              children: [{ k: 'text', s: em[1] }],
            });
            i += em[0].length;
            done = true;
          }
        }
        if (!done && text[i + 1] === '/') {
          // A closing tag takes no attributes: only the bare form
          // counts as a tag at all.
          CLOSE_TAG_RE.lastIndex = i;
          const cm = CLOSE_TAG_RE.exec(text);
          if (cm) {
            flush();
            nodes.push({ k: 'html', s: cm[0] });
            // Only the exact </a> ends the no-bare-autolink region.
            if (/^<\/a>$/i.test(cm[0])) state.inLink = false;
            i += cm[0].length;
            done = true;
          }
        }
        if (!done && text[i + 1] !== '/') {
          TAG_RE.lastIndex = i;
          const tm = TAG_RE.exec(text);
          if (tm) {
            flush();
            nodes.push({ k: 'html', s: tm[0] });
            // A raw <a ...> tag suppresses bare autolinks from here
            // to the matching </a> — and the state persists across
            // blocks until one appears. The tag must have a space
            // after the name and no newline outside quoted values.
            const bareTag = tm[0].replace(/"[^"]*"|'[^']*'/g, '');
            if (/^<a /i.test(tm[0]) && !bareTag.includes('\n')) {
              state.inLink = true;
            }
            i += tm[0].length;
            done = true;
          }
        }
        if (!done) { buf += '<'; i += 1; }
        break;
      }
      case 0x21: { // '!'
        if (text[i + 1] === '[') {
          flush();
          nodes.push({ k: 'bracket', image: true });
          brackets.push({
            idx: nodes.length - 1, image: true, active: true,
            srcStart: i + 2,
          });
          i += 2;
        } else {
          buf += '!';
          i += 1;
        }
        break;
      }
      case 0x5b: { // '['
        flush();
        nodes.push({ k: 'bracket', image: false });
        brackets.push({
          idx: nodes.length - 1, image: false, active: true,
          srcStart: i + 1,
        });
        i += 1;
        break;
      }
      case 0x5d: { // ']'
        const b = brackets[brackets.length - 1];
        if (!b) {
          buf += ']';
          i += 1;
        } else if (!b.active) {
          brackets.pop();
          buf += ']';
          i += 1;
        } else {
          const end = tryFormLink(b, i);
          if (end) i = end;
          else {
            brackets.pop();
            buf += ']';
            i += 1;
          }
        }
        break;
      }
      case 0x2a: case 0x5f: case 0x7e: { // '*', '_', '~': delimiter run
        let e = i;
        while (e < n && text[e] === tok) e++;
        const runLen = e - i;
        if (tok === '~' && runLen >= 3) {
          buf += text.slice(i, e);
          i = e;
          break;
        }
        const beforeCp = i === 0 ? -1 : codePointBefore(text, i);
        const afterCp = e >= n ? -1 : text.codePointAt(e);
        const beforeWs = beforeCp === -1 || isSpaceCp(beforeCp);
        const afterWs = afterCp === -1 || isSpaceCp(afterCp);
        const beforePunct = beforeCp !== -1 && isPunctCp(beforeCp);
        const afterPunct = afterCp !== -1 && isPunctCp(afterCp);
        const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
        const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
        let canOpen, canClose;
        if (tok === '_') {
          canOpen = leftFlank && (!rightFlank || beforePunct);
          canClose = rightFlank && (!leftFlank || afterPunct);
          if (canClose && usOpen > 0) usOpen--;
          else if (canOpen) usOpen++;
        } else {
          canOpen = leftFlank;
          canClose = rightFlank;
        }
        flush();
        nodes.push({
          k: 'delim', ch: tok, n: runLen, orig: runLen,
          open: canOpen, close: canClose, pos: i,
        });
        i = e;
        break;
      }
      case 0x0a: { // newline: hard break on 2+ trailing spaces, else soft
        let sp = 0;
        while (buf[buf.length - 1 - sp] === ' ') sp++;
        if (sp >= 2) {
          // A hard break swallows the next line's leading spaces —
          // but if nothing follows them, the break never forms and
          // the whole ending stays literal text.
          let j = i + 1;
          while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
          if (j >= n) {
            buf += '\n' + text.slice(i + 1, j);
            i = j;
          } else {
            buf = buf.slice(0, buf.length - sp);
            flush();
            nodes.push({ k: 'br' });
            i = j;
          }
        } else {
          buf += '\n';
          i += 1;
        }
        break;
      }
      default: {
        buf += tok;
        i += 1;
      }
    }
  }
  flush();
  if (poisonFrom !== -1) {
    for (const nd of nodes) {
      if (nd.k === 'delim' && nd.pos >= poisonFrom &&
          text.indexOf('`', nd.pos + 1) !== -1) {
        nd.open = false;
        nd.close = false;
      }
    }
  }
  processEmphasis(nodes, text);
  return nodes;
}

// A single-'*' emphasis match is poisoned when it would wrap a strong
// span whose opening run is preceded by a non-word character (start,
// whitespace or punctuation) and whose closing run is followed by a
// word character: *a **b**c* keeps its outer asterisks literal.
function emPoisoned(list, oi, ci, text) {
  for (let m = oi + 1; m < ci; m++) {
    const nd = list[m];
    if (nd.k !== 'strong' || nd.oPos === undefined) continue;
    const beforeCp = nd.oPos === 0 ? -1 : codePointBefore(text, nd.oPos);
    const beforeWord = beforeCp !== -1 && !isSpaceCp(beforeCp) &&
      !isPunctCp(beforeCp);
    const afterCp = nd.cEnd >= text.length ? -1 : text.codePointAt(nd.cEnd);
    const afterWord = afterCp !== -1 && !isSpaceCp(afterCp) &&
      !isPunctCp(afterCp);
    if (!beforeWord && afterWord) return true;
  }
  return false;
}

// Convert autolink nodes in a formed link's children back to text.
function deautolink(list) {
  for (let k = 0; k < list.length; k++) {
    const nd = list[k];
    if (nd.k === 'autolink') list[k] = { k: 'text', s: nd.s };
    else if (nd.children) deautolink(nd.children);
  }
}

// Is the em node at index m "glued" to what follows it — a text node
// starting with a non-whitespace character? (As in *b*two.)
function isGluedEm(list, m) {
  const nx = list[m + 1];
  return !!nx && nx.k === 'text' && nx.s.length > 0 &&
    !isSpaceCp(nx.s.codePointAt(0));
}

// Count em nodes of the given delimiter char in list[from..to-1] and
// note whether the last of them is glued to the following text. Also
// count the ems glued to a following word character (a letter or
// digit, as in *b*two — as opposed to *b*" where the quote is what
// follows).
function analyzeEms(list, from, to, ch) {
  let gluedCount = 0, lastGlued = false, wordGluedCount = 0;
  for (let m = from; m < to; m++) {
    const nd = list[m];
    if (nd.k === 'em' && nd.ch === ch) {
      const g = isGluedEm(list, m);
      if (g) gluedCount++;
      lastGlued = g;
      const nx = list[m + 1];
      if (nx && nx.k === 'text' && nx.s.length > 0) {
        const cp = nx.s.codePointAt(0);
        if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) ||
            (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f || cp >= 0xaa) {
          wordGluedCount++;
        }
      }
    }
  }
  return { gluedCount, lastGlued, wordGluedCount };
}

// Match emphasis/strikethrough delimiters inside a node list, wrapping
// the nodes between matched pairs. Leftover delimiters stay as delim
// nodes and render literally.
// Does the span list[from..to) hold an em (of the given delimiter
// character) whose closing run has a punctuation character on
// both sides in the original text (before the run, and after the
// whole run)? Such an em blocks an enclosing strong from forming,
// unless the span also holds another strong-capable run of the
// same character.
function spanHasPunctBoundedEm(list, from, to, ch, text) {
  for (let m = from; m < to; m++) {
    const nd = list[m];
    if (nd.k === 'delim' && nd.ch === ch && nd.n >= 2) return false;
  }
  return spanEmBlocked(list, from, to, ch, text);
}

function spanEmBlocked(list, from, to, ch, text) {
  for (let m = from; m < to; m++) {
    const nd = list[m];
    if (nd.k === 'em' && nd.ch === ch && nd.cEnd !== undefined) {
      const runStart = nd.cEnd - 1;
      let runEnd = runStart;
      while (runEnd < text.length && text[runEnd] === ch) runEnd++;
      const beforeCp = runStart > 0
        ? codePointBefore(text, runStart) : -1;
      const afterCp = runEnd < text.length
        ? text.codePointAt(runEnd) : -1;
      if (beforeCp !== -1 && afterCp !== -1 &&
          isPunctCp(beforeCp) && isPunctCp(afterCp)) return true;
    }
    if (nd.children &&
        spanEmBlocked(nd.children, 0, nd.children.length, ch, text)) {
      return true;
    }
  }
  return false;
}

// An '_' em does not form when its opener directly follows a
// punctuation character and the span holds a '__' strong whose
// opener is preceded (inside the span) only by punctuation.
function emBlockedByInnerStrong(list, oi, ci, opener, text) {
  if (opener.pos === 0) return false;
  const prevCp = codePointBefore(text, opener.pos);
  if (prevCp === -1 || !isPunctCp(prevCp)) return false;
  const from = opener.pos + opener.orig;
  const scan = (nodes) => {
    for (const nd of nodes) {
      if (nd.k === 'strong' && nd.ch === '_' && nd.oPos !== undefined) {
        const between = text.slice(from, nd.oPos);
        if (between.length > 0) {
          let allPunct = true;
          for (const chStr of between) {
            if (!isPunctCp(chStr.codePointAt(0))) { allPunct = false; break; }
          }
          if (allPunct) return true;
        }
      }
      if (nd.children && scan(nd.children)) return true;
    }
    return false;
  };
  return scan(list.slice(oi + 1, ci));
}

// Does the emphasis span from `from` to `to` (exclusive) in the
// source text contain a tag-like '<' (one followed by an ASCII
// letter) that completes (a '>' appears) only at or after `to`,
// with `to` falling inside a quoted section of that tag-like
// chunk? Such a span cannot form emphasis: the closing run is
// inside the chunk's quoted attribute value.
function spanCrossesTagChunk(text, from, to) {
  let lt = text.indexOf('<', from);
  while (lt !== -1 && lt < to) {
    const nc = text.charCodeAt(lt + 1);
    if ((nc >= 0x41 && nc <= 0x5a) || (nc >= 0x61 && nc <= 0x7a)) {
      const gt = text.indexOf('>', lt + 1);
      if (gt === -1 || gt < to) return false;
      let quote = 0;
      for (let p = lt + 1; p < to; p++) {
        const cc = text.charCodeAt(p);
        if (quote === 0) {
          if (cc === 0x22 || cc === 0x27) quote = cc;
        } else if (cc === quote) quote = 0;
      }
      return quote !== 0;
    }
    lt = text.indexOf('<', lt + 1);
  }
  return false;
}

// Is the position `pos` inside a complete <...> region of the
// source text — a '<' followed by a non-space character, with no
// '>' between it and `pos`, and a '>' somewhere at or after
// `pos` to close the region? An emphasis opener inside such a
// region does not pair.
function posInsideTagChunk(text, pos) {
  for (let p = pos - 1; p >= 0; p--) {
    const cc = text.charCodeAt(p);
    if (cc === 0x3e) return false; // '>' closes any earlier region
    if (cc === 0x20 || cc === 0x09 || cc === 0x0a || cc === 0x0d) {
      return false; // whitespace breaks the region
    }
    if (cc === 0x3c) { // '<'
      return text.indexOf('>', pos) !== -1;
    }
  }
  return false;
}

function processEmphasis(list, text) {
  let ci = 0;
  while (ci < list.length) {
    const c = list[ci];
    if (c.k !== 'delim' || !c.close || c.n === 0) { ci++; continue; }
    let opener = null, oi = -1, absorbN = 0;
    for (let k = ci - 1; k >= 0; k--) {
      const o = list[k];
      if (o.k !== 'delim' || o.ch !== c.ch || !o.open || o.n === 0) continue;
      // Strikethrough pairs only ever match runs of equal length,
      // and are not subject to the multiple-of-three rule.
      if (c.ch === '~' && o.n !== c.n) continue;
      if (c.ch !== '~' && ((o.open && o.close) || (c.open && c.close))) {
        const sum = o.orig + c.orig;
        if (sum % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) {
          continue;
        }
      }
      const useTry = o.n >= 2 && c.n >= 2 ? 2 : 1;
      if (useTry === 2 && c.ch !== '~' &&
          spanHasPunctBoundedEm(list, k + 1, ci, c.ch, text)) {
        // A strong does not form around an em whose closing run
        // is bounded by punctuation on both sides.
        continue;
      }
      if (useTry === 1 && c.ch === '*' && emPoisoned(list, k, ci, text)) {
        continue;
      }
      if (useTry === 1 && c.ch === '_' &&
          emBlockedByInnerStrong(list, k, ci, o, text)) {
        continue;
      }
      if (spanCrossesTagChunk(text,
          c.ch === '~' ? o.pos + o.n : o.pos + useTry, c.pos)) {
        continue;
      }
      if (posInsideTagChunk(text, o.pos)) {
        continue;
      }
      if (useTry === 1 && o.n >= 2 && c.n === 1 && c.ch !== '~') {
        // A lone closing delimiter does not take a multi-char opener
        // as an emphasis when the span holds a glued em and a later
        // run can still close the opener as a strong: the strong
        // wins and the lone delimiter stays literal inside it.
        let hasGluedEm = false;
        for (let m = k + 1; m < ci; m++) {
          if (list[m].k === 'em' && list[m].ch === c.ch &&
              isGluedEm(list, m)) { hasGluedEm = true; break; }
        }
        if (hasGluedEm) {
          let laterStrong = false;
          for (let m = ci + 1; m < list.length; m++) {
            const nd = list[m];
            if (nd.k === 'delim' && nd.ch === c.ch && nd.close &&
                nd.n >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) continue;
        }
      }
      if (useTry === 2 && c.ch !== '~' && c.n > 2) {
        // A strong closing run with leftover characters does not
        // form at all when two or more glued ems end the span.
        // When the span holds an em glued to a following word
        // character, the leftover characters belong inside the
        // strong (the closer used is the run's tail); otherwise
        // they stay as a delimiter run outside it.
        const a = analyzeEms(list, k + 1, ci, c.ch);
        if (a.gluedCount >= 2 && a.lastGlued) continue;
        if (a.wordGluedCount >= 1) absorbN = c.n - 2;
      }
      opener = o; oi = k; break;
    }
    if (!opener) { ci++; continue; }
    const use = c.ch === '~' ? c.n :
      opener.n >= 2 && c.n >= 2 ? 2 : 1;
    const type = c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const inner = list.splice(oi + 1, ci - oi - 1);
    const wrapped = { k: type, children: inner, ch: c.ch };
    wrapped.oPos = opener.pos;
    wrapped.cEnd = c.pos + use + absorbN;
    if (absorbN > 0) {
      wrapped.children.push({ k: 'text', s: c.ch.repeat(absorbN) });
      c.n = use;
    }
    list.splice(oi + 1, 0, wrapped);
    opener.n -= use;
    c.n -= use;
    let closerIdx = oi + 2;
    if (c.n === 0) list.splice(closerIdx, 1);
    if (opener.n === 0) { list.splice(oi, 1); closerIdx--; }
    ci = c.n > 0 ? list.indexOf(c) : closerIdx;
  }
}

// Plain-text view of a node list (used for image alt text): the
// label's rendered inline form with the tags dropped — text runs
// keep their escaped form, code spans their code escaping, raw HTML
// and autolink text their source as written.
function plainText(list) {
  let out = '';
  let pending = '';
  let pendingResets = null;
  const flush = () => {
    if (pending) {
      out += escapeTextRun(pending, pendingResets);
      pending = '';
      pendingResets = null;
    }
  };
  for (const nd of list) {
    if (nd.k === 'text') {
      if (nd.literal) { flush(); out += escapeCodeText(nd.s); }
      else pending += nd.s;
    }
    else if (nd.k === 'delim') {
      (pendingResets ??= []).push(pending.length);
      pending += nd.ch.repeat(nd.n);
    }
    else if (nd.k === 'autolink') { flush(); out += escapeHtmlText(nd.s); }
    else if (nd.k === 'code') { flush(); out += escapeCodeText(nd.s); }
    else if (nd.k === 'html') { flush(); out += nd.s; }
    else if (nd.k === 'br') { flush(); out += '\n'; }
    else if (nd.k === 'bracket') { flush(); out += nd.image ? '![' : '['; }
    else if (nd.k === 'img') { flush(); out += nd.alt; }
    else if (nd.children) { flush(); out += plainText(nd.children); }
  }
  flush();
  return out;
}

// ------------------------------------------------------------ rendering
//
// The reference cleans every URL the same way before putting it in an
// attribute: percent-encode it, then undo the encoding of any '%' that
// was already there (so existing escapes survive untouched). A URL that
// cannot be encoded at all (lone surrogates) drops the link wrapper.

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function renderNodes(list) {
  let out = '';
  // Adjacent plain text and unmatched delimiter runs are escaped as
  // ONE merged run: the reference tokenizes them as a single text
  // token, so a character reference whose name contains '_' (a
  // delimiter character) must still be seen whole by the escaper.
  // Literal (backslash-escaped) text and real tokens are barriers.
  let pending = '';
  let pendingResets = null;
  const flush = () => {
    if (pending) {
      out += escapeTextRun(pending, pendingResets);
      pending = '';
      pendingResets = null;
    }
  };
  for (const nd of list) {
    switch (nd.k) {
      case 'text':
        if (nd.literal) { flush(); out += escapeCodeText(nd.s); }
        else pending += nd.s;
        break;
      case 'delim':
        (pendingResets ??= []).push(pending.length);
        pending += nd.ch.repeat(nd.n);
        break;
      case 'code':
        flush();
        out += '<code>' + escapeCodeText(nd.s) + '</code>';
        break;
      case 'br': flush(); out += '<br>'; break;
      case 'autolink': {
        flush();
        const href = cleanUrl(nd.href);
        if (href === null) { out += escapeHtmlText(nd.s); break; }
        out += '<a href="' + escapeAttr(href) + '">' +
          escapeHtmlText(nd.s) + '</a>';
        break;
      }
      case 'html': flush(); out += nd.s; break;
      case 'bracket': flush(); out += nd.image ? '![' : '['; break;
      case 'em':
        flush();
        out += '<em>' + renderNodes(nd.children) + '</em>';
        break;
      case 'strong':
        flush();
        out += '<strong>' + renderNodes(nd.children) + '</strong>';
        break;
      case 'del':
        flush();
        out += '<del>' + renderNodes(nd.children) + '</del>';
        break;
      case 'link': {
        flush();
        const href = cleanUrl(nd.href);
        if (href === null) { out += renderNodes(nd.children); break; }
        out += '<a href="' + escapeAttr(href) + '"';
        if (nd.title != null) {
          out += ' title="' + escapeAttr(nd.title) + '"';
        }
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case 'img': {
        flush();
        const src = cleanUrl(nd.src);
        if (src === null) { out += escapeHtmlText(nd.alt); break; }
        out += '<img src="' + escapeAttr(src) + '" alt="' +
          escapeAttr(nd.alt) + '"';
        if (nd.title != null) {
          out += ' title="' + escapeAttr(nd.title) + '"';
        }
        out += '>';
        break;
      }
    }
  }
  flush();
  return out;
}

function renderInlines(text, refs, state) {
  return renderNodes(parseInlines(text, refs, state));
}

const TASK_RE = /^\[([ xX])\] /;

function renderItem(item, loose, refs, state) {
  let out = '<li>';
  const kids = item.children;
  for (let k = 0; k < kids.length; k++) {
    const child = kids[k];
    if (child.type === 'paragraph' && !loose) {
      let text = child.text;
      if (k === 0) {
        const m = TASK_RE.exec(text);
        if (m) {
          out += m[1] === ' '
            ? '<input disabled="" type="checkbox"> '
            : '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(4);
        }
      }
      out += renderInlines(text, refs, state);
    } else if (child.type === 'paragraph' && k === 0) {
      // Loose list: the paragraph keeps its <p> wrapper; a task
      // checkbox goes inside it, ahead of the text.
      const m = TASK_RE.exec(child.text);
      if (m) {
        out += '<p>' + (m[1] === ' '
          ? '<input disabled="" type="checkbox"> '
          : '<input checked="" disabled="" type="checkbox"> ') +
          renderInlines(child.text.slice(4), refs, state) + '</p>\n';
      } else {
        out += renderBlock(child, refs, state);
      }
    } else {
      out += renderBlock(child, refs, state);
    }
  }
  return out + '</li>\n';
}

function renderBlock(b, refs, state) {
  switch (b.type) {
    case 'paragraph':
      return '<p>' + renderInlines(b.text, refs, state) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInlines(b.text, refs, state) +
        '</h' + b.level + '>\n';
    case 'code': {
      const cls = b.lang
        ? ' class="language-' + escapeAttr(b.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeCodeText(b.text) +
        '</code></pre>\n';
    }
    case 'thematicBreak':
      return '<hr>\n';
    case 'html':
      return b.text + (b._addNl ? '\n' : '');
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const child of b.children) out += renderBlock(child, refs, state);
      return out + '</blockquote>\n';
    }
    case 'list': {
      let out;
      if (b.listKind === 'ordered') {
        out = b.start !== 1 && b.start != null
          ? '<ol start="' + b.start + '">\n' : '<ol>\n';
      } else {
        out = '<ul>\n';
      }
      for (const item of b.children) {
        out += renderItem(item, b.loose, refs, state);
      }
      return out + (b.listKind === 'ordered' ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const al = b.align[k];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' +
          renderInlines(b.header[k], refs, state) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < b.header.length; k++) {
            const al = b.align[k];
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' +
              renderInlines(row[k], refs, state) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    default:
      return '';
  }
}

function renderDocument(doc) {
  // One inline state for the whole document: a raw <a> tag opened in
  // any block suppresses bare autolinks in every later block until a
  // </a> appears.
  const state = { inLink: false };
  let out = '';
  for (const child of doc.children) out += renderBlock(child, doc.refs, state);
  return out;
}

export function parse(markdown) {
  const src = String(markdown)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\0/g, '�');
  const doc = blockParse(src);
  return renderDocument(doc);
}
