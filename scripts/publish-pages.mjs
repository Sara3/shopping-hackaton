#!/usr/bin/env node
// `npm run pages [outDir]`: static export of the demo's untrusted listing for GitHub Pages, so the
// audience can open the same "poisoned" product page on their phones while the agent reads the
// hidden sentence. Writes <outDir>/<slug>/index.html + hero.svg for every inspo listing, a small
// <outDir>/index.html linking them, and an empty .nojekyll. Pure file writes, no network. The
// replica's GET /inspo/<slug> route stays the offline fallback.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { escapeXml as escapeHtml, renderPatternSvg } from "../mock/images.mjs";
import { DEMO_FOOTER, INSPO_PAGES, INSPO_SLUGS, STYLE, renderInspoPage } from "../mock/inspo.mjs";
import { formatCents } from "../mock/pricing.mjs";

export const DEFAULT_OUT_DIR = fileURLToPath(new URL("../out/pages", import.meta.url));
export const INDEX_TITLE = "Odette Atelier";
const HERO_FILE = "hero.svg";
const PAGE_FILE = "index.html";
const NO_JEKYLL_FILE = ".nojekyll";
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const INDEX_STYLE = `${STYLE}
.listings{list-style:none;margin:16px 0;padding:0}
.listings li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-top:12px}
.listings a{color:inherit;font-weight:600}`;

function renderIndexPage(slugs) {
  const items = slugs.map((slug) => {
    const page = INSPO_PAGES[slug];
    return `<li><a href="${escapeHtml(encodeURIComponent(slug))}/">${escapeHtml(page.title)}</a> `
      + `<span class="muted">$${formatCents(page.priceCents)}</span></li>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(INDEX_TITLE)}</title><style>${INDEX_STYLE}</style></head><body><main>
<h1>${escapeHtml(INDEX_TITLE)}</h1>
<ul class="listings">
${items.join("\n")}
</ul>
<p class="muted demo-footer">${DEMO_FOOTER}</p>
</main></body></html>`;
}

function listingFiles(slug) {
  if (!SLUG_PATTERN.test(slug)) throw new Error(`publish-pages: unsafe slug ${JSON.stringify(slug)}`);
  const page = INSPO_PAGES[slug];
  return [
    { path: join(slug, PAGE_FILE), content: renderInspoPage(page, { heroSrc: HERO_FILE, banner: false, revealScript: true }) },
    { path: join(slug, HERO_FILE), content: renderPatternSvg(page.heroPrompt) },
  ];
}

// Every file of the site as { path, content }, paths relative to the output directory.
export const siteFiles = (slugs = INSPO_SLUGS) => Object.freeze([
  ...slugs.flatMap(listingFiles),
  { path: PAGE_FILE, content: renderIndexPage(slugs) },
  { path: NO_JEKYLL_FILE, content: "" },
]);

// Writes the site and returns the paths written, in order.
export async function exportPages(outDir = DEFAULT_OUT_DIR) {
  const written = [];
  for (const file of siteFiles()) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
    written.push(target);
  }
  return Object.freeze(written);
}

async function main() {
  const written = await exportPages(process.argv[2] ?? DEFAULT_OUT_DIR);
  for (const target of written) console.log(`[pages] wrote ${target}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[pages] ${error.message}`);
    process.exitCode = 1;
  });
}
