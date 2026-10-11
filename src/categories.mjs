// Our four demo categories go by the replica's names (mock/catalog.mjs). Live Arcade sells the same
// things under other names (no "Silk scarf"; "Scarves"), so each name lists its live names, best first.
// The agent resolves a category through this list, and a Leash token carries every name, so one
// allowance matches in mock and live mode alike. The gateway itself still matches names exactly.

export const LIVE_NAMES = Object.freeze({
  "silk scarf": Object.freeze(["Scarves", "Ribbon Scarf"]),
  "linen pillow": Object.freeze(["Decorative Pillows"]),
  "cotton dinner napkins": Object.freeze(["Napkins"]),
  lampshade: Object.freeze(["Drum Lampshades"]),
});

// The name itself first, then its live names; a name we do not know maps to itself only.
export function namesFor(name) {
  const text = String(name ?? "").trim();
  return Object.freeze([text, ...(LIVE_NAMES[text.toLowerCase()] ?? [])]);
}

// Every name an allowance's categories stand for, each once, in order.
export const withLiveNames = (names) => Object.freeze([...new Set((names ?? []).flatMap(namesFor))]);
