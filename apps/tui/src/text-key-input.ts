import { decodeKittyPrintable, isKeyRelease } from "@earendil-works/pi-tui";

export function textKeyInput(data: string): string | undefined {
  if (isKeyRelease(data)) {
    return undefined;
  }
  const text = decodeKittyPrintable(data) ?? data;
  return text.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(text) ? text : undefined;
}
