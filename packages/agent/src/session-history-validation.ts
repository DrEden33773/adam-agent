import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { RunResult, RuntimeEvent } from "./agent-session-contracts.js";
import type { ArtifactReference, ChangePreviewArtifactSource } from "./artifact-store.js";
import { type ContextProfile, isContextProfileSupported } from "./context-profile.js";
import {
  type ContextEvidenceV1,
  createContextProjectionMessage,
  digestContextMessages,
  digestContextRecordPrefix,
  reduceContextEvidence,
} from "./durable-context.js";
import { isMcpToolProfileV1Valid } from "./mcp-host.js";
import { sameModelTargetIdentity } from "./model-targets.js";
import {
  commitMcpToolProfileV3,
  hasSkillPromptContext,
  isPromptContextRecordValid,
  type PromptContextRecordV1,
  type PromptContextRecordV2,
  type PromptContextRecordV3,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import {
  isSkillActivationBatchValid,
  isSkillContextCatalogSuccessor,
  isSkillContextPathSuccessor,
} from "./session-history-folds.js";
import {
  inlineModelResponseField,
  modelMessagesFromCanonicalRecords,
} from "./session-history-replay.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import type {
  SessionContextCompactionCommittedRecord,
  SessionContextCompactionFailedRecord,
  SessionContextCompactionInterruptedRecord,
  SessionContextCompactionStartedRecord,
  SessionGenesisRecord,
  SessionLogicalRunStartedRecord,
  SessionMcpActivationSettledRecord,
  SessionMcpActivationStartedRecord,
  SessionMcpServerClosedRecord,
  SessionMcpServerDefinitionApprovedRecord,
  SessionMcpToolProfileCommittedRecord,
  SessionMcpWorkspaceConfirmedRecord,
  SessionModelResponseCompletedRecord,
  SessionModelResponseField,
  SessionRecord,
} from "./session-store.js";
import { isSkillContextRecordV1Valid } from "./skills.js";
import { canonicalChangePreviewForToolCall } from "./tool-runtime.js";

type ValidatedToolState = {
  readonly call: { readonly id: string; readonly name: string; readonly argumentsJson: string };
  readonly intent: {
    readonly effect?: string | undefined;
  };
  decision?: "allow" | "deny";
  changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource>;
  permissionRequestId?: string;
  requested: boolean;
  repositoryActivationPublished?: boolean;
  repositoryDisposition?: "mutation_retry_required" | "read_continue" | "unavailable";
  repositoryRevision?: number;
  started: boolean;
  terminal: boolean;
  terminalErrorCode?: string;
};

type ValidatedAttemptState = {
  readonly attempt: number;
  readonly turn: number;
  response?: SessionModelResponseCompletedRecord["record"];
  responseSequence?: number;
  status: "started" | "interrupted" | "completed";
};

export function validateCurrentSessionHistory(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  workspaceRoot: string,
): void {
  if (
    genesis.sequence !== 1 ||
    records[0] !== genesis ||
    records.some((record) => record.schemaVersion !== 3) ||
    (genesis.record.promptContext !== undefined &&
      genesis.record.promptContext.recordVersion !== 1) !==
      (genesis.record.skillContext !== undefined) ||
    (genesis.record.skillContext !== undefined &&
      !isSkillContextRecordV1Valid(genesis.record.skillContext)) ||
    (genesis.record.promptContext !== undefined &&
      (!isPromptContextRecordValid(genesis.record.promptContext) ||
        (genesis.record.lineage === undefined &&
          (genesis.record.promptContext.repository.revision !== 1 ||
            JSON.stringify(genesis.record.promptContext.repository.activeScopes) !== '["."]' ||
            genesis.record.promptContext.repository.sources.some(
              (source) => source.scope !== "." || source.loadReason !== "root_eager",
            )))))
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  let run: SessionLogicalRunStartedRecord["record"] | undefined;
  let attemptState: ValidatedAttemptState | undefined;
  let sawUserMessage = false;
  let sawSettlement = false;
  let sawSessionInterruption = false;
  let sawModelStart = false;
  let sawModelCompletion = false;
  let reasoningBlock:
    | { readonly id: string; readonly status: "active" | "completed" | "interrupted" | "failed" }
    | undefined;
  let sawReasoningBlock = false;
  let publishedResponseSequence: number | undefined;
  let terminalIntent: RunResult | undefined;
  let lastContextTerminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"]
    | undefined;
  let lastUsage: Extract<RuntimeEvent, { readonly type: "model_usage" }> | undefined;
  let toolStates = new Map<string, ValidatedToolState>();
  let activePromptContext = genesis.record.promptContext;
  let activeSkillContext = genesis.record.skillContext;
  const skillPermissions = new Map<
    string,
    {
      readonly qualifiedId: string;
      readonly permissionRequestId?: string;
      decision?: "allow" | "deny";
      committed: boolean;
    }
  >();
  const committedSkillResourceReads = new Set<string>();
  const publishedSkillActivations = new Set<number>();
  const publishedSkillRevocations = new Set<number>();
  let skillResourceRunBytes = 0;
  let manualSessionName: string | null = null;
  let automaticTitleEligible = false;
  let automaticTitleSlotClosed = false;
  let activeTitleGeneration:
    | {
        readonly generationId: string;
        readonly reason: "automatic" | "regenerate";
      }
    | undefined;
  const titleGenerationIds = new Set<string>();
  const activatableRepositoryRevisions = new Map<number, ValidatedToolState>();
  const publishedRepositoryRevisions = new Set<number>();
  let mcpWorkspaceConfirmation: SessionMcpWorkspaceConfirmedRecord["record"] | undefined;
  const mcpServerApprovals = new Map<string, SessionMcpServerDefinitionApprovedRecord["record"]>();
  let mcpActivationStarted: SessionMcpActivationStartedRecord["record"] | undefined;
  let mcpActivationSettled: SessionMcpActivationSettledRecord["record"] | undefined;
  let mcpToolProfile: SessionMcpToolProfileCommittedRecord["record"] | undefined;
  const closedMcpServers = new Set<string>();
  const pendingMcpServerClosures = new Map<string, SessionMcpServerClosedRecord["record"]>();
  const staleMcpCatalogs = new Set<string>();
  const inheritedMcpProfile =
    genesis.record.lineage !== undefined &&
    activePromptContext?.recordVersion === 3 &&
    activePromptContext.mcp !== undefined;

  for (const entry of currentRecords.slice(1)) {
    const record = entry.record;
    if (record.type === "session_genesis") {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "mcp_workspace_confirmed") {
      if (run !== undefined || mcpWorkspaceConfirmation !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpWorkspaceConfirmation = record;
      continue;
    }
    if (record.type === "mcp_server_definition_approved") {
      if (
        run !== undefined ||
        (mcpWorkspaceConfirmation === undefined && genesis.record.lineage === undefined) ||
        (mcpWorkspaceConfirmation !== undefined &&
          record.sourceDigest !== mcpWorkspaceConfirmation.sourceDigest) ||
        mcpServerApprovals.has(record.serverId)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpServerApprovals.set(record.serverId, record);
      continue;
    }
    if (record.type === "mcp_activation_started") {
      const expectedReason =
        mcpToolProfile !== undefined || inheritedMcpProfile
          ? "idle_reactivate"
          : mcpActivationStarted === undefined
            ? "initial"
            : "explicit_retry";
      if (
        run !== undefined ||
        (mcpWorkspaceConfirmation === undefined && genesis.record.lineage === undefined) ||
        (mcpActivationStarted !== undefined && mcpActivationSettled === undefined) ||
        record.reason !== expectedReason ||
        record.attempt !== (mcpActivationStarted?.attempt ?? 0) + 1 ||
        record.servers.some(
          (server) =>
            mcpServerApprovals.get(server.serverId)?.definitionDigest !== server.definitionDigest &&
            genesis.record.lineage === undefined,
        ) ||
        (mcpToolProfile !== undefined &&
          JSON.stringify(
            record.servers.map(({ serverId, definitionDigest }) => ({
              serverId,
              definitionDigest,
            })),
          ) !==
            JSON.stringify(
              mcpToolProfile.profile.servers.map(({ serverId, definitionDigest }) => ({
                serverId,
                definitionDigest,
              })),
            ))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpActivationStarted = record;
      mcpActivationSettled = undefined;
      continue;
    }
    if (record.type === "mcp_activation_settled") {
      const pendingClosures = [...pendingMcpServerClosures.values()].filter(
        (closure) => closure.generationId === record.generationId,
      );
      const validTerminalClosures =
        pendingClosures.length === 0 ||
        (record.status === "failed" &&
          record.error?.code === "mcp_shutdown_unconfirmed" &&
          pendingClosures.length <= (mcpActivationStarted?.servers.length ?? 0) &&
          pendingClosures.every(
            (closure) =>
              closure.reason === "failed" ||
              closure.reason === "peer_failure" ||
              closure.reason === "stale",
          )) ||
        (record.status === "failed" &&
          (mcpToolProfile !== undefined || inheritedMcpProfile) &&
          record.error?.serverId === undefined &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "stale")) ||
        (record.status === "failed" &&
          record.error?.serverId === undefined &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "failed")) ||
        (record.status === "failed" &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.some(
            (closure) => closure.serverId === record.error?.serverId && closure.reason === "failed",
          ) &&
          pendingClosures.every((closure) =>
            closure.serverId === record.error?.serverId
              ? closure.reason === "failed"
              : closure.reason === "peer_failure",
          )) ||
        (record.status === "cancelled" &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "session_close"));
      if (
        run !== undefined ||
        mcpActivationStarted === undefined ||
        mcpActivationSettled !== undefined ||
        record.generationId !== mcpActivationStarted.generationId ||
        record.attempt !== mcpActivationStarted.attempt ||
        (record.status === "ready" &&
          (record.catalogDigest === undefined ||
            record.error !== undefined ||
            record.servers.length !== mcpActivationStarted.servers.length)) ||
        (record.status !== "ready" &&
          (record.catalogDigest !== undefined || record.servers.length !== 0)) ||
        !validTerminalClosures
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpActivationSettled = record;
      for (const closure of pendingClosures) {
        pendingMcpServerClosures.delete(`${closure.generationId}:${closure.serverId}`);
      }
      continue;
    }
    if (record.type === "mcp_server_closed") {
      const key = `${record.generationId}:${record.serverId}`;
      const settledServer = mcpActivationSettled?.servers.find(
        (server) => server.serverId === record.serverId,
      );
      const startedServer = mcpActivationStarted?.servers.find(
        (server) => server.serverId === record.serverId,
      );
      const hasCommittedProfile = mcpToolProfile !== undefined || inheritedMcpProfile;
      const validFailedClose =
        !hasCommittedProfile &&
        mcpActivationSettled?.status === "failed" &&
        startedServer?.definitionDigest === record.definitionDigest &&
        ((record.reason === "failed" && mcpActivationSettled.error?.serverId === record.serverId) ||
          (record.reason === "peer_failure" &&
            mcpActivationSettled.error?.serverId !== record.serverId));
      const validPendingFailureClose =
        !hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        (record.reason === "failed" || record.reason === "peer_failure");
      const validPendingCancelledClose =
        !hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        record.reason === "session_close";
      const validPendingProfileClose =
        hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        (record.reason === "failed" ||
          record.reason === "peer_failure" ||
          record.reason === "stale");
      const validReadyClose =
        mcpActivationSettled?.status === "ready" &&
        settledServer?.definitionDigest === record.definitionDigest &&
        (((record.reason === "idle" || record.reason === "stale") && hasCommittedProfile) ||
          record.reason === "session_close");
      if (
        run !== undefined ||
        (!validFailedClose &&
          !validPendingFailureClose &&
          !validPendingCancelledClose &&
          !validPendingProfileClose &&
          !validReadyClose) ||
        record.generationId !==
          (mcpActivationSettled?.generationId ?? mcpActivationStarted?.generationId) ||
        record.attempt !== (mcpActivationSettled?.attempt ?? mcpActivationStarted?.attempt) ||
        closedMcpServers.has(key)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      closedMcpServers.add(key);
      if (validPendingFailureClose || validPendingCancelledClose || validPendingProfileClose) {
        pendingMcpServerClosures.set(key, record);
      }
      continue;
    }
    if (record.type === "mcp_tool_profile_committed") {
      let nextPromptContext: PromptContextRecordV3;
      try {
        if (
          activePromptContext?.recordVersion !== 3 ||
          activePromptContext.mcp !== undefined ||
          record.previousAssemblyIdentityDigest !== activePromptContext.assemblyIdentityDigest
        ) {
          throw new Error("invalid MCP prompt transition");
        }
        nextPromptContext = commitMcpToolProfileV3(activePromptContext, record.profile);
      } catch {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        run !== undefined ||
        mcpActivationSettled?.status !== "ready" ||
        mcpToolProfile !== undefined ||
        record.profile.generationId !== mcpActivationSettled.generationId ||
        record.profile.digest.length !== 71 ||
        !isMcpToolProfileV1Valid(record.profile) ||
        JSON.stringify(record.profile.servers) !== JSON.stringify(mcpActivationSettled.servers) ||
        record.assemblyIdentityDigest !== nextPromptContext.assemblyIdentityDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      activePromptContext = nextPromptContext;
      mcpToolProfile = record;
      continue;
    }
    if (record.type === "mcp_catalog_state_changed") {
      const staleKey = `${record.generationId}:${record.serverId}:${record.catalogDigest}`;
      const validIdentity =
        mcpActivationSettled?.status === "ready" &&
        record.generationId === mcpActivationSettled.generationId &&
        record.catalogDigest === mcpActivationSettled.catalogDigest &&
        mcpActivationSettled.servers.some((server) => server.serverId === record.serverId);
      if (record.status === "stale") {
        const validOccurrence =
          record.runId === undefined ? run === undefined : record.runId === run?.runId;
        if (!validOccurrence || !validIdentity || staleMcpCatalogs.has(staleKey)) {
          throw new SessionLifecycleError("session_invalid");
        }
        staleMcpCatalogs.add(staleKey);
      } else {
        if (
          run !== undefined ||
          mcpToolProfile === undefined ||
          !validIdentity ||
          !staleMcpCatalogs.delete(staleKey)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
      }
      continue;
    }
    if (record.type === "logical_run_started") {
      if (sawSettlement) {
        attemptState = undefined;
        sawUserMessage = false;
        sawSettlement = false;
        sawSessionInterruption = false;
        sawModelStart = false;
        sawModelCompletion = false;
        reasoningBlock = undefined;
        sawReasoningBlock = false;
        publishedResponseSequence = undefined;
        terminalIntent = undefined;
        lastContextTerminal = undefined;
        lastUsage = undefined;
        toolStates = new Map();
        skillPermissions.clear();
        committedSkillResourceReads.clear();
        skillResourceRunBytes = 0;
      }
      if (
        run !== undefined ||
        attemptState !== undefined ||
        sawUserMessage ||
        record.skills?.some(
          (selection, index) => selection.requestId !== `${record.runId}:skill:${index + 1}`,
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      run = record;
      continue;
    }
    if (record.type === "repository_instructions_committed") {
      const expectedLoadReason =
        record.trigger === undefined ? "explicit_reload" : "path_scope_activation";
      if (
        activePromptContext === undefined ||
        record.previousRevision !== activePromptContext.repository.revision ||
        record.previousEffectiveDigest !== activePromptContext.repository.effectiveDigest ||
        record.repository.revision !== activePromptContext.repository.revision + 1 ||
        record.repository.sources.some(
          (source: PromptContextRecordV1["repository"]["sources"][number]) =>
            source.loadReason !== expectedLoadReason,
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptRepositoryV1(activePromptContext, record.repository);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.trigger === undefined) {
        if (run !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        const toolState = toolStates.get(record.trigger.callId);
        if (
          run === undefined ||
          record.trigger.runId !== run.runId ||
          toolState === undefined ||
          toolState.call.name !== record.trigger.name ||
          record.trigger.argumentsDigest !==
            `sha256:${createHash("sha256")
              .update(toolState.call.argumentsJson, "utf8")
              .digest("hex")}` ||
          !toolState.requested ||
          toolState.started ||
          toolState.terminal ||
          toolState.decision !== undefined ||
          toolState.permissionRequestId !== undefined ||
          toolState.repositoryDisposition !== undefined ||
          (record.trigger.name === "read_file") !== (record.trigger.disposition === "read_continue")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        toolState.repositoryDisposition = record.trigger.disposition;
        toolState.repositoryRevision = record.repository.revision;
        activatableRepositoryRevisions.set(record.repository.revision, toolState);
      }
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "repository_instructions_failed") {
      if (
        activePromptContext === undefined ||
        record.activeRevision !== activePromptContext.repository.revision ||
        record.activeEffectiveDigest !== activePromptContext.repository.effectiveDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.trigger === undefined) {
        if (run !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        const toolState = toolStates.get(record.trigger.callId);
        if (
          run === undefined ||
          record.trigger.runId !== run.runId ||
          toolState === undefined ||
          toolState.call.name !== record.trigger.name ||
          record.trigger.argumentsDigest !==
            `sha256:${createHash("sha256")
              .update(toolState.call.argumentsJson, "utf8")
              .digest("hex")}` ||
          !toolState.requested ||
          toolState.started ||
          toolState.terminal ||
          toolState.decision !== undefined ||
          toolState.permissionRequestId !== undefined ||
          toolState.repositoryDisposition !== undefined
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        toolState.repositoryDisposition = "unavailable";
      }
      continue;
    }
    if (record.type === "path_context_committed") {
      const toolState = toolStates.get(record.trigger.callId);
      if (
        run === undefined ||
        record.trigger.runId !== run.runId ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.previousRepositoryRevision !== activePromptContext.repository.revision ||
        record.previousRepositoryDigest !== activePromptContext.repository.effectiveDigest ||
        record.repository.revision !== activePromptContext.repository.revision + 1 ||
        record.previousSkillRevision !== activeSkillContext.registry.revision ||
        record.previousSkillRegistryDigest !== activeSkillContext.registry.digest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillContextPathSuccessor(activeSkillContext, record.skillContext) ||
        toolState === undefined ||
        toolState.call.name !== record.trigger.name ||
        record.trigger.argumentsDigest !==
          `sha256:${createHash("sha256").update(toolState.call.argumentsJson, "utf8").digest("hex")}` ||
        !toolState.requested ||
        toolState.started ||
        toolState.terminal ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      let nextPromptContext = replacePromptRepositoryV1(activePromptContext, record.repository) as
        | PromptContextRecordV2
        | PromptContextRecordV3;
      nextPromptContext = replacePromptSkillsV2(nextPromptContext, record.skillContext);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryDisposition = record.trigger.disposition;
      toolState.repositoryRevision = record.repository.revision;
      activatableRepositoryRevisions.set(record.repository.revision, toolState);
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "path_context_failed") {
      const toolState = toolStates.get(record.trigger.callId);
      if (
        run === undefined ||
        record.trigger.runId !== run.runId ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.activeRepositoryRevision !== activePromptContext.repository.revision ||
        record.activeRepositoryDigest !== activePromptContext.repository.effectiveDigest ||
        record.activeSkillRevision !== activeSkillContext.registry.revision ||
        record.activeSkillRegistryDigest !== activeSkillContext.registry.digest ||
        toolState === undefined ||
        toolState.call.name !== record.trigger.name ||
        record.trigger.argumentsDigest !==
          `sha256:${createHash("sha256").update(toolState.call.argumentsJson, "utf8").digest("hex")}` ||
        !toolState.requested ||
        toolState.started ||
        toolState.terminal ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined ||
        toolState.repositoryDisposition !== undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryDisposition = "unavailable";
      continue;
    }
    if (record.type === "skill_catalog_committed") {
      if (
        (record.reason === undefined
          ? run !== undefined
          : record.reason !== "extension_reconciliation" || attemptState?.status === "started") ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.previousRevision !== activeSkillContext.registry.revision ||
        record.previousRegistryDigest !== activeSkillContext.registry.digest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillContextCatalogSuccessor(activeSkillContext, record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptSkillsV2(activePromptContext, record.skillContext);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "skill_catalog_failed") {
      if (
        run !== undefined ||
        activeSkillContext === undefined ||
        record.activeRevision !== activeSkillContext.registry.revision ||
        record.activeRegistryDigest !== activeSkillContext.registry.digest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      continue;
    }
    if (record.type === "skill_revoked") {
      const revocation = activeSkillContext?.revocations.find(
        (entry) => entry.activationIndex === record.activationIndex,
      );
      if (
        run !== undefined ||
        activeSkillContext === undefined ||
        record.catalogRevision !== activeSkillContext.catalog.revision ||
        revocation === undefined ||
        revocation.qualifiedId !== record.qualifiedId ||
        revocation.reason !== record.reason ||
        JSON.stringify(revocation.sourceEpoch) !== JSON.stringify(record.sourceEpoch) ||
        publishedSkillRevocations.has(record.activationIndex)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedSkillRevocations.add(record.activationIndex);
      continue;
    }
    if (record.type === "skill_activation_batch_committed") {
      const previousSkillContext = activeSkillContext;
      if (
        run === undefined ||
        record.runId !== run.runId ||
        !sawUserMessage ||
        (attemptState !== undefined &&
          (attemptState.status !== "completed" ||
            attemptState.response?.response.finishReason !== "tool_calls")) ||
        !hasSkillPromptContext(activePromptContext) ||
        previousSkillContext === undefined ||
        record.previousActivationDigest !== previousSkillContext.activationDigest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillActivationBatchValid(previousSkillContext, record.skillContext, record, run)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptSkillsV2(activePromptContext, record.skillContext);
      const newActivations = record.skillContext.active.slice(previousSkillContext.active.length);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext) ||
        newActivations.some((activation) => {
          const permission = skillPermissions.get(activation.requestId);
          const modelTool = toolStates.get(activation.requestId);
          let modelQualifiedId: string | undefined;
          try {
            const parsed =
              modelTool?.call.name === "activate_skill"
                ? (JSON.parse(modelTool.call.argumentsJson) as { qualifiedId?: unknown })
                : undefined;
            modelQualifiedId =
              typeof parsed?.qualifiedId === "string" ? parsed.qualifiedId : undefined;
          } catch {
            modelQualifiedId = undefined;
          }
          const validExplicitPermission =
            permission !== undefined &&
            permission.qualifiedId === activation.qualifiedId &&
            permission.decision === "allow" &&
            !permission.committed;
          const validModelTool =
            modelTool !== undefined &&
            modelQualifiedId === activation.qualifiedId &&
            modelTool.requested &&
            modelTool.started &&
            !modelTool.terminal &&
            modelTool.decision === "allow";
          return !validExplicitPermission && !validModelTool;
        })
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      for (const activation of newActivations) {
        for (const permission of skillPermissions.values()) {
          if (permission.qualifiedId === activation.qualifiedId) {
            permission.committed = true;
          }
        }
      }
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "skill_activated") {
      const activation = activeSkillContext?.active.find(
        (entry) => entry.activationIndex === record.activationIndex,
      );
      if (
        run === undefined ||
        record.runId !== run.runId ||
        activation === undefined ||
        activation.qualifiedId !== record.qualifiedId ||
        activation.catalogRevision !== record.catalogRevision ||
        activation.reason !== record.reason ||
        activation.skillMdDigest !== record.skillMdDigest ||
        activation.manifest.digest !== record.manifestDigest ||
        publishedSkillActivations.has(record.activationIndex)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedSkillActivations.add(record.activationIndex);
      continue;
    }
    if (record.type === "skill_resource_read_committed") {
      const toolState = toolStates.get(record.callId);
      const activation = activeSkillContext?.active.find(
        (entry) => entry.qualifiedId === record.qualifiedId,
      );
      let argumentsValue:
        | { qualifiedId?: unknown; path?: unknown; offset?: unknown; maxByteCount?: unknown }
        | undefined;
      try {
        argumentsValue = JSON.parse(toolState?.call.argumentsJson ?? "") as typeof argumentsValue;
      } catch {
        argumentsValue = undefined;
      }
      const requestedOffset =
        typeof argumentsValue?.offset === "number" ? argumentsValue.offset : 0;
      const requestedMaximum =
        typeof argumentsValue?.maxByteCount === "number" ? argumentsValue.maxByteCount : 65_536;
      if (
        run === undefined ||
        record.runId !== run.runId ||
        attemptState?.status !== "completed" ||
        attemptState.response?.response.finishReason !== "tool_calls" ||
        toolState?.call.name !== "read_skill_resource" ||
        !toolState.requested ||
        !toolState.started ||
        toolState.terminal ||
        toolState.decision !== "allow" ||
        committedSkillResourceReads.has(record.callId) ||
        argumentsValue?.qualifiedId !== record.qualifiedId ||
        argumentsValue.path !== record.path ||
        requestedOffset !== record.offset ||
        record.byteCount > requestedMaximum ||
        activation === undefined ||
        activation.activationIndex !== record.activationIndex ||
        activation.catalogRevision !== record.catalogRevision ||
        activation.manifest.revision !== record.manifestRevision ||
        !activation.manifest.entries.some((entry) => entry.path === record.path) ||
        record.offset + record.byteCount > record.totalByteCount ||
        record.eof !== (record.offset + record.byteCount === record.totalByteCount) ||
        Buffer.byteLength(record.content, "utf8") !== record.byteCount ||
        `sha256:${createHash("sha256").update(record.content, "utf8").digest("hex")}` !==
          record.pageDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      skillResourceRunBytes += record.byteCount;
      if (!Number.isSafeInteger(skillResourceRunBytes) || skillResourceRunBytes > 1024 * 1024) {
        throw new SessionLifecycleError("session_invalid");
      }
      committedSkillResourceReads.add(record.callId);
      continue;
    }
    if (record.type === "session_manual_name_set") {
      if (run !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      manualSessionName = record.name;
      continue;
    }
    if (record.type === "session_manual_name_cleared") {
      if (run !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      manualSessionName = null;
      continue;
    }
    if (record.type === "session_title_generation_started") {
      if (
        run !== undefined ||
        activeTitleGeneration !== undefined ||
        titleGenerationIds.has(record.generationId) ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        (record.reason === "automatic" &&
          (!automaticTitleEligible || automaticTitleSlotClosed || manualSessionName !== null))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      titleGenerationIds.add(record.generationId);
      activeTitleGeneration = {
        generationId: record.generationId,
        reason: record.reason,
      };
      if (record.reason === "automatic") {
        automaticTitleSlotClosed = true;
      }
      continue;
    }
    if (
      record.type === "session_title_generation_completed" ||
      record.type === "session_title_generation_failed"
    ) {
      if (run !== undefined || activeTitleGeneration?.generationId !== record.generationId) {
        throw new SessionLifecycleError("session_invalid");
      }
      activeTitleGeneration = undefined;
      continue;
    }
    if (record.type === "session_title_generation_skipped_manual") {
      if (
        run !== undefined ||
        activeTitleGeneration !== undefined ||
        !automaticTitleEligible ||
        automaticTitleSlotClosed ||
        manualSessionName === null
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      automaticTitleSlotClosed = true;
      continue;
    }
    if (run === undefined || record.runId !== run.runId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "provider_attempt_started") {
      if (
        terminalIntent !== undefined ||
        !sawUserMessage ||
        [...skillPermissions.values()].some(
          (permission) => permission.decision === "allow" && !permission.committed,
        ) ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        (activePromptContext === undefined
          ? record.promptProjection !== undefined
          : record.promptProjection === undefined ||
            record.promptProjection.assemblyIdentityDigest !==
              activePromptContext.assemblyIdentityDigest)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (attemptState === undefined) {
        if (record.turn !== 1 || record.attempt !== 1) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else if (attemptState.status === "interrupted") {
        if (record.turn !== attemptState.turn || record.attempt !== attemptState.attempt + 1) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else if (attemptState.status === "completed") {
        if (
          attemptState.response?.response.finishReason !== "tool_calls" ||
          [...toolStates.values()].some((state) => !state.terminal) ||
          record.turn !== attemptState.turn + 1 ||
          record.attempt !== 1
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState = {
        turn: record.turn,
        attempt: record.attempt,
        status: "started",
      };
      sawModelStart = false;
      sawModelCompletion = false;
      reasoningBlock = undefined;
      sawReasoningBlock = false;
      lastUsage = undefined;
      toolStates = new Map();
      continue;
    }
    if (record.type === "provider_attempt_interrupted") {
      if (
        !isMatchingStartedAttempt(attemptState, record) ||
        reasoningBlock?.status === "active" ||
        ((record.reason === "process_restart" || record.reason === "context_overflow") &&
          record.result !== undefined) ||
        (record.reason === "run_terminal" && record.result === undefined)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState.status = "interrupted";
      if (record.reason === "run_terminal") {
        terminalIntent = record.result;
      }
      continue;
    }
    if (record.type === "model_response_completed") {
      if (
        terminalIntent !== undefined ||
        !isMatchingStartedAttempt(attemptState, record) ||
        !sawModelStart ||
        reasoningBlock?.status === "active" ||
        (sawReasoningBlock && reasoningBlock?.status !== "completed") ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      validateCompletedResponse(record);
      if (!sameResponseUsage(record.response.usage, lastUsage)) {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState.status = "completed";
      attemptState.response = record;
      attemptState.responseSequence = entry.sequence;
      toolStates = new Map(
        record.response.toolCalls.map((call, index) => [
          call.id,
          {
            call,
            intent: record.response.toolIntents[index] as ValidatedToolState["intent"],
            requested: false,
            started: false,
            terminal: false,
          },
        ]),
      );
      continue;
    }
    if (
      record.type === "context_compaction_started" ||
      record.type === "context_compaction_committed" ||
      record.type === "context_compaction_failed" ||
      record.type === "context_compaction_interrupted"
    ) {
      if (
        record.type === "context_compaction_started" &&
        (!sawUserMessage ||
          terminalIntent !== undefined ||
          attemptState?.status === "started" ||
          (attemptState?.status === "completed" &&
            (attemptState.response?.response.finishReason !== "tool_calls" ||
              [...toolStates.values()].some((state) => !state.terminal))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.type !== "context_compaction_started") {
        lastContextTerminal = record;
      }
      continue;
    }
    if (record.type === "model_response_published") {
      if (
        attemptState?.status !== "completed" ||
        attemptState.responseSequence !== record.responseSequence ||
        sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedResponseSequence = record.responseSequence;
      sawModelCompletion = true;
      continue;
    }
    if (record.type === "run_settled") {
      const finishReason = attemptState?.response?.response.finishReason;
      const settlementMatchesResponse =
        (record.status === "completed" && finishReason === "stop") ||
        (record.status === "incomplete" &&
          record.reason === "output_limit" &&
          finishReason === "length");
      if (
        attemptState?.status !== "completed" ||
        attemptState.responseSequence !== record.responseSequence ||
        publishedResponseSequence !== record.responseSequence ||
        !settlementMatchesResponse ||
        !sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const settledResponse = attemptState.response;
      if (
        record.status === "completed" &&
        settledResponse !== undefined &&
        hasNonEmptyModelResponseText(settledResponse.response.text)
      ) {
        automaticTitleEligible = true;
      }
      sawSettlement = true;
      run = undefined;
      continue;
    }
    const event = record.event;
    if (event.type === "user_message") {
      if (
        terminalIntent !== undefined ||
        sawUserMessage ||
        attemptState !== undefined ||
        event.text !== run.userMessage
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawUserMessage = true;
      continue;
    }
    if (event.type === "model_message_started") {
      if (terminalIntent !== undefined || attemptState?.status !== "started" || sawModelStart) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawModelStart = true;
      continue;
    }
    if (event.type === "model_reasoning_started") {
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "started" ||
        !sawModelStart ||
        sawReasoningBlock ||
        event.id !== `${attemptState.turn}:${attemptState.attempt}:provider-reasoning-0`
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawReasoningBlock = true;
      reasoningBlock = { id: event.id, status: "active" };
      continue;
    }
    if (event.type === "model_reasoning_settled") {
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "started" ||
        reasoningBlock?.status !== "active" ||
        reasoningBlock.id !== event.id
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      reasoningBlock = { id: event.id, status: event.status };
      continue;
    }
    if (event.type === "model_usage") {
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "started" ||
        !sawModelStart ||
        event.totalTokens !== event.inputTokens + event.outputTokens
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      lastUsage = event;
      continue;
    }
    if (event.type === "model_message_completed") {
      const responseText = attemptState?.response?.response.text;
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "completed" ||
        responseText === undefined ||
        inlineModelResponseField(responseText) !== event.text ||
        sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawModelCompletion = true;
      continue;
    }
    if (event.type === "session_interrupted") {
      if (
        !sawUserMessage ||
        sawSessionInterruption ||
        (terminalIntent !== undefined && terminalIntent.status !== "cancelled")
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawSessionInterruption = true;
      continue;
    }
    if (
      (event.type === "tool_permission_requested" || event.type === "tool_permission_decided") &&
      event.name === "activate_skill" &&
      attemptState === undefined
    ) {
      const subject = event.subject;
      const candidate =
        subject?.type === "skill" && subject.operation === "activate"
          ? activeSkillContext?.registry.candidates.find(
              (entry) => entry.qualifiedId === subject.qualifiedId,
            )
          : undefined;
      if (
        run === undefined ||
        !sawUserMessage ||
        attemptState !== undefined ||
        event.effect !== "read" ||
        event.scope !== "call" ||
        candidate === undefined ||
        !run.skills?.some(
          (selection) =>
            selection.requestId === event.callId &&
            (selection.selection === candidate.qualifiedId ||
              selection.selection === candidate.name),
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const existing = skillPermissions.get(event.callId);
      if (event.type === "tool_permission_requested") {
        if (existing !== undefined || event.requestId !== event.callId) {
          throw new SessionLifecycleError("session_invalid");
        }
        skillPermissions.set(event.callId, {
          qualifiedId: candidate.qualifiedId,
          permissionRequestId: event.requestId,
          committed: false,
        });
      } else {
        if (event.decision !== "allow" && event.decision !== "deny") {
          throw new SessionLifecycleError("session_invalid");
        }
        if (existing === undefined) {
          if (event.requestId !== undefined) {
            throw new SessionLifecycleError("session_invalid");
          }
          skillPermissions.set(event.callId, {
            qualifiedId: candidate.qualifiedId,
            decision: event.decision,
            committed: false,
          });
        } else {
          if (
            existing.decision !== undefined ||
            existing.qualifiedId !== candidate.qualifiedId ||
            event.requestId !== existing.permissionRequestId
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          existing.decision = event.decision;
        }
      }
      continue;
    }
    if (event.type === "repository_instructions_activated") {
      const toolState = activatableRepositoryRevisions.get(event.revision);
      if (
        activePromptContext === undefined ||
        event.revision !== activePromptContext.repository.revision ||
        event.effectiveDigest !== activePromptContext.repository.effectiveDigest ||
        toolState === undefined ||
        toolState.repositoryDisposition === "unavailable" ||
        toolState.repositoryRevision !== event.revision ||
        toolState.repositoryActivationPublished === true ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined ||
        toolState.started ||
        toolState.terminal ||
        publishedRepositoryRevisions.has(event.revision)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryActivationPublished = true;
      publishedRepositoryRevisions.add(event.revision);
      continue;
    }
    if (event.type === "session_settled") {
      if (
        !sawUserMessage ||
        attemptState?.status === "started" ||
        (terminalIntent !== undefined &&
          JSON.stringify(terminalIntent) !== JSON.stringify(event.result)) ||
        (event.result.status === "completed" &&
          (attemptState?.status !== "completed" ||
            attemptState.response?.response.finishReason !== "stop" ||
            inlineModelResponseField(attemptState.response.response.text) !== event.result.answer ||
            !sawModelCompletion)) ||
        (event.result.status === "incomplete" &&
          (attemptState?.status !== "completed" ||
            attemptState.response?.response.finishReason !== "length" ||
            inlineModelResponseField(attemptState.response.response.text) !== event.result.answer ||
            !sawModelCompletion)) ||
        (event.result.status === "cancelled" && !sawSessionInterruption) ||
        (event.result.status === "failed" &&
          ((attemptState === undefined &&
            event.result.error.code !== "skill_activation_failed" &&
            !isContextTerminalFailure(event.result, lastContextTerminal)) ||
            event.result.error.code === "invalid_run_limits" ||
            event.result.error.code === "run_already_active" ||
            event.result.error.code === "session_persistence_failed" ||
            (event.result.error.code === "tool_effect_indeterminate" &&
              ![...toolStates.values()].some(
                (state) => state.terminalErrorCode === "tool_effect_indeterminate",
              ))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (event.result.status === "completed" && event.result.answer.length > 0) {
        automaticTitleEligible = true;
      }
      sawSettlement = true;
      run = undefined;
      continue;
    }
    if (
      event.type === "tool_requested" ||
      event.type === "tool_permission_requested" ||
      event.type === "tool_permission_decided" ||
      event.type === "tool_started" ||
      event.type === "tool_completed" ||
      event.type === "tool_failed"
    ) {
      if (terminalIntent !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      const state = toolStates.get(event.callId);
      if (
        attemptState?.status !== "completed" ||
        attemptState.response?.response.finishReason !== "tool_calls" ||
        state === undefined ||
        state.call.name !== event.name ||
        state.terminal
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        state.repositoryDisposition !== undefined &&
        (event.type === "tool_requested" ||
          (state.repositoryDisposition === "unavailable"
            ? event.type !== "tool_failed" ||
              (event.error.code !== "repository_instructions_unavailable" &&
                event.error.code !== "project_context_unavailable")
            : state.repositoryActivationPublished !== true ||
              (state.repositoryDisposition === "mutation_retry_required" &&
                (event.type !== "tool_failed" ||
                  (event.error.code !== "repository_context_changed" &&
                    event.error.code !== "project_context_changed")))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        (event.type === "tool_permission_requested" || event.type === "tool_permission_decided") &&
        !isCanonicalChangePreviewReference({
          event,
          genesis,
          runId: run.runId,
          state,
          workspaceRoot,
        })
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        state.call.name === "read_skill_resource" &&
        event.type === "tool_completed" &&
        !committedSkillResourceReads.has(event.callId)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (event.type === "tool_requested") {
        if (state.requested) {
          throw new SessionLifecycleError("session_invalid");
        }
        state.requested = true;
      } else if (event.type === "tool_permission_requested") {
        if (
          !state.requested ||
          state.started ||
          state.decision !== undefined ||
          (state.permissionRequestId !== undefined && state.permissionRequestId !== event.requestId)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        validatePermissionEffect(state, event.effect);
        state.permissionRequestId ??= event.requestId;
      } else if (event.type === "tool_permission_decided") {
        if (
          !state.requested ||
          state.started ||
          state.decision !== undefined ||
          (state.permissionRequestId === undefined
            ? event.requestId !== undefined
            : event.requestId !== state.permissionRequestId)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        validatePermissionEffect(state, event.effect);
        state.decision = event.decision;
      } else if (event.type === "tool_started") {
        if (!state.requested || state.started || state.decision !== "allow") {
          throw new SessionLifecycleError("session_invalid");
        }
        state.started = true;
      } else {
        if (
          !state.requested ||
          (event.type === "tool_completed" && !state.started) ||
          (event.type === "tool_failed" &&
            event.error.code === "permission_denied" &&
            state.decision !== "deny")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        state.terminal = true;
        if (event.type === "tool_failed") {
          state.terminalErrorCode = event.error.code;
        }
      }
      continue;
    }
    throw new SessionLifecycleError("session_invalid");
  }
  validateContextCompactionHistory(genesis, currentRecords);
}

function isContextTerminalFailure(
  result: Extract<RunResult, { readonly status: "failed" }>,
  terminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"]
    | undefined,
): boolean {
  if (terminal?.type === "context_compaction_committed") {
    return (
      result.error.code === "token_limit_exceeded" || result.error.code === "token_usage_missing"
    );
  }
  if (terminal?.type !== "context_compaction_failed") {
    return false;
  }
  const expectedCode =
    terminal.reason === "model_request_failed"
      ? "context_compaction_failed"
      : terminal.reason === "summary_invalid"
        ? "context_compaction_invalid"
        : terminal.reason === "input_unrecoverable"
          ? "context_compaction_input_unrecoverable"
          : terminal.reason === "context_window_unrecoverable"
            ? "context_window_unrecoverable"
            : undefined;
  return result.error.code === expectedCode;
}

function validateContextCompactionHistory(
  genesis: SessionGenesisRecord,
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): void {
  const starts = new Map<
    string,
    {
      readonly entry: SessionContextCompactionStartedRecord;
      terminal: boolean;
    }
  >();
  const boundaryAttempts = new Map<string, number>();
  const boundaryRetryAllowed = new Map<string, boolean>();
  const committedBoundaries = new Set<string>();
  const checkpointIds = new Set<string>();
  let latestCheckpointSequence: number | undefined;
  let latestWindowNumber = 0;
  for (const entry of records) {
    const record = entry.record;
    const openStart = [...starts.values()].find((start) => !start.terminal);
    if (
      openStart !== undefined &&
      !(
        (record.type === "context_compaction_committed" ||
          record.type === "context_compaction_failed" ||
          record.type === "context_compaction_interrupted") &&
        record.attemptId === openStart.entry.record.attemptId
      )
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "context_compaction_started") {
      if (
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        record.sourceThrough >= entry.sequence ||
        !isContextProfileValid(record.contextProfile) ||
        record.previousCheckpointSequence !== latestCheckpointSequence ||
        record.windowNumber !== latestWindowNumber + 1 ||
        digestContextRecordPrefix(
          records.filter((candidate) => candidate.sequence <= record.sourceThrough),
        ) !== record.sourceDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${record.sourceDigest}`;
      const expectedAttempt = (boundaryAttempts.get(boundary) ?? 0) + 1;
      if (
        record.attemptNumber !== expectedAttempt ||
        record.attemptNumber > 2 ||
        (record.attemptNumber === 1 && record.sourceThrough !== entry.sequence - 1) ||
        (expectedAttempt > 1 && boundaryRetryAllowed.get(boundary) !== true) ||
        starts.has(record.attemptId) ||
        committedBoundaries.has(boundary)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      boundaryAttempts.set(boundary, expectedAttempt);
      boundaryRetryAllowed.set(boundary, false);
      starts.set(record.attemptId, {
        entry: entry as SessionContextCompactionStartedRecord,
        terminal: false,
      });
      continue;
    }
    if (
      record.type !== "context_compaction_committed" &&
      record.type !== "context_compaction_failed" &&
      record.type !== "context_compaction_interrupted"
    ) {
      continue;
    }
    const started = starts.get(record.attemptId);
    if (
      started === undefined ||
      started.terminal ||
      !sameContextAttempt(started.entry.record, record)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    started.terminal = true;
    if (record.type !== "context_compaction_committed") {
      const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${started.entry.record.sourceDigest}`;
      boundaryRetryAllowed.set(
        boundary,
        (record.type === "context_compaction_failed" &&
          record.reason === "replacement_too_large") ||
          (record.type === "context_compaction_interrupted" && record.reason === "process_restart"),
      );
      continue;
    }
    const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${started.entry.record.sourceDigest}`;
    if (
      committedBoundaries.has(boundary) ||
      checkpointIds.has(record.checkpointId) ||
      record.retainedFrom < 1 ||
      record.retainedFrom > record.sourceThrough + 1 ||
      record.previousCheckpointSequence !== latestCheckpointSequence ||
      record.sourceDigest !== started.entry.record.sourceDigest ||
      !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
      JSON.stringify(record.contextProfile) !== JSON.stringify(started.entry.record.contextProfile)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const retainedRecords = records.filter(
      (candidate) =>
        candidate.sequence >= record.retainedFrom && candidate.sequence <= record.sourceThrough,
    );
    const replacement = [
      createContextProjectionMessage(record.summary, record.evidence),
      ...modelMessagesFromCanonicalRecords(retainedRecords),
    ];
    if (
      !isContextEvidenceValid(record.evidence, records, record.runId, record.sourceThrough) ||
      digestContextMessages(replacement) !== record.replacementDigest
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    committedBoundaries.add(boundary);
    checkpointIds.add(record.checkpointId);
    latestCheckpointSequence = entry.sequence;
    latestWindowNumber = record.windowNumber;
  }
  const dangling = [...starts.values()].filter((start) => !start.terminal);
  if (
    dangling.length > 1 ||
    (dangling.length === 1 && dangling[0]?.entry.sequence !== records.at(-1)?.sequence)
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
}

function isContextEvidenceValid(
  evidence: SessionContextCompactionCommittedRecord["record"]["evidence"],
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
  runId: string,
  sourceThrough: number,
): boolean {
  const localEvidence: ContextEvidenceV1 = {
    schemaVersion: 1,
    modifiedFiles: evidence.modifiedFiles.filter((entry) => entry.sessionId === undefined),
    permissions: evidence.permissions.filter((entry) => entry.sessionId === undefined),
    toolResults: evidence.toolResults.filter((entry) => entry.sessionId === undefined),
    failures: evidence.failures.filter((entry) => entry.sessionId === undefined),
  };
  return (
    JSON.stringify(localEvidence) ===
    JSON.stringify(reduceContextEvidence(records, runId, sourceThrough))
  );
}

function sameContextAttempt(
  started: SessionContextCompactionStartedRecord["record"],
  terminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"],
): boolean {
  return (
    terminal.runId === started.runId &&
    terminal.attemptId === started.attemptId &&
    terminal.attemptNumber === started.attemptNumber &&
    terminal.windowNumber === started.windowNumber &&
    terminal.trigger === started.trigger &&
    terminal.sourceThrough === started.sourceThrough
  );
}

function isContextProfileValid(profile: ContextProfile): boolean {
  return isContextProfileSupported(profile);
}

export function hasSuccessfullySettledAssistant(records: readonly SessionRecord[]): boolean {
  const completedResponseSequences = new Set(
    records.flatMap((entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "run_settled" &&
      entry.record.status === "completed"
        ? [entry.record.responseSequence]
        : [],
    ),
  );
  return records.some((entry) => {
    if (entry.schemaVersion !== 3) {
      return false;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_settled" &&
      entry.record.event.result.status === "completed"
    ) {
      return entry.record.event.result.answer.length > 0;
    }
    if (
      entry.record.type !== "model_response_completed" ||
      !completedResponseSequences.has(entry.sequence)
    ) {
      return false;
    }
    return hasNonEmptyModelResponseText(entry.record.response.text);
  });
}

function hasNonEmptyModelResponseText(field: string | SessionModelResponseField): boolean {
  return typeof field === "string"
    ? field.length > 0
    : field.storage === "inline"
      ? field.text.length > 0
      : field.reference.byteCount > 0;
}

function isMatchingStartedAttempt(
  attempt: ValidatedAttemptState | undefined,
  record: { readonly attempt: number; readonly turn: number },
): attempt is ValidatedAttemptState {
  return (
    attempt?.status === "started" &&
    attempt.turn === record.turn &&
    attempt.attempt === record.attempt
  );
}

function validateCompletedResponse(record: SessionModelResponseCompletedRecord["record"]): void {
  const { response } = record;
  if (
    response.toolCalls.length !== response.toolIntents.length ||
    ((response.finishReason === "stop" || response.finishReason === "length") &&
      response.toolCalls.length !== 0) ||
    (response.finishReason === "tool_calls" && response.toolCalls.length === 0)
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const callIds = new Set<string>();
  for (const [index, call] of response.toolCalls.entries()) {
    const intent = response.toolIntents[index];
    if (
      intent === undefined ||
      callIds.has(call.id) ||
      intent.callId !== call.id ||
      intent.name !== call.name ||
      intent.argumentsDigest !==
        `sha256:${createHash("sha256").update(call.argumentsJson).digest("hex")}` ||
      (intent.replay === "safe" &&
        (intent.effect === undefined || intent.definitionDigest === undefined))
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    callIds.add(call.id);
  }
}

function validatePermissionEffect(state: ValidatedToolState, effect: string | undefined): void {
  if (state.intent.effect === undefined || state.intent.effect !== effect) {
    throw new SessionLifecycleError("session_invalid");
  }
}

function isCanonicalChangePreviewReference(input: {
  readonly event: Extract<
    RuntimeEvent,
    { readonly type: "tool_permission_requested" | "tool_permission_decided" }
  >;
  readonly genesis: SessionGenesisRecord;
  readonly runId: string;
  readonly state: ValidatedToolState;
  readonly workspaceRoot: string;
}): boolean {
  const reference = input.event.changePreviewRef;
  if (reference === undefined) {
    return input.state.changePreviewRef === undefined;
  }
  const argumentsDigest = `sha256:${createHash("sha256")
    .update(input.state.call.argumentsJson, "utf8")
    .digest("hex")}`;
  if (
    (input.state.call.name !== "write_file" && input.state.call.name !== "edit_file") ||
    reference.source.projectId !== input.genesis.record.projectId ||
    reference.source.sessionId !== input.genesis.record.sessionId ||
    reference.source.runId !== input.runId ||
    reference.source.callId !== input.state.call.id ||
    reference.source.toolName !== input.state.call.name ||
    reference.source.argumentsDigest !== argumentsDigest ||
    (input.state.changePreviewRef !== undefined &&
      !isDeepStrictEqual(input.state.changePreviewRef, reference))
  ) {
    return false;
  }
  const expectedPreview = canonicalChangePreviewForToolCall({
    workspaceRoot: input.workspaceRoot,
    call: input.state.call,
  });
  if (expectedPreview === undefined) {
    return false;
  }
  const expectedBytes = Buffer.from(expectedPreview, "utf8");
  if (
    reference.id !== `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}` ||
    reference.byteCount !== expectedBytes.byteLength
  ) {
    return false;
  }
  input.state.changePreviewRef = reference;
  return true;
}

function sameResponseUsage(
  response:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens?: number;
        readonly cachedInputTokens?: number;
        readonly cacheMissInputTokens?: number;
      }
    | undefined,
  event: Extract<RuntimeEvent, { readonly type: "model_usage" }> | undefined,
): boolean {
  return (
    response?.inputTokens === event?.inputTokens &&
    response?.outputTokens === event?.outputTokens &&
    response?.reasoningTokens === event?.reasoningTokens &&
    response?.cachedInputTokens === event?.cachedInputTokens &&
    response?.cacheMissInputTokens === event?.cacheMissInputTokens
  );
}
