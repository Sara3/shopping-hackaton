// Static catalog of the Arcade replica: models, the 4 categories, makers and base prices.
// Category and maker names follow Arcade Studio's public landing page; prices are mock values.

export const CURRENCY = "USD";

export const MODELS = Object.freeze([
  Object.freeze({ modelId: "mock-canon-1", name: "Arcade Canon (mock)" }),
  Object.freeze({ modelId: "mock-sketch-1", name: "Sketch (mock)" }),
]);

const option = (key, label, values) =>
  Object.freeze({
    key,
    label,
    values: Object.freeze(values.map((value, index) => Object.freeze({ value, label: value, isDefault: index === 0 }))),
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
    categoryId: "c314010b-e15a-4014-a376-9b8f4e973461",
    name: "Cotton dinner napkins",
    basePriceCents: 4800,
    maker: Object.freeze({ makerId: "maker-esme", name: "Esme (mock)" }),
    options: Object.freeze([option("fabric", "Fabric", ["cotton", "linen"]), option("size", "Size", ["20x20", "18x18"])]),
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

export const selectionLabel = (category, selections) =>
  category.options.map((opt) => `${opt.label}: ${selections[opt.key]}`).join(", ");
