// Render stored records into the exact Arcade response shapes (docs/arcade-api-reference.md §5).
import { findCategory, selectionLabel } from "./catalog.mjs";
import { money, unitPriceCents, volumeDiscountsView } from "./pricing.mjs";

const PATTERN_SIZE_PX = 1024;

export const imageUrl = (origin, id) => `${origin}/img/${encodeURIComponent(id)}.svg`;
export const isReady = (record, now) => now >= record.readyAt;

export const patternView = (record, origin) => ({
  imageUrl: imageUrl(origin, record.patternId),
  thumbnailUrl: imageUrl(origin, record.patternId),
  width: PATTERN_SIZE_PX,
  height: PATTERN_SIZE_PX,
  patternId: record.patternId,
  prompt: record.prompt,
  sourcePatternId: record.sourcePatternId,
  createdAt: record.createdAt,
});

export function jobView(job, now) {
  const done = isReady(job, now);
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: done ? "succeeded" : "running",
    result: done ? job.result : null,
    error: null,
    createdAt: job.createdAt,
    completedAt: done ? new Date(job.readyAt).toISOString() : null,
  };
}

export const referenceView = (record, origin) => ({
  imageUrl: imageUrl(origin, record.referenceId),
  thumbnailUrl: imageUrl(origin, record.referenceId),
  width: PATTERN_SIZE_PX,
  height: PATTERN_SIZE_PX,
  mediaType: record.mediaType,
  referenceId: record.referenceId,
  createdAt: record.createdAt,
});

export function productSummaryView(record, origin) {
  const category = findCategory(record.categoryId);
  return {
    productId: record.productId,
    title: record.title,
    categoryId: record.categoryId,
    maker: { ...category.maker },
    selections: { ...record.selections },
    selectionLabel: selectionLabel(category, record.selections),
    imageUrl: imageUrl(origin, record.patternId),
    createdAt: record.createdAt,
    patternId: record.patternId,
  };
}

export function productView(record, origin, quantity) {
  const category = findCategory(record.categoryId);
  return {
    ...productSummaryView(record, origin),
    images: [{ url: imageUrl(origin, record.patternId) }],
    description: category.description,
    careInstructions: category.careInstructions,
    volumeDiscounts: volumeDiscountsView(),
    unitPrice: money(unitPriceCents(category.basePriceCents, quantity)),
  };
}

const orderLineView = (line, origin) => ({
  productId: line.productId,
  title: line.title,
  selectionLabel: line.selectionLabel,
  quantity: line.quantity,
  total: money(line.lineCents),
  imageUrl: imageUrl(origin, line.patternId),
  makerName: line.makerName,
});

export const orderSummaryView = (order, origin) => ({
  orderId: order.orderId,
  orderCode: order.orderCode,
  orderNumber: order.orderNumber,
  status: order.status,
  placedAt: order.placedAt,
  total: money(order.totalCents),
  itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
  imageUrl: order.lines.length ? imageUrl(origin, order.lines[0].patternId) : null,
  lines: order.lines.map((line) => orderLineView(line, origin)),
});

export const orderView = (order, origin) => ({
  ...orderSummaryView(order, origin),
  subtotal: money(order.subtotalCents),
  shipping: money(0),
  tax: money(0),
  volumeDiscount: money(order.discountCents),
  discounts: money(0),
  shippingAddress: { name: "Mock Buyer", city: "Sandbox", provinceCode: null, countryCode: "US" },
  tracking: [],
  refunds: [],
});
