/**
 * The one text contract for Clarity Jobs long-text fields.
 *
 * `description`, `qualifications`, `responsibilities`, `educationRequirements`
 * and `experienceRequirements` are stored and served as MARKDOWN — a CommonMark
 * subset: ATX headings, paragraphs, `-` and ordered lists (nested), `**bold**`,
 * `_em_`, `[text](https://…)` links and hard line breaks (`\` at end of line).
 * No raw HTML ever survives, so the value is safe to hand to a Markdown renderer
 * with HTML disabled.
 *
 * Sources state structure in two shapes: HTML (Google's `JobPosting` convention
 * and every ATS API) and plain text / Markdown (first-party publishers). Both go
 * through {@link toJobMarkdown}. Converting `<li>` into `- ` is a change of
 * notation for structure the source stated — it never adds content.
 *
 * Everything that needs PLAIN text — the lexical index, embeddings, snippets,
 * the dedupe fingerprint — derives it with {@link markdownToPlainText}, so the
 * same content fingerprints identically whether it arrived as HTML or Markdown.
 */
import { parseHTML } from 'linkedom';

/**
 * Repairs UTF-8 text a source double-encoded — its bytes decoded once as
 * Latin-1, producing "weâre" for "we're" — before Clarity
 * ever sees it. Confirmed byte-for-byte against RemoteOK's own `/api`
 * payload (OxyHQ/Clarity#19): the apostrophe's UTF-8 bytes `E2 80 99` come
 * back as the three separate codepoints U+00E2, U+0080, U+0099.
 *
 * Reinterpreting each code unit as a raw byte and re-decoding as UTF-8 only
 * succeeds when that byte sequence happens to be valid UTF-8, which correctly
 * encoded text essentially never is once it contains a genuine accented
 * character (a lone Latin-1 byte like 0xE9 is not valid standalone UTF-8). So
 * this is safe to run unconditionally: normal text round-trips as itself or
 * fails fast and is returned unchanged, never guessed at.
 */
export function repairMojibake(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0xff) return value;
    bytes[i] = code;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

type Block = { kind: 'para' | 'heading' | 'list'; text: string };

/** Elements whose contents are not listing text at all. */
const REMOVED = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'OBJECT', 'EMBED',
  'CANVAS', 'HEAD', 'TITLE',
]);

const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIALOG',
  'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HGROUP',
  'HR', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
  'BODY', 'HTML',
]);

/**
 * Standard HTML element names. Input is treated as HTML only when it carries
 * one of these, so a Markdown body that mentions `<company>` stays Markdown.
 */
const HTML_TAG_NAMES = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'body', 'br',
  'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
  'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'font',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i',
  'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'li', 'link', 'main', 'mark', 'math', 'meta',
  'nav', 'noscript', 'object', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'script', 'section',
  'small', 'source', 'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'table',
  'tbody', 'td', 'template', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'tt', 'u', 'ul', 'var',
  'video', 'wbr',
]);

/** Sentinel for `<br>` inside an inline run, resolved when the run is flushed. */
const BR = '\uE000';

const TAG_PATTERN = /(?<!\\)<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?\/?>/g;

/** Code spans and fences, which Markdown shows literally. */
const CODE_PATTERN = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`/g;

/** True when the value carries real HTML markup rather than text or Markdown. */
export function looksLikeHtml(value: string): boolean {
  const prose = value.replace(CODE_PATTERN, '');
  if (/<!--|<!doctype/i.test(prose)) return true;
  for (const match of prose.matchAll(TAG_PATTERN)) {
    if (HTML_TAG_NAMES.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * HTML, Markdown or plain text in; the Markdown contract out. Idempotent:
 * converting an already-converted value returns it unchanged, which matters
 * because feed listings are re-expressed as JSON-LD and normalized again.
 */
export function toJobMarkdown(value: string): string {
  const repaired = repairMojibake(value);
  return looksLikeHtml(repaired) ? htmlToMarkdown(repaired) : normalizeMarkdown(repaired);
}

// ---------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------

interface WalkContext { strong: boolean; em: boolean; link: boolean; pre: boolean }

class Builder {
  readonly blocks: Block[] = [];
  inline = '';

  flush(): void {
    for (const paragraph of finalizeInline(this.inline)) this.blocks.push({ kind: 'para', text: paragraph });
    this.inline = '';
  }

  push(block: Block): void {
    this.flush();
    this.blocks.push(block);
  }
}

type DomNode = {
  nodeType: number;
  nodeName: string;
  data?: string;
  childNodes: ArrayLike<DomNode>;
  getAttribute?: (name: string) => string | null;
};

export function htmlToMarkdown(html: string): string {
  const fullDocument = /<html[\s>]|<body[\s>]/i.test(html);
  const { document } = parseHTML(fullDocument ? html : `<!doctype html><html><head></head><body>${html}</body></html>`);
  const root = (document.body ?? document.documentElement) as unknown as DomNode | null;
  if (!root) return '';
  const builder = new Builder();
  walkChildren(root, builder, { strong: false, em: false, link: false, pre: false });
  builder.flush();
  return joinBlocks(builder.blocks);
}

function joinBlocks(blocks: readonly Block[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

function walkChildren(node: DomNode, builder: Builder, context: WalkContext): void {
  for (const child of Array.from(node.childNodes)) walk(child, builder, context);
}

function walk(node: DomNode, builder: Builder, context: WalkContext): void {
  if (node.nodeType === 3) {
    const raw = node.data ?? '';
    if (context.pre) {
      builder.inline += raw.split(/\r\n|\r|\n/).map((line) => escapeText(line.replace(/[ \t\f\v\u00a0]+/g, ' '))).join(BR);
    } else {
      builder.inline += escapeText(raw.replace(/\s+/g, ' '));
    }
    return;
  }
  if (node.nodeType !== 1) return;
  const name = node.nodeName.toUpperCase();
  if (REMOVED.has(name)) return;

  switch (name) {
    case 'BR':
      builder.inline += BR;
      return;
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const inner = new Builder();
      walkChildren(node, inner, context);
      inner.flush();
      const text = inner.blocks.map((block) => block.text).join(' ').replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) builder.push({ kind: 'heading', text: `${'#'.repeat(Number(name[1]))} ${text}` });
      else builder.flush();
      return;
    }
    case 'UL': case 'OL': {
      const list = renderList(node, name === 'OL', context);
      if (list) builder.push(list);
      else builder.flush();
      return;
    }
    case 'PRE':
      builder.flush();
      walkChildren(node, builder, { ...context, pre: true });
      builder.flush();
      return;
    case 'STRONG': case 'B':
      wrapInline(node, builder, { ...context, strong: true }, context.strong ? undefined : '**');
      return;
    case 'EM': case 'I':
      wrapInline(node, builder, { ...context, em: true }, context.em ? undefined : '_');
      return;
    case 'A':
      renderLink(node, builder, context);
      return;
    case 'TD': case 'TH':
      walkChildren(node, builder, context);
      builder.inline += ' ';
      return;
    default:
      if (BLOCKS.has(name)) {
        builder.flush();
        walkChildren(node, builder, context);
        builder.flush();
        return;
      }
      walkChildren(node, builder, context);
  }
}

/**
 * Renders an inline element's children, then wraps what they produced in a
 * delimiter — but only when they produced a single inline run. Emphasis cannot
 * span paragraphs, so a `<b>` around block content keeps just its text.
 */
function wrapInline(node: DomNode, builder: Builder, context: WalkContext, delimiter: string | undefined): void {
  const start = builder.inline.length;
  const blocksBefore = builder.blocks.length;
  walkChildren(node, builder, context);
  if (!delimiter || builder.blocks.length !== blocksBefore) return;
  const inner = builder.inline.slice(start);
  if (inner.includes(BR)) return;
  builder.inline = builder.inline.slice(0, start) + delimit(inner, delimiter);
}

function delimit(inner: string, delimiter: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!match || !match[2]) return inner;
  return `${match[1]}${delimiter}${match[2]}${delimiter}${match[3]}`;
}

function renderLink(node: DomNode, builder: Builder, context: WalkContext): void {
  const start = builder.inline.length;
  const blocksBefore = builder.blocks.length;
  walkChildren(node, builder, { ...context, link: true });
  const url = context.link ? undefined : safeLinkUrl(node.getAttribute?.('href'));
  if (!url || builder.blocks.length !== blocksBefore) return;
  const inner = builder.inline.slice(start);
  if (inner.includes(BR)) return;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const label = match?.[2] || escapeText(url);
  builder.inline = `${builder.inline.slice(0, start)}${match?.[1] ?? ''}[${label}](${url})${match?.[3] ?? ''}`;
}

/** Absolute http(s) only; anything else (javascript:, data:, relative) is dropped. */
function safeLinkUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  let parsed: URL;
  try { parsed = new URL(href.trim()); } catch { return undefined; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.href.replace(/[()<>\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function renderList(node: DomNode, ordered: boolean, context: WalkContext): Block | undefined {
  const startAttribute = Number.parseInt(node.getAttribute?.('start') ?? '', 10);
  let counter = ordered && Number.isFinite(startAttribute) && startAttribute >= 0 ? startAttribute : 1;
  const items: string[] = [];
  let loose = new Builder();

  const emit = (blocks: readonly Block[]): void => {
    if (blocks.length === 0) return;
    const marker = ordered ? `${counter}.` : '-';
    counter += 1;
    items.push(indentItem(marker, itemBody(blocks)));
  };

  for (const child of Array.from(node.childNodes)) {
    const childName = child.nodeType === 1 ? child.nodeName.toUpperCase() : '';
    if (childName === 'UL' || childName === 'OL') {
      // A list nested directly in a list belongs to the item before it.
      const nested = renderList(child, childName === 'OL', context);
      if (!nested) continue;
      loose.flush();
      if (loose.blocks.length > 0) { emit(loose.blocks); loose = new Builder(); }
      if (items.length === 0) { items.push(nested.text); continue; }
      const indent = ' '.repeat(items[items.length - 1].indexOf(' ') + 1);
      items[items.length - 1] += `\n${nested.text.split('\n').map((line) => (line ? indent + line : line)).join('\n')}`;
      continue;
    }
    if (childName === 'LI') {
      loose.flush();
      if (loose.blocks.length > 0) { emit(loose.blocks); loose = new Builder(); }
      const item = new Builder();
      walkChildren(child, item, context);
      item.flush();
      emit(item.blocks);
      continue;
    }
    walk(child, loose, context);
  }
  loose.flush();
  emit(loose.blocks);
  return items.length > 0 ? { kind: 'list', text: items.join('\n') } : undefined;
}

/** Joins an item's blocks tightly: paragraphs by a hard break, lists by a newline. */
function itemBody(blocks: readonly Block[]): string {
  let body = '';
  blocks.forEach((block, index) => {
    const text = block.kind === 'heading' ? block.text.replace(/^#+ /, '') : block.text;
    if (index === 0) { body = text; return; }
    const previous = blocks[index - 1];
    const separator = block.kind === 'list' ? '\n' : previous.kind === 'list' ? '\n\n' : '\\\n';
    body += separator + text;
  });
  return body;
}

function indentItem(marker: string, body: string): string {
  const indent = ' '.repeat(marker.length + 1);
  return `${marker} ${body.split('\n').map((line, index) => (index === 0 || !line ? line : indent + line)).join('\n')}`;
}

/** Splits an inline run into paragraphs at `<br><br>` and escapes block markers. */
function finalizeInline(run: string): string[] {
  return run
    .split(/(?:[ \t]*\uE000[ \t]*){2,}/)
    .map((paragraph) => paragraph
      .replace(/^[\s\uE000]+|[\s\uE000]+$/g, '')
      .replace(/ {2,}/g, ' ')
      // Text that reads as a character reference once rendered ("&amp;lt;" in the source).
      .replace(/(?<!\\)&(?=#?[a-zA-Z0-9]+;)/g, '\\&')
      .replace(/ *\uE000 */g, '\\\n')
      .split('\n')
      .map(escapeLineStart)
      .join('\n'))
    .filter((paragraph) => paragraph.length > 0);
}

/** Escapes Markdown syntax inside text a source meant literally. */
function escapeText(value: string): string {
  return value
    .replace(/[\uE000\uE001]/g, '')
    .replace(/[\\`*[\]<]/g, (character) => `\\${character}`)
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
}

/** A text line that would otherwise open a heading, list, quote or rule. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^([-+=>])/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
}

// ---------------------------------------------------------------------------
// Markdown / plain text passthrough
// ---------------------------------------------------------------------------

/**
 * Keeps the author's line structure: normalizes line endings, turns bullet
 * glyphs into `-` items, trims trailing whitespace (a two-space hard break
 * becomes the equivalent `\`), collapses runs of blank lines, and escapes any
 * `<` that could start markup so nothing downstream reads HTML.
 */
/** A line that opens a new block, so the line before it cannot end in a hard break. */
const BLOCK_START = /^\s*(?:[-+*•·▪◦●‣]|\d{1,9}[.)]|#{1,6}|>|```|~~~)(?:\s|$)/;

export function normalizeMarkdown(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const output = lines.map((line, index) => {
    let current = line.replace(/^(\s*)[•·▪◦●‣]\s+/, '$1- ');
    const next = lines[index + 1] ?? '';
    const hardBreak = / {2,}$/.test(current) && current.trim().length > 0 && next.trim().length > 0 && !BLOCK_START.test(next);
    current = current.replace(/[ \t\u00a0]+$/, '');
    return hardBreak && !current.endsWith('\\') ? `${current}\\` : current;
  }).join('\n');
  return escapeMarkupOutsideCode(output)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '')
    .replace(/^[ \t]+/, '');
}

function escapeMarkupOutsideCode(value: string): string {
  let output = '';
  let last = 0;
  for (const match of value.matchAll(CODE_PATTERN)) {
    output += escapeMarkup(value.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return output + escapeMarkup(value.slice(last));
}

function escapeMarkup(value: string): string {
  return value.replace(
    /(?<!\\)<(?![a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>)(?=[a-zA-Z/!?])/g,
    '\\<',
  );
}

// ---------------------------------------------------------------------------
// Markdown → plain text
// ---------------------------------------------------------------------------

/**
 * Plain text for every consumer that must not see Markdown syntax: search
 * vectors, embeddings, snippets and the dedupe fingerprint. Link targets are
 * dropped (their label stays), so a description fingerprints the same as the
 * HTML it came from.
 */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown) return '';
  const lines = markdown.replace(/[\uE000\uE001]/g, '').replace(/\r\n?/g, '\n').split('\n').flatMap((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) return [];
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s{0,3}=+\s*$/.test(line)) return [];
    return [line
      .replace(/^\s{0,3}#{1,6}(\s+|$)/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, '')
      .replace(/(?<!\\)\\$/, '')
      .replace(/ {2,}$/, '')];
  });
  const inline = lines.join('\n')
    .replace(/!\[((?:\\.|[^\]\\])*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/(?<!\\)\[((?:\\.|[^\]\\])*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/(?<!\\)<((?:https?|mailto):[^\s<>]+)>/g, '$1')
    .replace(/(?<!\\)(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, '$2')
    .replace(/(?<![\\*])\*\*(?=\S)([\s\S]*?[^\s\\])\*\*/g, '$1')
    .replace(/(?<![\\_\p{L}\p{N}])__(?=\S)([\s\S]*?[^\s\\])__(?![\p{L}\p{N}])/gu, '$1')
    .replace(/(?<![\\*])\*(?=[^\s*])([^*\n]*?[^\s\\*])\*/g, '$1')
    .replace(/(?<![\\_\p{L}\p{N}])_(?=[^\s_])([^_\n]*?[^\s\\_])_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/(?<!\\)~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/\\&/g, '\uE001')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
  // An escaped `&` is a literal ampersand, never the start of a reference.
  return decodeHtmlEntities(inline).replace(/\uE001/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const entityCache = new Map<string, string>();
let entityDocument: { createElement: (name: string) => { innerHTML: string; textContent: string | null } } | undefined;

/** Decodes named and numeric character references; unknown ones stay as written. */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(code);
    }
    const cached = entityCache.get(body);
    if (cached !== undefined) return cached;
    entityDocument ??= parseHTML('<!doctype html><html><body></body></html>').document as unknown as typeof entityDocument;
    const element = entityDocument!.createElement('span');
    element.innerHTML = entity;
    const decoded = element.textContent ?? entity;
    // A name the HTML spec does not define decodes to itself, not a prefix match.
    const resolved = decoded.length > 0 && !decoded.includes(';') ? decoded : entity;
    if (entityCache.size < 512) entityCache.set(body, resolved);
    return resolved;
  });
}
