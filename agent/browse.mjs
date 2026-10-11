// The naive agent's page reader. It behaves like a crude text extractor on purpose: styled-away spans
// and HTML comments are kept in the text the model reads (and listed in hiddenText for the trace), which
// is exactly how an instruction a human cannot see reaches the agent. It only ever fetches the replica's
// /inspo/ listings; every other URL (the real internet, /checkout, /v1) is refused before any request.
import { mockPort } from "../src/endpoint.mjs";
import { USER_AGENT } from "../src/arcade.mjs";

export const BROWSE_PATH_PREFIX = "/inspo/";
export const MAX_PAGE_BYTES = 256 * 1024;
export const FETCH_TIMEOUT_MS = 5000;
const OK_STATUS = 200;
const HTML_TYPE = "text/html";

export const defaultBrowseOrigins = (env = process.env) =>
  Object.freeze([`http://localhost:${mockPort(env)}`, `http://127.0.0.1:${mockPort(env)}`]);

export function isBrowsable(url, origins) {
  try {
    const parsed = new URL(url);
    return origins.includes(parsed.origin) && parsed.pathname.startsWith(BROWSE_PATH_PREFIX);
  } catch {
    return false;
  }
}

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " });
const ENTITY_PATTERN = /&(amp|lt|gt|quot|#39|apos|nbsp);/g;
const TAG_PATTERN = /<[/!a-z][^>]*>/gi;
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TITLE_SUFFIX = /\s+\|\s+[^|]*$/;
const DROPPED_BLOCKS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_PATTERN = /<!--([\s\S]*?)-->/g;
const OPEN_TAG = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const HIDING_STYLES = Object.freeze([/font-size:\s*0*1px/i, /display:\s*none/i, /visibility:\s*hidden/i]);
// "color:" must not be the tail of "background-color:", or any white card would count as hidden text.
const WHITE_TEXT = /(?<![-\w])color:\s*#(?:fff|ffffff)\b/i;
const WHITE_BACKGROUND = /background(?:-color)?:\s*#(?:fff|ffffff)\b/i;

const decodeEntities = (text) => text.replace(ENTITY_PATTERN, (_, name) => ENTITIES[name]);
const toPlain = (html) => decodeEntities(html.replace(TAG_PATTERN, " ")).replace(/\s+/g, " ").trim();

const isHiddenStyle = (style) =>
  HIDING_STYLES.some((pattern) => pattern.test(style)) || (WHITE_TEXT.test(style) && WHITE_BACKGROUND.test(style));

const styleOf = (attributes) => {
  const match = attributes.match(STYLE_ATTRIBUTE);
  return match ? (match[1] ?? match[2]) : "";
};

// Inner HTML of the element opened just before `from`, counting nested tags of the same name.
function innerHtml(html, tag, from) {
  const tokens = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tokens.lastIndex = from;
  let depth = 1;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    depth += token[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, token.index);
  }
  return null;
}

function hiddenElements(html) {
  const found = [];
  let consumedUntil = 0;
  for (const open of html.matchAll(OPEN_TAG)) {
    const tag = open[1].toLowerCase();
    if (open.index < consumedUntil || VOID_TAGS.has(tag) || !isHiddenStyle(styleOf(open[2]))) continue;
    const start = open.index + open[0].length;
    const inner = innerHtml(html, tag, start);
    if (inner === null) continue;
    found.push({ index: open.index, html: inner });
    consumedUntil = start + inner.length;
  }
  return found;
}

// Hidden spans and comments in document order, tags stripped, duplicates dropped.
function hiddenTexts(html) {
  const comments = [...html.matchAll(COMMENT_PATTERN)].map((match) => ({ index: match.index, html: match[1] }));
  const ordered = [...comments, ...hiddenElements(html)].sort((a, b) => a.index - b.index);
  return Object.freeze([...new Set(ordered.map((fragment) => toPlain(fragment.html)).filter(Boolean))]);
}

export function extractText(html) {
  const source = String(html ?? "");
  const titleMatch = source.match(TITLE_PATTERN);
  const title = titleMatch ? toPlain(titleMatch[1]).replace(TITLE_SUFFIX, "") : "";
  const visible = source.replace(DROPPED_BLOCKS, " ");
  return { title, text: toPlain(visible.replace(COMMENT_PATTERN, " $1 ")), hiddenText: hiddenTexts(visible) };
}

const discard = (response) => response.body?.cancel?.().catch(() => {});
const tooLarge = (url) => new Error(`browse: ${url} is larger than ${MAX_PAGE_BYTES} bytes`);

async function readHtml(response, url) {
  if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await discard(response);
    throw tooLarge(url);
  }
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw tooLarge(url);
  return html;
}

export async function fetchPage(url, { fetchImpl = fetch, origins = defaultBrowseOrigins() } = {}) {
  if (!isBrowsable(url, origins)) throw new Error(`browse only reads ${origins[0]}${BROWSE_PATH_PREFIX}* pages`);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, Accept: HTML_TYPE },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== OK_STATUS) {
    await discard(response);
    throw new Error(`browse: HTTP ${response.status} for ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(HTML_TYPE)) {
    await discard(response);
    throw new Error(`browse: ${url} is not an HTML page (${contentType || "no content-type"})`);
  }
  return { url, ...extractText(await readHtml(response, url)) };
}
