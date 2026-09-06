import type { AtMentionAtom, DraftMentionElement } from "@adam-agent/presentation";
import { z } from "zod";

const fields = {
  type: z.literal("mention"),
  literal: z
    .string()
    .min(2)
    .max(16_384)
    .regex(/^@[^\s\p{Cc}]+$/u),
};

export const atMentionAtomSchema: z.ZodType<AtMentionAtom> = z.discriminatedUnion("kind", [
  z.strictObject({ ...fields, kind: z.literal("literal") }),
  z.strictObject({ ...fields, kind: z.literal("path"), path: z.string().min(1).max(4096) }),
  z.strictObject({
    ...fields,
    kind: z.literal("role"),
    qualifiedRoleId: z.string().min(1).max(1024),
    definitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    ...fields,
    kind: z.literal("agent"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    handle: z.string().min(1).max(256),
  }),
  z.strictObject({ ...fields, kind: z.literal("main") }),
]);

export const draftMentionElementSchema = z.intersection(
  z.object({ elementId: z.string().min(1).max(256) }),
  z.unknown().transform((input, context) => {
    if (typeof input !== "object" || input === null || !("elementId" in input)) {
      context.addIssue({ code: "custom", message: "Missing mention identity." });
      return z.NEVER;
    }
    const { elementId: _elementId, ...atom } = input;
    const parsed = atMentionAtomSchema.safeParse(atom);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid mention identity." });
      return z.NEVER;
    }
    return parsed.data;
  }),
);

// Only the durable wire spelling differs; Presentation keeps the one atom family.
export function serializeMention(element: DraftMentionElement): object {
  if (element.kind !== "role" && element.kind !== "agent") return element;
  const { type: _type, kind, ...identity } = element;
  return { type: kind === "role" ? "role_ref" : "agent_ref", ...identity };
}

export function deserializeMention(element: unknown): unknown {
  if (
    typeof element !== "object" ||
    element === null ||
    !("type" in element) ||
    (element.type !== "role_ref" && element.type !== "agent_ref") ||
    "kind" in element
  )
    return element;
  return { ...element, type: "mention", kind: element.type === "role_ref" ? "role" : "agent" };
}
