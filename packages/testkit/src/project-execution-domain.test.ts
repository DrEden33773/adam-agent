import type {
  ProjectLifecycleOwner,
  ProjectLifecycleOwnerLease,
} from "@adam-agent/agent/internal-testing";
import {
  createProjectExecutionDomain,
  ProjectExecutionDomainError,
  ProjectLifecycleOwnerError,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("ProjectExecutionDomain retains one owner for a subordinate claim and the same root", async () => {
  let acquisitions = 0;
  let releases = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire(): Promise<ProjectLifecycleOwnerLease> {
      acquisitions += 1;
      let released = false;
      return {
        async release() {
          if (released) {
            return;
          }
          released = true;
          releases += 1;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parent = await domain.claimRoot({ rootId: "parent-session" });
  const child = await parent.claimChild({ childId: "child-1" });

  await parent.release();
  const reentered = await domain.claimRoot({ rootId: "parent-session" });
  await expect(domain.claimRoot({ rootId: "different-session" })).rejects.toEqual(
    new ProjectExecutionDomainError("root_conflict"),
  );
  expect({ acquisitions, releases }).toEqual({ acquisitions: 1, releases: 0 });

  await reentered.release();
  expect(releases).toBe(0);
  await child.release();
  expect(releases).toBe(1);
});

test("ProjectExecutionDomain releases root and child claims idempotently", async () => {
  let releases = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          releases += 1;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const root = await domain.claimRoot({ rootId: "parent-session" });
  const child = await root.claimChild({ childId: "child-1" });

  await root.release();
  await root.release();
  await child.release();
  await child.release();

  expect(releases).toBe(1);
});

test("ProjectExecutionDomain close fences admission before draining subordinate claims", async () => {
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const root = await domain.claimRoot({ rootId: "parent-session" });
  const child = await root.claimChild({ childId: "child-1" });
  await root.release();

  const closing = domain.close().then(() => "closed" as const);
  const firstSettlement = Promise.race([
    closing,
    domain
      .claimRoot({ rootId: "parent-session" })
      .catch((error: unknown) => ({ admissionError: error }) as const),
  ]);

  await expect(firstSettlement).resolves.toEqual({
    admissionError: new ProjectExecutionDomainError("domain_closed"),
  });
  await child.release();
  await expect(closing).resolves.toBe("closed");
});

test("ProjectExecutionDomain maps an unavailable OS owner without publishing a root", async () => {
  const owner: ProjectLifecycleOwner = {
    async acquire(): Promise<ProjectLifecycleOwnerLease> {
      throw new ProjectLifecycleOwnerError("project_owner_unavailable");
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });

  await expect(domain.claimRoot({ rootId: "parent-session" })).rejects.toEqual(
    new ProjectExecutionDomainError("project_owner_unavailable"),
  );
});

test("ProjectExecutionDomain preserves an external project-in-use rejection", async () => {
  const owner: ProjectLifecycleOwner = {
    async acquire(): Promise<ProjectLifecycleOwnerLease> {
      throw new ProjectLifecycleOwnerError("project_in_use");
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });

  await expect(domain.claimRoot({ rootId: "parent-session" })).rejects.toEqual(
    new ProjectExecutionDomainError("project_in_use"),
  );
});

test("ProjectExecutionDomain joins concurrent claims for the same root behind one acquisition", async () => {
  const acquisitionStarted = Promise.withResolvers<void>();
  const allowAcquisition = Promise.withResolvers<void>();
  let acquisitions = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      acquisitions += 1;
      acquisitionStarted.resolve();
      await allowAcquisition.promise;
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });

  const firstClaim = domain.claimRoot({ rootId: "parent-session" });
  await acquisitionStarted.promise;
  const secondClaim = domain.claimRoot({ rootId: "parent-session" });
  allowAcquisition.resolve();
  const [first, second] = await Promise.all([firstClaim, secondClaim]);

  expect(acquisitions).toBe(1);
  await first.release();
  await second.release();
});

test("ProjectExecutionDomain close fences an acquisition already in flight", async () => {
  const acquisitionStarted = Promise.withResolvers<void>();
  const allowAcquisition = Promise.withResolvers<void>();
  let releases = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      acquisitionStarted.resolve();
      await allowAcquisition.promise;
      return {
        async release() {
          releases += 1;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });

  const claiming = domain.claimRoot({ rootId: "parent-session" });
  await acquisitionStarted.promise;
  const closing = domain.close();
  allowAcquisition.resolve();

  await expect(claiming).rejects.toEqual(new ProjectExecutionDomainError("domain_closed"));
  await expect(closing).resolves.toBeUndefined();
  expect(releases).toBe(1);
});

test("ProjectExecutionDomain close waits for a final OS release already in flight", async () => {
  const ownerReleaseStarted = Promise.withResolvers<void>();
  const allowOwnerRelease = Promise.withResolvers<void>();
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          ownerReleaseStarted.resolve();
          await allowOwnerRelease.promise;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const root = await domain.claimRoot({ rootId: "parent-session" });

  const releasing = root.release();
  await ownerReleaseStarted.promise;
  const closing = domain.close().then(() => "closed" as const);
  const firstSettlement = Promise.race([
    closing,
    domain
      .claimRoot({ rootId: "parent-session" })
      .catch((error: unknown) => ({ admissionError: error }) as const),
  ]);

  await expect(firstSettlement).resolves.toEqual({
    admissionError: new ProjectExecutionDomainError("domain_closed"),
  });
  allowOwnerRelease.resolve();
  await expect(Promise.all([releasing, closing])).resolves.toEqual([undefined, "closed"]);
});

test("ProjectExecutionDomain close reports a failed final OS release", async () => {
  const releaseFailure = new Error("injected owner release failure");
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          throw releaseFailure;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const root = await domain.claimRoot({ rootId: "parent-session" });

  await expect(root.release()).rejects.toBe(releaseFailure);
  await expect(root.release()).rejects.toBe(releaseFailure);
  await expect(domain.close()).rejects.toBe(releaseFailure);
});

test("ProjectExecutionDomain preserves a failed final OS release for child retries", async () => {
  const releaseFailure = new Error("injected child owner release failure");
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          throw releaseFailure;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const root = await domain.claimRoot({ rootId: "parent-session" });
  const child = await root.claimChild({ childId: "child-1" });
  await root.release();

  await expect(child.release()).rejects.toBe(releaseFailure);
  await expect(child.release()).rejects.toBe(releaseFailure);
  await expect(domain.close()).rejects.toBe(releaseFailure);
});

test("ProjectExecutionDomain runs one operation under an exact root claim", async () => {
  let releases = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          releases += 1;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });

  await expect(domain.runRoot({ rootId: "parent-session" }, async () => "completed")).resolves.toBe(
    "completed",
  );
  expect(releases).toBe(1);
});

test("ProjectExecutionDomain rejects a child minted from a released root claim", async () => {
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const stale = await domain.claimRoot({ rootId: "parent-session" });
  await stale.release();
  const current = await domain.claimRoot({ rootId: "different-session" });

  await expect(stale.claimChild({ childId: "stale-child" })).rejects.toEqual(
    new ProjectExecutionDomainError("claim_released"),
  );
  await current.release();
});
