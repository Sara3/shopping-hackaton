// The hosted-checkout page a simulated checkout link opens: a Leash checkout on live Arcade (checkout.mjs
// step 7, under a mandate) or a key-holding agent's checkout with Leash off (simulated-checkout.mjs, no
// mandate). It reads like a checkout: order summary, total, a Pay button. Pay only flips the gateway's own
// receipt to paid: no card, no money, no Arcade order, and the page says so. No script; every value is
// escaped, and the product image is shown only for an http(s) URL.

const ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
const isHttpUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value);

const STYLE = `
:root{color-scheme:light dark;--bg:#faf8f4;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e4e0d8;--accent:#1f6f50}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f4;--muted:#a0a0a8;--card:#1d1d20;--line:#2e2e33;--accent:#4fbf8f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
.brand{font-weight:600;letter-spacing:.02em;color:var(--muted);font-size:14px;margin:0}
h1{font-size:22px;margin:4px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
.item{display:flex;gap:12px;align-items:center}
.thumb{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);flex:none}
.info{flex:1;min-width:0}.title{font-weight:600}
.muted{color:var(--muted);font-size:14px}.small{font-size:13px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line)}
.row.total{font-size:20px;font-weight:600}
button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:17px;cursor:pointer}
.paid{color:var(--accent);font-weight:600;margin:16px 0 4px}
.note{background:#fff3cd;color:#5c4400;border-radius:8px;padding:8px 12px;font-size:14px;margin-top:16px}`;

// The receipt's id on the gateway: its mandate, or its sim_ checkoutId when no mandate was involved.
const receiptId = (receipt) => receipt.mandateId ?? receipt.checkoutId;

const payForm = (id, total) =>
  `<form method="post" action="/simulated-checkout/${encodeURIComponent(id)}/pay"><button type="submit">Pay $${escapeHtml(total)}</button></form>`;

// Who let this purchase through: Leash under a mandate, or nobody (the agent held the account key).
const approvalNote = (receipt) => (receipt.mandateId
  ? `Leash approved this purchase under mandate ${escapeHtml(receipt.mandateId)}.`
  : "The agent held the account key; nothing was charged.");

const paidNote = (paid) =>
  `<p class="paid">Payment complete. Order ${escapeHtml(paid.orderNumber)} placed.</p>`
  + `<p class="muted small">Paid ${escapeHtml(paid.paidAt)}</p>`;

function itemRow(receipt) {
  const image = isHttpUrl(receipt.imageUrl) ? `<img class="thumb" src="${escapeHtml(receipt.imageUrl)}" alt="">` : "";
  const details = [receipt.selectionLabel, receipt.maker].filter(Boolean).map(escapeHtml).join(" · ");
  return `<div class="item">${image}<div class="info"><div class="title">${escapeHtml(receipt.title)}</div>`
    + `${details ? `<div class="muted">${details}</div>` : ""}`
    + `<div class="muted">Qty ${escapeHtml(receipt.quantity)} × $${escapeHtml(receipt.unitPrice)}</div></div>`
    + `<div>$${escapeHtml(receipt.total)}</div></div>`;
}

// paid: null until Pay, then { orderNumber, paidAt }.
export function renderSimulatedCheckoutPage(receipt, paid = null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout · ${escapeHtml(receipt.title)}</title><style>${STYLE}</style></head><body><main>
<p class="brand">Secure checkout</p><h1>${paid ? "Order confirmed" : "Review and pay"}</h1>
<div class="card">${itemRow(receipt)}
<div class="row"><span>Subtotal</span><span>$${escapeHtml(receipt.total)}</span></div>
<div class="row total"><span>Total</span><span>$${escapeHtml(receipt.total)} ${escapeHtml(receipt.currency)}</span></div>
${paid ? paidNote(paid) : payForm(receiptId(receipt), receipt.total)}</div>
<p class="note">Simulated checkout: no card is charged and no Arcade order is created. ${approvalNote(receipt)}</p>
</main></body></html>`;
}
