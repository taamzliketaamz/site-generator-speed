// A faster drop-in for makefun-site 1.0.0, written for site-generator-speed-01: run(input) returns, for every
// case's input, exactly the output tree makefun-site 1.0.0's build returns for that site — each page's index.html,
// the index and tag pages, build-report.txt and each static file, byte for byte — and returns it sooner. The dialect
// is makefun-site's own (its README states it; its code is the reference wherever the two differ): its front matter,
// its template dialect, its Markdown subset, its slug rule and its report are reimplemented here from that spec,
// tuned for CPU: ASCII fast paths for slugs and escaping, per-case memoisation of pure text functions, char-code
// line classification instead of stacked regexes, and an inline renderer that walks a string once instead of
// re-slicing it. No state is kept between cases: every memo lives inside one build.

// ---------------------------------------------------------------- text

/** The characters escapeHtml replaces, found by one native scan before any hand work. */
const ESCAPE_FIRST = /[&<>"']/;

/** The HTML escape table: & < > " ' (and nothing else). Most text holds none of them and is returned as it stands. */
function escapeHtml(s) {
  if (!ESCAPE_FIRST.test(s)) return s;
  let out = null;
  let last = 0;
  for (let k = s.search(ESCAPE_FIRST); k < s.length; k++) {
    const c = s.charCodeAt(k);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = s.slice(0, k);
      else if (last < k) out += s.slice(last, k);
      out += rep;
      last = k + 1;
    }
  }
  if (out === null) return s;
  if (last < s.length) out += s.slice(last);
  return out;
}

/** The most characters a slug keeps. */
const SLUG_MAX = 64;

/** Whether a slug run holds a capital (and so needs lowering). */
const HAS_CAPITAL = /[A-Z]/;

/**
 * The slug of `text`, unmemoised: NFKD, combining marks dropped, A-Z lowered, every run of characters other than
 * a-z and 0-9 one "-", none at either end, cut to SLUG_MAX (a "-" left at the cut dropped), "untitled" when empty.
 * Pure-ASCII text takes a fast path: NFKD is the identity on ASCII and ASCII holds no combining marks, so the same
 * result falls out of a char-code loop.
 */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    // Keepable runs are sliced whole (and lowered only when they hold a capital) instead of copied char by char.
    let runStart = -1;
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : -1;
      const keepable = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
      if (keepable) {
        if (runStart === -1) runStart = i;
        continue;
      }
      if (runStart !== -1) {
        if (gap) out += '-';
        gap = false;
        const run = text.slice(runStart, i);
        out += HAS_CAPITAL.test(run) ? run.toLowerCase() : run;
        runStart = -1;
      }
      if (c !== -1) gap = out.length > 0;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** A slugify with a per-build memo: titles and tag names repeat across a site's hundreds of sources. */
function makeSlugger() {
  const memo = new Map();
  return (text) => {
    let v = memo.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      memo.set(text, v);
    }
    return v;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is whitespace as JavaScript's \s sees it. */
function isWsCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. The block opens on a line "---" and runs to the next line "---"; every line between is blank, a
 * comment or "key: value"; the closing line is found before any line is judged, as the reference judges it. Only
 * the block's own lines are ever split out — the body is the rest of the text, untouched.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const lines = ['---'];
  let close = -1;
  let bodyStart = text.length;
  let pos = text === '---' ? 3 : 4;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    lines.push(line);
    if (line === '---') {
      close = lines.length - 1;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown
//
// makefun-site's Markdown subset: fenced code, ATX headings with ids, thematic breaks, blockquotes, flat lists and
// paragraphs; inline code spans, strong, emphasis, links and backslash escapes. No raw HTML, no setext headings, no
// indented code. Lines are classified by their first characters, which decides every line the generator draws the
// same way the reference's regexes do; each equivalence is noted where the shape is subtle.

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `c` may appear in a fence's language: A-Z, a-z, 0-9, "_", "+" and "-". */
function isLangCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language ("" for none), or null when the line opens no fence: ```, language, blanks. */
function fenceOpenOf(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length && isLangCode(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ``` and then only spaces or tabs. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's level and text, or null. One to six "#", at least one space or tab, then text with the blanks at
 * its end dropped (closing "#"s stay); no text, or seven or more "#", is no heading. The "#" run is counted first,
 * then the whole blank run is skipped, which is what the reference's greedy blank run and lazy text capture leave.
 */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= line.length) return null;
  const depth = i;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end <= i) return null;
  return { depth, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break: "---" or "***", then only spaces or tabs. */
function isBreak(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item line's content ("- " or "* ", then anything), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's number and content (1 to 9 digits, ". ", then anything), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a character that is not whitespace. */
function isContinuation(line) {
  return line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32 && line.length > 2 && !isWsCode(line.charCodeAt(2));
}

/** A line with the spaces and tabs at both ends dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const LINK_TARGET_WS = /\s/;

/** The characters that can open an inline span or an escape; a string with none of them is plain text. */
const INLINE_MARKS = /[\\`*\[]/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between the four opening characters are
 * escaped in one slice each; spans recurse on their own slice, as the reference renders them.
 */
function inline(s, env) {
  if (!INLINE_MARKS.test(s)) return escapeHtml(s);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !LINK_TARGET_WS.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // A plain run: everything up to the next character that can open a span or an escape, found by native scans.
    // This branch is also where a backslash that escapes nothing lands: it is written as it stands, as the
    // reference writes it, and the run runs on from it.
    let end = n;
    let t = s.indexOf('\\', i + 1);
    if (t !== -1 && t < end) end = t;
    t = s.indexOf('`', i + 1);
    if (t !== -1 && t < end) end = t;
    t = s.indexOf('*', i + 1);
    if (t !== -1 && t < end) end = t;
    t = s.indexOf('[', i + 1);
    if (t !== -1 && t < end) end = t;
    out += escapeHtml(s.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * `src` rendered: its HTML (every block followed by "\n"), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML), its excerpt (the first paragraph's inline HTML, or "") and its word count (the
 * body's runs of characters other than whitespace, for reading_minutes). `slug` is the build's
 * memoised slugify, shared with the permalinks so a heading's text is slugged once per site. Every line is
 * classified once, in the reference's dispatch order (blank, fence, heading, break, quote, list item, other); the
 * block walk, the paragraph peek and the list walk all read that verdict instead of re-testing the line.
 */
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const n = lines.length;
  const kinds = new Uint8Array(n);
  const datas = new Array(n);
  let words = 0;
  for (let li = 0; li < n; li++) {
    const line = lines[li];
    // The body's word count (for reading_minutes) is taken on this same pass: a word never spans a line, since
    // "\n" is whitespace, so the per-line runs add up to the whole body's runs.
    let inWord = false;
    for (let ci = 0; ci < line.length; ci++) {
      const c = line.charCodeAt(ci);
      let ws;
      if (c === 32 || (c >= 9 && c <= 13)) ws = true;
      else if (c < 128) ws = false;
      else ws = isWsCode(c);
      if (ws) inWord = false;
      else if (!inWord) {
        words++;
        inWord = true;
      }
    }
    if (isBlankLine(line)) {
      kinds[li] = 1;
      continue;
    }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      kinds[li] = 2;
      datas[li] = lang;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      kinds[li] = 3;
      datas[li] = heading;
      continue;
    }
    if (isBreak(line)) {
      kinds[li] = 4;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      kinds[li] = 5;
      continue;
    }
    const bullet = bulletOf(line);
    if (bullet !== null) {
      kinds[li] = 6;
      datas[li] = bullet;
      continue;
    }
    const ordered = orderedOf(line);
    if (ordered !== null) {
      kinds[li] = 7;
      datas[li] = ordered;
      continue;
    }
    kinds[li] = 0;
  }
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const kind = kinds[i];
    if (kind === 1) {
      i++;
      continue;
    }
    if (kind === 2) {
      const lang = datas[i];
      i++;
      const bodyStart = i;
      while (i < n && !isFenceClose(lines[i])) i++;
      // The reference escapes each body line and ends it in "\n"; escaping the joined lines at once is the same
      // text, since the escape table never touches "\n" — only the line count decides the trailing newline.
      const body = i === bodyStart ? '' : `${escapeHtml(lines.slice(bodyStart, i).join('\n'))}\n`;
      i++;
      parts.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${body}</code></pre>\n`);
      continue;
    }
    if (kind === 3) {
      const heading = datas[i];
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inline(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 4) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === 5) {
      const kept = [];
      while (i < n && kinds[i] === 5) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    if (kind === 6 || kind === 7) {
      const isOrdered = kind === 7;
      const startNum = isOrdered ? datas[i].num : 1;
      const items = [];
      while (i < n) {
        let content = null;
        if (kinds[i] === kind) content = isOrdered ? datas[i].text : datas[i];
        if (content !== null) {
          items.push([trimLine(content)]);
          i++;
        } else if (isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const partsOfItem of items) block += `<li>${inline(partsOfItem.join('\n'), env)}</li>\n`;
      block += `</${tag}>\n`;
      parts.push(block);
      continue;
    }
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && kinds[i] !== 1 && kinds[i] !== 2 && kinds[i] !== 3 && kinds[i] !== 4) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates
//
// makefun-site's template dialect: {{ path }} escaped, {{{ path }}} raw, {% for %}, {% if %}/{% if not %} with an
// optional {% else %}, and {% include "name" %} at most 8 deep. A {% %} tag alone on its line takes the whole line
// with it. Parsing mirrors the reference's judgements exactly — the same templates parse, and a failure is reported
// with the same words — while rendering walks the node tree into one array of pieces, joined once per page.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why, in its message. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Include expansion, done once per build: an include node is replaced by the included template's nodes, expanded
 * at one deeper level, and dropped when it names no parsed template or sits at the depth limit — in both cases
 * rendering it would write nothing. Expansion is memoised per (template, depth), so a template used both as a
 * layout (depth 0) and as an include keeps the depth accounting the reference's renderer would give it, and a
 * template that includes itself still stops at the limit. Text nodes that end up neighbours are merged (into a
 * fresh node; parsed nodes are never mutated), which leaves rendering fewer, longer pieces to push.
 */
function pushMerged(out, node) {
  if (node.kind === 'text') {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + node.text };
      return;
    }
  }
  out.push(node);
}

/** `nodes` with every include spliced in at `depth`, for and if bodies expanded at the same depth. */
function expandNodes(nodes, depth, templates, cache) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH && templates.has(n.name)) {
        for (const m of expandTemplate(n.name, depth + 1, templates, cache)) pushMerged(out, m);
      }
    } else if (n.kind === 'for') out.push({ ...n, body: expandNodes(n.body, depth, templates, cache) });
    else if (n.kind === 'if') out.push({ ...n, then: expandNodes(n.then, depth, templates, cache), else: n.else === null ? null : expandNodes(n.else, depth, templates, cache) });
    else pushMerged(out, n);
  }
  return out;
}

/** Template `name`'s nodes as they execute at `depth`, includes already spliced (memoised per name and depth). */
function expandTemplate(name, depth, templates, cache) {
  const key = `${depth}:${name}`;
  let v = cache.get(key);
  if (v === undefined) {
    v = expandNodes(templates.get(name), depth, templates, cache);
    cache.set(key, v);
  }
  return v;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOfValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfValue).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), its pieces pushed onto `out`. `ctx` holds the parsed templates and the HTML escape. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOfValue(lookupPath(scope, n.path))));
        break;
      case 'raw':
        out.push(textOfValue(lookupPath(scope, n.path)));
        break;
      case 'if': {
        const v = isTruthy(lookupPath(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope for the whole loop, its two bindings rewritten per turn: rendering is synchronous and reads
        // them only during the turn, so nothing can observe a later turn's values. `loop` is assigned after the
        // element binding, as in the reference's object literal, so a variable itself named "loop" still loses
        // to the loop record.
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = {};
        const inner = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, inner, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's for the same input. */
function build(input) {
  const slug = makeSlugger();
  const dateMemo = new Map();
  const longDate = (d) => {
    let v = dateMemo.get(d);
    if (v === undefined) {
      v = longDateRaw(d);
      dateMemo.set(d, v);
    }
    return v;
  };

  // Every template is parsed, in code-unit order of its name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Every template's executable tree: its includes spliced in (see expandTemplate), keyed as the parsed map is.
  const expandCache = new Map();
  const expandedTemplates = new Map();
  for (const name of templates.keys()) expandedTemplates.set(name, expandTemplate(name, 0, templates, expandCache));

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. The checks run in
  // the reference's order — front matter, the generator's own directories, a post's date, its layout, its draft —
  // and the first one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = tagBySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        tagBySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slug(name);
        return tagBySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The records templates read: a page's card, a page itself, a link record and a tag with its cards.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs; then the static files.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates: expandedTemplates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = expandedTemplates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported along the way and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, sooner: the same output tree, byte for byte. */
export function run(input) {
  return build(input);
}
