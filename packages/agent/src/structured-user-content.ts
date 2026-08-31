import { z } from "zod";
import type { ModelMessage } from "./agent-session-contracts.js";
import {
  createInputResourceUserMessageV1,
  type InputResourceOccurrenceV1,
  inputResourceLimitsV1,
  inputResourceOccurrenceV1Schema,
} from "./input-resources.js";

export type StagedUserContentElementV1 =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "input_resource";
      readonly selectionIndex: number;
      readonly draftOrdinal: number;
    };

export type SessionUserContentElementV1 =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "input_resource";
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
      element.type === "input_resource" ? [element.draftOrdinal] : [],
    );
    return new Set(ordinals).size === ordinals.length;
  }, "Structured input-resource ordinals must be unique.");

export function materializeSessionUserContentV1(input: {
  readonly elements: readonly StagedUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
  readonly userMessage: string;
}): readonly SessionUserContentElementV1[] {
  const elements = input.elements.map((element): SessionUserContentElementV1 => {
    if (element.type === "text") {
      return element;
    }
    const occurrence = input.occurrences[element.selectionIndex];
    if (occurrence === undefined) {
      throw new TypeError("The structured draft references an unavailable input resource.");
    }
    return {
      type: "input_resource",
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
    userMessage: input.userMessage,
  });
  return elements;
}

export function validateSessionUserContentV1(input: {
  readonly elements: readonly SessionUserContentElementV1[];
  readonly occurrences: readonly InputResourceOccurrenceV1[];
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
  if (
    literalText !== input.userMessage ||
    referenced.length !== expected.length ||
    referenced.some((occurrenceId, index) => occurrenceId !== expected[index]) ||
    new Set(referenced).size !== referenced.length
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
  readonly userMessage: string;
}): ModelMessage {
  validateSessionUserContentV1(input);
  return createInputResourceUserMessageV1(
    projectSessionUserContentTextV1({
      elements: input.elements,
      occurrences: input.occurrences,
    }),
    input.occurrences,
  );
}
