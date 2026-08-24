import {
  EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT,
  extensionProjectChangeSnapshotCodec,
  parseExtensionPackageManifest,
} from "@adam-agent/extension-api";
import { expect, test } from "vitest";

test("the public project-change snapshot codec admits the complete browser-neutral contract", () => {
  const snapshot = {
    base: {
      commit: "a".repeat(40),
      kind: "head",
      tree: "b".repeat(40),
    },
    candidateTree: "c".repeat(40),
    capturePolicy: { id: "adam.git-project-changes", objectFormat: "sha1", version: 1 },
    digest: `sha256:${"d".repeat(64)}`,
    kind: "adam.project-change-snapshot",
    schemaVersion: 1,
    sources: [
      {
        content: "before\n",
        contentDigest: `sha256:${"e".repeat(64)}`,
        mode: "100644",
        path: "src/example.ts",
        side: "base",
      },
      {
        content: "after\n",
        contentDigest: `sha256:${"f".repeat(64)}`,
        mode: "100755",
        path: "src/example.ts",
        side: "head",
      },
    ],
    unavailable: [
      {
        mode: "120000",
        path: "current-link",
        reason: "symlink",
        side: "head",
      },
    ],
    unifiedDiff: "diff --git a/src/example.ts b/src/example.ts\n",
  } as const;

  expect(EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT).toEqual({
    id: "adam.project-change-snapshot",
    version: 1,
  });
  const decoded = extensionProjectChangeSnapshotCodec.decode(snapshot);
  expect(decoded).toEqual({
    ok: true,
    value: snapshot,
  });
  if (!decoded.ok) {
    throw new TypeError("The valid project-change snapshot was rejected.");
  }
  expect(extensionProjectChangeSnapshotCodec.encode(decoded.value)).toEqual({
    ok: true,
    value: snapshot,
  });
});

test.each([
  {
    expected: { code: "unrecognized_keys", path: "/" },
    name: "an unknown field",
    value: { ...minimalSnapshot(), unexpected: true },
  },
  {
    expected: { code: "invalid-path", path: "/sources/0/path" },
    name: "a non-project-relative path",
    value: {
      ...minimalSnapshot(),
      sources: [{ ...minimalSnapshot().sources[0], path: "../outside.txt" }],
    },
  },
  {
    expected: { code: "duplicate-entry", path: "/unavailable/0" },
    name: "a duplicate side and path",
    value: {
      ...minimalSnapshot(),
      unavailable: [
        {
          mode: "120000",
          path: "example.txt",
          reason: "symlink",
          side: "head",
        },
      ],
    },
  },
  {
    expected: { code: "object-format-mismatch", path: "/capturePolicy" },
    name: "an object ID from another Git object format",
    value: {
      ...minimalSnapshot(),
      capturePolicy: {
        ...minimalSnapshot().capturePolicy,
        objectFormat: "sha256",
      },
    },
  },
  {
    expected: { code: "mode-reason-mismatch", path: "/unavailable/0/reason" },
    name: "an unavailable reason inconsistent with its mode",
    value: {
      ...minimalSnapshot(),
      sources: [],
      unavailable: [
        {
          mode: "120000",
          path: "example.txt",
          reason: "binary",
          side: "head",
        },
      ],
    },
  },
] as const)("the project-change snapshot codec rejects $name", ({ expected, value }) => {
  const decoded = extensionProjectChangeSnapshotCodec.decode(value);
  expect(decoded.ok).toBe(false);
  if (decoded.ok) {
    throw new TypeError("The invalid project-change snapshot was admitted.");
  }
  expect(decoded.issues).toContainEqual(expected);
});

test("the manifest rejects duplicate command names inside one extension", () => {
  const contribution = (id: string, commandId: string) => ({
    command: { id: commandId, name: "review", title: "Review project changes", version: 1 },
    id,
    input: { id: "adam.project-change-snapshot", version: 1 },
    inputSource: { id: "project_changes", version: 1 },
    kind: "operation",
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  });

  expect(() =>
    parseExtensionPackageManifest({
      name: "@fixture/duplicate-command",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.duplicate-command",
        apiVersion: "^0.3.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          contribution("fixture.first@1", "fixture.first"),
          contribution("fixture.second@1", "fixture.second"),
        ],
      },
    }),
  ).toThrow(/command descriptors must have unique IDs and names/iu);
});

function minimalSnapshot() {
  return {
    base: {
      commit: "a".repeat(40),
      kind: "head",
      tree: "b".repeat(40),
    },
    candidateTree: "c".repeat(40),
    capturePolicy: { id: "adam.git-project-changes", objectFormat: "sha1", version: 1 },
    digest: `sha256:${"d".repeat(64)}`,
    kind: "adam.project-change-snapshot",
    schemaVersion: 1,
    sources: [
      {
        content: "example\n",
        contentDigest: `sha256:${"e".repeat(64)}`,
        mode: "100644",
        path: "example.txt",
        side: "head",
      },
    ],
    unavailable: [],
    unifiedDiff: "diff --git a/example.txt b/example.txt\n",
  } as const;
}
