import type {
  ProjectLifecycleOwner,
  ProjectLifecycleOwnerLease,
} from "./project-lifecycle-owner.js";
import { ProjectLifecycleOwnerError } from "./project-lifecycle-owner.js";

export const projectRuntimeRootId = "project-runtime";

export class ProjectExecutionDomainError extends Error {
  readonly code:
    | "domain_closed"
    | "claim_released"
    | "project_in_use"
    | "project_owner_unavailable"
    | "root_conflict";

  constructor(code: ProjectExecutionDomainError["code"]) {
    super(
      code === "claim_released"
        ? "The project execution claim has already been released."
        : code === "domain_closed"
          ? "The project execution domain is closed."
          : code === "project_owner_unavailable"
            ? "The OS-backed project lifecycle owner is unavailable."
            : code === "project_in_use"
              ? "Another process owns lifecycle mutations for this canonical project."
              : "Another session or operation cannot start while this parent session owns active background children. Wait for or cancel them first.",
    );
    this.name = "ProjectExecutionDomainError";
    this.code = code;
  }
}

export type ProjectExecutionChildClaim = {
  readonly childId: string;
  release(): Promise<void>;
};

export type ProjectExecutionRootClaim = {
  readonly rootId: string;
  claimChild(input: { readonly childId: string }): Promise<ProjectExecutionChildClaim>;
  release(): Promise<void>;
};

export type ProjectExecutionDomain = {
  claimRoot(input: { readonly rootId: string }): Promise<ProjectExecutionRootClaim>;
  runRoot<T>(input: { readonly rootId: string }, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function createProjectExecutionDomain(options: {
  readonly lifecycleOwner: ProjectLifecycleOwner;
}): ProjectExecutionDomain {
  let activeRootId: string | undefined;
  let ownerLease: ProjectLifecycleOwnerLease | undefined;
  let acquisitionPromise: Promise<ProjectLifecycleOwnerLease> | undefined;
  let finalReleasePromise: Promise<void> | undefined;
  let finalReleaseFailure: { readonly error: unknown } | undefined;
  let claimCount = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let rejectClose: ((error: unknown) => void) | undefined;

  const releaseClaim = async () => {
    claimCount -= 1;
    if (claimCount !== 0) {
      return;
    }
    const lease = ownerLease;
    const release = (async () => {
      try {
        await lease?.release();
        ownerLease = undefined;
        activeRootId = undefined;
        resolveClose?.();
      } catch (error) {
        closed = true;
        finalReleaseFailure = { error };
        rejectClose?.(error);
        throw error;
      } finally {
        finalReleasePromise = undefined;
      }
    })();
    finalReleasePromise = release;
    await release;
  };

  const createRelease = () => {
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await releaseClaim();
    };
  };

  const domain: ProjectExecutionDomain = {
    async claimRoot({ rootId }) {
      if (closed) {
        throw new ProjectExecutionDomainError("domain_closed");
      }
      if (finalReleasePromise !== undefined) {
        throw new ProjectExecutionDomainError("root_conflict");
      }
      if (activeRootId !== undefined && activeRootId !== rootId) {
        throw new ProjectExecutionDomainError("root_conflict");
      }
      activeRootId ??= rootId;
      claimCount += 1;
      if (ownerLease === undefined) {
        try {
          if (acquisitionPromise === undefined) {
            acquisitionPromise = options.lifecycleOwner.acquire();
          }
          const acquisition = acquisitionPromise;
          ownerLease = await acquisition;
          if (acquisitionPromise === acquisition) {
            acquisitionPromise = undefined;
          }
        } catch (error) {
          acquisitionPromise = undefined;
          await releaseClaim();
          if (error instanceof ProjectLifecycleOwnerError) {
            throw new ProjectExecutionDomainError(error.code);
          }
          throw error;
        }
      }
      if (closed) {
        await releaseClaim();
        throw new ProjectExecutionDomainError("domain_closed");
      }
      let rootReleased = false;
      return {
        rootId,
        async claimChild({ childId }) {
          if (rootReleased || activeRootId !== rootId || ownerLease === undefined) {
            throw new ProjectExecutionDomainError("claim_released");
          }
          if (closed) {
            throw new ProjectExecutionDomainError("domain_closed");
          }
          claimCount += 1;
          return { childId, release: createRelease() };
        },
        async release() {
          if (rootReleased) {
            return;
          }
          rootReleased = true;
          await releaseClaim();
        },
      };
    },
    async runRoot(input, operation) {
      const claim = await domain.claimRoot(input);
      try {
        return await operation();
      } finally {
        await claim.release();
      }
    },
    close() {
      closed = true;
      closePromise ??=
        finalReleasePromise !== undefined
          ? finalReleasePromise
          : finalReleaseFailure !== undefined
            ? Promise.reject(finalReleaseFailure.error)
            : claimCount === 0
              ? Promise.resolve()
              : new Promise<void>((resolve, reject) => {
                  resolveClose = resolve;
                  rejectClose = reject;
                });
      return closePromise;
    },
  };
  return domain;
}
