// fastmark — a fast drop-in for marked 18.1.3 (MIT).
//
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (GFM on, breaks off, pedantic off, async off). Behavioural
// reference: marked 18.1.3 (MIT, github.com/markedjs/marked, tag v18.1.3).
// Where marked departs from the CommonMark or GFM spec, marked's HTML is the
// expected one, so this module follows marked's decisions, not the spec's.
//
// Design (written from scratch, restructured for speed):
//  - Block level: a cursor walks the source; each block is recognised by a
//    first-character dispatch so most rules are never even tried, then the
//    matching rule runs on the remaining source. Blocks are collected into a
//    light tree (no inline work yet) so link reference definitions — which
//    may appear after their use — are all known before any inline text is
//    rendered, exactly like marked's deferred inline queue.
//  - Inline level: a single-pass scanner over the inline source. Plain text
//    runs are copied with one escape/decode pass; markup is dispatched on the
//    character that starts it. Emphasis, strikethrough and links use the same
//    delimiter/lookahead decisions marked uses (ported here in this file's own
//    functions), with a masked copy of the source built lazily, only when a
//    run actually contains a delimiter.
//  - No per-call allocation of lexer/parser/renderer objects, no token trees
//    for inline content, no result cached across calls: every parse() call is
//    independent and deterministic.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Small string helpers (behaviour mirrors marked's helpers.ts)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(html, encode) {
  if (encode) {
    return /[&<>"']/.test(html) ? html.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]) : html;
  }
  if (/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(html)) {
    return html.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

function decodeNumericRefs(text) {
  if (!/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/.test(text)) return text;
  return text.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// Remove trailing `c` characters (rtrim). Equivalent to str.replace(/c*$/, '').
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Regexes. Patterns follow marked's block/inline grammars (the behaviour
// contract for this competition); they are composed here with a small local
// builder so each rule is written once and shared.
// ---------------------------------------------------------------------------

function editPat(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const supportsLookbehind = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_PAT = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const FENCES_PAT = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HEADING_PAT = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const NEWLINE_PAT = /^(?:[ \t]*(?:\n|$))+/;
const INDENT_CODE_PAT = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_TEXT_PAT = /^[^\n]+/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildLheading(tablePat) {
  const e = editPat(LHEADING_CORE)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/);
  if (tablePat) e.replace(/table/g, tablePat);
  else e.replace(/\|table/g, '');
  return e.getRegex();
}

const _BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_PAT = editPat(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _BLOCK_LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const LIST_PAT = editPat(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).getRegex();

const _COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_PAT = editPat(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const GFM_TABLE_PAT = editPat(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_PAT)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS)
  .getRegex();

const LHEADING_PAT = buildLheading(null);
const LHEADING_GFM_PAT = buildLheading(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);

const _PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt, tablePat) {
  const e = editPat(_PARA_CORE)
    .replace('hr', HR_PAT)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS);
  if (tablePat) e.replace('table', tablePat);
  else e.replace('|table', '');
  return e.getRegex();
}
const PARA_PAT = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, GFM_TABLE_PAT);
// Inside a blockquote a bare list marker (any number) starts a sibling list.
const BQ_PARA_PAT = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);
const BLOCKQUOTE_PAT = editPat(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BQ_PARA_PAT).getRegex();

// Indent-dependent one-line rules, cached per indent 0..3 like marked does.
function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) { re = make(idx); cache[idx] = re; }
    return re;
  };
}
const listItemRe = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

// ---- inline grammar (GFM) ----
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const ANY_PUNCT = editPat(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = editPat(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const PUNCTUATION = editPat(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();

const BLOCK_SKIP = editPat(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const EM_STRONG_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L = editPat(EM_STRONG_L_CORE, 'u').replace(/punct/g, PUNCT_GFM).getRegex();
const EM_STRONG_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_STRONG_R_AST = editPat(EM_STRONG_R_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();
const EM_STRONG_R_UND = editPat(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_L = editPat(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_R_CORE =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const DEL_R = editPat(DEL_R_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_PAT = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const AUTOLINK_PAT = editPat(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _INLINE_COMMENT = editPat(_COMMENT).replace('(?:-->|$)', '-->').getRegex();
const TAG_PAT = editPat(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _INLINE_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _INLINE_LABEL = editPat(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _INLINE_LABEL_BRACKETS)
  .getRegex();
const LINK_PAT = editPat(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _INLINE_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const REFLINK_PAT = editPat(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _INLINE_LABEL)
  .replace('ref', _BLOCK_LABEL)
  .getRegex();
const NOLINK_PAT = editPat(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _BLOCK_LABEL)
  .getRegex();
const _BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _BOUNDED_INLINE_LABEL = editPat(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _INLINE_LABEL_BRACKETS)
  .getRegex();
const REFLINK_SEARCH = editPat('reflink|nolink(?!\\()', 'g')
  .replace('reflink', editPat(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _BOUNDED_INLINE_LABEL)
    .replace('ref', _BOUNDED_BLOCK_LABEL)
    .getRegex())
  .replace('nolink', editPat(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _BOUNDED_BLOCK_LABEL)
    .getRegex())
  .getRegex();

const _EXT_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _EXT_EMAIL_PROTO = editPat(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _EXT_EMAIL)
  .getRegex();
const URL_PAT = editPat(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _EXT_EMAIL_PROTO)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// The plain-text run rule (GFM): stops before markup, links, code, breaks,
// autolink starts and e-mail starts, exactly as marked's inline text rule.
const INLINE_TEXT = editPat(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

// Shared one-char / one-line checks.
const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeComp: /^(\s+)(?:```)/,
  beginSpace: /^\s+/,
  endHash: /#$/,
  startSpace: /^ /,
  endSpace: / $/,
  endSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newLineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  dblBlankLine: /\n[ \t]*\n[ \t]*$/,
  bqStart: /^ {0,3}>/,
  bqSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  bqSetext2: /^ {0,3}>[ \t]?/gm,
  bqMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCb: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelim: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlank: /\n[ \t]*$/,
  tableAlignR: /^ *-+: *$/,
  tableAlignC: /^ *:-+: *$/,
  tableAlignL: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPre: /^<(pre|code|kbd|script)(\s|>)/i,
  endPre: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngle: /^</,
  endAngle: />$/,
  unicodeAlnum: /[\p{L}\p{N}]/u,
  numRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  setextLine: /^ {0,3}(?:=+|-+) *$/,
};

// ---------------------------------------------------------------------------
// Inline engine: a single-pass scanner. Plain text runs are copied with one
// escape/decode pass; markup is dispatched on the character that starts it.
// Emphasis, strikethrough and links follow marked's delimiter decisions.
// ---------------------------------------------------------------------------

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.indexOf(ch) !== -1;
}

const EMAIL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
const EMAIL_SET = new Uint8Array(128);
for (let k = 0; k < EMAIL_CHARS.length; k++) EMAIL_SET[EMAIL_CHARS.charCodeAt(k)] = 1;
function isEmailChar(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && EMAIL_SET[code] === 1;
}

function isAlnum(ch) {
  return ch.length === 1 && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'));
}

function lastCodePoint(str) {
  if (!str) return '';
  const cp = [...str];
  return cp.length ? cp[cp.length - 1] : '';
}

function scanClosers(masked) {
  let star = -1, under = -1, tilde = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
}

function lastCloserIndex(ctx, maskedSrc, delim) {
  const frame = ctx.frames.length ? ctx.frames[ctx.frames.length - 1] : null;
  if (frame && frame.masked === maskedSrc) {
    return delim === '~' ? frame.tilde : delim === '*' ? frame.star : frame.under;
  }
  const s = scanClosers(maskedSrc);
  return delim === '~' ? s.tilde : delim === '*' ? s.star : s.under;
}

function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP)) {
    if (LINK_PAT.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

function maskSrc(src, ctx) {
  let masked = src;
  if (ctx.links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH, maskReflink);
  }
  // Escapes and code spans only exist when the source holds a backslash or
  // a backtick; otherwise the punctuation pass scans the whole string for
  // nothing.
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  // Block-skip matches (links, code spans, html) are masked as a bracketed
  // run so emphasis never sees their delimiters. The second group is the
  // (empty) context capture before a code span; its length is the offset
  // that stays unmasked. It can only match when the source holds '[', '`'
  // or '<'.
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG_PAT.exec(tokenSrc) || AUTOLINK_PAT.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Render a link/image once its href/title are known. Returns the HTML, or
// undefined when the label already holds a link (links may not nest).
function outputLink(cap, link, raw, ctx) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RE.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const innerHtml = renderInline(text, ctx, false);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return undefined;
    }
    ctx.linkEmitted = true;
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return innerHtml;
    const escHref = escapeHtml(cleanHref, false);
    let out = '<a href="' + escHref + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    out += '>' + innerHtml + '</a>';
    return out;
  }
  // Image: the label is flattened to plain text for the alt attribute.
  // The alt rendering must not leak its inner links into linkEmitted: an
  // image is not a link, so it must not trip an outer link's nested-link
  // check.
  const outerLinkEmitted2 = ctx.linkEmitted;
  const alt = renderPlainText(text, ctx);
  ctx.linkEmitted = outerLinkEmitted2;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtml(alt);
  let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(alt) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>';
  return out;
}

// Plain-text rendering of an inline source (for image alt text): markup is
// stripped, only the characters remain. prevChar is tracked like the main
// inline loop, since it decides emphasis inside the label.
function renderPlainText(src, ctx) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevChar = '';
  let masked = null;
  const getMasked = () => {
    if (masked === null) {
      masked = maskSrc(src, ctx);
      ctx.frames.push({ masked, ...scanClosers(masked) });
    }
    return masked;
  };
  try {
    while (i < n) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
        out += src[i + 1];
        if (src[i + 1] !== '_') prevChar = src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '`') {
        const m = INLINE_CODE.exec(src.slice(i));
        if (m) {
          let t = m[2].replace(RE.newLineGlobal, ' ');
          if (RE.nonSpace.test(t) && RE.startSpace.test(t) && RE.endSpace.test(t)) t = t.substring(1, t.length - 1);
          out += t;
          i += m[0].length;
          prevChar = '';
          continue;
        }
      }
      if (ch === '*' || ch === '_') {
        const r = tryEmStrong(src, getMasked(), i, prevChar, ctx, true);
        if (r) { out += r.text; i += r.len; prevChar = ''; continue; }
      }
      if (ch === '~') {
        const r = tryDel(src, getMasked(), i, prevChar, ctx, true);
        if (r) { out += r.text; i += r.len; prevChar = ''; continue; }
      }
      if (ch === '<') {
        const m = TAG_PAT.exec(src.slice(i)) || AUTOLINK_PAT.exec(src.slice(i));
        if (m) { out += m[0]; i += m[0].length; prevChar = ''; continue; }
      }
      if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
        const r = tryLinkAt(src, i, ctx, true);
        if (r) {
          out += r.text;
          if (r.single) { if (r.text !== '_') prevChar = r.text; }
          else { prevChar = ''; ctx.linkEmitted = true; }
          i += r.len;
          continue;
        }
      }
      // One plain character (entities are decoded here, as marked's text does).
      out += decodeNumericRefs(ch);
      if (ch !== '_') prevChar = ch;
      i++;
    }
  } finally {
    if (masked !== null) ctx.frames.pop();
  }
  return out;
}

// Emphasis / strong. Returns {len, html} (or {len, text} in plain mode), or
// undefined. `masked` is the masked source of the current inline pass.
function tryEmStrong(src, masked, pos, prevChar, ctx, plain) {
  const sub = src.slice(pos);
  const match = EM_STRONG_L.exec(sub);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = masked.length - sub.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCodePoint(masked.slice(Math.max(0, runStart - 2), runStart));
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || PUNCTUATION.test(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : PUNCTUATION.test(prevChar);
  if (match[4] && RE.unicodeAlnum.test(prevChar)) return undefined;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? EM_STRONG_R_AST : EM_STRONG_R_UND;
    const lastPossible = lastCloserIndex(ctx, masked, delimChar);
    const windowStart = masked.length - sub.length + lLength;
    if (lastPossible < windowStart) return undefined;
    const windowMasked = masked.slice(-1 * sub.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    let m;
    while ((m = endReg.exec(windowMasked)) !== null) {
      if (m.index > lastPossibleInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = sub.slice(0, lLength + m.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        if (plain) return { len: raw.length, text };
        return { len: raw.length, html: '<em>' + renderInline(text, ctx, false) + '</em>' };
      }
      const text = raw.slice(2, -2);
      if (plain) return { len: raw.length, text };
      return { len: raw.length, html: '<strong>' + renderInline(text, ctx, false) + '</strong>' };
    }
  }
  return undefined;
}

// Strikethrough. Same shape as emphasis, with ~ delimiters.
function tryDel(src, masked, pos, prevChar, ctx, plain) {
  const sub = src.slice(pos);
  const match = DEL_L.exec(sub);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCTUATION.test(prevChar)) {
    const lLength = [...match[0]].length - 1;
    const lastPossible = lastCloserIndex(ctx, masked, '~');
    const windowStart = masked.length - sub.length + lLength;
    if (lastPossible < windowStart) return undefined;
    const windowMasked = masked.slice(-1 * sub.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    DEL_R.lastIndex = 0;
    let delimTotal = lLength;
    let m;
    while ((m = DEL_R.exec(windowMasked)) !== null) {
      if (m.index > lastPossibleInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = sub.slice(0, lLength + m.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      if (plain) return { len: raw.length, text };
      return { len: raw.length, html: '<del>' + renderInline(text, ctx, false) + '</del>' };
    }
  }
  return undefined;
}

// Codespan at pos. Returns {len, text} or undefined.
function tryCodespan(src, pos) {
  const cap = INLINE_CODE.exec(src.slice(pos));
  if (!cap) return undefined;
  let text = cap[2].replace(RE.newLineGlobal, ' ');
  if (RE.nonSpace.test(text) && RE.startSpace.test(text) && RE.endSpace.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { len: cap[0].length, text };
}

// Inline <a>-style autolink or <email> at pos. Returns {len, text, href}.
function tryAutolink(src, pos) {
  const cap = AUTOLINK_PAT.exec(src.slice(pos));
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { len: cap[0].length, text, href };
}

// Inline raw HTML tag at pos. Updates link/raw-block state. Returns raw or ''.
function tryTag(src, pos, ctx) {
  const cap = TAG_PAT.exec(src.slice(pos));
  if (!cap) return undefined;
  if (!ctx.inLink && RE.startATag.test(cap[0])) ctx.inLink = true;
  else if (ctx.inLink && RE.endATag.test(cap[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && RE.startPre.test(cap[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && RE.endPre.test(cap[0])) ctx.inRawBlock = false;
  return { len: cap[0].length, raw: cap[0] };
}

// Inline or reference link (or image) at pos. Returns {len, html} /
// {len, text} in plain mode, or undefined. When a reference exists in the
// source but has no definition, consumes exactly one character as text.
function tryLinkAt(src, pos, ctx, plain) {
  const sub = src.slice(pos);
  if (ctx.linkParenPossible) {
    const cap = LINK_PAT.exec(sub);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (!isLabelEndInsideToken(sub, cap[1], labelStart)) {
        const trimmedUrl = cap[2].trim();
        let ok = true;
        let href = cap[2];
        let title = '';
        if (RE.startAngle.test(trimmedUrl)) {
          if (!RE.endAngle.test(trimmedUrl)) ok = false;
          else {
            const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
            if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) ok = false;
          }
        } else {
          const lastParenIndex = findClosingBracket(cap[2], '()');
          if (lastParenIndex === -2) ok = false;
          else if (lastParenIndex > -1) {
            const start = cap[0].indexOf('!') === 0 ? 5 : 4;
            const linkLen = start + cap[1].length + lastParenIndex;
            cap[2] = cap[2].substring(0, lastParenIndex);
            cap[0] = cap[0].substring(0, linkLen).trim();
            cap[3] = '';
          }
        }
        if (ok) {
          const unescaped = rtrim(cap[0].slice(0, -1), '\\');
          if ((cap[0].length - unescaped.length) % 2 === 0) ok = false;
        }
        if (ok) {
          href = cap[2];
          title = cap[3] ? cap[3].slice(1, -1) : '';
          href = href.trim();
          if (RE.startAngle.test(href)) href = href.slice(1, -1);
          const link = {
            href: href ? href.replace(ANY_PUNCT, '$1') : href,
            title: title ? title.replace(ANY_PUNCT, '$1') : title,
          };
          if (plain) {
            const text = cap[1].replace(RE.outputLinkReplace, '$1');
            // A link whose label itself contains a link is rejected, exactly
            // as outputLink rejects it when rendering HTML; an image label
            // may contain links (they flatten to plain text for the alt).
            if (cap[0].charAt(0) !== '!') {
              const outerLinkEmitted = ctx.linkEmitted;
              ctx.linkEmitted = false;
              const plainText = renderPlainText(text, ctx);
              const textHasLink = ctx.linkEmitted;
              ctx.linkEmitted = outerLinkEmitted;
              if (textHasLink) return undefined;
              return { len: cap[0].length, text: plainText };
            }
            return { len: cap[0].length, text: renderPlainText(text, ctx) };
          }
          const html = outputLink(cap, link, cap[0], ctx);
          if (html !== undefined) return { len: cap[0].length, html };
        }
      }
    }
  }
  let cap = REFLINK_PAT.exec(sub) || NOLINK_PAT.exec(sub);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (!isLabelEndInsideToken(sub, cap[1], labelStart)) {
      const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return { len: 1, text, single: true };
      }
      if (plain) {
        const text = cap[1].replace(RE.outputLinkReplace, '$1');
        if (cap[0].charAt(0) !== '!') {
          const outerLinkEmitted = ctx.linkEmitted;
          ctx.linkEmitted = false;
          const plainText = renderPlainText(text, ctx);
          const textHasLink = ctx.linkEmitted;
          ctx.linkEmitted = outerLinkEmitted;
          if (textHasLink) return undefined;
          return { len: cap[0].length, text: plainText };
        }
        return { len: cap[0].length, text: renderPlainText(text, ctx) };
      }
      const html = outputLink(cap, link, cap[0], ctx);
      if (html !== undefined) return { len: cap[0].length, html };
    }
  }
  return undefined;
}

// GFM bare URL / e-mail autolink at pos (only when not inside a link).
function tryUrl(src, pos) {
  const cap = URL_PAT.exec(src.slice(pos));
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = URL_BACKPEDAL.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { len: cap[0].length, html: escapeHtml(text, true) };
  const out = '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>';
  return { len: cap[0].length, html: out };
}

// Render one plain-text run. Inside a raw block the text is kept verbatim;
// otherwise numeric references are decoded and the result escaped.
function renderTextRun(text, ctx) {
  if (ctx.inRawBlock) return text;
  if (!/[&<>"']/.test(text)) return text;
  return escapeHtml(decodeNumericRefs(text), false);
}

// Does a hard line break start at pos (spaces or backslash + newline, with
// non-whitespace following)? Returns the index just past the break, or -1.
function hardBreakEnd(src, pos) {
  const n = src.length;
  let i = pos;
  if (src[i] === '\\') {
    if (i + 1 < n && src[i + 1] === '\n') i += 2;
    else return -1;
  } else {
    let spaces = 0;
    while (i < n && src[i] === ' ') { i++; spaces++; }
    if (spaces < 2 || i >= n || src[i] !== '\n') return -1;
    i++;
  }
  // The break only counts when something non-whitespace follows.
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  if (j >= n) return -1;
  return j;
}

// Scan one plain-text run starting at `from`. Stops before markup, links,
// code, autolink starts and hard breaks, mirroring marked's GFM text rule:
// the first character is always taken, then the run stops before a markup
// character, a scheme://, a www. after a permitted predecessor, an e-mail
// start (right after the first character, or after a non-e-mail character),
// a mailto:/xmpp: after a non-alphanumeric character, or a hard break.
function scanText(src, from, ctx) {
  const n = src.length;
  let i = from;
  // A run may start with a backtick or tilde run (unmatched code/delimiter
  // is literal text); after that, those characters stop the run.
  if (src[i] === '`' || src[i] === '~') {
    const ch = src[i];
    while (i < n && src[i] === ch) i++;
  } else {
    i++;
  }
  const firstEnd = i;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' || ch === '<' || ch === '!' || ch === '[' || ch === '`' || ch === '*' || ch === '~' || ch === '_') break;
    if (ch === ' ') {
      // Hard break: two or more spaces before a newline, with more text after.
      let j = i;
      while (j < n && src[j] === ' ') j++;
      if (j - i >= 2 && j < n && src[j] === '\n') {
        let k = j + 1;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k < n) break;
      }
      i++;
      continue;
    }
    if (ch === 'w' && src.startsWith('www.', i)) {
      const prev = i === 0 ? '' : src[i - 1];
      if (prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' || prev === '*' || prev === '_' || prev === '~' || prev === '(') break;
      i++;
      continue;
    }
    if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F')) {
      // Scheme check without allocating a lowercased slice: compare the
      // next characters case-insensitively via char codes.
      const a = src.charCodeAt(i + 1) | 32, b = src.charCodeAt(i + 2) | 32, c = src.charCodeAt(i + 3) | 32;
      if ((ch === 'h' || ch === 'H') && a === 116 && b === 116 && c === 112) {
        const d = src.charCodeAt(i + 4);
        if (d === 58 && src[i + 5] === '/' && src[i + 6] === '/') break; // http://
        if ((d | 32) === 115 && src[i + 5] === ':' && src[i + 6] === '/' && src[i + 7] === '/') break; // https://
      } else if ((ch === 'f' || ch === 'F') && a === 116 && b === 112 && src[i + 3] === ':' && src[i + 4] === '/' && src[i + 5] === '/') break; // ftp://
    }
    if (ch === 'm' || ch === 'x') {
      // mailto: / xmpp: without allocating a lowercased slice.
      const a = src.charCodeAt(i + 1) | 32, b = src.charCodeAt(i + 2) | 32, c = src.charCodeAt(i + 3) | 32,
        d = src.charCodeAt(i + 4) | 32, e = src.charCodeAt(i + 5) | 32;
      const isMailto = ch === 'm' && a === 97 && b === 105 && c === 108 && d === 116 && e === 111 && src[i + 6] === ':';
      const isXmpp = ch === 'x' && a === 109 && b === 112 && c === 112 && src[i + 4] === ':';
      if ((isMailto || isXmpp) && (i === firstEnd || !isAlnum(src[i - 1]))) break;
    }
    // E-mail start: a run of e-mail characters followed by '@', begun right
    // after the run's first character, or after a non-e-mail character.
    if (isEmailChar(ch) && (i === firstEnd || !isEmailChar(src[i - 1]))) {
      let j = i;
      while (j < n && isEmailChar(src[j])) j++;
      if (j < n && src[j] === '@') break;
    }
    i++;
  }
  return { len: i - from, text: src.slice(from, i) };
}

// ---------------------------------------------------------------------------
// Block level: a cursor walks the source; each block is recognised by a
// first-character dispatch so most rules are never even tried. Blocks are
// collected into a light tree (no inline work yet) so link reference
// definitions — which may appear after their use — are all known before any
// inline text is rendered, exactly like marked's deferred inline queue.
// ---------------------------------------------------------------------------

function newCtx() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    frames: [],
  };
}

const TABLE_DELIM_LINE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const HTML_INTERRUPT_LINE = new RegExp(
  '^ {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|/?>|$)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
const LIST_INTERRUPT_LINE = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const ATX_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const HR_LINE = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

function isHrLine(line) {
  return HR_LINE.test(line);
}

function isFenceLine(line) {
  // The paragraph rule's fence interrupt (createParagraph): a backtick
  // fence needs its info string free of backticks — after the backtick run
  // the rest of the line must contain no backtick. A tilde fence has no
  // such restriction. The run itself may be 3+ backticks.
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line.startsWith('```', i)) {
    let j = i;
    while (line[j] === '`') j++;
    return line.indexOf('`', j) === -1;
  }
  if (line.startsWith('~~~', i)) return true;
  return false;
}

function isTableDelimiterLine(line) {
  return TABLE_DELIM_LINE.test(line);
}

// Fast paragraph scan: collect the lines of a paragraph starting at `pos`.
// Returns the end index (exclusive) of the paragraph text. The interrupt
// checks mirror the paragraph rule's negative lookahead exactly.
function scanParagraph(src, pos) {
  const n = src.length;
  let lineStart = pos;
  let end = pos;
  let first = true;
  while (lineStart < n) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = n;
    const line = src.slice(lineStart, lineEnd);
    if (!first) {
      // A space-only line is a blank line only when a newline follows it;
      // a trailing space-only fragment (no newline after) is a paragraph
      // continuation, as in marked's paragraph lookahead `[ \t]+\n`.
      if (isBlankLine(line) && lineEnd < n) break;
      if (isHrLine(line)) break;
      if (ATX_LINE.test(line)) break;
      let i = 0;
      while (i < 3 && line[i] === ' ') i++;
      if (line[i] === '>') break;
      if (isFenceLine(line)) break;
      if (LIST_INTERRUPT_LINE.test(line)) break;
      if (HTML_INTERRUPT_LINE.test(line)) break;
      // A table header + delimiter on the next two lines interrupts here.
      if (lineEnd < n) {
        let nextEnd = src.indexOf('\n', lineEnd + 1);
        if (nextEnd === -1) nextEnd = n;
        if (isTableDelimiterLine(src.slice(lineEnd + 1, nextEnd))) break;
      }
    }
    end = lineEnd;
    if (lineEnd >= n) break;
    lineStart = lineEnd + 1;
    first = false;
  }
  return end;
}

// Indented code block. Returns {len, node} or {len, merged:true}.
// Indented code. `mergeable` is true only when no blank line separates it
// from a preceding paragraph/text node: marked merges an indented code
// block into a preceding paragraph (appending the dedented text) and only
// then; after a blank line it is a code block of its own.
function parseCode(src, pos, ctx, nodes, mergeable) {
  const cap = INDENT_CODE_PAT.exec(src.slice(pos));
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(RE.codeRemoveIndent, '');
  const last = nodes[nodes.length - 1];
  if (mergeable && last && (last.t === 'para' || last.t === 'text')) {
    last.text += '\n' + text;
    return { len: raw.length, merged: true };
  }
  return { len: raw.length, node: { t: 'code', lang: null, text } };
}

function parseFences(src, pos) {
  const cap = FENCES_PAT.exec(src.slice(pos));
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  const lang = cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2];
  return { len: raw.length, node: { t: 'code', lang, text } };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(RE.indentCodeComp);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const matchIndentInNode = node.match(RE.beginSpace);
    if (matchIndentInNode === null) return node;
    const indentInNode = matchIndentInNode[0];
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

// ATX heading, parsed with string ops (the common case).
function parseHeading(src, pos) {
  let i = pos;
  let spaces = 0;
  while (spaces < 3 && src[i] === ' ') { i++; spaces++; }
  let hashes = 0;
  while (hashes < 6 && src[i] === '#') { i++; hashes++; }
  if (hashes === 0) return null;
  const after = src[i];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '\n') return null;
  let lineEnd = src.indexOf('\n', i);
  if (lineEnd === -1) lineEnd = src.length;
  let text = src.slice(i, lineEnd).trim();
  if (RE.endHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || RE.endSpaceTab.test(trimmed)) text = trimmed.trim();
  }
  return { len: lineEnd - pos, node: { t: 'heading', depth: hashes, text } };
}

// Thematic break, parsed with string ops.
function parseHr(src, pos) {
  let i = pos;
  let spaces = 0;
  while (spaces < 3 && src[i] === ' ') { i++; spaces++; }
  let lineEnd = src.indexOf('\n', i);
  if (lineEnd === -1) lineEnd = src.length;
  if (!isHrLine(src.slice(pos, lineEnd))) return null;
  return { len: lineEnd - pos, node: { t: 'hr' } };
}

function parseHtml(src, pos) {
  const cap = HTML_PAT.exec(src.slice(pos));
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return { len: raw.length, node: { t: 'html', text: raw } };
}

// Link reference definition. Registers the link (first definition wins),
// or merges its raw into a preceding paragraph/text block.
// Link reference definition. `mergeable` is true only when no blank line
// separates it from a preceding paragraph/text node. When it merges, the
// definition's raw text is appended to that paragraph and — exactly as in
// marked — the label is NOT registered (a merged definition never resolves
// a later reference). Otherwise the label is registered (first definition
// wins) and the definition itself renders nothing.
function parseDef(src, pos, ctx, nodes, mergeable) {
  const cap = DEF_PAT.exec(src.slice(pos));
  if (!cap) return null;
  if (!RE.startAngle.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(RE.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
  const raw = rtrim(cap[0], '\n');
  const last = nodes[nodes.length - 1];
  if (mergeable && last && (last.t === 'para' || last.t === 'text')) {
    last.text += '\n' + raw;
    return { len: raw.length, merged: true };
  }
  if (!Object.hasOwn(ctx.links, tag)) ctx.links[tag] = { href, title };
  return { len: raw.length, node: { t: 'def' } };
}

function parseTable(src, pos) {
  const cap = GFM_TABLE_PAT.exec(src.slice(pos));
  if (!cap) return null;
  if (!RE.tableDelim.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RE.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(RE.tableRowBlank, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const align = [];
  for (const a of aligns) {
    if (RE.tableAlignR.test(a)) align.push('right');
    else if (RE.tableAlignC.test(a)) align.push('center');
    else if (RE.tableAlignL.test(a)) align.push('left');
    else align.push(null);
  }
  const header = headers.map((h, i) => ({ text: h, align: align[i] }));
  const rowCells = rows.map((row) => splitCells(row, header.length).map((cell, i) => ({ text: cell, align: align[i] })));
  return { len: rtrim(cap[0], '\n').length, node: { t: 'table', header, align, rows: rowCells } };
}

function parseLheading(src, pos) {
  const cap = LHEADING_GFM_PAT.exec(src.slice(pos));
  if (!cap) return null;
  const text = cap[1].trim();
  const depth = cap[2].charAt(0) === '=' ? 1 : 2;
  return { len: rtrim(cap[0], '\n').length, node: { t: 'heading', depth, text } };
}

// Blockquote, ported from marked's tokenizer: chunks of `>` lines plus lazy
// continuations, re-parsed when a nested blockquote or list continues.
function parseBlockquote(src, pos, ctx) {
  const cap = BLOCKQUOTE_PAT.exec(src.slice(pos));
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (RE.bqStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(RE.bqMarkerWs, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(RE.bqSetext, '\n    $1')
      .replace(RE.bqSetext2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    parseBlocks(currentText, ctx, true, tokens, true);
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken && (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'bq') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(RE.bqSetext2, '');
      const newToken = parseBlockquote(newText, 0, ctx);
      tokens[tokens.length - 1] = newToken.node;
      const leftover = newText.substring(newToken.node.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newToken.node.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE.bqStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = parseList(newText, 0, ctx);
      tokens[tokens.length - 1] = newToken.node;
      const consumedCount = newToken.node.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.node.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { len: raw.length, node: { t: 'bq', children: tokens, raw, text } };
}

// List, ported from marked's tokenizer. Items are gathered with indentation
// rules, then tokenized as top=false blocks; the loose flag and task
// checkboxes are placed in a second pass.
function parseList(src, pos, ctx) {
  const cap = LIST_PAT.exec(src.slice(pos));
  if (!cap) return null;
  const base = pos;
  let cur = pos;
  const taken = () => cur - base;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRe(bull);
  let endsWithBlankLine = false;
  while (cur < src.length) {
    let endEarly = false;
    let itemContents = '';
    const m = itemRegex.exec(src.slice(cur));
    if (!m) break;
    if (HR_PAT.test(src.slice(cur))) break;
    const itemStart = taken();
    cur += m[0].length;
    const firstLine = m[2].split('\n', 1)[0];
    const bulletIndent = m[1].length;
    let line = firstLine.replace(RE.leadSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLineEnd = src.indexOf('\n', cur);
    if (nextLineEnd === -1) nextLineEnd = src.length;
    let nextLine = src.slice(cur, nextLineEnd);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(RE.nonSpace);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && RE.blankLine.test(nextLine)) {
      cur += nextLine.length + 1;
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = nextBulletRe(indent);
      const hrRegex = hrRe(indent);
      const fencesBeginRegex = fencesBeginRe(indent);
      const headingBeginRegex = headingBeginRe(indent);
      const htmlBeginRegex = htmlBeginRe(indent);
      const blockquoteBeginRegex = blockquoteBeginRe(indent);
      while (cur < src.length) {
        let lineEnd = src.indexOf('\n', cur);
        if (lineEnd === -1) lineEnd = src.length;
        const rawLine = src.slice(cur, lineEnd);
        nextLine = rawLine;
        const nextLineWithoutTabs = (rawLine[0] === ' ' || rawLine[0] === '\t')
          ? rawLine.replace(RE.leadSpaceTab, (ws) => expandTabs(ws))
          : rawLine;
        // First non-space character decides which break rules can match;
        // the others are never even tried.
        const firstNonSpace = nextLineWithoutTabs.search(RE.nonSpace);
        const fc = firstNonSpace === -1 ? '' : nextLineWithoutTabs[firstNonSpace];
        if ((fc === '`' || fc === '~') && fencesBeginRegex.test(nextLine)) break;
        if (fc === '#' && headingBeginRegex.test(nextLine)) break;
        if (fc === '<' && htmlBeginRegex.test(nextLine)) break;
        if (fc === '>' && blockquoteBeginRegex.test(nextLine)) break;
        if ((fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) && nextBulletRegex.test(nextLine)) break;
        if ((fc === '-' || fc === '_' || fc === '*') && hrRegex.test(nextLine)) break;
        if (firstNonSpace >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(RE.tabGlobal, '    ').search(RE.nonSpace) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = RE.setextLine.test(nextLine) && LHEADING_GFM_PAT.test(line + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        cur = lineEnd + 1;
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = src.slice(base + itemStart, cur);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (RE.dblBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      raw,
      task: RE.listIsTask.test(itemContents),
      text: itemContents,
      children: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(base, cur).trimEnd();
  // First pass: tokenize items (top=false) and finalize loose from spacers.
  for (const item of list.items) {
    const res = parseBlocks(item.text, ctx, false, item.children, false);
    if (!list.loose && res.doubleBlank) list.loose = true;
  }
  // Second pass: place task checkboxes using the final loose flag.
  for (const item of list.items) {
    const itemToken = item.children[0];
    if (item.task && (itemToken && (itemToken.t === 'text' || itemToken.t === 'para'))) {
      item.text = item.text.replace(RE.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(RE.listReplaceTask, '');
      const taskRaw = RE.listTaskCb.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checked = checked;
        if (list.loose) {
          itemToken.prefix = checkboxHtml;
        } else {
          item.children.unshift({ t: 'checkbox', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  // A loose list's text children become paragraphs.
  if (list.loose) {
    for (const item of list.items) {
      for (const token of item.children) {
        if (token.t === 'text') token.t = 'para';
      }
    }
  }
  return { len: list.raw.length, node: list };
}

// The block walker. Appends nodes into `nodes`; `top` selects paragraph vs
// text blocks; `clipFirst` lets the first paragraph merge with a preceding
// paragraph (blockquote continuations). Returns {doubleBlank}: whether any
// blank-line run with two or more newlines was consumed (list looseness).
function parseBlocks(src, ctx, top, nodes, clipFirst) {
  const n = src.length;
  let pos = 0;
  let doubleBlank = false;
  let canClip = !!clipFirst;
  // A chunk that continues a previous paragraph (clipFirst) may also have
  // a definition or indented code line merge into that paragraph, exactly
  // as marked merges them when the last token is a paragraph/text node.
  let textMergeable = !!clipFirst;
  while (pos < n) {
    // --- space: blank lines ---
    if (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\n') {
      let p = pos;
      let newlines = 0;
      while (p < n) {
        let q = p;
        while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
        if (q < n && src[q] === '\n') { newlines++; p = q + 1; }
        else if (q >= n) { p = q; break; }
        else break;
      }
      if (p > pos) {
        if (newlines >= 2) doubleBlank = true;
        // A single "\n" is folded into the previous token's raw, so a
        // following text/paragraph may still merge with it. A longer run
        // becomes a space token of its own, breaking the merge.
        if (!(newlines === 1 && p - pos === 1)) { textMergeable = false; canClip = false; }
        pos = p;
        continue;
      }
    }
    // --- first non-space character ---
    let i = pos;
    let spaces = 0;
    while (spaces < 4 && src[i] === ' ') { i++; spaces++; }
    const ch = src[i];
    let handled = false;
    // indented code: 4 spaces, or 0-3 spaces + tab
    if (spaces === 4 || ch === '\t') {
      const r = parseCode(src, pos, ctx, nodes, textMergeable);
      if (r) {
        if (r.node) nodes.push(r.node);
        pos += r.len;
        // A merge leaves the last node in place, so the merge flags stand;
        // a new code node breaks them.
        if (!r.merged) { textMergeable = false; canClip = false; }
        handled = true;
      }
    } else if (ch === '`' || ch === '~') {
      const r = parseFences(src, pos);
      if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
    } else if (ch === '#') {
      const r = parseHeading(src, pos);
      if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
    } else if (ch === '-' || ch === '_' || ch === '*') {
      const r = parseHr(src, pos);
      if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
      else if (ch !== '_') {
        const l = parseList(src, pos, ctx);
        if (l) { nodes.push(l.node); pos += l.len; textMergeable = false; canClip = false; handled = true; }
      }
    } else if (ch === '>') {
      const r = parseBlockquote(src, pos, ctx);
      if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
    } else if (ch === '+' || (ch >= '0' && ch <= '9')) {
      const l = parseList(src, pos, ctx);
      if (l) { nodes.push(l.node); pos += l.len; textMergeable = false; canClip = false; handled = true; }
    } else if (ch === '<') {
      const r = parseHtml(src, pos);
      if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
    } else if (ch === '[') {
      const r = parseDef(src, pos, ctx, nodes, textMergeable);
      if (r) {
        if (r.node) nodes.push(r.node);
        pos += r.len;
        if (!r.merged) { textMergeable = false; canClip = false; }
        handled = true;
      }
    }
    if (handled) continue;
    // --- table (GFM): next line must be a delimiter row ---
    if (!handled) {
      let lineEnd = src.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = n;
      if (lineEnd < n) {
        let nextEnd = src.indexOf('\n', lineEnd + 1);
        if (nextEnd === -1) nextEnd = n;
        if (isTableDelimiterLine(src.slice(lineEnd + 1, nextEnd))) {
          const r = parseTable(src, pos);
          if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
        }
      }
    }
    if (handled) continue;
    // --- setext heading: a setext underline must appear before a blank line ---
    if (!handled) {
      let p = pos;
      let found = false;
      while (p < n) {
        let e = src.indexOf('\n', p);
        if (e === -1) e = n;
        const line = src.slice(p, e);
        if (isBlankLine(line)) break;
        if (SETEXT_LINE.test(line)) { found = true; break; }
        if (e >= n) break;
        p = e + 1;
      }
      if (found) {
        const r = parseLheading(src, pos);
        if (r) { nodes.push(r.node); pos += r.len; textMergeable = false; canClip = false; handled = true; }
      }
    }
    if (handled) continue;
    // --- paragraph (top only) ---
    if (top) {
      const end = scanParagraph(src, pos);
      if (end > pos) {
        const text = src.slice(pos, end);
        const last = nodes[nodes.length - 1];
        if (canClip && last && last.t === 'para') {
          last.text += '\n' + text;
        } else {
          nodes.push({ t: 'para', text });
        }
        pos = end;
        // No blank line separates this paragraph from what follows yet, so
        // a following definition or indented code line may still merge
        // into it (the blank-line handler clears the flag when one appears).
        textMergeable = true;
        canClip = false;
        continue;
      }
    }
    // --- text: one line ---
    let lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = n;
    const line = src.slice(pos, lineEnd);
    if (line.length === 0) {
      // Should not happen (blank lines are consumed above); advance to be safe.
      pos++;
      continue;
    }
    const last = nodes[nodes.length - 1];
    if (textMergeable && last && last.t === 'text') {
      last.text += '\n' + line;
    } else {
      nodes.push({ t: 'text', text: line });
    }
    pos = lineEnd;
    textMergeable = true;
    canClip = false;
  }
  return { doubleBlank };
}

// ---------------------------------------------------------------------------
// Rendering: the light block tree is rendered directly to HTML (no token
// trees, no second lexing pass). Inline sources are rendered in document
// order, after every link reference definition in the document is known.
// ---------------------------------------------------------------------------

function renderCode(node) {
  const langString = (node.lang || '').match(RE.notSpaceStart)?.[0];
  const code = node.text ? node.text.replace(RE.endingNewline, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
}

function renderList(node, ctx) {
  let body = '';
  for (const item of node.items) body += '<li>' + renderNodes(item.children, ctx) + '</li>\n';
  const type = node.ordered ? 'ol' : 'ul';
  const startAttr = (node.ordered && node.start !== 1) ? ' start="' + node.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTable(node, ctx) {
  let header = '';
  for (const cell of node.header) {
    header += '<th' + (cell.align ? ' align="' + cell.align + '"' : '') + '>'
      + renderInline(cell.text, ctx, true) + '</th>\n';
  }
  header = '<tr>\n' + header + '</tr>\n';
  let body = '';
  for (const row of node.rows) {
    let cells = '';
    for (const cell of row) {
      cells += '<td' + (cell.align ? ' align="' + cell.align + '"' : '') + '>'
        + renderInline(cell.text, ctx, true) + '</td>\n';
    }
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'code':
        out += renderCode(node);
        break;
      case 'heading':
        out += '<h' + node.depth + '>' + renderInline(node.text, ctx, true) + '</h' + node.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'bq':
        out += '<blockquote>\n' + renderNodes(node.children, ctx) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(node, ctx);
        break;
      case 'html':
        out += node.text;
        break;
      case 'def':
        break;
      case 'table':
        out += renderTable(node, ctx);
        break;
      case 'para':
        out += '<p>' + (node.prefix || '') + renderInline(node.text, ctx, true) + '</p>\n';
        break;
      case 'text':
        out += (node.prefix || '') + renderInline(node.text, ctx, true);
        break;
      case 'checkbox':
        out += '<input ' + (node.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
    }
  }
  return out;
}

// Plain-text fast path (rank 9's element): an inline source with none of
// the markup triggers — no escape, tag, link, code, emphasis, strikethrough,
// autolink, bare URL/e-mail or hard break — is one text run, rendered by a
// single decode/escape pass with no scanner loop at all.
const PLAIN_INLINE = /[\\<!\[`*~_@]|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:| {2,}\n/i;

// Cheap pre-check for a bare URL / e-mail at `i`: only run the URL pattern
// when the text here can actually start one. Scheme/protocol checks compare
// char codes directly (no lowercased slice is allocated).
function maybeUrl(src, i) {
  const ch = src[i];
  if (ch === 'w' && src.startsWith('www.', i)) return true;
  if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
    const a = src.charCodeAt(i + 1) | 32, b = src.charCodeAt(i + 2) | 32, c = src.charCodeAt(i + 3) | 32;
    if ((ch === 'h' || ch === 'H') && a === 116 && b === 116 && c === 112) {
      const d = src.charCodeAt(i + 4);
      if (d === 58 && src[i + 5] === '/' && src[i + 6] === '/') return true;
      if ((d | 32) === 115 && src[i + 5] === ':' && src[i + 6] === '/' && src[i + 7] === '/') return true;
    } else if ((ch === 'f' || ch === 'F') && a === 116 && b === 112 && src[i + 3] === ':' && src[i + 4] === '/' && src[i + 5] === '/') return true;
    // Not a scheme: fall through to the e-mail check below.
  }
  if (ch === 'm' || ch === 'x') {
    const a = src.charCodeAt(i + 1) | 32, b = src.charCodeAt(i + 2) | 32, c = src.charCodeAt(i + 3) | 32,
      d = src.charCodeAt(i + 4) | 32, e = src.charCodeAt(i + 5) | 32;
    if (ch === 'm' && a === 97 && b === 105 && c === 108 && d === 116 && e === 111 && src[i + 6] === ':') return true;
    if (ch === 'x' && a === 109 && b === 112 && c === 112 && src[i + 4] === ':') return true;
    // Not a protocol: fall through to the e-mail check below.
  }
  if (!isAlnum(ch)) return false;
  let j = i;
  while (j < src.length && isEmailChar(src[j])) j++;
  return j < src.length && src[j] === '@';
}

// Render inline markdown to HTML. `topRun` resets the raw-block state, as
// marked does before each block-level inline unit.
function renderInline(src, ctx, topRun) {
  if (topRun) ctx.inRawBlock = false;
  if (!PLAIN_INLINE.test(src)) return renderTextRun(src, ctx);
  let out = '';
  let i = 0;
  const n = src.length;
  let prevChar = '';
  let masked = null;
  const getMasked = () => {
    if (masked === null) {
      masked = maskSrc(src, ctx);
      ctx.frames.push({ masked, ...scanClosers(masked) });
    }
    return masked;
  };
  const outerLinkParen = ctx.linkParenPossible;
  ctx.linkParenPossible = outerLinkParen && src.includes(')');
  try {
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        if (i + 1 < n && isAsciiPunct(src[i + 1])) {
          // An escape is a text token: prevChar becomes the escaped char.
          out += renderTextRun(src[i + 1], ctx);
          if (src[i + 1] !== '_') prevChar = src[i + 1];
          i += 2;
          continue;
        }
        const hb = hardBreakEnd(src, i);
        if (hb !== -1) {
          out += '<br>';
          i = hb;
          prevChar = '';
          continue;
        }
      } else if (ch === '`') {
        const r = tryCodespan(src, i);
        if (r) {
          out += '<code>' + escapeHtml(r.text, true) + '</code>';
          i += r.len;
          prevChar = '';
          continue;
        }
      } else if (ch === '*' || ch === '_') {
        const r = tryEmStrong(src, getMasked(), i, prevChar, ctx, false);
        if (r) {
          out += r.html;
          i += r.len;
          prevChar = '';
          continue;
        }
      } else if (ch === '~') {
        const r = tryDel(src, getMasked(), i, prevChar, ctx, false);
        if (r) {
          out += r.html;
          i += r.len;
          prevChar = '';
          continue;
        }
      } else if (ch === '<') {
        const a = tryAutolink(src, i);
        if (a) {
          const cleanHref = cleanUrl(a.href);
          if (cleanHref === null) out += escapeHtml(a.text, true);
          else out += '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(a.text, true) + '</a>';
          i += a.len;
          prevChar = '';
          continue;
        }
        const t = tryTag(src, i, ctx);
        if (t) {
          out += t.raw;
          i += t.len;
          prevChar = '';
          continue;
        }
      } else if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
        const r = tryLinkAt(src, i, ctx, false);
        if (r) {
          if (r.html !== undefined) {
            out += r.html;
            prevChar = '';
          } else {
            // A reference with no definition yields one literal character,
            // i.e. a text token: prevChar becomes that character.
            out += renderTextRun(r.text, ctx);
            if (r.text !== '_') prevChar = r.text;
          }
          i += r.len;
          continue;
        }
      } else if (ch === ' ') {
        const hb = hardBreakEnd(src, i);
        if (hb !== -1) {
          out += '<br>';
          i = hb;
          prevChar = '';
          continue;
        }
      } else if (!ctx.inLink && maybeUrl(src, i)) {
        const r = tryUrl(src, i);
        if (r) {
          out += r.html;
          i += r.len;
          prevChar = '';
          continue;
        }
      }
      const run = scanText(src, i, ctx);
      if (run.len > 0) {
        out += renderTextRun(run.text, ctx);
        const last = run.text.charAt(run.text.length - 1);
        if (last !== '_') prevChar = last;
        i += run.len;
        continue;
      }
      // No tokenizer matched and no text run: emit one literal character so
      // the loop always makes progress.
      out += renderTextRun(src[i], ctx);
      prevChar = src[i] === '_' ? prevChar : src[i];
      i++;
    }
  } finally {
    ctx.linkParenPossible = outerLinkParen;
    if (masked !== null) ctx.frames.pop();
  }
  return out;
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.replace(RE.carriageReturn, '\n');
  const ctx = newCtx();
  const nodes = [];
  parseBlocks(src, ctx, true, nodes, false);
  return renderNodes(nodes, ctx);
}
