export function quantityDiscountBasisPoints(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError("Quantity must be a positive integer.");
  }
  return quantity >= 3 ? 1_000 : 0;
}
