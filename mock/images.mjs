// SVG tile pattern drawn from the prompt, served at GET /img/<id>.svg.
// Colors come from color words, the motif from shape words, and the prompt is printed small.

const SIZE = 1024;
const TILE = 128;
const LARGE_TILE = 256;
const MAX_CAPTION_CHARS = 110;
const DEFAULT_BACKGROUND = "#f4efe6";
const DEFAULT_MOTIF = "#5b5b5b";

const COLOR_WORDS = Object.freeze([
  ["blue", "#2f5d9e"], ["red", "#c0392b"], ["black", "#1b1b1b"], ["white", "#ffffff"],
  ["green", "#3a7d44"], ["yellow", "#e8c547"], ["pink", "#e89ab5"],
  ["linen", "#e9dfcc"], ["beige", "#e9dfcc"], ["natural", "#e9dfcc"],
]);

export const escapeXml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);

const colorOf = (word) => COLOR_WORDS.find(([name]) => word === name)?.[1] ?? null;

export function paletteFor(prompt) {
  const words = prompt.toLowerCase().match(/[a-z]+/g) ?? [];
  const onIndex = words.lastIndexOf("on");
  const background = onIndex >= 0 ? words.slice(onIndex + 1).map(colorOf).find(Boolean) : null;
  const before = onIndex >= 0 ? words.slice(0, onIndex) : words;
  const motifs = before.map(colorOf).filter(Boolean);
  const fallbackBg = words.map(colorOf).filter(Boolean).find((color) => color !== motifs[0]);
  return {
    background: background ?? (motifs.length > 1 ? motifs[motifs.length - 1] : fallbackBg) ?? DEFAULT_BACKGROUND,
    motif: motifs[0] ?? DEFAULT_MOTIF,
  };
}

export function shapeFor(prompt) {
  const text = prompt.toLowerCase();
  if (/flor|flower|rose|petal/.test(text)) return "petals";
  if (/dot/.test(text)) return "dots";
  if (/stripe/.test(text)) return "stripes";
  return "circles";
}

const petals = (t, color) => {
  const c = t / 2;
  const leaves = [0, 72, 144, 216, 288].map(
    (deg) => `<ellipse cx="${c}" cy="${c - t * 0.17}" rx="${t * 0.09}" ry="${t * 0.17}" fill="${color}" transform="rotate(${deg} ${c} ${c})"/>`,
  );
  return `${leaves.join("")}<circle cx="${c}" cy="${c}" r="${t * 0.06}" fill="#ffffff" opacity="0.7"/>`;
};

const MOTIFS = Object.freeze({
  petals,
  dots: (t, color) => `<circle cx="${t / 4}" cy="${t / 4}" r="${t * 0.08}" fill="${color}"/><circle cx="${(3 * t) / 4}" cy="${(3 * t) / 4}" r="${t * 0.08}" fill="${color}"/>`,
  stripes: (t, color) => `<rect x="0" y="0" width="${t / 2}" height="${t}" fill="${color}"/>`,
  circles: (t, color) => `<circle cx="${t / 2}" cy="${t / 2}" r="${t * 0.3}" fill="none" stroke="${color}" stroke-width="${t * 0.06}"/>`,
});

export function renderPatternSvg(prompt) {
  const text = String(prompt ?? "");
  const { background, motif } = paletteFor(text);
  const tile = /\blarge\b/i.test(text) ? LARGE_TILE : TILE;
  const caption = text.length > MAX_CAPTION_CHARS ? `${text.slice(0, MAX_CAPTION_CHARS - 1)}…` : text;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><pattern id="tile" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">`,
    `<rect width="${tile}" height="${tile}" fill="${background}"/>${MOTIFS[shapeFor(text)](tile, motif)}`,
    `</pattern></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#tile)"/>`,
    `<rect x="0" y="${SIZE - 56}" width="${SIZE}" height="56" fill="#ffffff" opacity="0.8"/>`,
    `<text x="16" y="${SIZE - 22}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#222">${escapeXml(caption)}</text>`,
    `</svg>`,
  ].join("");
}
