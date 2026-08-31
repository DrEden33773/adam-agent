import { z } from "zod";
import type { ModelMessage } from "./agent-session-contracts.js";
import {
  createInputResourceUserMessageV1,
  type InputResourceOccurrenceV1,
  inputResourceLimitsV1,
  inputResourceOccurrenceV1Schema,
} from "./input-resources.js";
import { type PastedTextOccurrenceV1, pastedTextLimitsV1 } from "./pasted-text.js";

const pastedTextProjectionContentsV1 = Symbol("adam-agent.pasted-text-projection-contents-v1");

export function attachPastedTextProjectionContentsV1<RecordType extends object>(
  record: RecordType,
  contents: ReadonlyMap<string, string>,
): RecordType {
  return Object.assign(record, { [pastedTextProjectionContentsV1]: contents });
}

export function pastedTextProjectionContentsFromV1(
  record: object,
): ReadonlyMap<string, string> | undefined {
  return (
    record as {
      readonly [pastedTextProjectionContentsV1]?: ReadonlyMap<string, string>;
    }
  )[pastedTextProjectionContentsV1];
}

export type StagedUserContentElementV1 =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "input_resource";
      readonly selectionIndex: number;
      readonly draftOrdinal: number;
    }
  | {
      readonly type: "pasted_text";
      readonly selectionIndex: number;
      readonly draftOrdinal: number;
    };

export type SessionUserContentElementV1 =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "input_resource";
      readonly occurrenceId: string;
      readonly draftOrdinal: number;
    }
  | {
      readonly type: "pasted_text";
      readonly occurrenceId: string;
      readonly draftOrdinal: number;
    };

export const sessionUserContentElementV1Schema: z.ZodType<SessionUserContentElementV1> =
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(512 * 1024),
    }),
    z.strictObject({
      type: z.literal("input_resource"),
      occurrenceId: z.string().min(1).max(256),
      draftOrdinal: z.number().int().positive().safe(),
    }),
    z.strictObject({
      type: z.literal("pasted_text"),
      occurrenceId: z.string().min(1).max(256),
      draftOrdinal: z.number().int().positive().safe(),
    }),
  ]);

export const sessionUserContentV1Schema = z
  .array(sessionUserContentElementV1Schema)
  .min(1)
  .max(inputResourceLimitsV1.maximumOccurrencesPerRun * 2 + 1)
  .refine(
    (elements) =>
      elements.every(
        (element, index) => element.type !== "text" || elements[index - 1]?.type !== "text",
      ),
    "Adjacent structured user text elements must be normalized.",
  )
  .refine((elements) => {
    const ordinals = elements.flatMap((element) =>
      element.type === "text" ? [] : [element.draftOrdinal],
    );
    return new Set(ordinals).size === ordinals.length;
  }, "Structured atom ordinals must be unique.");

export function materializeSessionUserContentV1(input: {
  readonly elements: readonly StagedUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
  readonly pastedTexts?: readonly PastedTextOccurrenceV1[] | undefined;
  readonly userMessage: string;
}): readonly SessionUserContentElementV1[] {
  const elements = input.elements.map((element): SessionUserContentElementV1 => {
    if (element.type === "text") {
      return element;
    }
    const occurrence =
      element.type === "input_resource"
        ? input.occurrences[element.selectionIndex]
        : input.pastedTexts?.[element.selectionIndex];
    if (occurrence === undefined) {
      throw new TypeError("The structured draft references unavailable immutable content.");
    }
    return {
      type: element.type,
      occurrenceId: occurrence.occurrenceId,
      draftOrdinal: element.draftOrdinal,
    };
  });
  if (!sessionUserContentV1Schema.safeParse(elements).success) {
    throw new TypeError("The structured user content is invalid.");
  }
  validateSessionUserContentV1({
    elements,
    occurrences: input.occurrences,
    pastedTexts: input.pastedTexts ?? [],
    userMessage: input.userMessage,
  });
  return elements;
}

export function validateSessionUserContentV1(input: {
  readonly elements: readonly SessionUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
  readonly pastedTexts?: readonly PastedTextOccurrenceV1[] | undefined;
  readonly userMessage: string;
}): void {
  if (
    !sessionUserContentV1Schema.safeParse(input.elements).success ||
    !inputResourceOccurrenceV1Schema.array().safeParse(input.occurrences).success
  ) {
    throw new TypeError("The structured user content is invalid.");
  }
  const literalText = input.elements
    .flatMap((element) => (element.type === "text" ? [element.text] : []))
    .join("");
  const referenced = input.elements.flatMap((element) =>
    element.type === "input_resource" ? [element.occurrenceId] : [],
  );
  const expected = input.occurrences.map((occurrence) => occurrence.occurrenceId);
  const referencedPastedTexts = input.elements.flatMap((element) =>
    element.type === "pasted_text" ? [element.occurrenceId] : [],
  );
  const expectedPastedTexts = (input.pastedTexts ?? []).map(
    (occurrence) => occurrence.occurrenceId,
  );
  if (
    literalText !== input.userMessage ||
    referenced.length !== expected.length ||
    referenced.some((occurrenceId, index) => occurrenceId !== expected[index]) ||
    new Set(referenced).size !== referenced.length ||
    referencedPastedTexts.length !== expectedPastedTexts.length ||
    referencedPastedTexts.some(
      (occurrenceId, index) => occurrenceId !== expectedPastedTexts[index],
    ) ||
    new Set(referencedPastedTexts).size !== referencedPastedTexts.length ||
    Buffer.byteLength(literalText, "utf8") +
      (input.pastedTexts ?? []).reduce((total, occurrence) => total + occurrence.byteCount, 0) >
      pastedTextLimitsV1.maximumTextBytesPerTurn
  ) {
    throw new TypeError("The structured user content does not match its immutable occurrences.");
  }
}

export function projectSessionUserContentTextV1(input: {
  readonly elements: readonly SessionUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
}): string {
  const occurrences = new Map(
    input.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  return input.elements
    .map((element) => {
      if (element.type === "text") {
        return element.text;
      }
      if (element.type === "pasted_text") {
        return `[Text #${element.draftOrdinal}]`;
      }
      const occurrence = occurrences.get(element.occurrenceId);
      if (occurrence === undefined) {
        throw new TypeError("The structured user content occurrence is unavailable.");
      }
      return `[${occurrence.support === "image" ? "Image" : "File"} #${element.draftOrdinal}]`;
    })
    .join("");
}

export function createSessionUserContentMessageV1(input: {
  readonly elements: readonly SessionUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
  readonly pastedTexts?: readonly PastedTextOccurrenceV1[] | undefined;
  readonly pastedTextContents?: ReadonlyMap<string, string> | undefined;
  readonly userMessage: string;
}): ModelMessage {
  validateSessionUserContentV1(input);
  const occurrences = new Map(
    input.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const expanded = input.elements
    .map((element) => {
      if (element.type === "text") {
        return element.text;
      }
      if (element.type === "pasted_text") {
        const text = input.pastedTextContents?.get(element.occurrenceId);
        if (text === undefined) {
          throw new TypeError("The pasted-text projection content is unavailable.");
        }
        return text;
      }
      const occurrence = occurrences.get(element.occurrenceId);
      if (occurrence === undefined) {
        throw new TypeError("The structured user content occurrence is unavailable.");
      }
      return `[${occurrence.support === "image" ? "Image" : "File"} #${element.draftOrdinal}]`;
    })
    .join("");
  return createInputResourceUserMessageV1(expanded, input.occurrences);
}
