export async function withManagedFailureGuard<T>(
  operation: Promise<T>,
  missingState: string,
): Promise<T> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error(missingState)), 5_000);
      }),
    ]);
  } finally {
    if (guard !== undefined) {
      clearTimeout(guard);
    }
  }
}
