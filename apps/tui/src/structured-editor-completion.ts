import type {
  EditorDocumentPart,
  EditorDocumentPoint,
  EditorStructuredCompletion,
  EditorStructuredCompletionProjection,
} from "@earendil-works/pi-tui";

export const adamStructuredEditorCompletion: EditorStructuredCompletion = {
  project(document, cursor) {
    const textCursor = textPartAtCursor(document, cursor);
    if (textCursor === null) {
      return null;
    }
    const beforeCursor = textCursor.part.text.slice(0, textCursor.offset);
    const earlierLiteralContent = document
      .slice(0, textCursor.index)
      .some((part) => part.type === "text" && part.text.trim().length > 0);
    const blockSlash = earlierLiteralContent && beforeCursor.trimStart().startsWith("/");
    return projectTextPart(
      blockSlash ? `x${textCursor.part.text}` : textCursor.part.text,
      textCursor.offset + (blockSlash ? 1 : 0),
    );
  },
  accept(document, cursor, item, prefix) {
    const textCursor = textPartAtCursor(document, cursor);
    if (textCursor === null) {
      return null;
    }
    const start = textCursor.offset - prefix.length;
    if (start < 0 || textCursor.part.text.slice(start, textCursor.offset) !== prefix) {
      return null;
    }
    const replacement = `${textCursor.part.text.slice(0, start)}${item.value}${textCursor.part.text.slice(textCursor.offset)}`;
    const nextDocument = document.map((part) =>
      part.id === textCursor.part.id ? { ...textCursor.part, text: replacement } : part,
    );
    const range = {
      anchor: { partId: textCursor.part.id, offset: start },
      focus: { partId: textCursor.part.id, offset: textCursor.offset },
    } as const;
    return {
      cursor: { partId: textCursor.part.id, offset: start + item.value.length },
      document: nextDocument,
      range,
      text: item.value,
    };
  },
};

function textPartAtCursor(
  document: readonly EditorDocumentPart[],
  cursor: EditorDocumentPoint,
): {
  readonly index: number;
  readonly part: Extract<EditorDocumentPart, { readonly type: "text" }>;
  readonly offset: number;
} | null {
  if (!("offset" in cursor) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    return null;
  }
  const index = document.findIndex((candidate) => candidate.id === cursor.partId);
  const part = document[index];
  if (part?.type !== "text" || cursor.offset > part.text.length) {
    return null;
  }
  return { index, offset: cursor.offset, part };
}

function projectTextPart(text: string, cursorOffset: number): EditorStructuredCompletionProjection {
  const lines = text.split("\n");
  const beforeCursor = text.slice(0, cursorOffset).split("\n");
  return {
    cursorCol: beforeCursor.at(-1)?.length ?? 0,
    cursorLine: beforeCursor.length - 1,
    lines,
  };
}
