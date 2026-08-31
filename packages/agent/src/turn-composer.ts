import { randomUUID } from "node:crypto";
import { normalizeExplicitUserImageToPngV1 } from "./image-input.js";
import type { TurnComposerResourceStager } from "./input-resource-staging.js";
import {
  type InputResourceOccurrenceV1,
  inputResourceLimitsV1,
  type StagedInputResourceSelectionV1,
  safeInputResourceDisplayNameV1,
} from "./input-resources.js";
import {
  normalizePastedTextV1,
  pastedTextLimitsV1,
  type StagedPastedTextSelectionV1,
} from "./pasted-text.js";
import type { RecoverableTurnDraftV1 } from "./recoverable-turn-draft.js";
import type { StagedUserContentElementV1 } from "./structured-user-content.js";

export {
  type TurnComposerStageBarrier,
  turnComposerStageBarrier,
} from "./input-resource-staging.js";

export type TurnComposerResourceSnapshot = {
  readonly id: string;
  readonly elementId: string;
  readonly displayName: string;
  readonly state: "queued" | "copying" | "ready" | "failed" | "cancelled" | "removed";
  readonly byteCount: number | null;
  readonly kind: "file" | "image";
  readonly mediaHint: "binary" | "image" | "text" | null;
  readonly ordinal: number;
  readonly origin: "pasted_image" | "selected_file";
  readonly support: InputResourceOccurrenceV1["support"] | null;
  readonly token: string;
  readonly diagnostic: string | null;
};

export type TurnComposerDraftPoint =
  | { readonly edge: "start" | "end" }
  | { readonly elementId: string; readonly edge: "before" | "after" }
  | { readonly elementId: string; readonly offset: number };

export type TurnComposerElementSnapshot =
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
    };

export type TurnComposerSealedElement =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "resource";
      readonly kind: "file" | "image";
      readonly ordinal: number;
      readonly token: string;
      readonly selection: StagedInputResourceSelectionV1;
    }
  | {
      readonly type: "pasted_text";
      readonly ordinal: number;
      readonly token: string;
      readonly text: string;
      readonly selection: StagedPastedTextSelectionV1;
    };

export type TurnComposerPastedTextSnapshot = {
  readonly id: string;
  readonly elementId: string;
  readonly ordinal: number;
  readonly token: string;
  readonly state: "copying" | "ready" | "failed" | "removed";
  readonly byteCount: number;
  readonly lineCount: number;
  readonly scalarCount: number;
  readonly origin: "pasted_text";
  readonly diagnostic: string | null;
};

type TurnComposerResource = {
  readonly id: string;
  readonly elementId: string;
  displayName: string;
  state: TurnComposerResourceSnapshot["state"];
  byteCount: number | null;
  kind: "file" | "image";
  mediaHint: "binary" | "image" | "text" | null;
  readonly ordinal: number;
  readonly origin: "pasted_image" | "selected_file";
  support: InputResourceOccurrenceV1["support"] | null;
  diagnostic: string | null;
  readonly controller: AbortController;
  staged: StagedInputResourceSelectionV1 | null;
  retained: boolean;
  settlement: Promise<void> | null;
};

type TurnComposerPastedText = {
  readonly id: string;
  readonly elementId: string;
  readonly ordinal: number;
  readonly origin: "pasted_text";
  state: TurnComposerPastedTextSnapshot["state"];
  byteCount: number;
  lineCount: number;
  scalarCount: number;
  diagnostic: string | null;
  readonly controller: AbortController;
  staged: StagedPastedTextSelectionV1 | null;
  text: string | null;
  retained: boolean;
  settlement: Promise<void> | null;
};

export class TurnComposerError extends Error {
  readonly code: "cancelled" | "failed" | "limit_exceeded" | "unsupported";

  constructor(code: TurnComposerError["code"], message: string) {
    super(message);
    this.name = "TurnComposerError";
    this.code = code;
  }
}

export type TurnComposer = {
  stage(
    path: string,
    mutation?: { readonly at: TurnComposerDraftPoint; readonly baseRevision: number },
    commit?: () => Promise<void>,
  ): Promise<string>;
  stagePastedText(
    text: string,
    mutation?: { readonly at: TurnComposerDraftPoint; readonly baseRevision: number },
    commit?: () => Promise<void>,
  ): Promise<string>;
  stagePastedImage(
    bytes: Uint8Array,
    mutation?: { readonly at: TurnComposerDraftPoint; readonly baseRevision: number },
    commit?: () => Promise<void>,
  ): Promise<string>;
  replaceText(
    input: {
      readonly baseRevision: number;
      readonly document: readonly (
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "resource"; readonly elementId: string }
        | { readonly type: "pasted_text"; readonly elementId: string }
      )[];
    },
    commit?: () => Promise<void>,
  ): Promise<boolean>;
  captureDraft(scope: RecoverableTurnDraftV1["scope"]): Promise<RecoverableTurnDraftV1>;
  restoreDraft(draft: RecoverableTurnDraftV1): Promise<void>;
  undo(baseRevision: number, commit?: () => Promise<void>): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  remove(id: string, commit?: () => Promise<void>): Promise<boolean>;
  removePastedText(id: string, commit?: () => Promise<void>): Promise<boolean>;
  setText(text: string): void;
  commitText(text: string, commit: () => Promise<void>): Promise<void>;
  seal(signal: AbortSignal): Promise<{
    readonly elements: readonly TurnComposerSealedElement[];
    readonly renderedText: string;
    readonly structuredContent: readonly StagedUserContentElementV1[];
    readonly text: string;
    readonly selections: readonly StagedInputResourceSelectionV1[];
    readonly pastedTextSelections: readonly StagedPastedTextSelectionV1[];
  }>;
  unseal(): void;
  reset(baseRevision: number, commit: () => Promise<void>): Promise<boolean>;
  clear(options?: { readonly preserveRetained?: boolean }): Promise<void>;
  readExpandedText(): string;
  close(): Promise<void>;
  snapshot(): {
    readonly elements: readonly TurnComposerElementSnapshot[];
    readonly renderedText: string;
    readonly revision: number;
    readonly sealed: boolean;
    readonly resources: readonly TurnComposerResourceSnapshot[];
    readonly pastedTexts: readonly TurnComposerPastedTextSnapshot[];
  };
};

export async function createTurnComposer(options: {
  readonly onChange: () => void;
  readonly stager: TurnComposerResourceStager;
}): Promise<TurnComposer> {
  const resources = new Map<string, TurnComposerResource>();
  const pastedTexts = new Map<string, TurnComposerPastedText>();
  let elements: TurnComposerElementSnapshot[] = [];
  let nextOrdinal = 1;
  let revision = 0;
  const undoStack: Array<{
    readonly previousElements: readonly TurnComposerElementSnapshot[];
    readonly restoredResourceId?: string;
    readonly restoredPastedTextId?: string;
  }> = [];
  const pushUndo = (entry: (typeof undoStack)[number]): void => {
    if (undoStack.length >= 100) {
      undoStack.splice(0, undoStack.length - 99);
    }
    undoStack.push(entry);
  };
  let text = "";
  let sealed = false;
  let closed = false;

  const publish = (): void => {
    if (!closed) {
      options.onChange();
    }
  };

  const discardStaging = async (resource: TurnComposerResource): Promise<void> => {
    if (resource.staged !== null) {
      const staged = resource.staged;
      resource.staged = null;
      await options.stager.discard(staged);
    }
  };

  const discardPastedText = async (pastedText: TurnComposerPastedText): Promise<void> => {
    if (pastedText.staged !== null) {
      const staged = pastedText.staged;
      pastedText.staged = null;
      await options.stager.discard(staged);
    }
  };

  const atomToken = (kind: "file" | "image" | "text", ordinal: number): string =>
    `[${kind === "image" ? "Image" : kind === "text" ? "Text" : "File"} #${ordinal}]`;

  const renderedText = (): string =>
    elements
      .map((element) =>
        element.type === "text"
          ? element.text
          : atomToken(element.type === "pasted_text" ? "text" : element.kind, element.ordinal),
      )
      .join("");

  const literalText = (): string =>
    elements.flatMap((element) => (element.type === "text" ? [element.text] : [])).join("");

  const textPayloadBytes = (literal = literalText()): number =>
    Buffer.byteLength(literal, "utf8") +
    [...pastedTexts.values()]
      .filter((pastedText) => pastedText.state !== "removed")
      .reduce((total, pastedText) => total + pastedText.byteCount, 0);

  const resolvePoint = (
    point: TurnComposerDraftPoint,
  ): { readonly index: number; readonly offset: number } | undefined => {
    if ("elementId" in point && "edge" in point) {
      const index = elements.findIndex((element) => element.elementId === point.elementId);
      if (index < 0 || elements[index]?.type === "text") {
        return undefined;
      }
      return { index: point.edge === "before" ? index : index + 1, offset: 0 };
    }
    if ("edge" in point) {
      if (point.edge === "start") {
        return { index: 0, offset: 0 };
      }
      const last = elements.at(-1);
      return last?.type === "text"
        ? { index: elements.length - 1, offset: last.text.length }
        : { index: elements.length, offset: 0 };
    }
    const index = elements.findIndex((element) => element.elementId === point.elementId);
    const element = elements[index];
    if (
      index < 0 ||
      element?.type !== "text" ||
      !Number.isSafeInteger(point.offset) ||
      point.offset < 0 ||
      point.offset > element.text.length
    ) {
      return undefined;
    }
    return { index, offset: point.offset };
  };

  const normalizeTextElements = (
    source: readonly TurnComposerElementSnapshot[],
  ): TurnComposerElementSnapshot[] => {
    const normalized: TurnComposerElementSnapshot[] = [];
    for (const element of source) {
      if (element.type !== "text") {
        normalized.push(element);
        continue;
      }
      if (element.text.length === 0) {
        continue;
      }
      const previous = normalized.at(-1);
      if (previous?.type === "text") {
        normalized[normalized.length - 1] = {
          ...previous,
          text: `${previous.text}${element.text}`,
        };
      } else {
        normalized.push(element);
      }
    }
    return normalized;
  };

  const replaceAggregateText = (nextText: string): void => {
    const textElements = elements.flatMap((element, index) =>
      element.type === "text" ? [{ element, index }] : [],
    );
    if (!elements.some((element) => element.type !== "text")) {
      elements =
        nextText.length === 0 ? [] : [{ elementId: randomUUID(), type: "text", text: nextText }];
      return;
    }
    if (textElements.length === 0) {
      if (nextText.length > 0) {
        elements = [...elements, { elementId: randomUUID(), type: "text", text: nextText }];
      }
      return;
    }
    if (textElements.length !== 1) {
      throw new TypeError(
        "A mixed structured draft must be changed through an exact text element edit.",
      );
    }
    const textEntry = textElements[0];
    if (textEntry === undefined) {
      throw new TypeError("The structured draft text element is unavailable.");
    }
    const { element, index } = textEntry;
    elements =
      nextText.length === 0
        ? [...elements.slice(0, index), ...elements.slice(index + 1)]
        : elements.map((candidate, candidateIndex) =>
            candidateIndex === index ? { ...element, text: nextText } : candidate,
          );
  };

  const insertAtomicElement = (
    element: Exclude<TurnComposerElementSnapshot, { readonly type: "text" }>,
    mutation: { readonly at: TurnComposerDraftPoint; readonly baseRevision: number } | undefined,
  ): void => {
    if (mutation === undefined) {
      elements = [...elements, element];
      return;
    }
    if (mutation.baseRevision !== revision) {
      throw new TypeError("The turn composer draft point is stale.");
    }
    const point = resolvePoint(mutation.at);
    if (point === undefined) {
      throw new TypeError("The turn composer draft point is invalid.");
    }
    const current = elements[point.index];
    if (current?.type !== "text") {
      elements = [...elements.slice(0, point.index), element, ...elements.slice(point.index)];
      return;
    }
    const before = current.text.slice(0, point.offset);
    const after = current.text.slice(point.offset);
    elements = [
      ...elements.slice(0, point.index),
      ...(before.length === 0 ? [] : [{ ...current, text: before }]),
      element,
      ...(after.length === 0
        ? []
        : [{ elementId: randomUUID(), type: "text" as const, text: after }]),
      ...elements.slice(point.index + 1),
    ];
  };

  const removeResourceElement = (
    id: string,
  ):
    | {
        readonly element: Extract<TurnComposerElementSnapshot, { readonly type: "resource" }>;
        readonly previousElements: readonly TurnComposerElementSnapshot[];
      }
    | undefined => {
    const previousElements = elements;
    const index = previousElements.findIndex(
      (element) => element.type === "resource" && element.resourceId === id,
    );
    const element = previousElements[index];
    if (index < 0 || element?.type !== "resource") {
      return undefined;
    }
    elements = normalizeTextElements([
      ...previousElements.slice(0, index),
      ...previousElements.slice(index + 1),
    ]);
    revision += 1;
    return { element, previousElements };
  };

  const removePastedTextElement = (
    id: string,
  ):
    | {
        readonly element: Extract<TurnComposerElementSnapshot, { readonly type: "pasted_text" }>;
        readonly previousElements: readonly TurnComposerElementSnapshot[];
      }
    | undefined => {
    const previousElements = elements;
    const index = previousElements.findIndex(
      (element) => element.type === "pasted_text" && element.pastedTextId === id,
    );
    const element = previousElements[index];
    if (index < 0 || element?.type !== "pasted_text") {
      return undefined;
    }
    elements = normalizeTextElements([
      ...previousElements.slice(0, index),
      ...previousElements.slice(index + 1),
    ]);
    revision += 1;
    return { element, previousElements };
  };

  return {
    async captureDraft(scope) {
      const orderedResources = elements.flatMap((element) => {
        if (element.type !== "resource") {
          return [];
        }
        const resource = resources.get(element.resourceId);
        return resource === undefined ? [] : [resource];
      });
      const orderedPastedTexts = elements.flatMap((element) => {
        if (element.type !== "pasted_text") {
          return [];
        }
        const pastedText = pastedTexts.get(element.pastedTextId);
        return pastedText === undefined ? [] : [pastedText];
      });
      if (
        orderedResources.some(
          (resource) => resource.state !== "ready" && resource.state !== "failed",
        )
      ) {
        throw new TurnComposerError(
          "failed",
          "Only settled input resources can enter a recoverable draft.",
        );
      }
      if (
        orderedPastedTexts.some(
          (pastedText) => pastedText.state !== "ready" && pastedText.state !== "failed",
        )
      ) {
        throw new TurnComposerError(
          "failed",
          "Only settled Text atoms can enter a recoverable draft.",
        );
      }
      for (const resource of orderedResources) {
        if (resource.state === "ready" && resource.staged !== null && !resource.retained) {
          await options.stager.retain({ resourceId: resource.id, selection: resource.staged });
          resource.retained = true;
        }
      }
      for (const pastedText of orderedPastedTexts) {
        if (pastedText.state === "ready" && pastedText.staged !== null && !pastedText.retained) {
          await options.stager.retain({
            resourceId: pastedText.id,
            selection: pastedText.staged,
          });
          pastedText.retained = true;
        }
      }
      return {
        schemaVersion: 1,
        scope,
        nextOrdinal,
        elements: elements.map((element) => ({ ...element })),
        resources: orderedResources.map((resource) => ({
          id: resource.id,
          elementId: resource.elementId,
          displayName: resource.displayName,
          kind: resource.kind,
          origin: resource.origin,
          ordinal: resource.ordinal,
          state: resource.state as "failed" | "ready",
          byteCount: resource.byteCount,
          mediaHint: resource.mediaHint,
          support: resource.support,
          diagnostic: resource.diagnostic,
          ...(resource.staged === null ? {} : { selection: resource.staged }),
        })),
        pastedTexts: orderedPastedTexts.map((pastedText) => ({
          id: pastedText.id,
          elementId: pastedText.elementId,
          ordinal: pastedText.ordinal,
          state: pastedText.state as "failed" | "ready",
          byteCount: pastedText.byteCount,
          lineCount: pastedText.lineCount,
          scalarCount: pastedText.scalarCount,
          diagnostic: pastedText.diagnostic,
          ...(pastedText.state !== "ready" || pastedText.staged === null
            ? {}
            : { selection: pastedText.staged }),
        })),
      };
    },
    async restoreDraft(draft) {
      if (closed || sealed || elements.length > 0 || resources.size > 0 || pastedTexts.size > 0) {
        throw new TypeError("The turn composer cannot replace a nonempty draft.");
      }
      const recoveredResources = new Map(
        draft.resources.map((resource) => [resource.id, resource]),
      );
      if (
        draft.elements.some(
          (element) => element.type === "resource" && !recoveredResources.has(element.resourceId),
        )
      ) {
        throw new TypeError("The recoverable turn draft is incomplete.");
      }
      const recoveredPastedTexts = new Map(
        (draft.pastedTexts ?? []).map((item) => [item.id, item]),
      );
      if (
        draft.elements.some(
          (element) =>
            element.type === "pasted_text" && !recoveredPastedTexts.has(element.pastedTextId),
        )
      ) {
        throw new TypeError("The recoverable turn draft has incomplete Text atoms.");
      }
      if ((draft.pastedTexts?.length ?? 0) > 0 && options.stager.readText === undefined) {
        throw new TypeError("Recoverable Text atoms are unavailable.");
      }
      const recoveredPastedTextContents = new Map<string, string>();
      for (const recovered of draft.pastedTexts ?? []) {
        if (recovered.selection !== undefined) {
          try {
            recoveredPastedTextContents.set(
              recovered.id,
              (await options.stager.readText?.(recovered.selection)) as string,
            );
          } catch {
            // Preserve the atom as failed so the caller can remove it without guessing content.
          }
        }
      }
      elements = draft.elements.map((element) => ({ ...element }));
      nextOrdinal = draft.nextOrdinal;
      text = elements
        .flatMap((element) => (element.type === "text" ? [element.text] : []))
        .join("");
      for (const recovered of draft.resources) {
        resources.set(recovered.id, {
          id: recovered.id,
          elementId: recovered.elementId,
          displayName: recovered.displayName,
          state: recovered.state,
          byteCount: recovered.byteCount,
          kind: recovered.kind,
          mediaHint: recovered.mediaHint,
          ordinal: recovered.ordinal,
          origin: recovered.origin ?? "selected_file",
          support: recovered.support,
          diagnostic: recovered.diagnostic,
          controller: new AbortController(),
          staged: recovered.selection ?? null,
          retained: recovered.selection !== undefined,
          settlement: Promise.resolve(),
        });
      }
      for (const recovered of draft.pastedTexts ?? []) {
        const recoveredText = recoveredPastedTextContents.get(recovered.id) ?? null;
        pastedTexts.set(recovered.id, {
          id: recovered.id,
          elementId: recovered.elementId,
          ordinal: recovered.ordinal,
          origin: "pasted_text",
          state: recovered.state === "ready" && recoveredText === null ? "failed" : recovered.state,
          byteCount: recovered.byteCount,
          lineCount: recovered.lineCount,
          scalarCount: recovered.scalarCount,
          diagnostic:
            recovered.state === "ready" && recoveredText === null
              ? "The recoverable pasted-text bytes are unavailable."
              : recovered.diagnostic,
          controller: new AbortController(),
          staged: recovered.selection ?? null,
          text: recoveredText,
          retained: recovered.selection !== undefined,
          settlement: Promise.resolve(),
        });
      }
      revision += 1;
      publish();
    },
    async replaceText(input, commit) {
      if (
        closed ||
        sealed ||
        input.baseRevision !== revision ||
        input.document.length > inputResourceLimitsV1.maximumOccurrencesPerRun * 2 + 1
      ) {
        return false;
      }
      const currentAtoms = elements.filter(
        (element): element is Exclude<TurnComposerElementSnapshot, { readonly type: "text" }> =>
          element.type !== "text",
      );
      const projectedAtomIds = input.document.flatMap((part) =>
        part.type === "text" ? [] : [part.elementId],
      );
      if (
        projectedAtomIds.length !== currentAtoms.length ||
        projectedAtomIds.some((elementId, index) => currentAtoms[index]?.elementId !== elementId)
      ) {
        return false;
      }
      const currentTextIdByGap = new Map<number, string>();
      let gap = 0;
      for (const element of elements) {
        if (element.type !== "text") {
          gap += 1;
        } else if (!currentTextIdByGap.has(gap)) {
          currentTextIdByGap.set(gap, element.elementId);
        }
      }
      const atomsByElementId = new Map(currentAtoms.map((atom) => [atom.elementId, atom]));
      const nextElements: TurnComposerElementSnapshot[] = [];
      gap = 0;
      for (const part of input.document) {
        if (part.type !== "text") {
          const atom = atomsByElementId.get(part.elementId);
          if (atom === undefined || atom.type !== part.type) {
            return false;
          }
          nextElements.push(atom);
          gap += 1;
          continue;
        }
        if (part.text.length === 0) {
          continue;
        }
        const previous = nextElements.at(-1);
        if (previous?.type === "text") {
          nextElements[nextElements.length - 1] = {
            ...previous,
            text: `${previous.text}${part.text}`,
          };
        } else {
          nextElements.push({
            elementId: currentTextIdByGap.get(gap) ?? randomUUID(),
            type: "text",
            text: part.text,
          });
        }
      }
      const nextText = nextElements
        .flatMap((element) => (element.type === "text" ? [element.text] : []))
        .join("");
      if (
        nextText.length > 512 * 1024 ||
        textPayloadBytes(nextText) > pastedTextLimitsV1.maximumTextBytesPerTurn
      ) {
        throw new TurnComposerError(
          "limit_exceeded",
          "The structured text payload exceeds the v1 turn limit.",
        );
      }
      const previousElements = elements;
      const previousText = text;
      const previousRevision = revision;
      const previousUndoStack = [...undoStack];
      elements = nextElements;
      text = nextText;
      pushUndo({ previousElements });
      revision += 1;
      try {
        await commit?.();
      } catch (error) {
        elements = previousElements;
        text = previousText;
        revision = previousRevision;
        undoStack.length = 0;
        undoStack.push(...previousUndoStack);
        throw error;
      }
      publish();
      return true;
    },
    async cancel(id) {
      if (closed || sealed) {
        return false;
      }
      const resource = resources.get(id);
      if (resource === undefined || (resource.state !== "queued" && resource.state !== "copying")) {
        return false;
      }
      resource.state = "cancelled";
      resource.diagnostic = null;
      resource.controller.abort();
      publish();
      await resource.settlement;
      await discardStaging(resource);
      removeResourceElement(id);
      text = literalText();
      undoStack.length = 0;
      resources.delete(id);
      publish();
      return true;
    },
    async remove(id, commit) {
      if (closed || sealed) {
        return false;
      }
      const resource = resources.get(id);
      if (resource === undefined || resource.state === "removed") {
        return false;
      }
      const previousElements = elements;
      const previousText = text;
      const previousRevision = revision;
      const previousState = resource.state;
      const previousDiagnostic = resource.diagnostic;
      const previousUndoStack = [...undoStack];
      resource.state = "removed";
      resource.controller.abort();
      await resource.settlement;
      const removed = removeResourceElement(id);
      if (removed !== undefined && resource.staged !== null) {
        pushUndo({
          previousElements: removed.previousElements,
          restoredResourceId: removed.element.resourceId,
        });
      }
      text = literalText();
      try {
        await commit?.();
      } catch (error) {
        elements = previousElements;
        text = previousText;
        revision = previousRevision;
        resource.state = previousState;
        resource.diagnostic = previousDiagnostic;
        undoStack.length = 0;
        undoStack.push(...previousUndoStack);
        throw error;
      }
      if (removed === undefined || resource.staged === null) {
        await discardStaging(resource);
        resources.delete(id);
      }
      publish();
      return true;
    },
    async removePastedText(id, commit) {
      if (closed || sealed) {
        return false;
      }
      const pastedText = pastedTexts.get(id);
      if (pastedText === undefined || pastedText.state === "removed") {
        return false;
      }
      const previousElements = elements;
      const previousText = text;
      const previousRevision = revision;
      const previousState = pastedText.state;
      const previousDiagnostic = pastedText.diagnostic;
      const previousUndoStack = [...undoStack];
      pastedText.state = "removed";
      pastedText.controller.abort();
      await pastedText.settlement;
      const removed = removePastedTextElement(id);
      if (removed !== undefined && pastedText.staged !== null && pastedText.text !== null) {
        pushUndo({
          previousElements: removed.previousElements,
          restoredPastedTextId: removed.element.pastedTextId,
        });
      }
      text = literalText();
      try {
        await commit?.();
      } catch (error) {
        elements = previousElements;
        text = previousText;
        revision = previousRevision;
        pastedText.state = previousState;
        pastedText.diagnostic = previousDiagnostic;
        undoStack.length = 0;
        undoStack.push(...previousUndoStack);
        throw error;
      }
      if (removed === undefined || pastedText.staged === null || pastedText.text === null) {
        await discardPastedText(pastedText);
        pastedTexts.delete(id);
      }
      publish();
      return true;
    },
    async undo(baseRevision, commit) {
      if (closed || sealed || baseRevision !== revision) {
        return false;
      }
      const entry = undoStack.pop();
      if (entry === undefined) {
        return false;
      }
      const resource =
        entry.restoredResourceId === undefined
          ? undefined
          : resources.get(entry.restoredResourceId);
      const pastedText =
        entry.restoredPastedTextId === undefined
          ? undefined
          : pastedTexts.get(entry.restoredPastedTextId);
      if (
        entry.restoredResourceId !== undefined &&
        (resource?.state !== "removed" || resource.staged === null)
      ) {
        undoStack.push(entry);
        return false;
      }
      if (
        entry.restoredPastedTextId !== undefined &&
        (pastedText?.state !== "removed" || pastedText.staged === null)
      ) {
        undoStack.push(entry);
        return false;
      }
      const previousElements = elements;
      const previousText = text;
      const previousRevision = revision;
      elements = entry.previousElements.map((element) => ({ ...element }));
      text = literalText();
      if (resource !== undefined) {
        resource.state = "ready";
      }
      if (pastedText !== undefined) {
        pastedText.state = "ready";
      }
      revision += 1;
      try {
        await commit?.();
      } catch (error) {
        elements = previousElements;
        text = previousText;
        revision = previousRevision;
        if (resource !== undefined) {
          resource.state = "removed";
        }
        if (pastedText !== undefined) {
          pastedText.state = "removed";
        }
        undoStack.push(entry);
        throw error;
      }
      publish();
      return true;
    },
    async stage(path, mutation, commit) {
      if (closed || sealed) {
        throw new TypeError("The turn composer is not accepting input resources.");
      }
      const retainedCount =
        [...resources.values()].filter(
          (resource) => resource.state !== "cancelled" && resource.state !== "removed",
        ).length +
        [...pastedTexts.values()].filter((candidate) => candidate.state !== "removed").length;
      if (retainedCount >= inputResourceLimitsV1.maximumOccurrencesPerRun) {
        throw new TypeError("The turn composer input-resource count exceeds the v1 run limit.");
      }
      const id = randomUUID();
      const elementId = randomUUID();
      const ordinal = nextOrdinal;
      const previousElements = elements;
      const previousNextOrdinal = nextOrdinal;
      const previousRevision = revision;
      const previousUndoStack = [...undoStack];
      const resource: TurnComposerResource = {
        id,
        elementId,
        displayName: safeInputResourceDisplayNameV1(path),
        state: "queued",
        byteCount: null,
        kind: "file",
        mediaHint: null,
        ordinal,
        origin: "selected_file",
        support: null,
        diagnostic: null,
        controller: new AbortController(),
        staged: null,
        retained: false,
        settlement: null,
      };
      insertAtomicElement(
        { elementId, type: "resource", kind: "file", ordinal, resourceId: id },
        mutation,
      );
      nextOrdinal += 1;
      revision += 1;
      undoStack.length = 0;
      resources.set(id, resource);
      publish();
      resource.state = "copying";
      publish();
      const settlement = (async () => {
        let staged: StagedInputResourceSelectionV1;
        try {
          staged = await options.stager.stage({
            id,
            path,
            signal: resource.controller.signal,
          });
        } catch (error) {
          if (resource.state === "cancelled" || closed || !resources.has(id)) {
            return;
          }
          resource.state = "failed";
          resource.diagnostic =
            error instanceof Error ? error.message : "The selected input resource failed.";
          try {
            await commit?.();
          } catch (commitError) {
            elements = previousElements;
            nextOrdinal = previousNextOrdinal;
            revision = previousRevision;
            undoStack.push(...previousUndoStack);
            resources.delete(id);
            publish();
            throw commitError;
          }
          publish();
          return;
        }
        if (closed || resource.state === "cancelled" || !resources.has(id)) {
          await options.stager.discard(staged);
          return;
        }
        resource.displayName = staged.displayName;
        resource.byteCount = staged.staged.byteCount;
        resource.mediaHint = staged.mediaHint;
        resource.support = staged.support;
        resource.kind = staged.support === "image" ? "image" : "file";
        elements = elements.map((element) =>
          element.type === "resource" && element.resourceId === id
            ? { ...element, kind: resource.kind }
            : element,
        );
        resource.staged = staged;
        resource.state = "ready";
        try {
          await commit?.();
        } catch (error) {
          elements = previousElements;
          nextOrdinal = previousNextOrdinal;
          revision = previousRevision;
          undoStack.push(...previousUndoStack);
          resources.delete(id);
          await discardStaging(resource);
          publish();
          throw error;
        }
        publish();
      })();
      resource.settlement = settlement;
      await settlement;
      return id;
    },
    async stagePastedImage(bytes, mutation, commit) {
      if (closed || sealed) {
        throw new TypeError("The turn composer is not accepting pasted images.");
      }
      const normalizedPng = normalizeExplicitUserImageToPngV1(bytes);
      const retainedCount =
        [...resources.values()].filter(
          (resource) => resource.state !== "cancelled" && resource.state !== "removed",
        ).length +
        [...pastedTexts.values()].filter((candidate) => candidate.state !== "removed").length;
      if (retainedCount >= inputResourceLimitsV1.maximumOccurrencesPerRun) {
        throw new TypeError("The turn composer input count exceeds the v1 run limit.");
      }
      if (options.stager.stageImage === undefined) {
        throw new TypeError("Clipboard-image staging is unavailable.");
      }
      const id = randomUUID();
      const elementId = randomUUID();
      const ordinal = nextOrdinal;
      const previousElements = elements;
      const previousNextOrdinal = nextOrdinal;
      const previousRevision = revision;
      const previousUndoStack = [...undoStack];
      const resource: TurnComposerResource = {
        id,
        elementId,
        displayName: "Clipboard image",
        state: "copying",
        byteCount: null,
        kind: "image",
        mediaHint: "image",
        ordinal,
        origin: "pasted_image",
        support: "image",
        diagnostic: null,
        controller: new AbortController(),
        staged: null,
        retained: false,
        settlement: null,
      };
      insertAtomicElement(
        { elementId, type: "resource", kind: "image", ordinal, resourceId: id },
        mutation,
      );
      nextOrdinal += 1;
      revision += 1;
      undoStack.length = 0;
      resources.set(id, resource);
      publish();
      const settlement = (async () => {
        let staged: StagedInputResourceSelectionV1;
        try {
          staged = (await options.stager.stageImage?.({
            id,
            bytes: normalizedPng,
            signal: resource.controller.signal,
          })) as StagedInputResourceSelectionV1;
        } catch (error) {
          if (resource.state === "cancelled" || closed || !resources.has(id)) {
            return;
          }
          elements = previousElements;
          nextOrdinal = previousNextOrdinal;
          revision = previousRevision;
          undoStack.push(...previousUndoStack);
          resources.delete(id);
          publish();
          throw error;
        }
        if (
          closed ||
          resource.state === "cancelled" ||
          !resources.has(id) ||
          staged.support !== "image" ||
          staged.mediaHint !== "image" ||
          staged.staged.mediaType !== "image/png" ||
          staged.origin !== "pasted_image"
        ) {
          await options.stager.discard(staged);
          if (!closed && resources.has(id)) {
            elements = previousElements;
            nextOrdinal = previousNextOrdinal;
            revision = previousRevision;
            undoStack.push(...previousUndoStack);
            resources.delete(id);
            publish();
            throw new TypeError("The clipboard image normalization result is invalid.");
          }
          return;
        }
        resource.displayName = staged.displayName;
        resource.byteCount = staged.staged.byteCount;
        resource.staged = staged;
        resource.state = "ready";
        try {
          await commit?.();
        } catch (error) {
          elements = previousElements;
          nextOrdinal = previousNextOrdinal;
          revision = previousRevision;
          undoStack.push(...previousUndoStack);
          resources.delete(id);
          await discardStaging(resource);
          publish();
          throw error;
        }
        publish();
      })();
      resource.settlement = settlement;
      await settlement;
      return id;
    },
    async stagePastedText(pastedText, mutation, commit) {
      if (closed || sealed) {
        throw new TypeError("The turn composer is not accepting pasted text.");
      }
      const activeAtomCount =
        [...resources.values()].filter(
          (resource) => resource.state !== "cancelled" && resource.state !== "removed",
        ).length +
        [...pastedTexts.values()].filter((candidate) => candidate.state !== "removed").length;
      if (activeAtomCount >= pastedTextLimitsV1.maximumAtomsPerTurn) {
        throw new TypeError("The turn composer atom count exceeds the v1 run limit.");
      }
      const normalizedPastedText = normalizePastedTextV1(pastedText);
      const pastedBytes = Buffer.byteLength(normalizedPastedText, "utf8");
      if (textPayloadBytes() + pastedBytes > pastedTextLimitsV1.maximumTextBytesPerTurn) {
        throw new TypeError("The structured text payload exceeds the v1 turn limit.");
      }
      const id = randomUUID();
      const elementId = randomUUID();
      const ordinal = nextOrdinal;
      const previousElements = elements;
      const previousNextOrdinal = nextOrdinal;
      const previousRevision = revision;
      const previousUndoStack = [...undoStack];
      const atom: TurnComposerPastedText = {
        id,
        elementId,
        ordinal,
        origin: "pasted_text",
        state: "copying",
        byteCount: pastedBytes,
        lineCount: normalizedPastedText.split("\n").length,
        scalarCount: Array.from(normalizedPastedText).length,
        diagnostic: null,
        controller: new AbortController(),
        staged: null,
        text: normalizedPastedText,
        retained: false,
        settlement: null,
      };
      insertAtomicElement({ elementId, type: "pasted_text", ordinal, pastedTextId: id }, mutation);
      nextOrdinal += 1;
      revision += 1;
      undoStack.length = 0;
      pastedTexts.set(id, atom);
      publish();
      const settlement = (async () => {
        let staged: StagedPastedTextSelectionV1;
        try {
          if (options.stager.stageText === undefined) {
            throw new TypeError("Pasted-text staging is unavailable.");
          }
          staged = await options.stager.stageText({
            id,
            text: normalizedPastedText,
            signal: atom.controller.signal,
          });
        } catch (error) {
          if (closed || atom.state === "removed" || !pastedTexts.has(id)) {
            return;
          }
          atom.state = "failed";
          atom.diagnostic =
            error instanceof Error ? error.message : "The pasted text failed to stage.";
          try {
            await commit?.();
          } catch (commitError) {
            elements = previousElements;
            nextOrdinal = previousNextOrdinal;
            revision = previousRevision;
            undoStack.push(...previousUndoStack);
            pastedTexts.delete(id);
            publish();
            throw commitError;
          }
          publish();
          return;
        }
        if (closed || !pastedTexts.has(id)) {
          await options.stager.discard(staged);
          return;
        }
        atom.staged = staged;
        atom.state = "ready";
        atom.byteCount = staged.byteCount;
        atom.lineCount = staged.lineCount;
        atom.scalarCount = staged.scalarCount;
        try {
          await commit?.();
        } catch (error) {
          elements = previousElements;
          nextOrdinal = previousNextOrdinal;
          revision = previousRevision;
          undoStack.push(...previousUndoStack);
          pastedTexts.delete(id);
          await discardPastedText(atom);
          publish();
          throw error;
        }
        publish();
      })();
      atom.settlement = settlement;
      await settlement;
      return id;
    },
    async reset(baseRevision, commit) {
      if (
        closed ||
        sealed ||
        baseRevision !== revision ||
        [...resources.values()].some(
          (resource) => resource.state === "queued" || resource.state === "copying",
        ) ||
        [...pastedTexts.values()].some((pastedText) => pastedText.state === "copying")
      ) {
        return false;
      }
      const previousElements = elements;
      const previousNextOrdinal = nextOrdinal;
      const previousRevision = revision;
      const previousText = text;
      const previousUndoStack = [...undoStack];
      const previousResourceStates = new Map(
        [...resources].map(([id, resource]) => [id, resource.state] as const),
      );
      const previousPastedTextStates = new Map(
        [...pastedTexts].map(([id, pastedText]) => [id, pastedText.state] as const),
      );
      elements = [];
      nextOrdinal = 1;
      text = "";
      undoStack.length = 0;
      for (const resource of resources.values()) {
        resource.state = "removed";
      }
      for (const pastedText of pastedTexts.values()) {
        pastedText.state = "removed";
      }
      revision += 1;
      try {
        await commit();
      } catch (error) {
        elements = previousElements;
        nextOrdinal = previousNextOrdinal;
        revision = previousRevision;
        text = previousText;
        undoStack.push(...previousUndoStack);
        for (const [id, state] of previousResourceStates) {
          const resource = resources.get(id);
          if (resource !== undefined) {
            resource.state = state;
          }
        }
        for (const [id, state] of previousPastedTextStates) {
          const pastedText = pastedTexts.get(id);
          if (pastedText !== undefined) {
            pastedText.state = state;
          }
        }
        throw error;
      }
      const retained = [...resources.values()];
      const retainedPastedTexts = [...pastedTexts.values()];
      resources.clear();
      pastedTexts.clear();
      await Promise.allSettled([
        ...retained.map(discardStaging),
        ...retainedPastedTexts.map(discardPastedText),
      ]);
      publish();
      return true;
    },
    async seal(signal) {
      if (closed || sealed) {
        throw new TurnComposerError("failed", "The turn composer cannot be sealed.");
      }
      sealed = true;
      publish();
      const cancelStaging = (): void => {
        for (const resource of resources.values()) {
          if (resource.state === "queued" || resource.state === "copying") {
            resource.state = "cancelled";
            resource.diagnostic = null;
            resource.controller.abort();
          }
        }
        for (const pastedText of pastedTexts.values()) {
          if (pastedText.state === "copying") {
            pastedText.controller.abort();
          }
        }
        publish();
      };
      signal.addEventListener("abort", cancelStaging, { once: true });
      try {
        await Promise.all([
          ...[...resources.values()].map((resource) => resource.settlement),
          ...[...pastedTexts.values()].map((pastedText) => pastedText.settlement),
        ]);
      } finally {
        signal.removeEventListener("abort", cancelStaging);
      }
      if (signal.aborted) {
        sealed = false;
        publish();
        throw new TurnComposerError("cancelled", "Input-resource sealing was cancelled.");
      }
      const retained = [...resources.values()].filter(
        (resource) => resource.state !== "cancelled" && resource.state !== "removed",
      );
      const failed = retained.find((resource) => resource.state !== "ready");
      if (failed !== undefined) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "failed",
          "Every retained input resource must be ready before send.",
        );
      }
      const aggregateBytes = retained.reduce(
        (total, resource) => total + (resource.byteCount ?? 0),
        0,
      );
      if (aggregateBytes > inputResourceLimitsV1.maximumAggregateBytesPerRun) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "limit_exceeded",
          "The retained input resources exceed the v1 aggregate run limit.",
        );
      }
      if (
        retained.some(
          (resource) => resource.support !== "utf8_text" && resource.support !== "image",
        )
      ) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "unsupported",
          "Every retained input resource must have supported immutable content.",
        );
      }
      const retainedPastedTexts = [...pastedTexts.values()].filter(
        (pastedText) => pastedText.state !== "removed",
      );
      const failedPastedText = retainedPastedTexts.find(
        (pastedText) =>
          pastedText.state !== "ready" || pastedText.staged === null || pastedText.text === null,
      );
      if (failedPastedText !== undefined) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "failed",
          "Every retained Text atom must be ready before send.",
        );
      }
      if (textPayloadBytes() > pastedTextLimitsV1.maximumTextBytesPerTurn) {
        sealed = false;
        publish();
        throw new TurnComposerError(
          "limit_exceeded",
          "The structured text payload exceeds the v1 turn limit.",
        );
      }
      const resourceById = new Map(retained.map((resource) => [resource.id, resource]));
      const pastedTextById = new Map(
        retainedPastedTexts.map((pastedText) => [pastedText.id, pastedText]),
      );
      const selectionIndexById = new Map(
        retained.map((resource, index) => [resource.id, index] as const),
      );
      return {
        elements: elements.map((element): TurnComposerSealedElement => {
          if (element.type === "text") {
            return { type: "text", text: element.text };
          }
          if (element.type === "pasted_text") {
            const pastedText = pastedTextById.get(element.pastedTextId);
            if (
              pastedText?.staged === null ||
              pastedText?.staged === undefined ||
              pastedText.text === null
            ) {
              throw new TurnComposerError(
                "failed",
                "Every retained Text atom must be ready before send.",
              );
            }
            return {
              type: "pasted_text",
              ordinal: element.ordinal,
              token: atomToken("text", element.ordinal),
              text: pastedText.text,
              selection: pastedText.staged,
            };
          }
          const resource = resourceById.get(element.resourceId);
          if (resource?.staged === null || resource?.staged === undefined) {
            throw new TurnComposerError(
              "failed",
              "Every retained input resource must be ready before send.",
            );
          }
          return {
            type: "resource",
            kind: element.kind,
            ordinal: element.ordinal,
            token: atomToken(element.kind, element.ordinal),
            selection: resource.staged,
          };
        }),
        renderedText: renderedText(),
        structuredContent: elements.map((element): StagedUserContentElementV1 => {
          if (element.type === "text") {
            return { type: "text", text: element.text };
          }
          if (element.type === "pasted_text") {
            const selectionIndex = retainedPastedTexts.findIndex(
              (pastedText) => pastedText.id === element.pastedTextId,
            );
            if (selectionIndex < 0) {
              throw new TurnComposerError(
                "failed",
                "Every retained Text atom must be ready before send.",
              );
            }
            return {
              type: "pasted_text",
              selectionIndex,
              draftOrdinal: element.ordinal,
            };
          }
          const selectionIndex = selectionIndexById.get(element.resourceId);
          if (selectionIndex === undefined) {
            throw new TurnComposerError(
              "failed",
              "Every retained input resource must be ready before send.",
            );
          }
          return {
            type: "input_resource",
            selectionIndex,
            draftOrdinal: element.ordinal,
          };
        }),
        text,
        selections: retained.map((resource) => resource.staged as StagedInputResourceSelectionV1),
        pastedTextSelections: retainedPastedTexts.map(
          (pastedText) => pastedText.staged as StagedPastedTextSelectionV1,
        ),
      };
    },
    async clear(options = {}) {
      const retained = [...resources.values()];
      const retainedPastedTexts = [...pastedTexts.values()];
      sealed = false;
      for (const resource of retained) {
        if (resource.state === "queued" || resource.state === "copying") {
          resource.state = "cancelled";
          resource.diagnostic = null;
          resource.controller.abort();
        }
      }
      for (const pastedText of retainedPastedTexts) {
        if (pastedText.state === "copying") {
          pastedText.state = "removed";
          pastedText.controller.abort();
        }
      }
      await Promise.allSettled([
        ...retained.map((resource) => resource.settlement),
        ...retainedPastedTexts.map((pastedText) => pastedText.settlement),
      ]);
      resources.clear();
      pastedTexts.clear();
      await Promise.all(
        retained.map((resource) =>
          options.preserveRetained === true && resource.retained && resource.state !== "removed"
            ? Promise.resolve()
            : discardStaging(resource),
        ),
      );
      await Promise.all(
        retainedPastedTexts.map((pastedText) =>
          options.preserveRetained === true && pastedText.retained && pastedText.state !== "removed"
            ? Promise.resolve()
            : discardPastedText(pastedText),
        ),
      );
      text = "";
      elements = [];
      nextOrdinal = 1;
      undoStack.length = 0;
      revision += 1;
      publish();
    },
    readExpandedText() {
      return elements
        .map((element) => {
          if (element.type === "text") {
            return element.text;
          }
          if (element.type === "resource") {
            return atomToken(element.kind, element.ordinal);
          }
          const pastedText = pastedTexts.get(element.pastedTextId);
          if (pastedText?.state !== "ready" || pastedText.text === null) {
            throw new TurnComposerError(
              "failed",
              "Every retained Text atom must be ready before copy.",
            );
          }
          return pastedText.text;
        })
        .join("");
    },
    async commitText(nextText, commit) {
      if (closed || sealed) {
        throw new TypeError("The sealed turn composer cannot change draft text.");
      }
      if (
        nextText.length > 512 * 1024 ||
        textPayloadBytes(nextText) > pastedTextLimitsV1.maximumTextBytesPerTurn
      ) {
        throw new TurnComposerError(
          "limit_exceeded",
          "The structured text payload exceeds the v1 turn limit.",
        );
      }
      if (text !== nextText) {
        const previousText = text;
        const previousElements = elements;
        const previousRevision = revision;
        const previousUndoStack = [...undoStack];
        text = nextText;
        replaceAggregateText(nextText);
        undoStack.length = 0;
        revision += 1;
        try {
          await commit();
        } catch (error) {
          text = previousText;
          elements = previousElements;
          revision = previousRevision;
          undoStack.push(...previousUndoStack);
          throw error;
        }
        publish();
      }
    },
    setText(nextText) {
      if (closed || sealed) {
        throw new TypeError("The sealed turn composer cannot change draft text.");
      }
      if (
        nextText.length > 512 * 1024 ||
        textPayloadBytes(nextText) > pastedTextLimitsV1.maximumTextBytesPerTurn
      ) {
        throw new TurnComposerError(
          "limit_exceeded",
          "The structured text payload exceeds the v1 turn limit.",
        );
      }
      if (text !== nextText) {
        text = nextText;
        replaceAggregateText(nextText);
        undoStack.length = 0;
        revision += 1;
        publish();
      }
    },
    unseal() {
      if (!closed && sealed) {
        sealed = false;
        publish();
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const resource of resources.values()) {
        resource.controller.abort();
      }
      for (const pastedText of pastedTexts.values()) {
        pastedText.controller.abort();
      }
      await Promise.allSettled([
        ...[...resources.values()].map((resource) => resource.settlement),
        ...[...pastedTexts.values()].map((pastedText) => pastedText.settlement),
      ]);
      await Promise.all([
        ...[...resources.values()]
          .filter((resource) => resource.state === "removed")
          .map(discardStaging),
        ...[...pastedTexts.values()]
          .filter((pastedText) => pastedText.state === "removed")
          .map(discardPastedText),
      ]);
      await options.stager.close();
      resources.clear();
      pastedTexts.clear();
    },
    snapshot() {
      return {
        elements: elements.map((element) => ({ ...element })),
        renderedText: renderedText(),
        revision,
        sealed,
        resources: [...resources.values()]
          .filter((resource) => resource.state !== "removed")
          .map(
            ({
              controller: _controller,
              retained: _retained,
              settlement: _settlement,
              staged: _staged,
              ...item
            }) => ({
              ...item,
              token: atomToken(item.kind, item.ordinal),
            }),
          ),
        pastedTexts: [...pastedTexts.values()]
          .filter((pastedText) => pastedText.state !== "removed")
          .map(
            ({
              controller: _controller,
              retained: _retained,
              settlement: _settlement,
              staged: _staged,
              text: _text,
              ...item
            }) => ({ ...item, token: atomToken("text", item.ordinal) }),
          ),
      };
    },
  };
}
