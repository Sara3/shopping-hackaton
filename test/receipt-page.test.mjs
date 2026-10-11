import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSimulatedCheckoutPage } from "../gateway/receipt-page.mjs";

const RECEIPT = Object.freeze({
  simulated: true, mandateId: "mnd_0123456789abcdef", productId: "p1", title: "Silk scarf · roses", imageUrl: "https://cdn.example/x.png",
  selectionLabel: "90x90 • hand-rolled", maker: "Odette", quantity: 1, unitPrice: "128.00", total: "128.00", currency: "USD",
});

test("the checkout page escapes every value and shows the image only for an http(s) URL", () => {
  const hostile = { ...RECEIPT, title: '<img src=x onerror=alert(1)>', maker: '"><script>x</script>', imageUrl: "javascript:alert(1)" };
  const html = renderSimulatedCheckoutPage(hostile);
  assert.ok(!html.includes("<script") && !html.includes("<img src=x") && !html.includes("javascript:"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(renderSimulatedCheckoutPage(RECEIPT).includes('<img class="thumb" src="https://cdn.example/x.png"'));
});

test("unpaid shows Review and pay with a Pay form; paid shows the order and no form", () => {
  const unpaid = renderSimulatedCheckoutPage(RECEIPT);
  assert.ok(unpaid.includes("Review and pay") && unpaid.includes("<form") && unpaid.includes("Pay $128.00"));
  const paid = renderSimulatedCheckoutPage(RECEIPT, { orderNumber: "SIM-000007", paidAt: "2026-10-11T20:30:00.000Z" });
  assert.ok(paid.includes("Order confirmed") && paid.includes("Order SIM-000007 placed") && !paid.includes("<form"));
});

test("a receipt with no mandate (Leash off, the agent held the key) pays under its sim_ id and says so instead of naming a mandate", () => {
  const keyHeld = { ...RECEIPT, mandateId: null, checkoutId: "sim_fedcba9876543210" };
  const html = renderSimulatedCheckoutPage(keyHeld);
  assert.ok(html.includes('action="/simulated-checkout/sim_fedcba9876543210/pay"'), html);
  assert.ok(html.includes("Simulated checkout: no card is charged and no Arcade order is created. The agent held the account key; nothing was charged."));
  assert.ok(!html.includes("mandate") && !html.includes("null"), html);
  const paid = renderSimulatedCheckoutPage(keyHeld, { orderNumber: "SIM-000002", paidAt: "2026-10-11T20:31:00.000Z" });
  assert.ok(paid.includes("Order confirmed") && paid.includes("Order SIM-000002 placed") && !paid.includes("<form"));
  const mandated = renderSimulatedCheckoutPage(RECEIPT);
  assert.ok(mandated.includes("Leash approved this purchase under mandate mnd_0123456789abcdef.") && !mandated.includes("held the account key"));
});
