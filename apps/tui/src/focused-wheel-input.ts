/** Decode one vertical SGR wheel press for the currently focused viewport. */
export function focusedWheelDirection(data: string): -1 | 1 | null {
  const event = data.codePointAt(0) === 27 ? /^\[<(\d+);\d+;\d+M$/u.exec(data.slice(1)) : null;
  if (event === null) return null;
  const button = Number(event[1]);
  // Shift, Alt and Ctrl retain vertical wheel direction; horizontal wheels do not.
  const base = button & ~28;
  return base === 64 ? -1 : base === 65 ? 1 : null;
}
