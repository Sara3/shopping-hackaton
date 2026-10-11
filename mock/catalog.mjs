// Static catalog of the Arcade replica: models, the 4 categories, makers and base prices.
// Category and maker names follow Arcade Studio's public landing page; prices are mock values.

export const CURRENCY = "USD";

// Real modelId/name pairs from a live models.list call (2026-10-11); the replica never actually
// renders in a given style (see images.mjs), but real IDs let a demo pass one through untouched.
export const MODELS = Object.freeze([
  Object.freeze({ modelId: "batik", name: "Indonesian Batik" }),
  Object.freeze({ modelId: "chinoiserie", name: "East Asian" }),
  Object.freeze({ modelId: "arts-and-crafts-floral", name: "Arts and Crafts Floral" }),
  Object.freeze({ modelId: "victorian-floral", name: "Archival British Floral" }),
  Object.freeze({ modelId: "parisian-garden", name: "Archival French Floral" }),
  Object.freeze({ modelId: "marbled-paper", name: "Archival Hand Marbled" }),
  Object.freeze({ modelId: "stamped-floral", name: "Ukrainian Folk Art" }),
  Object.freeze({ modelId: "french-floral-wallpaper", name: "French Floral Wallpaper" }),
  Object.freeze({ modelId: "art-nouveau", name: "Art Nouveau" }),
  Object.freeze({ modelId: "japanese-botanical", name: "Japanese Botanical" }),
  Object.freeze({ modelId: "japanese-woodblock", name: "Japanese Woodblock" }),
  Object.freeze({ modelId: "french-neoclassical", name: "French Neoclassical" }),
  Object.freeze({ modelId: "indian-textiles", name: "Indian Textiles" }),
  Object.freeze({ modelId: "american-aesthetic-movement", name: "American Aesthetic Movement" }),
  Object.freeze({ modelId: "gilded-age-frieze", name: "Gilded Age Frieze" }),
  Object.freeze({ modelId: "gilded-age", name: "Gilded Age" }),
  Object.freeze({ modelId: "austrian-biedermeier", name: "Austrian Biedermeier" }),
  Object.freeze({ modelId: "estonian-watercolor", name: "Estonian Watercolor" }),
  Object.freeze({ modelId: "toile", name: "Toile" }),
  Object.freeze({ modelId: "impressionism", name: "Impressionism" }),
  Object.freeze({ modelId: "nonpareil-hand-marbled", name: "Nonpareil Hand Marbled" }),
  Object.freeze({ modelId: "french-rococo", name: "French Rococo" }),
  Object.freeze({ modelId: "european-tapestry", name: "European Tapestry" }),
  Object.freeze({ modelId: "italian-silk", name: "Italian Silk" }),
  Object.freeze({ modelId: "meiji-period", name: "Meiji Period" }),
  Object.freeze({ modelId: "mughal-watercolor", name: "Mughal Watercolor" }),
]);

const option = (key, label, values, labels = {}) =>
  Object.freeze({
    key,
    label,
    values: Object.freeze(
      values.map((value, index) => Object.freeze({ value, label: labels[value] ?? value, isDefault: index === 0 })),
    ),
  });

export const CATEGORIES = Object.freeze([
  Object.freeze({
    categoryId: "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a001",
    name: "Silk scarf",
    basePriceCents: 12800,
    maker: Object.freeze({ makerId: "maker-odette", name: "Odette (mock)" }),
    options: Object.freeze([option("size", "Size", ["90x90", "70x70"]), option("hem", "Hem", ["hand-rolled", "machine"])]),
    description: "Silk twill scarf printed with your pattern (mock product).",
    careInstructions: "Dry clean only.",
  }),
  Object.freeze({
    categoryId: "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a002",
    name: "Linen pillow",
    basePriceCents: 6400,
    maker: Object.freeze({ makerId: "maker-lattice-loom", name: "Lattice & Loom (mock)" }),
    options: Object.freeze([option("size", "Size", ["18x18", "20x20"]), option("insert", "Insert", ["with", "without"])]),
    description: "100% linen pillow cover printed with your pattern (mock product).",
    careInstructions: "Machine wash cold, line dry.",
  }),
  Object.freeze({
    // Real categoryId, maker name and options (2026-10-11 live categories.get); basePriceCents is
    // that call's real unitPrice for the default selection (cotton, 20x20) via products.get.
    categoryId: "c314010b-e15a-4014-a376-9b8f4e973461",
    name: "Cotton dinner napkins",
    basePriceCents: 3396,
    maker: Object.freeze({ makerId: "maker-esme", name: "Esme (mock)" }),
    options: Object.freeze([
      option("fabric", "Fabric", ["cotton", "linen", "refined_linen"], {
        cotton: "Everyday Cotton", linen: "Crisp Linen", refined_linen: "Refined Linen",
      }),
      option("size", "Size", ["20x20", "5x5"], { "20x20": '20" x 20"', "5x5": '5" x 5"' }),
    ]),
    description: "Set of dinner napkins printed with your pattern (mock product).",
    careInstructions: "Machine wash warm, tumble dry low.",
  }),
  Object.freeze({
    categoryId: "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a004",
    name: "Lampshade",
    basePriceCents: 18000,
    maker: Object.freeze({ makerId: "maker-jack-of-all-shades", name: "Jack of All Shades (mock)" }),
    options: Object.freeze([option("size", "Size", ["small", "medium", "large"])]),
    description: "Drum lampshade wrapped in your pattern (mock product).",
    careInstructions: "Dust with a soft brush.",
  }),
]);

export const VOLUME_TIERS = Object.freeze([
  Object.freeze({ minimumSpendCents: 100000, maximumSpendCents: 300000, discountPercent: 10 }),
  Object.freeze({ minimumSpendCents: 300000, maximumSpendCents: null, discountPercent: 20 }),
]);

export const findCategory = (categoryId) => CATEGORIES.find((category) => category.categoryId === categoryId) ?? null;

export const defaultSelections = (category) =>
  Object.fromEntries(category.options.map((opt) => [opt.key, opt.values.find((value) => value.isDefault).value]));

// "Everyday Cotton • 20" x 20"" (value labels joined by " • "), matching the real products.get shape.
export const selectionLabel = (category, selections) =>
  category.options
    .map((opt) => opt.values.find((value) => value.value === selections[opt.key])?.label ?? selections[opt.key])
    .join(" • ");
