// Money math in integer cents. The quoted unit price applies the volume tier that
// quantity x base price reaches (mock simplification, see the MOCK CONTRACT).
// KNOWN DIVERGENCE from the real API: docs/arcade-api-reference.md (products/get) says the real
// unitPrice is BEFORE the volume discount. So for 50 scarves the agent shows $5120.00 here and
// $6400.00 (pre-discount) in live mode; the real checkout page applies the tier. REPRO Part B notes this.
import { CURRENCY, VOLUME_TIERS } from "./catalog.mjs";

const PERCENT = 100;

export const formatCents = (cents) => (Math.round(cents) / 100).toFixed(2);

export const money = (cents) => ({ amount: formatCents(cents), currency: CURRENCY });

export const tierFor = (spendCents) =>
  VOLUME_TIERS.find(
    (tier) => spendCents >= tier.minimumSpendCents && (tier.maximumSpendCents === null || spendCents < tier.maximumSpendCents),
  ) ?? null;

export function unitPriceCents(basePriceCents, quantity) {
  if (quantity <= 1) return basePriceCents;
  const tier = tierFor(basePriceCents * quantity);
  if (!tier) return basePriceCents;
  return Math.round((basePriceCents * (PERCENT - tier.discountPercent)) / PERCENT);
}

export const volumeDiscountsView = () => ({
  currency: CURRENCY,
  tiers: VOLUME_TIERS.map((tier) => ({
    minimumSpend: formatCents(tier.minimumSpendCents),
    maximumSpend: tier.maximumSpendCents === null ? null : formatCents(tier.maximumSpendCents),
    discountPercent: tier.discountPercent,
  })),
});

export function priceLine({ basePriceCents, quantity }) {
  const unitCents = unitPriceCents(basePriceCents, quantity);
  return {
    unitCents,
    lineCents: unitCents * quantity,
    discountCents: (basePriceCents - unitCents) * quantity,
  };
}
