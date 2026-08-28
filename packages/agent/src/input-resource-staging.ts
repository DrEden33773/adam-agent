import {
  type ArtifactStore,
  createFileArtifactStagingStore,
  type StagedArtifactReference,
} from "./artifact-store.js";
import {
  ingestLocalInputResourcesV1,
  type StagedInputResourceSelectionV1,
} from "./input-resources.js";

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
  discard(selection: StagedInputResourceSelectionV1): Promise<void>;
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
        };
      } catch (error) {
        if (staged !== undefined) {
          await staging.discard(staged);
        }
        throw error;
      }
    },
    discard(selection) {
      return staging.discard(selection.staged);
    },
    close() {
      return staging.close();
    },
  };
}
