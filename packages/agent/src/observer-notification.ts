/** Invoke ordinary observers synchronously, without letting them control execution. */
export function notifyObserver(notify: () => unknown): void {
  try {
    const outcome = notify();
    if (outcome !== undefined) void Promise.resolve(outcome).catch(() => {});
  } catch {
    // Durable appends and required runtime barriers never use this notification seam.
  }
}
