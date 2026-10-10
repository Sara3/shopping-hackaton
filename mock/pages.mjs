// The mock hosted checkout page (GET /checkout/<id>). No money moves: the Pay button
// POSTs /checkout/<id>/pay, which places the order in the replica only.
import { escapeXml as escapeHtml } from "./images.mjs";
import { formatCents } from "./pricing.mjs";

const STYLE = `
:root{color-scheme:light dark;--bg:#faf8f4;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e4e0d8;--accent:#1f6f50}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f4;--muted:#a0a0a8;--card:#1d1d20;--line:#2e2e33;--accent:#4fbf8f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
.banner{background:#fff3cd;color:#5c4400;border-radius:8px;padding:8px 12px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
td.num,th.num{text-align:right;white-space:nowrap}.muted{color:var(--muted);font-size:14px}
.total{font-size:20px;font-weight:600;text-align:right;margin-top:12px}
button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:17px;cursor:pointer}
.paid{color:var(--accent);font-weight:600}`;

const lineRow = (line) => `<tr>
<td>${escapeHtml(line.title)}<div class="muted">${escapeHtml(line.selectionLabel)} · ${escapeHtml(line.makerName)}</div></td>
<td class="num">${line.quantity}</td>
<td class="num">$${formatCents(line.unitCents)}${line.unitCents < line.baseCents ? `<div class="muted">was $${formatCents(line.baseCents)}</div>` : ""}</td>
<td class="num">$${formatCents(line.lineCents)}</td></tr>`;

const payForm = (checkoutId) =>
  `<form method="post" action="/checkout/${encodeURIComponent(checkoutId)}/pay"><button type="submit">Pay (mock, no money)</button></form>`;

const paidNote = (order) =>
  `<p class="paid">Paid (mock). Order ${escapeHtml(order.orderNumber)} placed, orderId ${escapeHtml(order.orderId)}.</p>`;

export function renderCheckoutPage(checkout, order) {
  const discount = checkout.discountCents > 0 ? `<p class="muted">Volume discount applied: −$${formatCents(checkout.discountCents)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock Checkout ${escapeHtml(checkout.checkoutId)}</title><style>${STYLE}</style></head><body><main>
<div class="banner">Arcade replica (sandbox). This page is a local mock: no card, no money, no real order.</div>
<div class="card"><h1>Checkout ${escapeHtml(checkout.checkoutId)}</h1>
<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line total</th></tr></thead>
<tbody>${checkout.lines.map(lineRow).join("")}</tbody></table>
${discount}<div class="total" data-total="${formatCents(checkout.totalCents)}">Total: $${formatCents(checkout.totalCents)} USD</div>
${order ? paidNote(order) : payForm(checkout.checkoutId)}</div></main></body></html>`;
}

export const renderNotFoundPage = () =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout not found</title></head><body><p>Checkout not found.</p></body></html>`;
