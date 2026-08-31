import {
  type ArtifactChunk,
  type ArtifactReference,
  type CommandReceipt,
  type PresentationCommand,
  presentationArtifactPageMaximumBytes,
} from "@adam-agent/presentation";

export const largeReasoningViewPolicy = {
  version: 1,
  thresholdBytes: 256 * 1024,
  pageBytes: presentationArtifactPageMaximumBytes,
  cacheBytes: 128 * 1024,
} as const;

export type LargeReasoningInput = {
  readonly id: string;
  readonly text: string | null;
  readonly artifact: ArtifactReference | null;
  readonly preferEnd: boolean;
};

export type LargeReasoningPage = {
  readonly anchorId: string;
  readonly byteCount: number;
  readonly offset: number;
  readonly text: string;
};

export type LargeReasoningView = {
  readonly totalByteCount: number;
  readonly pages: readonly LargeReasoningPage[];
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  readonly loadingAbove: boolean;
  readonly loadingBelow: boolean;
  readonly loadingInitial: boolean;
  readonly failureAbove: boolean;
  readonly failureBelow: boolean;
  readonly failureInitial: boolean;
};

type Direction = "initial" | "up" | "down";

type CachedPage = {
  readonly byteCount: number;
  readonly eof: boolean;
  readonly key: string;
  readonly nextOffset: number | null;
  readonly offset: number;
  readonly sourceKey: string;
  readonly text: string;
  readonly totalByteCount: number;
};

type LocalPage = CachedPage & {
  readonly characterEnd: number;
  readonly characterStart: number;
};

type StateBase = {
  readonly id: string;
  generation: number;
  navigationToken: number;
  readonly pending: Map<Direction, { readonly offset: number; readonly token: number }>;
  readonly failures: Set<Direction>;
};

type LocalState = StateBase & {
  readonly kind: "local";
  sourceKey: string;
  text: string;
  totalByteCount: number;
  current: LocalPage;
};

type ArtifactState = StateBase & {
  readonly kind: "artifact";
  readonly artifact: ArtifactReference;
  readonly sourceKey: string;
  currentOffset: number;
  readonly previousOffsets: Map<number, number>;
};

type LargeReasoningState = LocalState | ArtifactState;

export function isLargeReasoning(input: {
  readonly artifact: ArtifactReference | null;
  readonly text: string | null;
}): boolean {
  return (
    (input.artifact?.byteCount ?? 0) > largeReasoningViewPolicy.thresholdBytes ||
    (input.text !== null &&
      Buffer.byteLength(input.text, "utf8") > largeReasoningViewPolicy.thresholdBytes)
  );
}

export function largeReasoningBoundaryAnchorId(
  reasoningId: string,
  direction: "up" | "down",
): string {
  return `large-reasoning:${reasoningId}:${direction}`;
}

export function largeReasoningPageAnchorId(reasoningId: string, offset: number): string {
  return `large-reasoning:${reasoningId}:page:${offset}`;
}

export class LargeReasoningViewStore {
  readonly #cache: ByteLru;
  readonly #onChange: (focusAnchorId?: string) => void;
  readonly #readArtifact: (
    command: Extract<PresentationCommand, { readonly type: "read_artifact" }>,
  ) => Promise<CommandReceipt>;
  readonly #states = new Map<string, LargeReasoningState>();

  constructor(options: {
    readonly cacheBytes?: number;
    readonly onChange: (focusAnchorId?: string) => void;
    readonly readArtifact: (
      command: Extract<PresentationCommand, { readonly type: "read_artifact" }>,
    ) => Promise<CommandReceipt>;
  }) {
    this.#cache = new ByteLru(options.cacheBytes ?? largeReasoningViewPolicy.cacheBytes);
    this.#onChange = options.onChange;
    this.#readArtifact = options.readArtifact;
  }

  clear(): void {
    this.#states.clear();
    this.#cache.clear();
  }

  close(reasoningId: string): void {
    this.#states.delete(reasoningId);
  }

  noteViewportMovement(direction: "up" | "down"): void {
    const opposite = direction === "up" ? "down" : "up";
    for (const state of this.#states.values()) {
      if (state.pending.has("initial") || state.pending.has(opposite)) {
        state.navigationToken += 1;
      }
    }
  }

  sync(input: LargeReasoningInput): LargeReasoningView | null {
    if (!isLargeReasoning(input)) {
      this.close(input.id);
      return null;
    }
    const state = this.#synchronizeState(input);
    return state.kind === "local" ? this.#localView(state) : this.#artifactView(state);
  }

  navigate(reasoningId: string, direction: "up" | "down"): void {
    const state = this.#states.get(reasoningId);
    if (state === undefined) {
      return;
    }
    if (state.kind === "local") {
      const next =
        direction === "down"
          ? localPageAfter(state.text, state.current, state.sourceKey)
          : localPageBefore(state.text, state.current, state.sourceKey);
      if (next !== null) {
        state.current = next;
        state.navigationToken += 1;
        this.#onChange(largeReasoningPageAnchorId(state.id, next.offset));
      }
      return;
    }
    if (state.pending.has(direction)) {
      return;
    }
    const current = this.#cache.peek(pageKey(state.sourceKey, state.currentOffset));
    if (current === undefined) {
      this.#requestArtifactPage(state, state.currentOffset, direction);
      return;
    }
    const targetOffset =
      direction === "down"
        ? current.nextOffset
        : (state.previousOffsets.get(current.offset) ?? null);
    if (targetOffset === null) {
      return;
    }
    const cached = this.#cache.touch(pageKey(state.sourceKey, targetOffset));
    state.navigationToken += 1;
    if (cached !== undefined) {
      state.currentOffset = targetOffset;
      state.failures.delete(direction);
      this.#onChange(largeReasoningPageAnchorId(state.id, targetOffset));
      return;
    }
    this.#requestArtifactPage(state, targetOffset, direction, state.navigationToken);
  }

  #synchronizeState(input: LargeReasoningInput): LargeReasoningState {
    const current = this.#states.get(input.id);
    if (
      input.artifact !== null &&
      input.artifact.byteCount > largeReasoningViewPolicy.thresholdBytes
    ) {
      const sourceKey = artifactSourceKey(input.artifact);
      if (current?.kind === "artifact" && current.sourceKey === sourceKey) {
        return current;
      }
      const state = this.#artifactStateFrom(input.id, input.artifact, sourceKey, current);
      this.#states.set(input.id, state);
      if (this.#cache.peek(pageKey(sourceKey, state.currentOffset)) === undefined) {
        this.#requestArtifactPage(state, state.currentOffset, "initial");
      }
      return state;
    }
    const text = input.text as string;
    const totalByteCount = Buffer.byteLength(text, "utf8");
    if (current?.kind === "local") {
      const sourceChanged = current.text !== text;
      const wasAtEnd = current.current.characterEnd >= current.text.length;
      current.text = text;
      current.totalByteCount = totalByteCount;
      if (sourceChanged) {
        current.generation += 1;
        current.failures.clear();
        current.pending.clear();
      }
      if (input.preferEnd && wasAtEnd) {
        current.current = localTailPage(text, totalByteCount, current.sourceKey);
      } else if (current.current.characterStart >= text.length) {
        current.current = localTailPage(text, totalByteCount, current.sourceKey);
      } else {
        current.current = localPageAt(
          text,
          current.current.characterStart,
          current.current.offset,
          current.sourceKey,
          totalByteCount,
        );
      }
      return current;
    }
    const sourceKey = `local:${input.id}`;
    const state: LocalState = {
      id: input.id,
      kind: "local",
      sourceKey,
      text,
      totalByteCount,
      current: input.preferEnd
        ? localTailPage(text, totalByteCount, sourceKey)
        : localPageAt(text, 0, 0, sourceKey, totalByteCount),
      generation: (current?.generation ?? 0) + 1,
      navigationToken: 0,
      pending: new Map(),
      failures: new Set(),
    };
    this.#states.set(input.id, state);
    return state;
  }

  #artifactStateFrom(
    reasoningId: string,
    artifact: ArtifactReference,
    sourceKey: string,
    previous: LargeReasoningState | undefined,
  ): ArtifactState {
    const previousOffsets = new Map<number, number>();
    let currentOffset = 0;
    if (previous?.kind === "local" && previous.totalByteCount === artifact.byteCount) {
      const migration = canonicalArtifactMigration(previous);
      currentOffset = migration.current.offset;
      for (const [nextOffset, previousOffset] of migration.previousOffsets) {
        previousOffsets.set(nextOffset, previousOffset);
      }
      for (const page of migration.pages) {
        const migrated = { ...page, key: pageKey(sourceKey, page.offset), sourceKey };
        this.#cache.set(migrated);
      }
    }
    return {
      id: reasoningId,
      kind: "artifact",
      artifact,
      sourceKey,
      currentOffset,
      previousOffsets,
      generation: (previous?.generation ?? 0) + 1,
      navigationToken: 0,
      pending: new Map(),
      failures: new Set(),
    };
  }

  #localView(state: LocalState): LargeReasoningView {
    const pages = localWindow(state);
    return {
      totalByteCount: state.totalByteCount,
      pages: pages.map((page) => viewPage(state.id, page)),
      moreAbove: (pages[0]?.offset ?? 0) > 0,
      moreBelow: pages.at(-1)?.eof === false,
      loadingAbove: false,
      loadingBelow: false,
      loadingInitial: false,
      failureAbove: false,
      failureBelow: false,
      failureInitial: false,
    };
  }

  #artifactView(state: ArtifactState): LargeReasoningView {
    const current = this.#cache.peek(pageKey(state.sourceKey, state.currentOffset));
    const previousOffset = state.previousOffsets.get(state.currentOffset);
    const offsets = [previousOffset, state.currentOffset, current?.nextOffset]
      .filter((offset): offset is number => offset !== undefined && offset !== null)
      .filter((offset, index, values) => values.indexOf(offset) === index);
    const pages = offsets
      .map((offset) => this.#cache.peek(pageKey(state.sourceKey, offset)))
      .filter((page): page is CachedPage => page !== undefined)
      .sort((left, right) => left.offset - right.offset);
    return {
      totalByteCount: state.artifact.byteCount,
      pages: pages.map((page) => viewPage(state.id, page)),
      moreAbove: (pages[0]?.offset ?? state.currentOffset) > 0,
      moreBelow: pages.length === 0 ? state.artifact.byteCount > 0 : pages.at(-1)?.eof === false,
      loadingAbove: state.pending.has("up"),
      loadingBelow: state.pending.has("down"),
      loadingInitial: state.pending.has("initial"),
      failureAbove: state.failures.has("up"),
      failureBelow: state.failures.has("down"),
      failureInitial: state.failures.has("initial"),
    };
  }

  #requestArtifactPage(
    state: ArtifactState,
    offset: number,
    direction: Direction,
    navigationToken = state.navigationToken,
  ): void {
    if (state.pending.has(direction)) {
      return;
    }
    state.failures.delete(direction);
    const request = { offset, token: navigationToken };
    state.pending.set(direction, request);
    const generation = state.generation;
    void this.#readArtifact({
      type: "read_artifact",
      artifact: state.artifact,
      range: { offset, maximumBytes: largeReasoningViewPolicy.pageBytes },
    }).then(
      (receipt) => {
        const active = this.#states.get(state.id);
        if (
          active !== state ||
          active.generation !== generation ||
          active.pending.get(direction) !== request
        ) {
          return;
        }
        state.pending.delete(direction);
        if (receipt.status === "rejected" || receipt.resource === null) {
          state.failures.add(direction);
          this.#onChange();
          return;
        }
        const page = validateArtifactPage(state, receipt.resource, offset);
        if (page === null) {
          state.failures.add(direction);
          this.#onChange();
          return;
        }
        this.#cache.set(page);
        if (page.nextOffset !== null) {
          state.previousOffsets.set(page.nextOffset, page.offset);
        }
        if (state.navigationToken === request.token) {
          state.currentOffset = page.offset;
        }
        this.#onChange(
          direction === "initial" || state.currentOffset !== page.offset
            ? undefined
            : largeReasoningPageAnchorId(state.id, page.offset),
        );
      },
      () => {
        const active = this.#states.get(state.id);
        if (
          active !== state ||
          active.generation !== generation ||
          active.pending.get(direction) !== request
        ) {
          return;
        }
        state.pending.delete(direction);
        state.failures.add(direction);
        this.#onChange();
      },
    );
  }
}

class ByteLru {
  readonly #maximumBytes: number;
  readonly #pages = new Map<string, CachedPage>();
  #totalBytes = 0;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  clear(): void {
    this.#pages.clear();
    this.#totalBytes = 0;
  }

  peek(key: string): CachedPage | undefined {
    return this.#pages.get(key);
  }

  touch(key: string): CachedPage | undefined {
    const page = this.#pages.get(key);
    if (page === undefined) {
      return undefined;
    }
    this.#pages.delete(key);
    this.#pages.set(key, page);
    return page;
  }

  set(page: CachedPage): void {
    const existing = this.#pages.get(page.key);
    if (existing !== undefined) {
      this.#totalBytes -= existing.byteCount;
      this.#pages.delete(page.key);
    }
    this.#pages.set(page.key, page);
    this.#totalBytes += page.byteCount;
    while (this.#totalBytes > this.#maximumBytes) {
      const oldest = this.#pages.entries().next().value as [string, CachedPage] | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#pages.delete(oldest[0]);
      this.#totalBytes -= oldest[1].byteCount;
    }
  }
}

function artifactSourceKey(artifact: ArtifactReference): string {
  return `artifact:${artifact.id}:${artifact.byteCount}`;
}

function pageKey(sourceKey: string, offset: number): string {
  return `${sourceKey}:${offset}`;
}

function viewPage(reasoningId: string, page: CachedPage): LargeReasoningPage {
  return {
    anchorId: largeReasoningPageAnchorId(reasoningId, page.offset),
    byteCount: page.byteCount,
    offset: page.offset,
    text: page.text,
  };
}

function validateArtifactPage(
  state: ArtifactState,
  chunk: ArtifactChunk,
  expectedOffset: number,
): CachedPage | null {
  const actualBytes = Buffer.byteLength(chunk.text, "utf8");
  const expectedNextOffset = chunk.eof ? null : chunk.offset + chunk.byteCount;
  if (
    chunk.offset !== expectedOffset ||
    chunk.totalByteCount !== state.artifact.byteCount ||
    chunk.mediaType !== state.artifact.mediaType ||
    chunk.byteCount <= 0 ||
    chunk.byteCount > largeReasoningViewPolicy.pageBytes ||
    actualBytes !== chunk.byteCount ||
    chunk.offset + chunk.byteCount > chunk.totalByteCount ||
    chunk.eof !== (chunk.offset + chunk.byteCount === chunk.totalByteCount) ||
    (chunk.nextRange === null
      ? expectedNextOffset !== null
      : chunk.nextRange.offset !== expectedNextOffset ||
        chunk.nextRange.maximumBytes !== largeReasoningViewPolicy.pageBytes)
  ) {
    return null;
  }
  return {
    byteCount: chunk.byteCount,
    eof: chunk.eof,
    key: pageKey(state.sourceKey, chunk.offset),
    nextOffset: expectedNextOffset,
    offset: chunk.offset,
    sourceKey: state.sourceKey,
    text: chunk.text,
    totalByteCount: chunk.totalByteCount,
  };
}

function localWindow(state: LocalState): readonly LocalPage[] {
  const previous = localPageBefore(state.text, state.current, state.sourceKey);
  const next = localPageAfter(state.text, state.current, state.sourceKey);
  return [previous, state.current, next].filter((page): page is LocalPage => page !== null);
}

function canonicalArtifactMigration(state: LocalState): {
  readonly current: LocalPage;
  readonly pages: readonly LocalPage[];
  readonly previousOffsets: ReadonlyMap<number, number>;
} {
  const previousOffsets = new Map<number, number>();
  let previous: LocalPage | null = null;
  let current = localPageAt(state.text, 0, 0, state.sourceKey, state.totalByteCount);
  while (true) {
    const next = localPageAfter(state.text, current, state.sourceKey);
    if (next !== null) {
      previousOffsets.set(next.offset, current.offset);
    }
    const containsPreviousPosition =
      state.current.eof ||
      (state.current.offset >= current.offset &&
        (next === null || state.current.offset < next.offset));
    if ((state.current.eof && current.eof) || (!state.current.eof && containsPreviousPosition)) {
      return {
        current,
        pages: [previous, current, next].filter((page): page is LocalPage => page !== null),
        previousOffsets,
      };
    }
    if (next === null) {
      return {
        current,
        pages: [previous, current].filter((page): page is LocalPage => page !== null),
        previousOffsets,
      };
    }
    previous = current;
    current = next;
  }
}

function localPageAt(
  text: string,
  characterStart: number,
  offset: number,
  sourceKey: string,
  totalByteCount = Buffer.byteLength(text, "utf8"),
): LocalPage {
  let characterEnd = characterStart;
  let byteCount = 0;
  while (characterEnd < text.length) {
    const scalar = scalarAt(text, characterEnd);
    if (byteCount + scalar.byteCount > largeReasoningViewPolicy.pageBytes) {
      break;
    }
    byteCount += scalar.byteCount;
    characterEnd += scalar.characterCount;
  }
  const pageText = text.slice(characterStart, characterEnd);
  return {
    byteCount,
    characterEnd,
    characterStart,
    eof: characterEnd >= text.length,
    key: pageKey(sourceKey, offset),
    nextOffset: characterEnd >= text.length ? null : offset + byteCount,
    offset,
    sourceKey,
    text: pageText,
    totalByteCount,
  };
}

function localTailPage(text: string, totalByteCount: number, sourceKey: string): LocalPage {
  let characterStart = text.length;
  let byteCount = 0;
  while (characterStart > 0) {
    const start = previousScalarStart(text, characterStart);
    const scalarBytes = Buffer.byteLength(text.slice(start, characterStart), "utf8");
    if (byteCount + scalarBytes > largeReasoningViewPolicy.pageBytes) {
      break;
    }
    byteCount += scalarBytes;
    characterStart = start;
  }
  const offset = totalByteCount - byteCount;
  return {
    byteCount,
    characterEnd: text.length,
    characterStart,
    eof: true,
    key: pageKey(sourceKey, offset),
    nextOffset: null,
    offset,
    sourceKey,
    text: text.slice(characterStart),
    totalByteCount,
  };
}

function localPageAfter(text: string, page: LocalPage, sourceKey: string): LocalPage | null {
  if (page.characterEnd >= text.length) {
    return null;
  }
  return localPageAt(
    text,
    page.characterEnd,
    page.offset + page.byteCount,
    sourceKey,
    page.totalByteCount,
  );
}

function localPageBefore(text: string, page: LocalPage, sourceKey: string): LocalPage | null {
  if (page.characterStart === 0 || page.offset === 0) {
    return null;
  }
  let characterStart = page.characterStart;
  let byteCount = 0;
  while (characterStart > 0) {
    const start = previousScalarStart(text, characterStart);
    const scalarBytes = Buffer.byteLength(text.slice(start, characterStart), "utf8");
    if (byteCount + scalarBytes > largeReasoningViewPolicy.pageBytes) {
      break;
    }
    byteCount += scalarBytes;
    characterStart = start;
  }
  const offset = page.offset - byteCount;
  return localPageAt(text, characterStart, offset, sourceKey, page.totalByteCount);
}

function scalarAt(
  text: string,
  index: number,
): { readonly byteCount: number; readonly characterCount: number } {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return { byteCount: 0, characterCount: 0 };
  }
  const character = String.fromCodePoint(codePoint);
  return { byteCount: Buffer.byteLength(character, "utf8"), characterCount: character.length };
}

function previousScalarStart(text: string, end: number): number {
  const candidate = end - 1;
  const code = text.charCodeAt(candidate);
  return code >= 0xdc00 && code <= 0xdfff && candidate > 0 ? candidate - 1 : candidate;
}
