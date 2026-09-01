import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import type { StagedPastedTextSelectionV1 } from "./pasted-text.js";

const maximumManifestBytes = 1024 * 1024;
const projectIdPattern = /^sha256:([0-9a-f]{64})$/u;

export type TurnDraftScopeV1 =
  | { readonly type: "new_session" }
  | { readonly type: "session"; readonly sessionId: string };

export type RecoverableTurnDraftV1 = {
  readonly schemaVersion: 1;
  readonly scope:
    | { readonly type: "new_session"; readonly targetId: string }
    | { readonly type: "session"; readonly sessionId: string };
  readonly nextOrdinal: number;
  readonly elements: readonly (
    | { readonly elementId: string; readonly type: "text"; readonly text: string }
    | {
        readonly elementId: string;
        readonly type: "resource";
        readonly kind: "file" | "image";
        readonly ordinal: number;
        readonly resourceId: string;
      }
    | {
        readonly elementId: string;
        readonly type: "pasted_text";
        readonly ordinal: number;
        readonly pastedTextId: string;
      }
  )[];
  readonly resources: readonly {
    readonly id: string;
    readonly elementId: string;
    readonly displayName: string;
    readonly kind: "file" | "image";
    readonly origin?: "pasted_image" | "selected_file" | undefined;
    readonly ordinal: number;
    readonly state: "failed" | "ready";
    readonly byteCount: number | null;
    readonly mediaHint: "binary" | "image" | "text" | null;
    readonly support: "image" | "unsupported_binary" | "utf8_text" | null;
    readonly diagnostic: string | null;
    readonly selection?:
      | {
          readonly type: "staged_artifact";
          readonly staged: {
            readonly stagingId: string;
            readonly id: `sha256:${string}`;
            readonly mediaType: string;
            readonly byteCount: number;
          };
          readonly displayName: string;
          readonly digest: `sha256:${string}`;
          readonly mediaHint: "binary" | "image" | "text";
          readonly support: "image" | "unsupported_binary" | "utf8_text";
          readonly origin?: "pasted_image" | "selected_file" | undefined;
        }
      | undefined;
  }[];
  readonly pastedTexts?:
    | readonly {
        readonly id: string;
        readonly elementId: string;
        readonly ordinal: number;
        readonly state: "failed" | "ready";
        readonly byteCount: number;
        readonly lineCount: number;
        readonly scalarCount: number;
        readonly diagnostic: string | null;
        readonly selection?: StagedPastedTextSelectionV1 | undefined;
      }[]
    | undefined;
};

export type RecoverableTurnDraftV2 = Omit<RecoverableTurnDraftV1, "elements" | "schemaVersion"> & {
  readonly schemaVersion: 2;
  readonly elements: readonly (
    | RecoverableTurnDraftV1["elements"][number]
    | {
        readonly type: "skill";
        readonly elementId: string;
        readonly name: string;
        readonly qualifiedId: string;
      }
  )[];
};

export type RecoverableTurnDraftV3 = Omit<RecoverableTurnDraftV2, "elements" | "schemaVersion"> & {
  readonly schemaVersion: 3;
  readonly elements: readonly (
    | RecoverableTurnDraftV2["elements"][number]
    | { readonly type: "path"; readonly elementId: string; readonly path: string }
  )[];
};

export type RecoverableTurnDraft =
  | RecoverableTurnDraftV1
  | RecoverableTurnDraftV2
  | RecoverableTurnDraftV3;

export type RecoverableTurnDraftRepository = {
  load(scope: TurnDraftScopeV1): Promise<RecoverableTurnDraft | null>;
  save(draft: RecoverableTurnDraftV3): Promise<void>;
  delete(scope: TurnDraftScopeV1): Promise<void>;
};

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u) as z.ZodType<`sha256:${string}`>;
const stagedSelectionSchema = z.strictObject({
  type: z.literal("staged_artifact"),
  staged: z.strictObject({
    stagingId: z.uuid(),
    id: digestSchema,
    mediaType: z.enum([
      "application/octet-stream",
      "image/jpeg",
      "image/png",
      "text/plain; charset=utf-8",
    ]),
    byteCount: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
  }),
  displayName: z.string().min(1).max(255),
  digest: digestSchema,
  mediaHint: z.enum(["binary", "image", "text"]),
  support: z.enum(["image", "unsupported_binary", "utf8_text"]),
  origin: z.enum(["pasted_image", "selected_file"]).optional(),
});
const stagedPastedTextSelectionSchema: z.ZodType<StagedPastedTextSelectionV1> = z.strictObject({
  type: z.literal("staged_pasted_text"),
  staged: z.strictObject({
    stagingId: z.uuid(),
    id: digestSchema,
    mediaType: z.literal("text/plain; charset=utf-8"),
    byteCount: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  }),
  digest: digestSchema,
  byteCount: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
  lineCount: z.number().int().positive().safe(),
  scalarCount: z.number().int().positive().safe(),
});
const textElementSchema = z.strictObject({
  elementId: z.string().min(1).max(256),
  type: z.literal("text"),
  text: z
    .string()
    .min(1)
    .max(512 * 1024),
});
const resourceElementSchema = z.strictObject({
  elementId: z.string().min(1).max(256),
  type: z.literal("resource"),
  kind: z.enum(["file", "image"]),
  ordinal: z.number().int().positive().safe(),
  resourceId: z.string().min(1).max(256),
});
const pastedTextElementSchema = z.strictObject({
  elementId: z.string().min(1).max(256),
  type: z.literal("pasted_text"),
  ordinal: z.number().int().positive().safe(),
  pastedTextId: z.string().min(1).max(256),
});
const skillElementSchema = z.strictObject({
  elementId: z.string().min(1).max(256),
  type: z.literal("skill"),
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(64),
  qualifiedId: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => /^[\x20-\x7e]+$/u.test(value) && Buffer.byteLength(value, "utf8") <= 16_384),
});
const pathElementSchema = z.strictObject({
  elementId: z.string().min(1).max(256),
  type: z.literal("path"),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\0\r\n]/u.test(value)),
});
const draftV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("new_session"),
        targetId: z
          .string()
          .min(1)
          .max(512)
          .refine((value) => !value.includes("\0")),
      }),
      z.strictObject({ type: z.literal("session"), sessionId: z.uuid() }),
    ]),
    nextOrdinal: z.number().int().positive().safe(),
    elements: z
      .array(
        z.discriminatedUnion("type", [
          textElementSchema,
          resourceElementSchema,
          pastedTextElementSchema,
        ]),
      )
      .max(17),
    resources: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(256),
          elementId: z.string().min(1).max(256),
          displayName: z.string().min(1).max(255),
          kind: z.enum(["file", "image"]),
          origin: z.enum(["pasted_image", "selected_file"]).optional(),
          ordinal: z.number().int().positive().safe(),
          state: z.enum(["failed", "ready"]),
          byteCount: z
            .number()
            .int()
            .nonnegative()
            .max(8 * 1024 * 1024)
            .nullable(),
          mediaHint: z.enum(["binary", "image", "text"]).nullable(),
          support: z.enum(["image", "unsupported_binary", "utf8_text"]).nullable(),
          diagnostic: z.string().max(1024).nullable(),
          selection: stagedSelectionSchema.optional(),
        }),
      )
      .max(8),
    pastedTexts: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(256),
          elementId: z.string().min(1).max(256),
          ordinal: z.number().int().positive().safe(),
          state: z.enum(["failed", "ready"]),
          byteCount: z
            .number()
            .int()
            .positive()
            .max(1024 * 1024),
          lineCount: z.number().int().positive().safe(),
          scalarCount: z.number().int().positive().safe(),
          diagnostic: z.string().max(1024).nullable(),
          selection: stagedPastedTextSelectionSchema.optional(),
        }),
      )
      .max(8)
      .optional(),
  })
  .superRefine((draft, context) => validateDraftGraph(draft, context));

const draftV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    scope: draftV1Schema.shape.scope,
    nextOrdinal: draftV1Schema.shape.nextOrdinal,
    elements: z
      .array(
        z.discriminatedUnion("type", [
          textElementSchema,
          resourceElementSchema,
          pastedTextElementSchema,
          skillElementSchema,
        ]),
      )
      .max(17),
    resources: draftV1Schema.shape.resources,
    pastedTexts: draftV1Schema.shape.pastedTexts,
  })
  .superRefine((draft, context) => validateDraftGraph(draft, context));

const draftV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    scope: draftV1Schema.shape.scope,
    nextOrdinal: draftV1Schema.shape.nextOrdinal,
    elements: z
      .array(
        z.discriminatedUnion("type", [
          textElementSchema,
          resourceElementSchema,
          pastedTextElementSchema,
          skillElementSchema,
          pathElementSchema,
        ]),
      )
      .max(17),
    resources: draftV1Schema.shape.resources,
    pastedTexts: draftV1Schema.shape.pastedTexts,
  })
  .superRefine((draft, context) => validateDraftGraph(draft, context));

const recoverableDraftSchema = z.discriminatedUnion("schemaVersion", [
  draftV1Schema,
  draftV2Schema,
  draftV3Schema,
]);

function validateDraftGraph(draft: RecoverableTurnDraft, context: z.RefinementCtx): void {
  const allElements: readonly RecoverableTurnDraftV3["elements"][number][] = draft.elements;
  const resourceElements = allElements.filter(
    (
      element,
    ): element is Extract<RecoverableTurnDraftV3["elements"][number], { type: "resource" }> =>
      element.type === "resource",
  );
  const pastedTextElements = allElements.filter(
    (
      element,
    ): element is Extract<RecoverableTurnDraftV3["elements"][number], { type: "pasted_text" }> =>
      element.type === "pasted_text",
  );
  const pastedTexts = draft.pastedTexts ?? [];
  if (
    new Set(draft.elements.map((element) => element.elementId)).size !== draft.elements.length ||
    new Set(draft.resources.map((resource) => resource.id)).size !== draft.resources.length ||
    new Set(draft.resources.map((resource) => resource.ordinal)).size !== draft.resources.length ||
    new Set(pastedTexts.map((pastedText) => pastedText.id)).size !== pastedTexts.length ||
    new Set(pastedTexts.map((pastedText) => pastedText.ordinal)).size !== pastedTexts.length ||
    draft.elements.reduce(
      (length, element) =>
        length +
        (element.type === "text"
          ? Buffer.byteLength(element.text, "utf8")
          : element.type === "skill"
            ? Buffer.byteLength(`$${element.name}`, "utf8")
            : element.type === "path"
              ? Buffer.byteLength(`@${element.path}`, "utf8")
              : 0),
      0,
    ) +
      pastedTexts.reduce((total, pastedText) => total + pastedText.byteCount, 0) >
      1024 * 1024 ||
    resourceElements.length !== draft.resources.length ||
    pastedTextElements.length !== pastedTexts.length ||
    resourceElements.some((element, index) => {
      const resource = draft.resources[index];
      return (
        resource === undefined ||
        resource.id !== element.resourceId ||
        resource.elementId !== element.elementId ||
        resource.kind !== element.kind ||
        resource.ordinal !== element.ordinal
      );
    }) ||
    pastedTextElements.some((element, index) => {
      const pastedText = pastedTexts[index];
      return (
        pastedText === undefined ||
        pastedText.id !== element.pastedTextId ||
        pastedText.elementId !== element.elementId ||
        pastedText.ordinal !== element.ordinal
      );
    }) ||
    draft.resources.some(
      (resource) =>
        (resource.state === "ready") !== (resource.selection !== undefined) ||
        (resource.selection !== undefined &&
          (resource.selection.displayName !== resource.displayName ||
            resource.selection.support !== resource.support ||
            resource.selection.mediaHint !== resource.mediaHint ||
            (resource.selection.origin ?? "selected_file") !==
              (resource.origin ?? "selected_file") ||
            resource.selection.staged.byteCount !== resource.byteCount ||
            resource.selection.staged.id !== resource.selection.digest ||
            (resource.kind === "image") !== (resource.selection.support === "image"))),
    ) ||
    pastedTexts.some(
      (pastedText) =>
        (pastedText.state === "ready") !== (pastedText.selection !== undefined) ||
        (pastedText.selection !== undefined &&
          (pastedText.selection.staged.id !== pastedText.selection.digest ||
            pastedText.selection.byteCount !== pastedText.byteCount ||
            pastedText.selection.lineCount !== pastedText.lineCount ||
            pastedText.selection.scalarCount !== pastedText.scalarCount)),
    ) ||
    draft.resources.length + pastedTexts.length > 8 ||
    draft.nextOrdinal <=
      Math.max(
        0,
        ...draft.resources.map((resource) => resource.ordinal),
        ...pastedTexts.map((pastedText) => pastedText.ordinal),
      )
  ) {
    context.addIssue({ code: "custom", message: "The recoverable draft graph is invalid." });
  }
}

export async function createRecoverableTurnDraftRepository(options: {
  readonly projectId: string;
  readonly stateRoot: string;
}): Promise<RecoverableTurnDraftRepository> {
  const projectMatch = projectIdPattern.exec(options.projectId);
  if (projectMatch?.[1] === undefined) {
    throw new TypeError("The recoverable draft project identity is invalid.");
  }
  const root = resolve(options.stateRoot, "drafts", projectMatch[1]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  let mutationQueue = Promise.resolve();
  const enqueueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    delete(scope) {
      return enqueueMutation(async () => {
        try {
          await unlink(join(root, manifestName(scope)));
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            return;
          }
          throw error;
        }
        await syncDirectory(root);
      });
    },
    async load(scope) {
      await mutationQueue;
      const path = join(root, manifestName(scope));
      let bytes: Buffer;
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = await file.stat();
          if (
            !stats.isFile() ||
            stats.size <= 0 ||
            stats.size > maximumManifestBytes ||
            (stats.mode & 0o077) !== 0 ||
            (process.geteuid?.() !== undefined && stats.uid !== process.geteuid())
          ) {
            throw new TypeError("The recoverable draft manifest is unsafe.");
          }
          bytes = await file.readFile();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
      const parsed = recoverableDraftSchema.safeParse(
        JSON.parse(bytes.toString("utf8")) as unknown,
      );
      if (!parsed.success || !matchesScope(parsed.data.scope, scope)) {
        throw new TypeError("The recoverable draft manifest is invalid.");
      }
      return parsed.data;
    },
    save(draft) {
      return enqueueMutation(async () => {
        const validated = draftV3Schema.parse(draft);
        const serialized = `${JSON.stringify(validated)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > maximumManifestBytes) {
          throw new TypeError("The recoverable draft manifest is too large.");
        }
        await replaceOwnerPrivateFile(join(root, manifestName(validated.scope)), serialized);
        await syncDirectory(root);
      });
    },
  };
}

async function replaceOwnerPrivateFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const temporaryFile = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await temporaryFile.chmod(0o600);
      await temporaryFile.writeFile(content, "utf8");
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

function manifestName(scope: TurnDraftScopeV1 | RecoverableTurnDraft["scope"]): string {
  return scope.type === "new_session" ? "new-session.json" : `session-${scope.sessionId}.json`;
}

function matchesScope(
  draftScope: RecoverableTurnDraft["scope"],
  requested: TurnDraftScopeV1,
): boolean {
  return (
    draftScope.type === requested.type &&
    (draftScope.type === "new_session" ||
      (requested.type === "session" && draftScope.sessionId === requested.sessionId))
  );
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
