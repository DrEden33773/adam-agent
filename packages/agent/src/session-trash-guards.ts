import type { ManagedControlStore } from "./managed-agent-folds.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import type { SessionStore, SessionStoreDirectory } from "./session-store.js";
import { type createSessionTrashRepository, SessionTrashError } from "./session-trash.js";

export function createSessionTrashAccess(
  repository: ReturnType<typeof createSessionTrashRepository>,
) {
  const assertAccessible = async (sessionId: string) => {
    try {
      await repository.assertAccessible(sessionId);
    } catch (error) {
      throw new SessionLifecycleError(
        error instanceof SessionTrashError && error.code === "conflict"
          ? "session_in_trash"
          : "session_trash_unavailable",
      );
    }
  };
  const reservedIds = async (): Promise<ReadonlySet<string>> => {
    try {
      const catalog = await repository.list();
      if (catalog.diagnostics.length > 0)
        throw new SessionLifecycleError("session_trash_unavailable");
      return new Set(
        catalog.transactions
          .filter((entry) => entry.phase !== "restored")
          .flatMap((entry) => [
            entry.unit.mainSessionId,
            ...entry.unit.children.map((child) => child.sessionId),
          ]),
      );
    } catch {
      throw new SessionLifecycleError("session_trash_unavailable");
    }
  };
  const checked = async <T>(sessionId: string, read: () => Promise<T>): Promise<T> => {
    await assertAccessible(sessionId);
    const result = await read();
    await assertAccessible(sessionId);
    return result;
  };
  const wrapStore = (sessionId: string, store: SessionStore): SessionStore => ({
    read: () => checked(sessionId, () => store.read()),
    async append(record) {
      await assertAccessible(sessionId);
      await store.append(record);
    },
    async appendBatch(records) {
      await assertAccessible(sessionId);
      await store.appendBatch(records);
    },
  });
  const wrapDirectory = (directory: SessionStoreDirectory): SessionStoreDirectory => ({
    ...(directory.byteLength === undefined
      ? {}
      : {
          byteLength: (sessionId: string) =>
            checked(
              sessionId,
              () => directory.byteLength?.(sessionId) ?? Promise.resolve(undefined),
            ),
        }),
    readRecords: (sessionId) =>
      checked(sessionId, async () =>
        directory.readRecords === undefined
          ? (await directory.open(sessionId))?.read()
          : directory.readRecords(sessionId),
      ),
    async create(sessionId) {
      await assertAccessible(sessionId);
      return wrapStore(sessionId, await directory.create(sessionId));
    },
    async open(sessionId) {
      const store = await checked(sessionId, () => directory.open(sessionId));
      return store === undefined ? undefined : wrapStore(sessionId, store);
    },
    async listSessionEntries() {
      const entries = await directory.listSessionEntries();
      const reserved = await reservedIds();
      return entries.filter((entry) => !reserved.has(entry.sessionId));
    },
    async listSessionIds() {
      const ids = await directory.listSessionIds();
      const reserved = await reservedIds();
      return ids.filter((id) => !reserved.has(id));
    },
  });
  const wrapControlStore = (
    store: ManagedControlStore,
    parentSessionId?: string,
  ): ManagedControlStore => ({
    forParent(id) {
      return wrapControlStore(store.forParent(id), id);
    },
    async preflight() {
      if (parentSessionId !== undefined) await assertAccessible(parentSessionId);
      await store.preflight();
    },
    async readLegacy() {
      if (parentSessionId !== undefined) await assertAccessible(parentSessionId);
      return store.readLegacy();
    },
    async read() {
      if (parentSessionId !== undefined) return checked(parentSessionId, () => store.read());
      const records = await store.read();
      const reserved = await reservedIds();
      return records.filter((record) => !reserved.has(record.parentSessionId));
    },
    async append(record) {
      await assertAccessible(record.parentSessionId);
      await store.append(record);
    },
    async appendNext(record) {
      await assertAccessible(record.parentSessionId);
      return store.appendNext(record);
    },
    async appendBatchNext(records) {
      for (const parent of new Set(records.map((record) => record.parentSessionId)))
        await assertAccessible(parent);
      return store.appendBatchNext(records);
    },
  });
  return { assertAccessible, reservedIds, wrapDirectory, wrapControlStore };
}
