import type {
  ModelMessage,
  ModelModalityProfile,
  ModelUserContent,
} from "./agent-session-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import { imageInputLimitsV1, inspectExplicitUserImageV1 } from "./image-input.js";
import {
  authorizedInputResourceOccurrencesV1,
  type InputResourceOccurrenceV1,
  inputResourceImageV1Schema,
  materializeInputResourceImageV1,
  parseInputResourceProjectionV1,
  projectInputResourcesV1,
} from "./input-resources.js";

type ModelUserContentProjection =
  | {
      readonly status: "projected";
      readonly content: ModelUserContent;
      readonly imageUsage?: ProjectedExplicitUserImageUsageV1;
      readonly imageArtifacts?: readonly (ProjectedExplicitUserImageArtifactUsageV1 & {
        readonly artifactId: `sha256:${string}`;
      })[];
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code:
          | "input_resource_invalid"
          | "input_resource_limit_exceeded"
          | "input_resource_unsupported";
        readonly message: string;
      };
    };

export { imageInputLimitsV1 } from "./image-input.js";

export type ProjectedContentUsageV1 = {
  readonly version: 1;
  readonly explicitUserImages?: ProjectedExplicitUserImageUsageV1 | undefined;
  readonly imageToolResults?: ProjectedExplicitUserImageUsageV1 | undefined;
};

type ProjectedExplicitUserImageUsageV1 = {
  readonly count: number;
  readonly byteCount: number;
  readonly pixelCount: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;
};

export type ProjectedExplicitUserImageArtifactUsageV1 = {
  readonly byteCount: number;
  readonly pixelCount: number;
  readonly width: number;
  readonly height: number;
};

export async function projectExplicitUserImageContentV1(input: {
  readonly artifactStore: ArtifactStore | undefined;
  readonly modalityProfile: ModelModalityProfile | undefined;
  readonly occurrences: readonly InputResourceOccurrenceV1[] | undefined;
  readonly signal: AbortSignal;
  readonly text: string;
}): Promise<ModelUserContentProjection> {
  if (input.occurrences === undefined || input.occurrences.length === 0) {
    return { status: "projected", content: input.text };
  }
  if (
    input.modalityProfile?.explicitUserImages !== "supported" &&
    input.modalityProfile?.imageToolResults === "supported"
  ) {
    return {
      status: "projected",
      content: projectInputResourcesV1(input.text, input.occurrences),
    };
  }
  const images: Array<{
    readonly occurrenceId: string;
    readonly artifactId: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly mediaType: "image/jpeg" | "image/png";
    readonly width: number;
    readonly height: number;
  }> = [];
  let aggregateImageBytes = 0;
  for (const occurrence of input.occurrences) {
    if (occurrence.support !== "image") {
      continue;
    }
    if (input.artifactStore === undefined) {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image artifact is unavailable.",
        },
      };
    }
    input.signal.throwIfAborted();
    const bytes = await input.artifactStore.read(occurrence.artifact.id, {
      maximumBytes: occurrence.artifact.byteCount,
    });
    input.signal.throwIfAborted();
    if (bytes === undefined || bytes.byteLength !== occurrence.artifact.byteCount) {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image artifact is unavailable or corrupt.",
        },
      };
    }
    const image = inspectExplicitUserImageV1(bytes);
    if (image.status === "not_image") {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image artifact does not match its immutable descriptor.",
        },
      };
    }
    if (image.status === "invalid") {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image is corrupt or has an unsupported image format.",
        },
      };
    }
    if (image.status === "limit_exceeded") {
      return {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected image dimensions exceed the v1 limit.",
        },
      };
    }
    if (occurrence.artifact.mediaType !== image.mediaType) {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image artifact does not match its immutable descriptor.",
        },
      };
    }
    if (
      image.width > imageInputLimitsV1.maximumWidth ||
      image.height > imageInputLimitsV1.maximumHeight ||
      image.width > Math.floor(imageInputLimitsV1.maximumPixels / image.height)
    ) {
      return {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected image dimensions exceed the v1 limit.",
        },
      };
    }
    if (bytes.byteLength > imageInputLimitsV1.maximumBytesPerImage) {
      return {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected image exceeds the v1 byte limit.",
        },
      };
    }
    if (images.length >= imageInputLimitsV1.maximumImagesPerRun) {
      return {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "At most one explicit user image is supported per run.",
        },
      };
    }
    aggregateImageBytes += bytes.byteLength;
    if (aggregateImageBytes > imageInputLimitsV1.maximumAggregateBytesPerRun) {
      return {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected images exceed the v1 aggregate byte limit.",
        },
      };
    }
    const immutableBytes = new Uint8Array(bytes.byteLength);
    immutableBytes.set(bytes);
    images.push({
      occurrenceId: occurrence.occurrenceId,
      artifactId: occurrence.artifact.id,
      bytes: immutableBytes,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
    });
  }
  if (images.length === 0) {
    return {
      status: "projected",
      content: projectInputResourcesV1(input.text, input.occurrences),
    };
  }
  if (input.modalityProfile?.explicitUserImages !== "supported") {
    return {
      status: "failed",
      error: {
        code: "input_resource_unsupported",
        message: "The selected target does not support explicit user images.",
      },
    };
  }
  const imageByOccurrenceId = new Map(images.map((image) => [image.occurrenceId, image]));
  return {
    status: "projected",
    content: [
      { type: "text", text: input.text },
      ...input.occurrences.map((occurrence) => {
        const image = imageByOccurrenceId.get(occurrence.occurrenceId);
        return image === undefined
          ? { type: "text" as const, text: projectInputResourcesV1("", [occurrence]) }
          : {
              type: "file" as const,
              artifactId: image.artifactId,
              bytes: image.bytes,
              mediaType: image.mediaType,
            };
      }),
    ],
    imageUsage: {
      count: images.length,
      byteCount: aggregateImageBytes,
      pixelCount: images.reduce((sum, image) => sum + image.width * image.height, 0),
      maximumWidth: Math.max(...images.map((image) => image.width)),
      maximumHeight: Math.max(...images.map((image) => image.height)),
    },
    imageArtifacts: images.map((image) => ({
      artifactId: image.artifactId,
      byteCount: image.bytes.byteLength,
      pixelCount: image.width * image.height,
      width: image.width,
      height: image.height,
    })),
  };
}

export async function prepareExplicitUserImageMessagesV1(input: {
  readonly artifactStore: ArtifactStore | undefined;
  readonly inputResources?: readonly InputResourceOccurrenceV1[];
  readonly messages: readonly ModelMessage[];
  readonly modalityProfile: ModelModalityProfile | undefined;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly status: "prepared";
      readonly projections: ReadonlyMap<ModelMessage, ModelUserContent>;
      readonly imageUsageByProjection: ReadonlyMap<ModelMessage, ProjectedExplicitUserImageUsageV1>;
      readonly imageUsageByArtifactId: ReadonlyMap<
        `sha256:${string}`,
        ProjectedExplicitUserImageArtifactUsageV1
      >;
    }
  | Extract<ModelUserContentProjection, { readonly status: "failed" }>
> {
  const projections = new Map<ModelMessage, ModelUserContent>();
  const imageUsageByProjection = new Map<ModelMessage, ProjectedExplicitUserImageUsageV1>();
  const imageUsageByArtifactId = new Map<
    `sha256:${string}`,
    ProjectedExplicitUserImageArtifactUsageV1
  >();
  for (const message of input.messages) {
    if (message.role === "tool") {
      const output = message.result.status === "completed" ? message.result.output : undefined;
      const parsedImage = inputResourceImageV1Schema.safeParse(output);
      if (!parsedImage.success) {
        continue;
      }
      if (
        input.modalityProfile?.imageToolResults !== "supported" ||
        input.artifactStore === undefined
      ) {
        return {
          status: "failed",
          error: {
            code: "input_resource_unsupported",
            message: "The selected target does not support image-bearing tool results.",
          },
        };
      }
      const occurrence = input.inputResources?.find(
        (candidate) => candidate.occurrenceId === parsedImage.data.occurrenceId,
      );
      try {
        const materialized = await materializeInputResourceImageV1({
          artifactStore: input.artifactStore,
          occurrence,
          occurrenceId: parsedImage.data.occurrenceId,
          signal: input.signal,
        });
        if (JSON.stringify(materialized.descriptor) !== JSON.stringify(parsedImage.data)) {
          return {
            status: "failed",
            error: {
              code: "input_resource_invalid",
              message: "The image-bearing tool result does not match canonical resource truth.",
            },
          };
        }
        projections.set(message, [
          {
            type: "file",
            artifactId: materialized.descriptor.artifactId,
            mediaType: materialized.descriptor.mediaType,
            bytes: materialized.bytes,
          },
        ]);
        const usage = {
          count: 1,
          byteCount: materialized.bytes.byteLength,
          pixelCount: materialized.descriptor.width * materialized.descriptor.height,
          maximumWidth: materialized.descriptor.width,
          maximumHeight: materialized.descriptor.height,
        };
        imageUsageByProjection.set(message, usage);
        imageUsageByArtifactId.set(materialized.descriptor.artifactId, {
          byteCount: usage.byteCount,
          pixelCount: usage.pixelCount,
          width: usage.maximumWidth,
          height: usage.maximumHeight,
        });
      } catch {
        return {
          status: "failed",
          error: {
            code: "input_resource_invalid",
            message: "The image-bearing tool result is unavailable or corrupt.",
          },
        };
      }
      continue;
    }
    if (message.role !== "user" || typeof message.content !== "string") {
      continue;
    }
    const parsed = parseInputResourceProjectionV1(message.content);
    if (parsed === undefined) {
      continue;
    }
    const authorizedOccurrences = authorizedInputResourceOccurrencesV1(message);
    if (
      authorizedOccurrences === undefined ||
      JSON.stringify(authorizedOccurrences) !== JSON.stringify(parsed.occurrences)
    ) {
      return {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The input-resource projection does not match its canonical run.",
        },
      };
    }
    const projected = await projectExplicitUserImageContentV1({
      artifactStore: input.artifactStore,
      modalityProfile: input.modalityProfile,
      occurrences: parsed.occurrences,
      signal: input.signal,
      text: parsed.text,
    });
    if (projected.status === "failed") {
      return projected;
    }
    projections.set(message, projected.content);
    if (projected.imageUsage !== undefined) {
      imageUsageByProjection.set(message, projected.imageUsage);
    }
    for (const image of projected.imageArtifacts ?? []) {
      imageUsageByArtifactId.set(image.artifactId, image);
    }
  }
  return { status: "prepared", projections, imageUsageByProjection, imageUsageByArtifactId };
}

export function projectedContentUsageV1(
  messages: readonly ModelMessage[],
  imageUsageByProjection: ReadonlyMap<ModelMessage, ProjectedExplicitUserImageUsageV1>,
): ProjectedContentUsageV1 | undefined {
  const user = emptyProjectedImageUsage();
  const tool = emptyProjectedImageUsage();
  for (const message of messages) {
    const usage = imageUsageByProjection.get(message);
    if (usage === undefined) {
      continue;
    }
    addProjectedImageUsage(message.role === "tool" ? tool : user, usage);
  }
  return user.count === 0 && tool.count === 0
    ? undefined
    : {
        version: 1,
        ...(user.count === 0 ? {} : { explicitUserImages: user }),
        ...(tool.count === 0 ? {} : { imageToolResults: tool }),
      };
}

function emptyProjectedImageUsage(): {
  count: number;
  byteCount: number;
  pixelCount: number;
  maximumWidth: number;
  maximumHeight: number;
} {
  return { count: 0, byteCount: 0, pixelCount: 0, maximumWidth: 0, maximumHeight: 0 };
}

function addProjectedImageUsage(
  target: ReturnType<typeof emptyProjectedImageUsage>,
  usage: ProjectedExplicitUserImageUsageV1,
): void {
  target.count += usage.count;
  target.byteCount += usage.byteCount;
  target.pixelCount += usage.pixelCount;
  target.maximumWidth = Math.max(target.maximumWidth, usage.maximumWidth);
  target.maximumHeight = Math.max(target.maximumHeight, usage.maximumHeight);
}

export function applyPreparedExplicitUserImageMessagesV1(
  messages: readonly ModelMessage[],
  projections: ReadonlyMap<ModelMessage, ModelUserContent>,
): readonly ModelMessage[] {
  if (projections.size === 0) {
    return messages;
  }
  return messages.map((message) => {
    const projected = projections.get(message);
    if (projected === undefined) {
      return message;
    }
    return message.role === "tool"
      ? { ...message, content: typeof projected === "string" ? [] : projected }
      : { role: "user", content: projected };
  });
}
