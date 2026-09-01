import {
  type ArtifactStore,
  createFileArtifactStagingStore,
  type StagedArtifactReference,
} from "./artifact-store.js";
import {
  ingestLocalInputResourcesV1,
  type StagedInputResourceSelectionV1,
} from "./input-resources.js";
import {
  isLargePastedTextV1,
  pastedTextLimitsV1,
  pastedTextMetricsV1,
  type StagedPastedTextSelectionV1,
} from "./pasted-text.js";

export const turnComposerStageBarrier = Symbol("adam-agent.turn-composer-stage-barrier");

export type TurnComposerStageBarrier = {
  afterOpen(input: { readonly signal: AbortSignal }): Promise<void> | void;
};

export type TurnComposerResourceStager = {
  stage(input: {
    readonly id: string;
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<StagedInputResourceSelectionV1>;
  stageText?(input: {
    readonly id: string;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<StagedPastedTextSelectionV1>;
  readText?(selection: StagedPastedTextSelectionV1): Promise<string>;
  retain(input: {
    readonly resourceId: string;
    readonly selection: StagedInputResourceSelectionV1 | StagedPastedTextSelectionV1;
  }): Promise<void>;
  discard(selection: StagedInputResourceSelectionV1 | StagedPastedTextSelectionV1): Promise<void>;
  close(): Promise<void>;
};

export async function createFileTurnComposerResourceStager(options: {
  readonly artifactRoot: string;
  readonly stageBarrier?: TurnComposerStageBarrier;
}): Promise<TurnComposerResourceStager> {
  const staging = await createFileArtifactStagingStore({ root: options.artifactRoot });

  return {
    async stage(input) {
      let staged: StagedArtifactReference | undefined;
      const stagingArtifactStore: ArtifactStore = {
        async write(writeInput) {
          const written = await staging.write({
            bytes: writeInput.bytes,
            mediaType: writeInput.mediaType,
          });
          staged = written;
          return { ...written, source: writeInput.source };
        },
        async read() {
          return undefined;
        },
      };
      try {
        const [occurrence] = await ingestLocalInputResourcesV1({
          artifactStore: stagingArtifactStore,
          ...(options.stageBarrier === undefined
            ? {}
            : {
                afterOpened: () => options.stageBarrier?.afterOpen({ signal: input.signal }),
              }),
          runId: input.id,
          selections: [{ type: "local_file", path: input.path }],
          signal: input.signal,
        });
        if (occurrence === undefined || staged === undefined) {
          throw new TypeError("The provisional input resource did not settle.");
        }
        return {
          type: "staged_artifact",
          staged,
          displayName: occurrence.displayName,
          digest: occurrence.digest,
          mediaHint: occurrence.mediaHint,
          support: occurrence.support,
          origin: "selected_file",
        };
      } catch (error) {
        if (staged !== undefined) {
          await staging.discard(staged);
        }
        throw error;
      }
    },
    async stageText(input) {
      let staged: StagedArtifactReference | undefined;
      try {
        input.signal.throwIfAborted();
        if (!isLargePastedTextV1(input.text)) {
          throw new TypeError("Only a large normalized paste can become a Text atom.");
        }
        const metrics = pastedTextMetricsV1(input.text);
        if (metrics.byteCount > pastedTextLimitsV1.maximumTextBytesPerTurn) {
          throw new TypeError("The pasted text exceeds the v1 turn limit.");
        }
        staged = await staging.write({
          bytes: Buffer.from(input.text, "utf8"),
          mediaType: "text/plain; charset=utf-8",
        });
        input.signal.throwIfAborted();
        return {
          type: "staged_pasted_text",
          staged,
          digest: staged.id,
          ...metrics,
        };
      } catch (error) {
        if (staged !== undefined) {
          await staging.discard(staged);
        }
        throw error;
      }
    },
    async readText(selection) {
      const bytes = await staging.read(
        selection.staged,
        pastedTextLimitsV1.maximumTextBytesPerTurn,
      );
      if (bytes === undefined) {
        throw new TypeError("The recoverable pasted-text bytes are unavailable.");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const metrics = pastedTextMetricsV1(text);
      if (
        selection.digest !== selection.staged.id ||
        metrics.byteCount !== selection.byteCount ||
        metrics.lineCount !== selection.lineCount ||
        metrics.scalarCount !== selection.scalarCount ||
        !isLargePastedTextV1(text)
      ) {
        throw new TypeError("The recoverable pasted-text bytes are corrupt.");
      }
      return text;
    },
    async retain(input) {
      await staging.retain(input.selection.staged);
    },
    discard(selection) {
      return staging.discard(selection.staged);
    },
    close() {
      return staging.close();
    },
  };
}
