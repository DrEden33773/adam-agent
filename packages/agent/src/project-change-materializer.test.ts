import { createHash } from "node:crypto";

import { extensionProjectChangeSnapshotCodec } from "@adam-agent/extension-api";
import { expect, test } from "vitest";
import {
  createProjectChangeMaterializer,
  type ProjectChangeCaptureAdapter,
} from "./project-change-materializer.js";

const utf8 = new TextEncoder();

test("ProjectChangeMaterializer converts one deterministic capture into the strict snapshot", async () => {
  const captureCalls: string[] = [];
  const adapter: ProjectChangeCaptureAdapter = {
    async capture({ canonicalProjectRoot }) {
      captureCalls.push(canonicalProjectRoot);
      return {
        base: {
          commit: "a".repeat(40),
          kind: "head",
          tree: "b".repeat(40),
        },
        candidateTree: "c".repeat(40),
        entries: [
          {
            content: utf8.encode("export const answer = 42;\n"),
            mode: "100644",
            path: utf8.encode("src/answer.ts"),
            side: "head",
          },
        ],
        objectFormat: "sha1",
        unifiedDiff: utf8.encode(
          "diff --git a/src/answer.ts b/src/answer.ts\nnew file mode 100644\n",
        ),
      };
    },
  };

  const snapshot = await createProjectChangeMaterializer(adapter).materialize({
    canonicalProjectRoot: "/project",
  });

  expect(captureCalls).toEqual(["/project"]);
  expect(snapshot).toMatchObject({
    base: {
      commit: "a".repeat(40),
      kind: "head",
      tree: "b".repeat(40),
    },
    candidateTree: "c".repeat(40),
    capturePolicy: {
      id: "adam.git-project-changes",
      objectFormat: "sha1",
      version: 1,
    },
    kind: "adam.project-change-snapshot",
    schemaVersion: 1,
    sources: [
      {
        content: "export const answer = 42;\n",
        contentDigest: sha256("export const answer = 42;\n"),
        mode: "100644",
        path: "src/answer.ts",
        side: "head",
      },
    ],
    unavailable: [],
    unifiedDiff: "diff --git a/src/answer.ts b/src/answer.ts\nnew file mode 100644\n",
  });
  expect(snapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(extensionProjectChangeSnapshotCodec.decode(snapshot)).toEqual({
    ok: true,
    value: snapshot,
  });
});

test("ProjectChangeMaterializer preserves explicit binary, symlink and gitlink evidence", async () => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "c".repeat(40),
        entries: [
          {
            content: Uint8Array.from([0, 1, 2]),
            mode: "100644",
            path: utf8.encode("binary.bin"),
            side: "head",
          },
          { mode: "120000", path: utf8.encode("current-link"), side: "head" },
          { mode: "160000", path: utf8.encode("nested"), side: "head" },
        ],
        objectFormat: "sha1",
        unifiedDiff: utf8.encode("diff --git a/binary.bin b/binary.bin\n"),
      };
    },
  };

  const snapshot = await createProjectChangeMaterializer(adapter).materialize({
    canonicalProjectRoot: "/project",
  });

  expect(snapshot.sources).toEqual([]);
  expect(snapshot.unavailable).toEqual([
    { mode: "100644", path: "binary.bin", reason: "binary", side: "head" },
    { mode: "120000", path: "current-link", reason: "symlink", side: "head" },
    { mode: "160000", path: "nested", reason: "gitlink", side: "head" },
  ]);
});

test.each([
  {
    code: "content_invalid_utf8",
    entry: {
      content: Uint8Array.from([0xc3, 0x28]),
      mode: "100644",
      path: utf8.encode("invalid-content.txt"),
      side: "head",
    },
    name: "invalid UTF-8 content",
  },
  {
    code: "path_invalid",
    entry: {
      content: utf8.encode("valid\n"),
      mode: "100644",
      path: Uint8Array.from([0xff]),
      side: "head",
    },
    name: "invalid UTF-8 path",
  },
  {
    code: "mode_invalid",
    entry: {
      content: utf8.encode("valid\n"),
      mode: "100600",
      path: utf8.encode("invalid-mode.txt"),
      side: "head",
    },
    name: "unknown Git mode",
  },
] as const)("ProjectChangeMaterializer rejects $name", async ({ code, entry }) => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "c".repeat(40),
        entries: [entry],
        objectFormat: "sha1",
        unifiedDiff: utf8.encode("diff --git a/example b/example\n"),
      };
    },
  };

  await expect(
    createProjectChangeMaterializer(adapter).materialize({ canonicalProjectRoot: "/project" }),
  ).rejects.toMatchObject({ code });
});

test("ProjectChangeMaterializer rejects an unchanged candidate before constructing input", async () => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "b".repeat(40),
        entries: [],
        objectFormat: "sha1",
        unifiedDiff: new Uint8Array(),
      };
    },
  };

  await expect(
    createProjectChangeMaterializer(adapter).materialize({ canonicalProjectRoot: "/project" }),
  ).rejects.toMatchObject({ code: "no_changes" });
});

test("ProjectChangeMaterializer rejects a source side above its entry-count limit", async () => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "c".repeat(40),
        entries: Array.from({ length: 101 }, (_, index) => ({
          content: utf8.encode(`${index}\n`),
          mode: "100644" as const,
          path: utf8.encode(`file-${index}.txt`),
          side: "head" as const,
        })),
        objectFormat: "sha1",
        unifiedDiff: utf8.encode("diff --git a/example b/example\n"),
      };
    },
  };

  await expect(
    createProjectChangeMaterializer(adapter).materialize({ canonicalProjectRoot: "/project" }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
});

test("ProjectChangeMaterializer rejects a source blob above its byte limit", async () => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "c".repeat(40),
        entries: [
          {
            content: new Uint8Array(1_000_001).fill(0x61),
            mode: "100644",
            path: utf8.encode("oversized.txt"),
            side: "head",
          },
        ],
        objectFormat: "sha1",
        unifiedDiff: utf8.encode("diff --git a/oversized.txt b/oversized.txt\n"),
      };
    },
  };

  await expect(
    createProjectChangeMaterializer(adapter).materialize({ canonicalProjectRoot: "/project" }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
});

test("ProjectChangeMaterializer rejects aggregate source bytes above the snapshot limit", async () => {
  const adapter: ProjectChangeCaptureAdapter = {
    async capture() {
      return {
        base: { commit: "a".repeat(40), kind: "head", tree: "b".repeat(40) },
        candidateTree: "c".repeat(40),
        entries: Array.from({ length: 9 }, (_, index) => ({
          content: new Uint8Array(1_000_000).fill(0x61),
          mode: "100644" as const,
          path: utf8.encode(`large-${index}.txt`),
          side: "head" as const,
        })),
        objectFormat: "sha1",
        unifiedDiff: utf8.encode("diff --git a/large-0.txt b/large-0.txt\n"),
      };
    },
  };

  await expect(
    createProjectChangeMaterializer(adapter).materialize({ canonicalProjectRoot: "/project" }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
