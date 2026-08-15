export type MutationCoordinator = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export function createMutationCoordinator(): MutationCoordinator {
  let tail = Promise.resolve();

  return {
    async run(operation) {
      let release: () => void = () => {};
      const predecessor = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
