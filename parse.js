// parse.js — a fast, dependency-free Markdown-to-HTML renderer whose output
// matches marked 18.1.3 (default options: gfm, no breaks, no pedantic)
// byte for byte. Written from scratch against the CommonMark 0.31.2 and
// GFM 0.29 specs plus observed reference behaviour.
//
// Layout: small text helpers first, then the inline engine (single scan
// with a delimiter-run emphasis matcher), then the line-oriented block
// parser (prescan classification + recursive container handling), and
// finally the public parse() entry point.

// ---------------------------------------------------------------- helpers

const CC_TAB = 9, CC_LF = 10, CC_CR = 13, CC_SP = 32;

function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

// Escape a string used as literal code content: every special char encoded.
function escapeCode(s) {
  let out = '', i = 0, start = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape a string for use inside a double-quoted attribute value.
// An ampersand that begins an entity-looking reference is left alone.
const RE_ENTITY_AT = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/;
function escapeAttr(s) {
  let out = '', i = 0, start = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (RE_ENTITY_AT.test(s.slice(i, i + 24))) continue;
      rep = '&amp;';
    }
    else if (c === 34) rep = '&quot;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// URL preparation applied to link destinations and autolink hrefs:
// percent-encode the way the reference does (encodeURI semantics, with a
// guard for lone surrogates).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Decode the code point of a numeric character reference; invalid values
// (zero, surrogates, beyond U+10FFFF) become U+FFFD.
function entityChar(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
  return String.fromCodePoint(cp);
}

// Escape one decoded character as inline text.
function escapeTextChar(ch, code) {
  if (code === 38) return '&amp;';
  if (code === 60) return '&lt;';
  if (code === 62) return '&gt;';
  if (code === 34) return '&quot;';
  if (code === 39) return '&#39;';
  return ch;
}

const RE_UNICODE_PUNCT = /\p{P}|\p{S}/u;
const RE_WS_CHAR = /\s/;

// Character classification for delimiter flanking. `ch` is a single
// character string, or '' at a text boundary (counts as whitespace).
function charIsWs(ch) {
  return ch === '' || RE_WS_CHAR.test(ch);
}
function charIsPunct(ch) {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return isAsciiPunct(code);
  return RE_UNICODE_PUNCT.test(ch);
}

// Resolve backslash escapes of ASCII punctuation in a short string
// (used for link labels and destinations).
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Normalise a link label for reference lookup: collapse every
// whitespace run to a single space, trim, fold case. Backslash escapes
// are NOT resolved (labels match on their raw spelling), but the
// lowercase fold maps ß to ss (so ẞ, ß, ss and SS all match).
function normaliseLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------------------------------------------------------------- inline
//
// The inline parser scans a text segment once, dispatching on character
// codes. Plain runs are copied verbatim (they cannot contain a character
// that needs escaping: every escapable character is a dispatch point).
// Constructs become tokens; emphasis, strikethrough and link labels are
// resolved by a delimiter-run matcher over the token list.

// Characters that interrupt a plain text run.
const INTERESTING = new Uint8Array(128);
for (const c of [92, 96, 60, 38, 91, 93, 33, 42, 95, 126, 64, 10, 62, 34, 39,
  119, 87, 104, 72, 102, 70]) INTERESTING[c] = 1;

function isLocalChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 46 || code === 95 ||
    code === 37 || code === 43 || code === 45;
}

function isResourceChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 46 || code === 64;
}

// Escape a raw string as ordinary inline text (entity-aware), used when a
// would-be autolink inside a link label is demoted back to plain text.
function escTextRun(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const ent = matchEntity(s, i);
      if (ent) { out += ent.text; i = ent.end - 1; continue; }
      out += '&amp;';
    } else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

// At s[i] === '&': a numeric reference decodes to its character (escaped
// as text); a named-looking reference passes through unchanged; anything
// else is not an entity. Returns {text, end} or null.
function matchEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    if (hex) {
      while (j < n && j - ds < 6 && isHexDigit(s.charCodeAt(j))) j++;
    } else {
      while (j < n && j - ds < 7 && isDigit(s.charCodeAt(j))) j++;
    }
    if (j === ds || j >= n || s[j] !== ';') return null;
    const cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
    const ch = entityChar(cp);
    return { text: escapeTextChar(ch, cp < 128 ? cp : 0), end: j + 1, decoded: true, ch };
  }
  const ds = j;
  while (j < n && isWordChar(s.charCodeAt(j))) j++;
  if (j === ds || j >= n || s[j] !== ';') return null;
  return { text: s.slice(i, j + 1), end: j + 1, decoded: false };
}

function isDigit(c) { return c >= 48 && c <= 57; }
function isHexDigit(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) || c === 95;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Scan a code span opening at text[i] (a run of backticks). Returns
// {html, end} or null when no closing run exists.
function scanCodeSpan(text, i) {
  const n = text.length;
  let run = 0;
  while (i + run < n && text[i + run] === '`') run++;
  let j = i + run;
  while (j < n) {
    if (text[j] === '`') {
      let r2 = 0;
      while (j + r2 < n && text[j + r2] === '`') r2++;
      if (r2 === run) {
        let content = text.slice(i + run, j).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' &&
            content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        return {
          html: '<code>' + escapeCode(content) + '</code>',
          content, end: j + r2,
        };
      }
      j += r2;
    } else j++;
  }
  return null;
}

// Extended (GFM) autolink body scan: from `start` (just past the prefix),
// consume the URL run and apply the trailing trims. Returns the end index
// of the link text, or -1 when nothing linkable remains.
function scanExtUrl(text, start, prefixLen, inBracket) {
  const n = text.length;
  // The run ends at whitespace or '<'. Inside a bracket that can
  // still form a link, the run also stops at a ']' that begins a
  // link target ('(' or '[' follows), so the enclosing link forms.
  const atStop = (j) => {
    const c = text.charCodeAt(j);
    if (c <= 32 || c === 60) return true;
    if (inBracket && c === 93) {
      const nx = text[j + 1];
      if (nx === '(' || nx === '[') return true;
    }
    return false;
  };
  let end = start;
  while (end < n && !atStop(end)) end++;
  // Paren groups: a '(' opens a group that ends at the next ')'.
  // A '(' with no ')' later in the run cuts the link just before it.
  const groupCloses = new Set();
  for (let i = start; i < end; i++) {
    if (text[i] === '(') {
      const close = text.indexOf(')', i + 1);
      if (close === -1 || close >= end) { end = i; break; }
      groupCloses.add(close);
      i = close;
    }
  }
  // Trailing trims, interleaved until stable.
  for (;;) {
    if (end <= start) break;
    const last = text[end - 1];
    if (last === ';') {
      // A trailing named entity is excluded as a whole; a numeric one
      // only loses its semicolon (plain punctuation trim below).
      let amp = end - 2;
      while (amp >= start && isWordChar(text.charCodeAt(amp))) amp--;
      if (amp >= start && text[amp] === '&' && amp < end - 2) { end = amp; continue; }
      end--; continue;
    }
    if (last === '?' || last === '!' || last === '.' || last === ',' ||
        last === ':' || last === '*' || last === '_' || last === '~' ||
        last === "'" || last === '"') { end--; continue; }
    if (last === ')') {
      // A trailing ')' is dropped unless it closes a paren group.
      if (groupCloses.has(end - 1)) break;
      end--; continue;
    }
    break;
  }
  if (end - (start - prefixLen) <= prefixLen) return -1;
  return end;
}

// Validate an extended-email candidate: `local` is the text before '@',
// the domain is scanned from `ds` in `text`. Returns end index or -1.
function scanExtEmailDomain(text, ds, hasUndOpener) {
  const n = text.length;
  let i = ds;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isAlpha(c) || isDigit(c) || c === 46 || c === 45 || c === 95) i++;
    else break;
  }
  let end = i;
  // A trailing '_' run is delimiter territory: with an unmatched
  // '_' opener in scope it stays outside the address (the emphasis
  // engine will claim it); without one the address is rejected.
  if (end > ds && text[end - 1] === '_') {
    let rs = end;
    while (rs > ds && text[rs - 1] === '_') rs--;
    if (!hasUndOpener) return -1;
    end = rs;
  }
  // Trailing dots are not part of the address.
  while (end > ds && text[end - 1] === '.') end--;
  if (end === ds) return -1;
  const dom = text.slice(ds, end);
  if (dom.indexOf('.') === -1) return -1;
  if (dom[0] === '.' || dom.indexOf('..') !== -1) return -1;
  const lastCode = text.charCodeAt(end - 1);
  if (!isAlpha(lastCode) && !isDigit(lastCode)) return -1;
  return end;
}

const RE_TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const RE_ATTR_NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;

// Scan an inline HTML tag (or comment / PI / declaration / CDATA) at
// text[i] === '<'. Returns {end, name, closing} or null.
function scanTag(text, i) {
  const n = text.length;
  const c1 = i + 1 < n ? text[i + 1] : '';
  if (c1 === '!') {
    if (text.startsWith('<!--', i)) {
      if (text.startsWith('<!-->', i)) return { end: i + 5, name: '', closing: false };
      if (text.startsWith('<!--->', i)) return { end: i + 6, name: '', closing: false };
      const e = text.indexOf('-->', i + 4);
      if (e === -1) return null;
      return { end: e + 3, name: '', closing: false };
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e === -1) return null;
      return { end: e + 3, name: '', closing: false };
    }
    if (i + 2 < n && isAlpha(text.charCodeAt(i + 2))) {
      const e = text.indexOf('>', i + 2);
      if (e === -1) return null;
      return { end: e + 1, name: '', closing: false };
    }
    return null;
  }
  if (c1 === '?') {
    const e = text.indexOf('?>', i + 2);
    if (e === -1) return null;
    return { end: e + 2, name: '', closing: false };
  }
  let j = i + 1;
  let closing = false;
  if (c1 === '/') { closing = true; j = i + 2; }
  RE_TAG_NAME.lastIndex = j;
  const nm = RE_TAG_NAME.exec(text);
  if (!nm) return null;
  const name = nm[0].toLowerCase();
  j += nm[0].length;
  if (closing) {
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j < n && text[j] === '>') return { end: j + 1, name, closing };
    return null;
  }
  // Open tag: whitespace-separated attributes, then > or />.
  for (;;) {
    let ws = 0;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) { j++; ws++; }
    if (j >= n) return null;
    if (text[j] === '>') return { end: j + 1, name, closing };
    if (text[j] === '/' && j + 1 < n && text[j + 1] === '>') {
      return { end: j + 2, name, closing };
    }
    if (ws === 0) return null;
    RE_ATTR_NAME.lastIndex = j;
    const am = RE_ATTR_NAME.exec(text);
    if (!am) return null;
    j += am[0].length;
    // Optional = value (whitespace allowed around '=').
    let k = j;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    if (k < n && text[k] === '=') {
      k++;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      if (k >= n) return null;
      const q = text[k];
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, k + 1);
        if (e === -1) return null;
        j = e + 1;
      } else {
        let v = k;
        while (v < n) {
          const c = text.charCodeAt(v);
          if (c <= 32 || c === 34 || c === 39 || c === 61 || c === 60 ||
              c === 62 || c === 96) break;
          v++;
        }
        if (v === k) return null;
        j = v;
      }
    }
  }
}

const RE_SCHEME = /[A-Za-z][A-Za-z0-9+.-]{1,31}:/y;
const RE_ANGLE_EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// At text[i] === '<': try an angle autolink. Returns {html, end} or null.
function scanAngleAutolink(text, i) {
  const gt = text.indexOf('>', i + 1);
  if (gt === -1) return null;
  const inner = text.slice(i + 1, gt);
  if (inner.length === 0) return null;
  RE_SCHEME.lastIndex = 0;
  const sm = RE_SCHEME.exec(inner);
  if (sm) {
    const rest = inner.slice(sm[0].length);
    if (!/[\s<]/.test(rest)) {
      const href = cleanUrl(inner);
      return {
        html: '<a href="' + escapeAttr(href) + '">' + escTextRun(inner) + '</a>',
        end: gt + 1, inner,
      };
    }
  }
  if (RE_ANGLE_EMAIL.test(inner)) {
    return {
      html: '<a href="mailto:' + escapeAttr(inner) + '">' + escTextRun(inner) + '</a>',
      end: gt + 1, inner,
    };
  }
  return null;
}

// Parse a link destination/title group starting at text[i] === '('.
// Returns {href, title, end} or null. Titles use '' when absent so that
// a present-but-empty title can be told apart.
function scanParenTarget(text, i) {
  const n = text.length;
  let j = i + 1;
  let wsSkipped = 0;
  const skipWs = () => {
    wsSkipped = 0;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) { j++; wsSkipped++; }
      else break;
    }
  };
  skipWs();
  let href = '';
  if (j < n && text[j] === '<') {
    // Angle destination: up to the next unescaped '>'.
    let k = j + 1, closed = false;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\' && k + 1 < n) { k += 2; continue; }
      if (ch === '>') { closed = true; break; }
      if (ch === '<' || ch === '\n') return null;
      k++;
    }
    if (!closed) return null;
    href = unescapePunct(text.slice(j + 1, k));
    j = k + 1;
  } else {
    // Bare destination: balanced parentheses, no spaces or controls.
    let depth = 0, k = j;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c <= 32) break;
      const ch = text[k];
      if (ch === '\\' && k + 1 < n && isAsciiPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    href = unescapePunct(text.slice(j, k));
    j = k;
  }
  skipWs();
  let title = null;
  if (j < n && text[j] !== ')') {
    if (wsSkipped === 0) return null;
    const q = text[j];
    if (q === '"' || q === "'") {
      let k = j + 1, closed = false;
      while (k < n) {
        if (text[k] === '\\' && k + 1 < n) { k += 2; continue; }
        if (text[k] === q) { closed = true; break; }
        k++;
      }
      if (!closed) return null;
      title = unescapePunct(text.slice(j + 1, k));
      j = k + 1;
    } else if (q === '(') {
      let k = j + 1, closed = false;
      while (k < n) {
        if (text[k] === '\\' && k + 1 < n) { k += 2; continue; }
        if (text[k] === '(') return null;
        if (text[k] === ')') { closed = true; break; }
        k++;
      }
      if (!closed) return null;
      title = unescapePunct(text.slice(j + 1, k));
      j = k + 1;
    } else {
      return null;
    }
    skipWs();
  }
  if (j < n && text[j] === ')') return { href, title, end: j + 1 };
  return null;
}

// The delimiter matcher. Operates on toks[lo..hi): finds emphasis /
// strikethrough pairs among delimiter tokens and splices the tag tokens
// in. Returns the list of formed pairs (for callers that track them).
function processEmphasis(toks, lo, hi, text, plain, brackets) {
  const ds = [];
  for (let k = lo; k < hi; k++) {
    if (toks[k].k === 'd') ds.push(toks[k]);
  }
  const pairs = [];
  if (ds.length === 0) return pairs;

  // Marked's crossing block: a candidate pair may not reach across a
  // completed inner pair when the text before the inner pair ends with
  // whitespace, the tail after it starts with a letter or digit, and
  // the tail holds no inert run of the inner pair's length. Whether
  // the block then applies depends on the runs' original lengths and
  // the two uses (see crossedBlock).
  const textBeforeEndsWs = (fromTok, toTok) => {
    const s = text.slice(fromTok.pos + fromTok.orig, toTok.pos);
    return s.length > 0 && /[ \t\n]/.test(s[s.length - 1]);
  };
  const tailInfo = (inner, closerTok) => {
    const s = text.slice(inner.c.pos + inner.c.orig, closerTok.pos);
    if (s.length === 0 || !/[\p{L}\p{N}]/u.test(s[0])) return null;
    // Inert run: a run of the inner pair's character with exactly the
    // inner pair's use length, followed by whitespace or the tail end.
    const ch = inner.c.ch;
    for (let k = 0; k < s.length; k++) {
      if (s[k] !== ch) continue;
      let r = 0;
      while (k + r < s.length && s[k + r] === ch) r++;
      if (r === inner.use &&
          (k + r === s.length || /[ \t\n]/.test(s[k + r]))) return null;
      k += r - 1;
    }
    return s;
  };
  const crossedBlock = (o, closer, u) => {
    for (const p of pairs) {
      if (p.o.ch !== o.ch) continue;
      if (p.o.pos <= o.pos || p.c.pos >= closer.pos) continue;
      if (!textBeforeEndsWs(o, p.o)) continue;
      if (tailInfo(p, closer) === null) continue;
      // The block applies unless the uses and original lengths say
      // otherwise (matrix derived from oracle probes).
      if (p.use === u) { if (o.orig > closer.orig) return true; }
      else if (u === 1) return true;
      else if (closer.orig <= o.orig) return true;
    }
    return false;
  };

  // Inside a label that failed over a backtick-bearing code span,
  // an emphasis pair may not reach across such a span.
  const tickBan = (o, closer) => {
    const spans = brackets && brackets.tickBadSpans;
    const ranges = brackets && brackets.tickBadLabels;
    if (!spans || !ranges || spans.length === 0 || ranges.length === 0) {
      return false;
    }
    for (const r of ranges) {
      if (o.pos <= r[0] || closer.pos >= r[1]) continue;
      for (const s of spans) {
        if (o.pos < s.start && closer.pos >= s.end) return true;
      }
    }
    return false;
  };

  // Poisoned-label rule: after an inline link or image whose label
  // held two or more unmatched backtick runs, a candidate pair is
  // blocked when some backtick run occurs after the closer and an
  // even number of backtick runs sit between opener and closer.
  // (Derived from oracle probes; reference links do not poison.)
  const poisonSkip = (o, closer) => {
    const pp = brackets && brackets.poisonPos;
    const tr = brackets && brackets.tickRuns;
    if (!pp || !tr || pp.length === 0 || tr.length === 0) return false;
    let poisoned = false;
    for (const p of pp) if (p < o.pos) { poisoned = true; break; }
    if (!poisoned) return false;
    let after = false, between = 0;
    for (const p of tr) {
      if (p > closer.pos) after = true;
      if (p > o.pos && p < closer.pos) between++;
    }
    return after && between % 2 === 0;
  };

  let ci = 0;
  while (ci < ds.length) {
    const closer = ds[ci];
    if (!closer.close || closer.len === 0) { ci++; continue; }
    // Find the nearest earlier opener that may pair with this closer.
    let oi = ci - 1, found = -1, use = 0;
    while (oi >= 0) {
      const o = ds[oi];
      if (o.ch === closer.ch && o.open && o.len > 0) {
        if (o.ch === '~') {
          if (o.orig === closer.orig && !poisonSkip(o, closer)) {
            found = oi; use = o.orig; break;
          }
        } else {
          let u = (o.len >= 2 && closer.len >= 2) ? 2 : 1;
          // Rule of three.
          const odd = (o.open && o.close) || (closer.open && closer.close);
          if (!(odd && (o.orig + closer.orig) % 3 === 0 &&
                !(o.orig % 3 === 0 && closer.orig % 3 === 0))) {
            if (crossedBlock(o, closer, u)) {
              // A blocked strong candidate may still pair as em.
              if (u === 2 && !crossedBlock(o, closer, 1)) u = 1;
              else { oi--; continue; }
            }
            if (tickBan(o, closer)) { oi--; continue; }
            if (poisonSkip(o, closer)) { oi--; continue; }
            found = oi; use = u; break;
          }
        }
      }
      oi--;
    }
    if (found === -1) { ci++; continue; }
    const opener = ds[found];
    opener.len -= use;
    closer.len -= use;
    pairs.push({ o: opener, c: closer, use });
    // Delimiters between the pair are spent (can no longer match).
    ds.splice(found + 1, ci - found - 1);
    ci = found + 1; // index of closer after the splice
    if (closer.len === 0) { ds.splice(ci, 1); }
    // If the closer still has length, retry it against earlier openers.
  }
  // Apply the wraps in formation order: each open tag goes immediately
  // after its opener token, each close tag immediately before its
  // closer token, so pairs sharing a delimiter nest correctly. In
  // plain-text mode (image alt), pairs simply vanish.
  if (plain) return pairs;
  // Rule (c): a strong closer's leftover lands inside the pair when a
  // completed inner pair's tail (up to this closer) is free of
  // whitespace and of the pair's character.
  const lastPairOfCloser = new Map();
  for (const p of pairs) lastPairOfCloser.set(p.c, p);
  for (let p = 0; p < pairs.length; p++) {
    const { o, c, use } = pairs[p];
    const tag = o.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const oi = toks.indexOf(o), ci2 = toks.indexOf(c);
    let inside = false;
    if (use === 2 && c.len > 0 && lastPairOfCloser.get(c) === pairs[p]) {
      for (const q of pairs) {
        if (q === pairs[p] || q.o.ch !== o.ch) continue;
        if (q.o.pos <= o.pos || q.c.pos >= c.pos) continue;
        const tail = text.slice(q.c.pos + q.c.orig, c.pos);
        if (!/[ \t\n]/.test(tail) && !tail.includes(c.ch)) {
          inside = true;
          break;
        }
      }
    }
    if (inside) toks.splice(ci2 + 1, 0, { k: 't', s: '</' + tag + '>' });
    else toks.splice(ci2, 0, { k: 't', s: '</' + tag + '>' });
    toks.splice(oi + 1, 0, { k: 't', s: '<' + tag + '>' });
  }
  return pairs;
}

function renderToks(toks, lo, hi, plain) {
  let out = '';
  for (let k = lo; k < hi; k++) {
    const t = toks[k];
    if (t.k === 't') out += t.s;
    else if (t.k === 'd') { if (t.len > 0) out += t.ch.repeat(t.len); }
    else if (t.k === 'b') out += t.img ? '![' : '[';
    else if (t.k === 'x') out += plain ? t.raw : t.html;
  }
  return out;
}

// The main inline entry point. With `plain` set, the result is the
// segment's plain text (used for image alt attributes): constructs
// contribute their text, tags their raw source, entities their decoded
// character (numeric) or raw spelling (named).
function inline(text, ctx, plain) {
  const n = text.length;
  const toks = [];
  const brackets = [];
  let buf = '';
  let i = 0;
  // Source index up to which everything consumed is plain text or soft
  // delimiters; an email local part may not reach back past this point.
  let cleanFrom = 0;
  // Inside an <a ...> element (until </a>), extended autolinks are off.
  // Whether the scan is inside an <a ...> element: extended
  // autolinks stay literal there. The flag lives on the document
  // state (marked keeps it in the lexer), so an unclosed <a> in one
  // block suppresses autolinks in later blocks too.
  const inA = () => ctx.state.inA;
  // An autolink run stops at a following ']' only while the
  // innermost open bracket can still form a link (an image, or a
  // bracket with no link inside it yet).
  const bracketStop = () => {
    if (brackets.length === 0) return false;
    const b = brackets[brackets.length - 1];
    return b.img || !b.hasLink;
  };

  const flush = () => {
    if (buf !== '') { toks.push({ k: 't', s: buf }); buf = ''; }
  };
  const pushTok = (t) => { flush(); toks.push(t); };

  while (i < n) {
    const code = text.charCodeAt(i);
    if (code >= 128 || !INTERESTING[code]) {
      // Plain run: copy until the next interesting character.
      let j = i + 1;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c < 128 && INTERESTING[c]) break;
        j++;
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    switch (code) {
      case 92: { // backslash
        const nx = i + 1 < n ? text.charCodeAt(i + 1) : -1;
        if (nx === 10) {
          // Hard break: drop trailing spaces of the pending text and
          // any spaces or tabs that open the next line.
          buf = buf.replace(/ +$/, '');
          pushTok({ k: 't', s: plain ? '' : '<br>' });
          i += 2;
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        } else if (nx !== -1 && isAsciiPunct(nx)) {
          pushTok({ k: 't', s: plain ? text[i + 1] : escapeTextChar(text[i + 1], nx) });
          // An escaped backtick still counts as a backtick run for
          // the poisoned-label emphasis rule (see processEmphasis).
          if (nx === 96) (brackets.tickRuns ??= []).push(i + 1);
          i += 2;
          cleanFrom = i;
        } else {
          buf += '\\';
          i += 1;
        }
        break;
      }
      case 10: { // newline: hard break when preceded by 2+ spaces
        if (buf.endsWith('  ')) {
          buf = buf.replace(/ +$/, '');
          pushTok({ k: 't', s: plain ? '' : '<br>' });
          i += 1;
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        } else {
          buf += '\n';
          i += 1;
        }
        break;
      }
      case 96: { // backtick: code span
        (brackets.tickRuns ??= []).push(i);
        let span = scanCodeSpan(text, i);
        if (brackets.length > 0) {
          // A span that would jump past the innermost open bracket's
          // ']' is not a span at all (marked keeps label spans
          // local) — except a run of one backtick that is the first
          // backtick run inside that bracket, which may jump.
          const top = brackets[brackets.length - 1];
          let run = 0;
          while (i + run < n && text[i + run] === '`') run++;
          const mayJump = run === 1 && !top.sawTick;
          top.sawTick = true;
          if (span && !mayJump) {
            let d = brackets.length, jumps = false;
            for (let p = i; p < span.end; p++) {
              const cc = text.charCodeAt(p);
              if (cc === 92) { p++; continue; }
              if (cc === 91) d++;
              else if (cc === 93) {
                if (d === brackets.length) { jumps = true; break; }
                d--;
              }
            }
            if (jumps) span = null;
          }
        }
        if (span) {
          const tok = { k: 't', s: plain ? span.content : span.html };
          // A code span whose content itself holds a backtick is
          // marked: it poisons an enclosing link label unless it is
          // the label's very last token (see closeBracket).
          let run = 0;
          while (i + run < n && text[i + run] === '`') run++;
          brackets.tickRuns.push(span.end - run);
          if (text.slice(i + run, span.end - run).includes('`')) {
            tok.tickBad = true;
            (brackets.tickBadSpans ??= []).push({ start: i, end: span.end });
          }
          pushTok(tok);
          i = span.end;
          cleanFrom = i;
        } else {
          let run = 0;
          while (i + run < n && text[i + run] === '`') run++;
          buf += '`'.repeat(run);
          i += run;
          // An unmatched backtick run toggles the code state of
          // every enclosing link label (marked scans labels with a
          // per-run toggle; an odd count blocks the link). Two or
          // more unmatched runs in a formed inline link's label
          // poison later emphasis in the segment (see closeBracket).
          for (const b of brackets) {
            b.tickParity = (b.tickParity || 0) + 1;
            b.tickUnmatched = (b.tickUnmatched || 0) + 1;
          }
        }
        break;
      }
      case 38: { // ampersand: entity or literal
        const ent = matchEntity(text, i);
        if (ent) {
          buf += plain && ent.decoded ? ent.ch : ent.text;
          i = ent.end;
        }
        else { buf += plain ? '&' : '&amp;'; i += 1; }
        break;
      }
      case 60: { // '<': autolink, tag, or literal
        const auto = scanAngleAutolink(text, i);
        if (auto) {
          pushTok({ k: 't', s: plain ? auto.inner : auto.html });
          i = auto.end; cleanFrom = i; break;
        }
        const tag = scanTag(text, i);
        if (tag) {
          const raw = text.slice(i, tag.end);
          pushTok({ k: 't', s: raw });
          if (tag.name === 'a') {
            if (tag.closing) ctx.state.inA = false;
            else if (text[i + 2] === ' ' || text[i + 2] === '\t') ctx.state.inA = true;
          }
          i = tag.end;
          cleanFrom = i;
          break;
        }
        buf += plain ? '<' : '&lt;';
        i += 1;
        break;
      }
      case 62: buf += plain ? '>' : '&gt;'; i += 1; break;
      case 34: buf += plain ? '"' : '&quot;'; i += 1; break;
      case 39: buf += plain ? "'" : '&#39;'; i += 1; break;
      case 33: { // '!': image opener only when followed by '['
        if (i + 1 < n && text[i + 1] === '[') {
          flush();
          const tok = { k: 'b', img: true, pos: i, hasLink: false };
          toks.push(tok);
          brackets.push(tok);
          i += 2;
        } else {
          buf += '!'; i += 1;
        }
        break;
      }
      case 91: { // '['
        flush();
        const tok = { k: 'b', img: false, pos: i, hasLink: false };
        toks.push(tok);
        brackets.push(tok);
        i += 1;
        break;
      }
      case 93: { // ']': try to form a link or image
        flush();
        const formed = closeBracket(text, i, toks, brackets, ctx, plain);
        if (formed) {
          i = formed.end;
          cleanFrom = i;
        } else {
          buf += ']';
          i += 1;
        }
        break;
      }
      case 42: case 95: case 126: { // '*', '_', '~' delimiter runs
        let run = 0;
        while (i + run < n && text.charCodeAt(i + run) === code) run++;
        const ch = text[i];
        if (ch === '~' && run > 2) {
          buf += '~'.repeat(run);
          i += run;
          break;
        }
        const prevCh = i === 0 ? '' : text[i - 1];
        const nextCh = i + run >= n ? '' : text[i + run];
        const prevWs = charIsWs(prevCh), nextWs = charIsWs(nextCh);
        const prevPu = charIsPunct(prevCh), nextPu = charIsPunct(nextCh);
        const leftFlank = !nextWs && (!nextPu || prevWs || prevPu);
        const rightFlank = !prevWs && (!prevPu || nextWs || nextPu);
        let canOpen, canClose;
        if (ch === '*') { canOpen = leftFlank; canClose = rightFlank; }
        else if (ch === '_') {
          canOpen = leftFlank && (!rightFlank || prevPu);
          canClose = rightFlank && (!leftFlank || nextPu);
        } else { // '~'
          canOpen = !nextWs;
          canClose = !prevWs;
        }
        flush();
        toks.push({
          k: 'd', ch, len: run, orig: run,
          open: canOpen, close: canClose, pos: i,
        });
        i += run;
        break;
      }
      case 64: { // '@': possible extended email autolink
        const hasUndOpener = toks.some(
          (t) => t.k === 'd' && t.ch === '_' && t.open && t.len > 0);
        const em = inA() ? null : tryExtEmail(text, i, cleanFrom, hasUndOpener);
        if (em) {
          buf = dropTextTail(toks, buf, em.localLen);
          pushTok({ k: 'x', raw: em.raw, html: em.html });
          i = em.end;
          cleanFrom = i;
        } else {
          buf += '@';
          i += 1;
        }
        break;
      }
      case 119: case 87: { // 'w' / 'W': possible www. autolink
        const prevOk = !inA() && (i === 0 || (() => {
          const p = text[i - 1];
          return p === ' ' || p === '\t' || p === '\n' || p === '(' ||
            p === '~' || p === '*' || p === '_';
        })());
        if (prevOk && text.startsWith('www.', i)) {
          const end = scanExtUrl(text, i + 4, 4, bracketStop());
          if (end !== -1) {
            const raw = text.slice(i, end);
            pushTok({
              k: 'x', raw,
              html: '<a href="http://' + escapeAttr(cleanUrl(raw)) + '">' +
                escTextRun(raw) + '</a>',
            });
            i = end;
            cleanFrom = i;
            break;
          }
        }
        buf += text[i]; i += 1;
        break;
      }
      case 104: case 72: case 102: case 70: { // 'h','H','f','F': scheme autolink
        const sch = inA() ? 0 : matchSchemePrefix(text, i);
        if (sch > 0) {
          const end = scanExtUrl(text, i + sch, sch, bracketStop());
          if (end !== -1) {
            const raw = text.slice(i, end);
            pushTok({
              k: 'x', raw,
              html: '<a href="' + escapeAttr(cleanUrl(raw)) + '">' +
                escTextRun(raw) + '</a>',
            });
            i = end;
            cleanFrom = i;
            break;
          }
        }
        buf += text[i]; i += 1;
        break;
      }
      default:
        buf += text[i];
        i += 1;
        break;
    }
  }
  flush();
  processEmphasis(toks, 0, toks.length, text, plain, brackets);
  return renderToks(toks, 0, toks.length, plain);
}

// Length of a scheme prefix (http://, https://, ftp://, any case) at
// text[i], or 0.
function matchSchemePrefix(text, i) {
  const c = text.charCodeAt(i);
  if (c === 104 || c === 72) { // h
    if (text.slice(i, i + 4).toLowerCase() === 'http') {
      let j = i + 4;
      if (text[j] === 's' || text[j] === 'S') j++;
      if (text.startsWith('://', j)) return j + 3 - i;
    }
    return 0;
  }
  if (c === 102 || c === 70) { // f
    if (text.slice(i, i + 3).toLowerCase() === 'ftp' &&
        text.startsWith('://', i + 3)) return 6;
  }
  return 0;
}

// At text[i] === '@': try to form an extended email autolink. The local
// part is the run of local characters in the source ending at i, not
// reaching back past `cleanFrom` (the end of the last hard construct).
// Returns {localLen, raw, html, end} or null; localLen counts the source
// characters (local part plus any mailto:/xmpp: prefix) to remove from
// the pending text.
function tryExtEmail(text, i, cleanFrom, hasUndOpener) {
  let s = i;
  while (s > cleanFrom && isLocalChar(text.charCodeAt(s - 1))) {
    if (text[s - 1] === '_') {
      // A '_' run joins the local part only when it is intraword
      // (alphanumerics on both sides); otherwise it is a delimiter
      // run and the local part starts after it.
      let rs = s;
      while (rs > cleanFrom && text[rs - 1] === '_') rs--;
      const before = rs > 0 ? text.charCodeAt(rs - 1) : -1;
      const after = s < i ? text.charCodeAt(s) : -1;
      if (!(isAlpha(before) || isDigit(before)) ||
          !(isAlpha(after) || isDigit(after))) { s = rs + (s - rs); break; }
      s = rs;
      continue;
    }
    s--;
  }
  if (s === i) return null;
  const end = scanExtEmailDomain(text, i + 1, hasUndOpener);
  if (end === -1) return null;
  const local = text.slice(s, i);
  const addr = local + '@' + text.slice(i + 1, end);
  // A lowercase mailto: or xmpp: directly before the local part joins
  // the link (and is consumed from the pending text as well).
  for (const pfx of ['mailto:', 'xmpp:']) {
    const at = s - pfx.length;
    if (at >= cleanFrom && text.startsWith(pfx, at) &&
        (at === 0 || !isLocalChar(text.charCodeAt(at - 1)))) {
      let e = end, extra = '';
      // An xmpp: address may carry one resource segment: '/' plus a
      // run of [A-Za-z0-9.@], with trailing dots left outside.
      if (pfx === 'xmpp:' && text[e] === '/') {
        let r = e + 1;
        while (r < text.length && isResourceChar(text.charCodeAt(r))) r++;
        if (r > e + 1) {
          let t = r;
          while (t > e + 1 && text[t - 1] === '.') t--;
          extra = text.slice(e, t);
          e = t;
        }
      }
      const raw = pfx + addr + extra;
      return {
        localLen: local.length + pfx.length, raw,
        html: '<a href="' + escapeAttr(raw) + '">' + escTextRun(raw) + '</a>',
        end: e,
      };
    }
  }
  return {
    localLen: local.length, raw: addr,
    html: '<a href="mailto:' + escapeAttr(addr) + '">' +
      escTextRun(addr) + '</a>',
    end,
  };
}

// Remove `count` source characters of plain text from the tail of the
// token stream (the pending buffer first, then '_' delimiter tokens and
// text tokens). Used when an email autolink absorbs its local part.
function dropTextTail(toks, buf, count) {
  let need = count;
  const take = Math.min(buf.length, need);
  buf = buf.slice(0, buf.length - take);
  need -= take;
  while (need > 0 && toks.length) {
    const t = toks[toks.length - 1];
    if (t.k === 'd' && t.ch === '_') {
      need -= t.len;
      toks.pop();
    } else if (t.k === 't') {
      const take2 = Math.min(t.s.length, need);
      t.s = t.s.slice(0, t.s.length - take2);
      need -= take2;
      if (t.s === '') toks.pop();
      else break;
    } else break;
  }
  return buf;
}

// Attempt to close the innermost open bracket at text[pos] === ']'.
// On success the label tokens collapse into one link/image token and
// {end} (the index just past the link target) is returned; else null.
function closeBracket(text, pos, toks, brackets, ctx, plain) {
  if (brackets.length === 0) return null;
  const b = brackets[brackets.length - 1];
  // A link label that already contains a formed link cannot itself
  // become a link: the bracket is spent and the ']' stays literal
  // (no falling through to an earlier opener for this ']').
  if (!b.img && b.hasLink) {
    brackets.pop();
    return null;
  }
  // A label whose backtick runs are unbalanced (odd count, counting
  // each run once) cannot form a link or image.
  if (b.tickParity % 2 === 1) {
    brackets.pop();
    return null;
  }
  const labelStart = b.pos + (b.img ? 2 : 1);
  const labelText = text.slice(labelStart, pos);
  let href = null, title = null, end = -1;

  const after = pos + 1;
  let inlineForm = false;
  if (after < text.length && text[after] === '(') {
    const t = scanParenTarget(text, after);
    if (t) { href = t.href; title = t.title; end = t.end; inlineForm = true; }
  }
  if (end === -1 && after < text.length && text[after] === '[') {
    // Full or collapsed reference.
    let k = after + 1, closed = false;
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) { k += 2; continue; }
      if (text[k] === '[') break;
      if (text[k] === ']') { closed = true; break; }
      k++;
    }
    if (closed) {
      const refLabel = text.slice(after + 1, k);
      const key = normaliseLabel(refLabel === '' ? labelText : refLabel);
      const def = ctx.refs.get(key);
      if (def) { href = def.href; title = def.title; end = k + 1; }
      else {
        // A defined-looking second label that resolves nowhere kills
        // the whole construct; the bracket is spent.
        brackets.pop();
        return null;
      }
    }
  }
  if (end === -1) {
    // Shortcut reference.
    const key = normaliseLabel(labelText);
    const def = key === '' ? undefined : ctx.refs.get(key);
    if (def) { href = def.href; title = def.title; end = pos + 1; }
  }
  if (end === -1) {
    brackets.pop();
    return null;
  }
  brackets.pop();
  const bi = toks.indexOf(b);
  const lo = bi + 1, hi = toks.length;
  // A code span with a backtick in its content blocks the label
  // unless it is the label's last token.
  for (let k = lo; k < hi - 1; k++) {
    if (toks[k].tickBad) {
      // Remember the failed label's source range: emphasis pairs
      // inside it may not reach across such a span (marked leaves
      // them literal when the link fails this way).
      (brackets.tickBadLabels ??= []).push([b.pos, pos]);
      return null;
    }
  }
  // Extended autolinks stay literal inside a link label.
  if (!plain) {
    for (let k = lo; k < hi; k++) {
      if (toks[k].k === 'x') toks[k] = { k: 't', s: escTextRun(toks[k].raw) };
    }
  }
  processEmphasis(toks, lo, toks.length, text, plain, brackets);
  const inner = renderToks(toks, lo, toks.length, plain);
  let html;
  if (plain) {
    html = inner;
  } else if (b.img) {
    const hrefOut = escapeAttr(cleanUrl(href));
    const titleOut = title === null ? '' : ' title="' + escapeAttr(title) + '"';
    const alt = escapeAttr(inline(labelText, ctx, true));
    html = '<img src="' + hrefOut + '" alt="' + alt + '"' + titleOut + '>';
  } else {
    const hrefOut = escapeAttr(cleanUrl(href));
    const titleOut = title === null ? '' : ' title="' + escapeAttr(title) + '"';
    html = '<a href="' + hrefOut + '"' + titleOut + '>' + inner + '</a>';
  }
  // An inline (parenthesised) link or image whose label holds two
  // or more unmatched backtick runs poisons the rest of the segment:
  // later emphasis closers are skipped under a parity rule (see
  // processEmphasis). Reference-style links do not poison.
  if (inlineForm && (b.tickUnmatched || 0) >= 2) {
    (brackets.poisonPos ??= []).push(b.pos);
  }
  toks.length = bi;
  toks.push({ k: 't', s: html });
  if (!b.img) {
    // A formed link poisons every enclosing bracket: their labels now
    // contain a link, so they can no longer form links themselves.
    for (let k = 0; k < brackets.length; k++) brackets[k].hasLink = true;
  }
  return { end };
}

// ---------------------------------------------------------------- blocks
//
// Blocks are parsed over arrays of source lines. Containers (block
// quotes, list items) are handled by stripping their markers/indentation
// into fresh line arrays and recursing, so every level sees plain lines.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote ' +
  'body caption center col colgroup dd details dialog dir div dl dt ' +
  'fieldset figcaption figure footer form frame frameset header hgroup hr ' +
  'html iframe legend li link main menu menuitem nav noframes ol optgroup ' +
  'option p section source summary table tbody td tfoot th thead title tr ' +
  'track ul').split(' '));

// Per-line facts: leading-whitespace columns (a tab advances to the next
// multiple of four), the number of leading whitespace characters, whether
// the line is blank, and the first non-whitespace character code.
function makeFacts(lines) {
  const F = new Array(lines.length);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let cols = 0, k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c === 32) { cols++; k++; }
      else if (c === 9) { cols += 4 - (cols % 4); k++; }
      else break;
    }
    F[idx] = {
      indent: cols, leadChars: k, blank: k === line.length,
      first: k < line.length ? line.charCodeAt(k) : -1,
    };
  }
  return F;
}

// Remove up to `cols` columns of indentation from a line whose first
// character sits at column `base`. A partially consumed tab leaves its
// remaining width as spaces.
function stripCols(line, cols, base = 0) {
  let col = base, k = 0;
  while (k < line.length && col < cols) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; k++; }
      else return ' '.repeat(col + w - cols) + line.slice(k + 1);
    } else break;
  }
  return line.slice(k);
}

// Remove up to `count` whitespace characters (not columns).
function stripWsChars(line, count) {
  let k = 0;
  while (k < line.length && k < count) {
    const c = line.charCodeAt(k);
    if (c === 32 || c === 9) k++;
    else break;
  }
  return line.slice(k);
}

function fenceStart(line, f) {
  if (f.indent > 3) return null;
  const c = f.first;
  if (c !== 96 && c !== 126) return null;
  let run = 0;
  while (line.charCodeAt(f.leadChars + run) === c) run++;
  if (run < 3) return null;
  const info = line.slice(f.leadChars + run).trim();
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { ch: c === 96 ? '`' : '~', len: run, info, indentChars: f.leadChars };
}

function fenceClose(line, f, ch, len) {
  if (f.indent > 3) return false;
  const c = ch === '`' ? 96 : 126;
  if (f.first !== c) return false;
  let run = 0;
  while (line.charCodeAt(f.leadChars + run) === c) run++;
  if (run < len) return false;
  return /^[ \t]*$/.test(line.slice(f.leadChars + run));
}

function atxHeading(line, f) {
  if (f.indent > 3 || f.first !== 35) return null;
  let run = 0;
  while (line.charCodeAt(f.leadChars + run) === 35) run++;
  if (run > 6) return null;
  const after = line[f.leadChars + run];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let s = line.slice(f.leadChars + run).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(s)) s = '';
  else {
    const m = /[ \t]#+$/.exec(s);
    if (m) s = s.slice(0, m.index).replace(/[ \t]+$/, '');
  }
  return { level: run, text: s };
}

function thematicBreak(line, f) {
  if (f.indent > 3) return false;
  const c = f.first;
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  for (let k = f.leadChars; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
  }
  return count >= 3;
}

function setextLevel(line, f) {
  if (f.indent > 3) return 0;
  const c = f.first;
  if (c !== 61 && c !== 45) return 0;
  let k = f.leadChars;
  while (line.charCodeAt(k) === c) k++;
  if (!/^[ \t]*$/.test(line.slice(k))) return 0;
  return c === 61 ? 1 : 2;
}

// Parse a list marker at the start of a line (indent already known <= 3
// columns when called from block level). Returns marker facts or null.
function listMarker(line, f) {
  if (f.indent > 3) return null;
  const k = f.leadChars;
  const c = line.charCodeAt(k);
  let ordered = false, bullet = '', num = 0, delim = '', mlen = 0;
  if (c === 45 || c === 43 || c === 42) {
    bullet = line[k]; mlen = 1;
  } else if (isDigit(c)) {
    let d = 0;
    while (d < 9 && isDigit(line.charCodeAt(k + d))) d++;
    const dc = line.charCodeAt(k + d);
    if (dc !== 46 && dc !== 41) return null;
    // A ')' or '.' must directly follow the digits.
    num = parseInt(line.slice(k, k + d), 10);
    delim = line[k + d];
    ordered = true; mlen = d + 1;
  } else return null;
  const afterIdx = k + mlen;
  const afterCh = line[afterIdx];
  if (afterCh !== undefined && afterCh !== ' ' && afterCh !== '\t') return null;
  // Content indent: marker column + marker width + following whitespace
  // (1-4 columns count; 5+ or end-of-line means a single column).
  const markerCol = f.indent;
  let col = markerCol + mlen, p = afterIdx, wsCols = 0;
  while (p < line.length) {
    const ch = line.charCodeAt(p);
    if (ch === 32) { wsCols++; col++; p++; }
    else if (ch === 9) { const w = 4 - (col % 4); wsCols += w; col += w; p++; }
    else break;
  }
  const empty = p >= line.length;
  const contentIndent = (empty || wsCols >= 5) ? markerCol + mlen + 1 : col;
  return {
    ordered, bullet, num, delim, contentIndent,
    markerIndent: markerCol, empty, afterIdx,
    // The item's content on the marker line itself: the whitespace run
    // past the content indent collapses to spaces (columns measured on
    // the original line), so tabs never survive a container strip.
    content: empty ? '' : ' '.repeat(col - contentIndent) + line.slice(p),
  };
}

function sameList(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// Strip a block quote marker: up to 3 columns of indent, '>', and one
// column of following whitespace (a tab is partially consumed). The
// rest of the leading whitespace run collapses to spaces, measured in
// columns on the original line.
function quoteStrip(line, f) {
  let idx = f.leadChars + 1;
  let col = f.indent + 1;
  let rem = 0;
  if (line[idx] === ' ') { idx++; col++; }
  else if (line[idx] === '\t') {
    const w = 4 - (col % 4);
    rem = w - 1;
    col += w;
    idx++;
  }
  while (idx < line.length && (line[idx] === ' ' || line[idx] === '\t')) {
    if (line[idx] === ' ') { rem++; col++; }
    else { const w = 4 - (col % 4); rem += w; col += w; }
    idx++;
  }
  return rem > 0 ? ' '.repeat(rem) + line.slice(idx) : line.slice(idx);
}

const RE_HTML_TYPE1 = /^<(script|pre|style|textarea)(?=[ \t>]|$)/i;
const RE_HTML_TYPE6 = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/;

// Detect an HTML block start on this line. `inPara` suppresses type 7.
// Returns {type, tag} or null.
function htmlBlockStart(line, f, inPara) {
  if (f.indent > 3 || f.first !== 60) return null;
  const rest = line.slice(f.leadChars);
  const m1 = RE_HTML_TYPE1.exec(rest);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2, tag: '' };
  if (rest.startsWith('<?')) return { type: 3, tag: '' };
  if (/^<![A-Z]/.test(rest)) return { type: 4, tag: '' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, tag: '' };
  const m6 = RE_HTML_TYPE6.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[2].toLowerCase())) {
    return { type: 6, tag: m6[2].toLowerCase(), closing: m6[1] === '/' };
  }
  if (!inPara) {
    const tag = scanTag(line, f.leadChars);
    if (tag && tag.name !== '') {
      const tail = line.slice(tag.end);
      if (/^[ \t]*$/.test(tail)) return { type: 7, tag: tag.name };
    }
  }
  return null;
}

// Split a table row into raw cells, honouring \| escapes and code spans.
// A leading/trailing pipe produces a phantom empty cell that is dropped.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n && line[i + 1] === '|') {
      cur += '|'; i += 2; continue;
    }
    if (ch === '`') {
      let run = 0;
      while (i + run < n && line[i + run] === '`') run++;
      // Find the matching closing run (exactly this many backticks).
      let j = i + run, closedEnd = -1;
      while (j < n) {
        if (line[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && line[j + r2] === '`') r2++;
          if (r2 === run) { closedEnd = j + r2; break; }
          j += r2;
        } else j++;
      }
      if (closedEnd !== -1) {
        cur += line.slice(i, closedEnd).replace(/\\\|/g, '|');
        i = closedEnd;
      }
      else { cur += '`'; i++; }
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  // Drop phantom cells from a leading/trailing pipe.
  const trimmed = line.trim();
  if (cells.length > 1 && trimmed.startsWith('|')) cells.shift();
  if (cells.length > 1 && trimmed.endsWith('|') &&
      !trimmed.endsWith('\\|')) cells.pop();
  return cells;
}

// If lines[i] is a table header and lines[i+1] its delimiter row, return
// the alignment array; else null.
function tableAlign(lines, F, i) {
  if (i + 1 >= lines.length) return null;
  const header = lines[i], delim = lines[i + 1];
  if (header.indexOf('|') === -1 && delim.indexOf('|') === -1) return null;
  if (F[i].blank || F[i + 1].blank) return null;
  const dcells = splitTableRow(delim);
  const align = [];
  for (const raw of dcells) {
    const c = raw.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) align.push('center');
    else if (c.startsWith(':')) align.push('left');
    else if (c.endsWith(':')) align.push('right');
    else align.push(null);
  }
  const hcells = splitTableRow(header);
  if (hcells.length !== align.length) return null;
  return align;
}

// Parse a link reference definition at text[i] === '['. The text is a
// window of joined lines. Returns {label, href, title, end} or null;
// `end` is the index just past the definition (not past the newline).
function defParse(text, i) {
  const n = text.length;
  let j = i + 1;
  let labelEnd = -1;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < n) { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { labelEnd = j; break; }
    j++;
  }
  if (labelEnd === -1 || labelEnd === i + 1) return null;
  const label = text.slice(i + 1, labelEnd);
  j = labelEnd + 1;
  if (text[j] !== ':') return null;
  j++;
  // Optional whitespace, including up to one line ending.
  let sawNl = false;
  while (j < n) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t') j++;
    else if (ch === '\n' && !sawNl) { sawNl = true; j++; }
    else break;
  }
  let href = null;
  if (text[j] === '<') {
    let k = j + 1, closed = false;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\' && k + 1 < n) { k += 2; continue; }
      if (ch === '>') { closed = true; break; }
      if (ch === '<') return null;
      k++;
    }
    if (!closed) return null;
    href = unescapePunct(text.slice(j + 1, k));
    j = k + 1;
  } else {
    let depth = 0, k = j;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c <= 32) break;
      const ch = text[k];
      if (ch === '\\' && k + 1 < n && isAsciiPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (k === j) return null;
    href = unescapePunct(text.slice(j, k));
    j = k;
  }
  // Optional title: separated by whitespace; may sit on the next line.
  // A title on the destination's own line must be well-formed and alone
  // there, or the definition is invalid. A title on the following line
  // that does not fit simply is not part of the definition.
  let title = null;
  let k = j;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  const lineEnd = k; // end of the destination's line (at '\n' or EOF)
  if (k < n && text[k] !== '\n') {
    // Something else on the destination's line: it must be a title,
    // separated from the destination by whitespace.
    if (k > j && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
      const t = scanDefTitle(text, k);
      if (t) {
        let e = t.end;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= n || text[e] === '\n') {
          return { label, href, title: t.title, end: e };
        }
      }
    }
    return null;
  }
  if (k < n && text[k] === '\n') {
    // Peek at the next line for a title.
    let p = k + 1;
    while (p < n && (text[p] === ' ' || text[p] === '\t')) p++;
    if (p < n && (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
      const t = scanDefTitle(text, p);
      if (t) {
        let e = t.end;
        while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= n || text[e] === '\n') {
          return { label, href, title: t.title, end: e };
        }
      }
    }
  }
  return { label, href, title, end: lineEnd };
}

function scanDefTitle(text, j) {
  const n = text.length;
  const q = text[j];
  if (q === '"' || q === "'") {
    let k = j + 1;
    while (k < n) {
      if (text[k] === '\\' && k + 1 < n) { k += 2; continue; }
      if (text[k] === q) {
        return { title: unescapePunct(text.slice(j + 1, k)), end: k + 1 };
      }
      k++;
    }
    return null;
  }
  if (q === '(') {
    let k = j + 1;
    while (k < n) {
      if (text[k] === '\\' && k + 1 < n) { k += 2; continue; }
      if (text[k] === '(') return null;
      if (text[k] === ')') {
        return { title: unescapePunct(text.slice(j + 1, k)), end: k + 1 };
      }
      k++;
    }
  }
  return null;
}

// Does this line interrupt a paragraph in progress?
function interruptsParagraph(lines, F, j, inItem) {
  const f = F[j], line = lines[j];
  if (fenceStart(line, f)) return true;
  if (atxHeading(line, f)) return true;
  if (thematicBreak(line, f)) return true;
  if (f.first === 62 && f.indent <= 3) return true;
  if (htmlBlockStart(line, f, true)) return true;
  const m = listMarker(line, f);
  // Ordered lists interrupt with any start number inside a list item;
  // elsewhere only a list starting at 1 interrupts.
  if (m && !m.empty && (!m.ordered || m.num === 1 || inItem)) return true;
  if (tableAlign(lines, F, j)) return true;
  return false;
}

// Could this line be lazy continuation text for an open paragraph?
function isLazyLine(lines, F, j) {
  const f = F[j], line = lines[j];
  if (fenceStart(line, f)) return false;
  // A line opening with a fence run is never lazy, even when the info
  // string disqualifies it as a fence (backtick in a backtick info).
  if (f.indent <= 3 && (f.first === 96 || f.first === 126)) {
    let run = 0;
    while (line.charCodeAt(f.leadChars + run) === f.first) run++;
    if (run >= 3) return false;
  }
  if (atxHeading(line, f)) return false;
  if (thematicBreak(line, f)) return false;
  if (f.first === 62 && f.indent <= 3) return false;
  if (htmlBlockStart(line, f, true)) return false;
  const m = listMarker(line, f);
  if (m && !m.empty) return false;
  if (tableAlign(lines, F, j)) return false;
  return true;
}

// Approximation used for laziness decisions: does the block content in
// `lines` end with a paragraph still open (not closed by a blank line
// or a completed block)?
function endsWithOpenPara(lines) {
  if (lines.length === 0) return false;
  const F = makeFacts(lines);
  let open = false, inFence = false, fch = '', flen = 0, fenceDepth = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    let f = F[idx], line = lines[idx];
    // Look through nested quote markers: laziness is decided by the
    // deepest open paragraph. A fence opened at some quote depth
    // only swallows lines carrying at least that many markers.
    let depth = 0, fenceLine = null, fenceFacts = null;
    if (inFence && fenceDepth === 0) { fenceLine = line; fenceFacts = f; }
    while (f.first === 62 && f.indent <= 3) {
      line = quoteStrip(line, f);
      f = makeFacts([line])[0];
      depth++;
      if (inFence && depth === fenceDepth) {
        fenceLine = line; fenceFacts = f;
      }
    }
    if (inFence) {
      if (depth < fenceDepth) {
        inFence = false; // the quote holding the fence has ended
      } else {
        if (fenceLine !== null &&
            fenceClose(fenceLine, fenceFacts, fch, flen)) inFence = false;
        open = false;
        continue;
      }
    }
    if (f.blank) { open = false; continue; }
    const fs = fenceStart(line, f);
    if (fs) {
      inFence = true; fch = fs.ch; flen = fs.len; fenceDepth = depth;
      open = false; continue;
    }
    if (atxHeading(line, f) || thematicBreak(line, f)) { open = false; continue; }
    if (open && setextLevel(line, f)) { open = false; continue; }
    const m = listMarker(line, f);
    if (m) {
      open = m.content.trim() !== '';
      continue;
    }
    if (htmlBlockStart(line, f, true)) { open = false; continue; }
    if (f.indent >= 4) continue; // continuation if open, code if not
    open = true;
  }
  return open;
}

// Extract link reference definitions from the start of a paragraph's
// text, registering them in refs. Returns the remaining text.
function extractDefs(text, refs) {
  let pos = 0;
  for (;;) {
    let p = pos;
    while (text[p] === ' ' || text[p] === '\t') p++;
    if (text[p] !== '[') break;
    const d = defParse(text, p);
    if (!d) break;
    const key = normaliseLabel(d.label);
    // A definition whose label normalises to nothing is not a
    // definition at all: the text stays paragraph content.
    if (key === '') break;
    if (!refs.has(key)) {
      refs.set(key, { href: d.href, title: d.title });
    }
    pos = d.end;
    if (text[pos] === '\n') pos++;
    else if (pos < text.length) break;
    if (pos >= text.length) return '';
  }
  if (pos === 0) return text;
  return text.slice(pos).replace(/^[ \t]+/, '');
}

function parseBlocks(lines, ctx) {
  const F = makeFacts(lines);
  const nodes = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const f = F[i], line = lines[i];
    if (f.blank) { i++; continue; }

    const fence = fenceStart(line, f);
    if (fence) {
      const body = [];
      let j = i + 1;
      while (j < n && !fenceClose(lines[j], F[j], fence.ch, fence.len)) {
        body.push(lines[j]);
        j++;
      }
      if (j < n) j++;
      if (body.length && body[body.length - 1] === '') body.pop();
      const content = fence.ch === '`'
        ? body.map((l) => stripWsChars(l, fence.indentChars))
        : body;
      nodes.push({
        t: 'code',
        text: content.length ? content.join('\n') + '\n' : '',
        lang: fence.info ? fence.info.split(/[ \t]+/)[0]
          .replace(/\\(.)/g, (m, c) => (isAsciiPunct(c.charCodeAt(0)) ? c : m)) : null,
      });
      i = j;
      continue;
    }

    const atx = atxHeading(line, f);
    if (atx) {
      nodes.push({ t: 'h', level: atx.level, text: atx.text });
      i++;
      continue;
    }

    if (thematicBreak(line, f)) {
      nodes.push({ t: 'hr' });
      i++;
      continue;
    }

    if (f.first === 62 && f.indent <= 3) {
      const q = parseQuote(lines, F, i, ctx);
      nodes.push(q.node);
      i = q.next;
      continue;
    }

    const hb = htmlBlockStart(line, f, false);
    if (hb) {
      const h = parseHtmlBlock(lines, F, i, hb, ctx);
      nodes.push(h.node);
      i = h.next;
      continue;
    }

    const mk = listMarker(line, f);
    if (mk) {
      const lst = parseList(lines, F, i, ctx);
      nodes.push(lst.node);
      i = lst.next;
      continue;
    }

    if (f.indent >= 4) {
      const body = [];
      let j = i;
      while (j < n && (F[j].indent >= 4 || F[j].blank)) {
        body.push({ s: stripCols(lines[j], 4), blank: F[j].blank });
        j++;
      }
      while (body.length && body[body.length - 1].blank) body.pop();
      nodes.push({
        t: 'code',
        text: body.length ? body.map(b => b.s).join('\n') + '\n' : '',
        lang: null,
      });
      i = j;
      continue;
    }

    if (tableAlign(lines, F, i)) {
      const tb = parseTable(lines, F, i, ctx);
      nodes.push(tb.node);
      i = tb.next;
      continue;
    }

    i = parseParagraph(lines, F, i, ctx, nodes);
  }
  return nodes;
}

function parseParagraph(lines, F, start, ctx, nodes) {
  const plines = [];
  const n = lines.length;
  let j = start;
  while (j < n) {
    const f = F[j], line = lines[j];
    if (line === '\n') {
      // Sentinel from list gathering: an extra empty text line inside
      // the paragraph (the over-indent run newline).
      plines.push('');
      j++;
      continue;
    }
    if (f.blank) {
      // A whitespace-only final line of the segment still belongs to
      // the paragraph (marked keeps it when no newline follows it).
      if (j === n - 1 && line.length > 0) { plines.push(line); j++; }
      break;
    }
    if (j > start && !(ctx.lazyText && ctx.lazyText.has(j))) {
      const sx = setextLevel(line, f);
      if (sx) {
        // Definitions at the head of the paragraph are extracted
        // first; if nothing else remains, the underline line is not
        // a heading at all and instead opens a fresh paragraph.
        const rest = extractDefs(plines.join('\n'), ctx.refs);
        if (rest === '') {
          plines.length = 0;
          plines.push(line);
          j++;
          continue;
        }
        nodes.push({
          t: 'h', level: sx,
          text: rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
        });
        return j + 1;
      }
      if (interruptsParagraph(lines, F, j, ctx.inListItem)) break;
    }
    plines.push(line);
    j++;
  }
  const text = plines.join('\n');
  const rest = extractDefs(text, ctx.refs);
  if (rest !== '') nodes.push({ t: 'p', text: rest });
  return j;
}

function parseQuote(lines, F, start, ctx) {
  const qlines = [];
  const lazyIdx = new Set();
  const n = lines.length;
  let j = start;
  let inFence = false, fch = '', flen = 0;
  let prevLazy = false;
  while (j < n) {
    const f = F[j], line = lines[j];
    if (f.indent <= 3 && f.first === 62) {
      const stripped = quoteStrip(line, f);
      qlines.push(stripped);
      prevLazy = false;
      const sf = makeFacts([stripped])[0];
      if (inFence) {
        if (fenceClose(stripped, sf, fch, flen)) inFence = false;
      } else {
        const fs = fenceStart(stripped, sf);
        if (fs) { inFence = true; fch = fs.ch; flen = fs.len; }
      }
      j++;
      continue;
    }
    if (f.blank) break; // a bare blank line ends the quote
    if (!inFence && endsWithOpenPara(qlines) && isLazyLine(lines, F, j)) {
      // Lazy lines join the open paragraph as text: they are marked
      // so the recursive pass does not re-lex them as block starts.
      lazyIdx.add(qlines.length);
      // A setext-underline-shaped lazy line that itself follows a lazy
      // line is defused with four leading spaces (marked quirk).
      if (prevLazy && setextLevel(line, f) !== 0 && !thematicBreak(line, f)) {
        qlines.push('    ' + line.slice(f.leadChars));
      } else {
        qlines.push(quoteLazyStrip(line, f));
      }
      prevLazy = true;
      j++;
      continue;
    }
    break;
  }
  const kids = parseBlocks(qlines, {
    refs: ctx.refs,
    state: ctx.state,
    tail: ctx.tail && j >= n,
    docEndsWithNl: ctx.docEndsWithNl,
    lazyText: lazyIdx.size ? lazyIdx : undefined,
    inListItem: ctx.inListItem,
  });
  return { node: { t: 'quote', kids }, next: j };
}

function parseHtmlBlock(lines, F, start, hb, ctx) {
  const n = lines.length;
  let j = start;
  let trailingNl = false;
  // A block whose content ends the input gets a trailing newline when
  // the input itself ends with one (its last line is the final content
  // line, just before the split artifact).
  const eofNl = () => ctx.tail && ctx.docEndsWithNl && j === n - 2;
  if (hb.type === 1) {
    const needle = '</' + hb.tag;
    j = start;
    while (j < n && lines[j].toLowerCase().indexOf(needle) === -1) j++;
    if (j >= n) j = n - 1;
  } else if (hb.type >= 2 && hb.type <= 5) {
    const needle = hb.type === 2 ? '-->' : hb.type === 3 ? '?>' :
      hb.type === 4 ? '>' : ']]>';
    j = start;
    while (j < n && lines[j].indexOf(needle) === -1) j++;
    if (j >= n) j = n - 1;
  } else {
    // Types 6 and 7 run until a blank line.
    j = start;
    while (j + 1 < n && !F[j + 1].blank) j++;
    if (eofNl()) trailingNl = true;
    const text = lines.slice(start, j + 1).join('\n') + (trailingNl ? '\n' : '');
    return { node: { t: 'html', text }, next: j + 1 };
  }
  // Types 1-5: a following non-blank line earns the block a trailing
  // newline; following whitespace-only (but non-empty) lines are
  // absorbed into the block and still earn it one newline.
  let next = j + 1;
  if (j + 1 < n && !F[j + 1].blank) trailingNl = true;
  else if (j + 1 < n && F[j + 1].blank && lines[j + 1].length > 0) {
    trailingNl = true;
    let k = j + 1;
    while (k < n && F[k].blank && lines[k].length > 0) k++;
    next = k;
  }
  else if (eofNl()) trailingNl = true;
  const text = lines.slice(start, j + 1).join('\n') + (trailingNl ? '\n' : '');
  return { node: { t: 'html', text }, next };
}

function parseTable(lines, F, start, ctx) {
  const align = tableAlign(lines, F, start);
  const header = splitTableRow(lines[start]).map((c) => c.trim());
  const rows = [];
  const n = lines.length;
  let j = start + 2;
  while (j < n) {
    const f = F[j], line = lines[j];
    // Whitespace-only lines end the table, except lines of pure
    // tabs, which marked treats as (empty) rows.
    if (f.blank && !/^\t+$/.test(line)) break;
    if (fenceStart(line, f)) break;
    if (htmlBlockStart(line, f, false)) break;
    if (/^ {4}/.test(line)) break;
    if (atxHeading(line, f)) break;
    if (thematicBreak(line, f)) break;
    if (f.first === 62 && f.indent <= 3) break;
    // Only bullet markers and ordered markers starting at 1 stop
    // the row loop; other ordered marker lines become rows.
    { const m = listMarker(line, f); if (m && (!m.ordered || m.num === 1)) break; }
    const cells = splitTableRow(line).map((c) => c.trim());
    while (cells.length < align.length) cells.push('');
    cells.length = align.length;
    rows.push(cells);
    j++;
  }
  return { node: { t: 'table', header, align, rows }, next: j };
}

// Whether the blank line(s) gathered in an item loosen the list
// (design rule: only when the item has no nested list yet, or the next
// line sits exactly at the content indent and is not a list marker).
function blankLoosens(item, nextIndent, nextIsMarker) {
  if (!item.nestedSeen) return true;
  return nextIndent === item.ci && !nextIsMarker;
}

function lazyStrip(line, f) {
  const strip = f.indent - (f.indent % 4);
  if (strip < 4) return line;
  return ' '.repeat(f.indent - strip) + line.slice(f.leadChars);
}

// Lazy lines in a blockquote lose exactly four columns of indent
// (marked treats the missing '> ' as one indent level).
function quoteLazyStrip(line, f) {
  if (f.indent < 4) return line;
  return ' '.repeat(f.indent - 4) + line.slice(f.leadChars);
}

function parseList(lines, F, start, ctx) {
  const first = listMarker(lines[start], F[start]);
  const items = [];
  const n = lines.length;
  let loose = false;
  let cur = null;
  let pendingBlanks = 0;
  let j = start;

  const finishItem = () => {
    if (cur) {
      // An over-indent run at the item's end still earns its extra
      // newline in the paragraph text (tight rendering trims it).
      if (cur.overEnd >= 0) cur.lines.push('\n');
      items.push(cur);
      cur = null;
    }
  };
  const startItem = (m, line) => {
    cur = {
      lines: [m.content],
      ci: m.contentIndent, nestedSeen: false,
      lazyIdx: new Set(),
      inFence: false, fch: '', flen: 0, fenceBody: false,
      fenceBlank: false,
      overEnd: -1, overMode: false, overBlanks: 0,
    };
    const fs = fenceStart(m.content, makeFacts([m.content])[0]);
    if (fs) { cur.inFence = true; cur.fch = fs.ch; cur.flen = fs.len; }
    pendingBlanks = 0;
  };

  while (j < n) {
    const f = F[j], line = lines[j];
    if (cur === null) {
      const m = listMarker(line, f);
      if (!m || !sameList(m, first)) break;
      startItem(m, line);
      j++;
      continue;
    }
    if (f.blank) {
      // Blank lines inside an item's fence are fence content; they
      // neither loosen the list nor count as item separators.
      if (cur.inFence) {
        cur.lines.push('');
        cur.fenceBody = true;
        cur.fenceBlank = true;
        j++;
        continue;
      }
      // Blanks inside an over-indent run are buffered: if the run
      // goes on, they become paragraph-internal empty lines.
      if (cur.overMode) { cur.overBlanks++; j++; continue; }
      pendingBlanks++;
      j++;
      continue;
    }
    // While a fence is open inside the item, lines at the content
    // indent are fence content; under-indented lines join in only
    // while the fence is fresh — it has a body and no blank line
    // has been gathered since it opened — otherwise the item ends.
    if (cur.inFence && (f.indent >= cur.ci ||
        (cur.fenceBody && !cur.fenceBlank))) {
      const fd = f.indent >= cur.ci
        ? ' '.repeat(f.indent - cur.ci) + line.slice(f.leadChars)
        : line;
      cur.lines.push(fd);
      cur.fenceBody = true;
      if (fenceClose(fd, makeFacts([fd])[0], cur.fch, cur.flen)) {
        cur.inFence = false;
      }
      j++;
      continue;
    }
    // A thematic break line outside the item's content indent ends
    // the list: it is never an item or lazy text.
    if (f.indent < cur.ci && thematicBreak(line, f)) break;
    const m = listMarker(line, f);
    if (m && f.indent < cur.ci) {
      if (!sameList(m, first)) {
        finishItem();
        return { node: listNode(first, items, loose, ctx, false), next: j };
      }
      if (pendingBlanks > 0) loose = true; // a blank between items loosens
      finishItem();
      startItem(m, line);
      j++;
      continue;
    }
    // An item that is still empty when content arrives after a blank
    // line is finished: the content does not belong to it.
    if (pendingBlanks > 0 && cur.lines.every(l => l === '')) break;
    if (f.indent >= cur.ci) {
      const dedented = ' '.repeat(f.indent - cur.ci) + line.slice(f.leadChars);
      // Would this line take the over-indent strip? (Single open
      // paragraph, no nested list yet, no blank so far, and the line
      // does not start a block after the plain dedent — block starts
      // are judged with the indent cap lifted, since nesting is
      // relative.)
      let canOver = false;
      if (f.indent >= cur.ci + 4 && !cur.nestedSeen &&
          endsWithOpenPara(cur.lines) && !cur.lines.some(l => l === '')) {
        const df = makeFacts([dedented])[0];
        const trueIndent = df.indent;
        df.indent = Math.min(df.indent, 3);
        canOver = !listMarker(dedented, df) && !fenceStart(dedented, df) &&
          !atxHeading(dedented, df) && !thematicBreak(dedented, df) &&
          !(df.first === 62 && trueIndent <= 3) &&
          !htmlBlockStart(dedented, df, true);
      }
      if (cur.overBlanks > 0) {
        if (canOver) {
          // The over-indent run goes on: buffered blanks become
          // paragraph-internal empty lines.
          for (let b = 0; b < cur.overBlanks; b++) cur.lines.push('\n');
        } else {
          // The run is over: the blanks were ordinary ones.
          pendingBlanks += cur.overBlanks;
          cur.overMode = false;
        }
        cur.overBlanks = 0;
      }
      const hadBlanks = pendingBlanks > 0;
      if (hadBlanks) {
        // Marker-ness for the looseness rule is judged on the
        // dedented line (a nested list's blank does not loosen us).
        const dfx = makeFacts([dedented])[0];
        dfx.indent = Math.min(dfx.indent, 3);
        if (blankLoosens(cur, f.indent, !!listMarker(dedented, dfx))) {
          loose = true;
        }
        for (let b = 0; b < pendingBlanks; b++) cur.lines.push('');
        pendingBlanks = 0;
        cur.overEnd = -1; // the item went on after a blank: no run \n
      }
      let finalLine = dedented;
      let overFired = false;
      if (canOver && !hadBlanks) {
        finalLine = ' '.repeat(f.indent - cur.ci - 4) + line.slice(f.leadChars);
        overFired = true;
      }
      if (!overFired && cur.overEnd >= 0) {
        // The over-indent run ended: the paragraph text gains an
        // extra newline after it (sentinel line, consumed by
        // parseParagraph as an empty text line).
        cur.lines.splice(cur.overEnd, 0, '\n');
        cur.overEnd = -1;
      }
      cur.overMode = overFired;
      const dm = listMarker(finalLine, makeFacts([finalLine])[0]);
      if (dm && cur.lines.length > 0) {
        cur.nestedSeen = true;
      }
      cur.lines.push(finalLine);
      if (overFired) cur.overEnd = cur.lines.length;
      if (cur.inFence) {
        if (fenceClose(finalLine, makeFacts([finalLine])[0], cur.fch, cur.flen)) {
          cur.inFence = false;
        }
      } else {
        const fs = fenceStart(finalLine, makeFacts([finalLine])[0]);
        if (fs) {
          cur.inFence = true; cur.fch = fs.ch; cur.flen = fs.len;
          cur.fenceBody = false; cur.fenceBlank = false;
        }
      }
      j++;
      continue;
    }
    // Under-indented non-marker line: lazy continuation or the end.
    if (pendingBlanks === 0 && endsWithOpenPara(cur.lines) &&
        isLazyLine(lines, F, j)) {
      if (cur.overEnd >= 0) {
        cur.lines.splice(cur.overEnd, 0, '\n');
        cur.overEnd = -1;
      }
      // Lazy lines are paragraph text, protected from re-lexing.
      cur.lazyIdx.add(cur.lines.length);
      cur.lines.push(lazyStrip(line, f));
      j++;
      continue;
    }
    break;
  }
  finishItem();
  return { node: listNode(first, items, loose, ctx, j >= n), next: j };
}

function listNode(first, items, loose, ctx, atTail) {
  const kids = items.map((item, idx) => {
    // Marked trims the trailing whitespace of an item's final
    // paragraph line (its raw item text is end-trimmed).
    const lines = item.lines.slice();
    if (lines.length && lines[lines.length - 1] !== '\n' &&
        endsWithOpenPara(lines)) {
      lines[lines.length - 1] =
        lines[lines.length - 1].replace(/[ \t]+$/, '');
    }
    return parseBlocks(lines, {
      refs: ctx.refs,
      state: ctx.state,
      tail: atTail && idx === items.length - 1,
      docEndsWithNl: ctx.docEndsWithNl,
      lazyText: item.lazyIdx && item.lazyIdx.size ? item.lazyIdx : undefined,
      inListItem: true,
    });
  });
  // Task list markers live in the first paragraph of an item.
  for (const itemKids of kids) {
    if (itemKids.length && itemKids[0].t === 'p') {
      const m = /^\[([ xX])\][ \t]+/.exec(itemKids[0].text);
      if (m && itemKids[0].text.length > m[0].length) {
        itemKids[0] = {
          ...itemKids[0],
          text: itemKids[0].text.slice(m[0].length),
          task: m[1] !== ' ',
        };
      }
    }
  }
  return {
    t: 'list', ordered: first.ordered, startNum: first.num,
    tight: !loose, items: kids,
  };
}

// ------------------------------------------------------------- rendering

function renderNodes(nodes, ctx, tight) {
  let out = '';
  for (const node of nodes) out += renderNode(node, ctx, tight);
  return out;
}

function renderNode(node, ctx, tight) {
  switch (node.t) {
    case 'h':
      return '<h' + node.level + '>' + inline(node.text, ctx) +
        '</h' + node.level + '>\n';
    case 'p': {
      const inner = (node.task !== undefined
        ? '<input ' + (node.task ? 'checked="" ' : '') +
          'disabled="" type="checkbox"> '
        : '') + inline(node.text, ctx);
      return tight ? inner : '<p>' + inner + '</p>\n';
    }
    case 'code':
      return '<pre><code' +
        (node.lang ? ' class="language-' + escapeAttr(node.lang) + '"' : '') +
        '>' + escapeCode(node.text) + '</code></pre>\n';
    case 'html':
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderNodes(node.kids, ctx, false) +
        '</blockquote>\n';
    case 'list': {
      const open = node.ordered
        ? '<ol' + (node.startNum !== 1 ? ' start="' + node.startNum + '"' : '') + '>\n'
        : '<ul>\n';
      let out = open;
      for (const item of node.items) {
        out += '<li>' + renderListItem(item, node, ctx) + '</li>\n';
      }
      return out + (node.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      node.header.forEach((cell, idx) => {
        out += '<th' + (node.align[idx] ? ' align="' + node.align[idx] + '"' : '') +
          '>' + inline(cell, ctx) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          row.forEach((cell, idx) => {
            out += '<td' + (node.align[idx] ? ' align="' + node.align[idx] + '"' : '') +
              '>' + inline(cell, ctx) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function renderListItem(item, list, ctx) {
  if (list.tight) {
    // Paragraphs render bare; the item body is the concatenation of its
    // blocks with paragraph text trimEnd()ed.
    let out = '';
    for (const node of item) {
      if (node.t === 'p') {
        out += renderNode({ ...node, text: node.text.replace(/\s+$/, '') }, ctx, true);
      } else {
        out += renderNode(node, ctx, false);
      }
    }
    return out;
  }
  return renderNodes(item, ctx, false);
}

// ------------------------------------------------------------- entry point

export function parse(markdown) {
  let src = markdown;
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const ctx = {
    refs: new Map(),
    state: { inA: false },
    tail: true,
    docEndsWithNl: src.endsWith('\n'),
  };
  const nodes = parseBlocks(lines, ctx);
  return renderNodes(nodes, ctx, false);
}
