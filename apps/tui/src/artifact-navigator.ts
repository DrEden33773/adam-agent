import type {
  ArtifactChunk,
  ArtifactRange,
  ArtifactReference,
  OperationDisplay,
  TranscriptItem,
} from "@adam-agent/presentation";
import { presentationArtifactPageMaximumBytes } from "@adam-agent/presentation";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { type SearchableSelectItem, SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

const loadOlderEntryKey = "__load_older_chronology__";

export type ArtifactEntry = {
  readonly artifact: ArtifactReference;
  readonly description: string;
  readonly key: string;
  readonly label: string;
};

export function activeChronologyArtifacts(
  items: readonly TranscriptItem[],
  operations: readonly OperationDisplay[] = [],
): readonly ArtifactEntry[] {
  const chronology = items.flatMap((item) => {
    if (item.type === "plan_submission") {
      return [
        {
          artifact: {
            id: item.submission.artifact.id,
            mediaType: item.submission.artifact.mediaType,
            byteCount: item.submission.artifact.byteCount,
            source: "plan" as const,
          },
          description: `${item.submission.artifact.byteCount} bytes · ${item.submission.artifact.mediaType} · ${item.status}`,
          key: `${item.id}:plan`,
          label: item.submission.title ?? `Plan revision ${item.submission.revision}`,
        },
      ];
    }
    if (item.type === "assistant_message" && item.artifact !== null) {
      return [
        {
          artifact: item.artifact,
          description: `${item.artifact.byteCount} bytes · ${item.artifact.mediaType}`,
          key: `${item.id}:assistant`,
          label: "assistant response",
        },
      ];
    }
    if (item.type !== "tool_call") {
      return [];
    }
    return item.artifacts.map((artifact, index) => ({
      artifact,
      description: `${artifact.byteCount} bytes · ${artifact.mediaType}`,
      key: `${item.id}:tool:${index}`,
      label: `${item.label} output`,
    }));
  });
  const linked = operations.flatMap((operation) =>
    operation.artifacts.map((artifact, index) => ({
      artifact: artifact.reference,
      description: `${artifact.reference.byteCount} bytes · ${artifact.reference.mediaType} · ${artifact.contract.id}@${artifact.contract.version}`,
      key: `operation:${operation.operationId}:${artifact.role}:${index}`,
      label: `${operation.provenance.title} ${artifact.role}`,
    })),
  );
  return [...chronology, ...linked];
}

export function activeChronologyDiffs(items: readonly TranscriptItem[]): readonly ArtifactEntry[] {
  return items.flatMap((item) =>
    item.type === "tool_call" &&
    item.changePreviewRef !== null &&
    (item.status === "completed" || item.status === "failed" || item.status === "denied")
      ? [
          {
            artifact: item.changePreviewRef,
            description: `${item.changePreviewRef.byteCount} bytes · ${item.changePreviewRef.mediaType}`,
            key: `${item.id}:change-preview`,
            label: `${item.label} change preview`,
          },
        ]
      : [],
  );
}

export class ArtifactNavigator implements Component {
  readonly #entries: ReadonlyMap<string, ArtifactEntry>;
  readonly #list: SearchableSelectList;
  readonly #onChange: () => void;
  readonly #onRead: (artifact: ArtifactReference, range: ArtifactRange) => Promise<ArtifactChunk>;
  readonly #paged: boolean;
  readonly #theme: AdamTuiTheme;
  readonly #title: string;
  readonly #detailTitle: string;
  #detail: {
    readonly entry: ArtifactEntry;
    readonly chunk: ArtifactChunk;
    readonly previousRanges: readonly ArtifactRange[];
    readonly range: ArtifactRange;
  } | null = null;
  #generation = 0;
  #notice: string | null = null;

  constructor(options: {
    readonly entries: readonly ArtifactEntry[];
    readonly onChange: () => void;
    readonly onClose: () => void;
    readonly onLoadOlder?: () => void;
    readonly onRead: (artifact: ArtifactReference, range: ArtifactRange) => Promise<ArtifactChunk>;
    readonly paged?: boolean;
    readonly theme: AdamTuiTheme;
    readonly title?: string;
    readonly detailTitle?: string;
  }) {
    this.#entries = new Map(options.entries.map((entry) => [entry.key, entry]));
    this.#onChange = options.onChange;
    this.#onRead = options.onRead;
    this.#paged = options.paged ?? true;
    this.#theme = options.theme;
    this.#title = options.title ?? "Session artifacts";
    this.#detailTitle = options.detailTitle ?? "Artifact detail";
    const items: SearchableSelectItem[] = [
      ...options.entries.map((entry) => ({
        item: {
          value: entry.key,
          label: safeTerminalText(entry.label),
          description: safeTerminalText(entry.description),
        },
        searchText: `${entry.label} ${entry.description}`,
      })),
      ...(options.onLoadOlder === undefined
        ? []
        : [
            {
              alwaysVisible: true,
              item: {
                value: loadOlderEntryKey,
                label: "Load older chronology",
                description: "Read one older authoritative page",
              },
              searchText: "",
            },
          ]),
    ];
    this.#list = new SearchableSelectList({
      items,
      maxVisible: 8,
      onCancel: () => {
        this.cancelPendingRead();
        options.onClose();
      },
      onSelect: (item) => {
        if (item.value === loadOlderEntryKey) {
          options.onLoadOlder?.();
          return;
        }
        const entry = this.#entries.get(item.value);
        if (entry !== undefined) {
          this.#open(entry, artifactPageRange(0), []);
        }
      },
      theme: options.theme.editor.selectList,
    });
  }

  handleInput(data: string): void {
    if (this.#detail !== null && getKeybindings().matches(data, "tui.select.cancel")) {
      this.cancelPendingRead();
      this.#detail = null;
      this.#notice = null;
      return;
    }
    if (
      this.#detail !== null &&
      this.#paged &&
      this.#detail.chunk.nextRange !== null &&
      getKeybindings().matches(data, "tui.select.pageDown")
    ) {
      this.#open(this.#detail.entry, this.#detail.chunk.nextRange, [
        ...this.#detail.previousRanges,
        this.#detail.range,
      ]);
      return;
    }
    if (
      this.#detail !== null &&
      this.#paged &&
      this.#detail.previousRanges.length > 0 &&
      getKeybindings().matches(data, "tui.select.pageUp")
    ) {
      const previousRange = this.#detail.previousRanges.at(-1);
      if (previousRange !== undefined) {
        this.#open(this.#detail.entry, previousRange, this.#detail.previousRanges.slice(0, -1));
      }
      return;
    }
    if (this.#detail === null) {
      this.#list.handleInput(data);
    }
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  cancelPendingRead(): void {
    this.#generation += 1;
  }

  setNotice(notice: string | null): void {
    this.#notice = notice;
    this.#onChange();
  }

  render(width: number): string[] {
    if (this.#detail === null) {
      return [
        this.#theme.toolTitle(this.#title),
        "",
        ...this.#list.render(width),
        ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
        "",
        this.#theme.muted("type search · Enter inspect · Esc close · Ctrl+Q exit"),
      ];
    }
    const { chunk, entry } = this.#detail;
    return [
      this.#theme.toolTitle(this.#detailTitle),
      safeTerminalText(entry.label),
      `${chunk.offset + 1}-${chunk.offset + chunk.byteCount} of ${chunk.totalByteCount} bytes`,
      "",
      ...safeTerminalText(chunk.text).split("\n"),
      "",
      this.#theme.muted(
        this.#paged
          ? "PageUp previous · PageDown next · Esc back · Ctrl+Q exit"
          : "Esc back · Ctrl+Q exit",
      ),
    ];
  }

  #open(
    entry: ArtifactEntry,
    range: ArtifactRange,
    previousRanges: readonly ArtifactRange[],
  ): void {
    const generation = ++this.#generation;
    this.#notice = "Reading bounded artifact page…";
    void this.#onRead(entry.artifact, range).then(
      (chunk) => {
        if (generation !== this.#generation) {
          return;
        }
        this.#detail = { entry, chunk, previousRanges, range };
        this.#notice = null;
        this.#onChange();
      },
      (error: unknown) => {
        if (generation !== this.#generation) {
          return;
        }
        this.#notice = error instanceof Error ? error.message : "The artifact page is unavailable.";
        this.#onChange();
      },
    );
  }
}

export function artifactPageRange(offset: number): {
  readonly offset: number;
  readonly maximumBytes: number;
} {
  return { offset, maximumBytes: presentationArtifactPageMaximumBytes };
}
