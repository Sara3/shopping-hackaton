// Money helpers in integer cents so totals never drift (e.g. 50 x 102.40 = 5120.00).
const CENTS = 100;

export const toCents = (amount) => Math.round(Number.parseFloat(String(amount)) * CENTS);
export const formatCents = (cents) => (cents / CENTS).toFixed(2);
export const lineTotal = (unitAmount, quantity) => formatCents(toCents(unitAmount) * quantity);
