import { quantityDiscountBasisPoints } from "./discounts.ts";

export function calculateOrderTotalCents(unitPriceCents: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new RangeError("Unit price must be a non-negative integer number of cents.");
  }
  const subtotalCents = unitPriceCents * quantity;
  const discountBasisPoints = quantityDiscountBasisPoints(quantity);
  return subtotalCents - discountBasisPoints;
}
