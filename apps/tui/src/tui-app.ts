import type {
  ActiveSessionDisplay,
  ArtifactReference,
  BranchSourceBoundary,
  OperationDisplay,
  PresentationSession,
  PresentationTransientState,
  ReasoningBlockDisplay,
  RepositoryInstructionsDisplay,
  TargetDisplay,
  ThinkingCapabilityDisplay,
  ThinkingPolicySelectionDisplay,
} from "@adam-agent/presentation";
import {
  Box,
  type Component,
  Container,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Loader,
  Markdown,
  type OverlayOptions,
  ProcessTerminal,
  Spacer,
  type Terminal,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import {
  ArtifactNavigator,
  activeChronologyArtifacts,
  activeChronologyDiffs,
} from "./artifact-navigator.js";
import { ChronologyPicker, completeChronologyBoundaries } from "./chronology-picker.js";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import {
  type AdamCommandParseResult,
  type AdamCommandRegistry,
  adamCommandRegistry,
} from "./command-registry.js";
import { type ConfigurationField, ConfigurationPage } from "./configuration-page.js";
import {
  type ClipboardAdapter,
  copyDraftToClipboard,
  copySelectionToClipboard,
  copyTextToClipboard,
  type DeadlineScheduler,
  ExitArm,
  LegacyDuplicateGuard,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { HelpNavigator, type HelpPage } from "./help-navigator.js";
import {
  isLargeReasoning,
  type LargeReasoningView,
  LargeReasoningViewStore,
  largeReasoningBoundaryAnchorId,
} from "./large-reasoning-view.js";
import { mcpAdvanceCommand } from "./mcp-advance.js";
import { McpWizard } from "./mcp-wizard.js";
import { OverlayFrame } from "./overlay-frame.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { ProjectPathPicker } from "./project-path-picker.js";
import { reasoningFoldTitle } from "./reasoning-fold.js";
import { ResourceReloadPicker } from "./resource-reload-picker.js";
import {
  ResponsiveLine,
  ResponsiveRoot,
  ResponsiveText,
  terminalSizeIsSupported,
} from "./responsive-root.js";
import { RightEdgeGuardTerminal } from "./right-edge-guard-terminal.js";
import { RoundedFrame } from "./rounded-frame.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { SessionInspector, type SessionRunStatus } from "./session-inspector.js";
import { SessionPicker } from "./session-picker.js";
import { SkillPalette } from "./skill-palette.js";
import { TargetPicker } from "./target-picker.js";
import { type AdamTuiTheme, createAdamTuiTheme } from "./theme.js";
import { ThinkingPicker } from "./thinking-picker.js";
import { ToolPreview } from "./tool-preview.js";
import { TranscriptViewport } from "./transcript-viewport.js";
import { WorkspaceTrustPage } from "./workspace-trust-page.js";

export type { ClipboardAdapter, DeadlineScheduler } from "./exit-policy.js";

export type TuiTargetStatus = {
  readonly certification: "Certified" | "Experimental";
  readonly targetId: string;
  readonly upstreamLifecycle?: "Experimental" | "Stable";
};

export type RunTuiOptions = {
  readonly closeRuntime: () => Promise<void>;
  readonly commandRegistry?: AdamCommandRegistry;
  readonly presentation: PresentationSession;
  readonly startupNotice?: string;
  readonly startupTargetId?: string;
  readonly targetStatus?: TuiTargetStatus;
  readonly terminal?: Terminal;
  readonly clipboard?: ClipboardAdapter;
  readonly deadlineScheduler?: DeadlineScheduler;
  readonly mouse?: boolean;
};

type TuiNotice = {
  readonly actionId: number;
  readonly kind: "error" | "info" | "progress" | "success" | "warning";
  readonly lifetime: "until_edit" | "until_next_action" | "until_replaced";
  readonly sessionId?: string;
  readonly text: string;
};

export async function runTui(options: RunTuiOptions): Promise<void> {
  const physicalTerminal = options.terminal ?? new ProcessTerminal();
  const terminal = new RightEdgeGuardTerminal(physicalTerminal);
  const deadlineScheduler = options.deadlineScheduler ?? nodeDeadlineScheduler;
  const commandRegistry = options.commandRegistry ?? adamCommandRegistry;
  const startupTargetId =
    options.startupTargetId ??
    options.presentation.getState().authoritative.targets.defaultTargetId;
  let newSessionSelected =
    options.presentation.getState().authoritative.sessions.items.length === 0;
  let noticeActionId = 0;
  let statusNotice: TuiNotice | null = null;
  const beginNoticeAction = (): number => {
    noticeActionId += 1;
    statusNotice = null;
    return noticeActionId;
  };
  const showNotice = (
    kind: TuiNotice["kind"],
    text: string,
    lifetime: TuiNotice["lifetime"],
    sessionId?: string,
  ): number => {
    const actionId = beginNoticeAction();
    statusNotice = {
      actionId,
      kind,
      lifetime,
      ...(sessionId === undefined ? {} : { sessionId }),
      text,
    };
    return actionId;
  };
  const settleNotice = (
    actionId: number,
    kind: TuiNotice["kind"],
    text: string,
    lifetime: TuiNotice["lifetime"],
    sessionId?: string,
  ): boolean => {
    if (
      actionId !== noticeActionId ||
      (sessionId !== undefined &&
        options.presentation.getState().authoritative.active?.session.id !== sessionId)
    ) {
      return false;
    }
    statusNotice = {
      actionId,
      kind,
      lifetime,
      ...(sessionId === undefined ? {} : { sessionId }),
      text,
    };
    return true;
  };
  const settleNoticeClear = (actionId: number): boolean => {
    if (actionId !== noticeActionId) {
      return false;
    }
    beginNoticeAction();
    return true;
  };
  const clearNotice = (): void => {
    beginNoticeAction();
  };
  if (options.startupNotice !== undefined) {
    showNotice("info", options.startupNotice, "until_replaced");
  }
  let requestPolicyRender: () => void = () => undefined;
  const tui = new TuiAltScreen(terminal, true, undefined, {
    mouse: options.mouse ?? true,
    transcriptSearch: false,
    async copySelection(text) {
      const actionId = beginNoticeAction();
      const result = await copySelectionToClipboard(text, options.clipboard, deadlineScheduler);
      if (result === "too_large") {
        settleNotice(
          actionId,
          "warning",
          "Selection is larger than 1 MiB and was not copied.",
          "until_edit",
        );
      } else if (result === "unsupported") {
        settleNotice(
          actionId,
          "error",
          "Clipboard unavailable; selection was not copied.",
          "until_edit",
        );
      } else if (result === "failed") {
        settleNotice(
          actionId,
          "error",
          "Clipboard copy failed; selection was not copied.",
          "until_edit",
        );
      }
      if (result !== "copied") {
        requestPolicyRender();
      }
      return result === "copied";
    },
  });
  const theme = createAdamTuiTheme();
  const showOverlay = (component: Component, overlayOptions: OverlayOptions) => {
    const renderOptions = resolvePhysicalOverlayWidth(
      overlayOptions,
      physicalTerminal.columns,
      terminal.columns,
    );
    return tui.showOverlay(
      new OverlayFrame(component, theme, () =>
        resolveOverlayMaximumHeight(overlayOptions, terminal.rows),
      ),
      {
        ...renderOptions,
        visible: () => terminalSizeIsSupported(physicalTerminal.columns, physicalTerminal.rows),
      },
    );
  };
  const root = new ResponsiveRoot(
    () => physicalTerminal.rows,
    () => physicalTerminal.columns,
  );
  const header = new Text();
  const transcriptViewport = new TranscriptViewport();
  const transcript = transcriptViewport.document;
  const editorSlot = new Container();
  const createEditor = (active: ActiveSessionDisplay | null): Editor => {
    const created = new Editor(tui, theme.editor, { paddingX: 1 });
    created.setAutocompleteProvider(
      new AdamAutocompleteProvider({
        getAttachmentsAvailable: () => options.presentation.getState().composer.attachmentAvailable,
        getProjectPaths: () =>
          options.presentation.getState().authoritative.active?.projectPaths.items ??
          options.presentation.getState().draft?.projectPaths.items ??
          [],
        getRunActive: () => {
          const state = options.presentation.getState();
          return (
            state.transient !== null ||
            (state.authoritative.active?.pendingInteractions.length ?? 0) > 0
          );
        },
        getThinkingLevelIds: () => {
          const state = options.presentation.getState();
          const targetId = state.authoritative.active?.session.targetId ?? state.draft?.targetId;
          return (
            state.authoritative.targets.items
              .find((target) => target.targetId === targetId)
              ?.thinking?.levels.map((level) => level.id) ?? []
          );
        },
        getSkills: () =>
          (
            options.presentation.getState().authoritative.active?.skills?.items ??
            options.presentation.getState().draft?.skills.items ??
            []
          ).map((skill) => ({
            description: skill.description,
            name: skill.name,
            qualifiedId: skill.qualifiedId,
          })),
        keyword: theme.keyword,
        registry: commandRegistry,
      }),
    );
    for (const prompt of authoritativePromptHistory(active)) {
      created.addToHistory(prompt);
    }
    return created;
  };
  let editor = createEditor(options.presentation.getState().authoritative.active);
  let projectedPromptHistory = authoritativePromptHistory(
    options.presentation.getState().authoritative.active,
  );
  let projectedHistorySessionId = options.presentation.getState().authoritative.active?.session.id;
  const statusLine = new Text();
  const footer = new ResponsiveText(() => physicalTerminal.columns);
  const working = new Loader(tui, theme.toolTitle, theme.muted, "Working", { intervalMs: 80 });
  const thinking = new Loader(tui, theme.keyword, theme.muted, "Thinking", { intervalMs: 80 });
  thinking.stop();
  const operationLoaders = new Map<string, Loader>();
  let workingVisible = false;
  let thinkingVisible = false;
  let cancelSettling = false;
  const exitArm = new ExitArm(deadlineScheduler, () => requestPolicyRender());
  const legacyDuplicateGuard = new LegacyDuplicateGuard(deadlineScheduler);
  let previousRunActive: boolean | undefined;
  const expandedToolIds = new Set<string>();
  let pendingOperationBaseline: {
    readonly sessionId: string;
    readonly operationIds: ReadonlySet<string>;
  } | null = null;
  let permission:
    | {
        readonly overlay: PermissionOverlay;
        readonly requestId: string;
        readonly hide: () => void;
      }
    | undefined;
  let targetPicker:
    | {
        readonly close: () => void;
        readonly picker: TargetPicker;
        readonly hide: () => void;
      }
    | undefined;
  let thinkingPicker:
    | {
        readonly close: () => void;
        readonly hide: () => void;
      }
    | undefined;
  let sessionPicker:
    | {
        readonly close: () => void;
        readonly picker: SessionPicker;
        readonly hide: () => void;
      }
    | undefined;
  let sessionInspector:
    | {
        readonly close: () => void;
        readonly hide: () => void;
        readonly inspector: SessionInspector;
      }
    | undefined;
  let chronologyPicker:
    | {
        readonly close: () => void;
        readonly hide: () => void;
        readonly picker: ChronologyPicker;
      }
    | undefined;
  let resourceReloadPicker:
    | {
        readonly close: () => void;
        readonly hide: () => void;
        readonly picker: ResourceReloadPicker;
      }
    | undefined;
  let configurationPage:
    | {
        readonly close: () => void;
        readonly hide: () => void;
      }
    | undefined;
  let workspaceTrustPage:
    | {
        readonly close: () => void;
        readonly hide: () => void;
        readonly mode: "manage" | "startup";
        readonly page: WorkspaceTrustPage;
      }
    | undefined;
  let skillPalette:
    | {
        readonly close: () => void;
        readonly hide: () => void;
      }
    | undefined;
  let pathPicker:
    | {
        readonly close: () => void;
        readonly hide: () => void;
      }
    | undefined;
  let mcpWizard:
    | {
        readonly close: () => void;
        readonly wizard: McpWizard;
        readonly hide: () => void;
      }
    | undefined;
  let helpNavigator:
    | {
        readonly close: () => void;
        readonly hide: () => void;
        readonly navigator: HelpNavigator;
      }
    | undefined;
  let artifactNavigator:
    | {
        readonly close: () => void;
        readonly hide: () => void;
      }
    | undefined;
  type CloseableOverlay = {
    readonly close: () => void;
    readonly hide: () => void;
  };
  const closeableOverlaysInPrecedence = (): readonly (CloseableOverlay | undefined)[] => [
    helpNavigator,
    artifactNavigator,
    mcpWizard,
    pathPicker,
    skillPalette,
    sessionInspector,
    chronologyPicker,
    resourceReloadPicker,
    workspaceTrustPage,
    configurationPage,
    sessionPicker,
    targetPicker,
    thinkingPicker,
  ];
  const focusedCloseableOverlay = (): CloseableOverlay | undefined =>
    closeableOverlaysInPrecedence().find((overlay) => overlay !== undefined);
  const hideSessionScopedOverlays = () => {
    skillPalette?.hide();
    skillPalette = undefined;
    pathPicker?.hide();
    pathPicker = undefined;
    mcpWizard?.hide();
    mcpWizard = undefined;
    sessionInspector?.hide();
    sessionInspector = undefined;
    chronologyPicker?.hide();
    chronologyPicker = undefined;
    resourceReloadPicker?.hide();
    resourceReloadPicker = undefined;
    workspaceTrustPage?.hide();
    workspaceTrustPage = undefined;
    configurationPage?.hide();
    configurationPage = undefined;
    artifactNavigator?.hide();
    artifactNavigator = undefined;
    thinkingPicker?.hide();
    thinkingPicker = undefined;
  };
  const selectedSkills = new Set<string>();
  const selectedThinkingLevels = new Map<string, string>();
  const expandedReasoningIds = new Set<string>();
  const reasoningArtifactReads = new Set<string>();
  const reasoningArtifactTexts = new Map<string, string>();
  const largeReasoningBoundaryOwners = new Map<
    string,
    { readonly direction: "up" | "down"; readonly reasoningId: string }
  >();
  const largeReasoningViews = new LargeReasoningViewStore({
    onChange: (focusAnchorId) => {
      if (focusAnchorId !== undefined) {
        transcriptViewport.focusOnNextLayout(focusAnchorId);
      }
      requestPolicyRender();
    },
    presentation: options.presentation,
  });
  transcriptViewport.setScrollListener((direction) => {
    largeReasoningViews.noteViewportMovement(direction);
    const visibleBoundary = transcriptViewport.selectVisibleAnchor(
      [...largeReasoningBoundaryOwners.entries()]
        .filter(([, owner]) => owner.direction === direction)
        .map(([anchorId]) => anchorId),
      transcriptViewport.scrollView.contentWidth,
    );
    const owner =
      visibleBoundary === null ? undefined : largeReasoningBoundaryOwners.get(visibleBoundary);
    if (owner !== undefined) {
      largeReasoningViews.navigate(owner.reasoningId, owner.direction);
    }
  });
  let previousActiveSessionId: string | undefined;
  let sessionPickerDismissed = false;
  let sessionPickerRequested = false;
  let targetPickerDismissed = false;
  let targetPickerIntent: "create" | "transition" = "create";
  let targetPickerRequested = false;
  let defaultTargetAttempted = false;
  let defaultTargetRejected = false;
  let startupTargetFailure: string | null = null;
  let workspaceTrustMutationPending = false;
  editorSlot.addChild(editor);
  const supportedRoot = new VStack([
    header,
    {
      component: new Spacer(1),
      visible: (viewport) => viewport.height > 12,
    },
    {
      component: transcriptViewport.scrollView,
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: new VStack([
        editorSlot,
        {
          component: statusLine,
          visible: () => statusNotice !== null,
        },
        footer,
      ]),
      basis: "auto",
      minSize: 1,
      shrink: 1,
    },
  ]);
  tui.setLayoutRoot(
    new VStack([
      {
        component: supportedRoot,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () => terminalSizeIsSupported(physicalTerminal.columns, physicalTerminal.rows),
      },
      {
        component: root,
        basis: 0,
        grow: 1,
        minSize: 1,
        visible: () => !terminalSizeIsSupported(physicalTerminal.columns, physicalTerminal.rows),
      },
    ]),
  );
  tui.setFocus(editor);

  const synchronizePromptHistory = (active: ActiveSessionDisplay | null) => {
    const nextHistory = authoritativePromptHistory(active);
    const nextSessionId = active?.session.id;
    if (
      projectedHistorySessionId === nextSessionId &&
      sameStrings(projectedPromptHistory, nextHistory)
    ) {
      return;
    }
    const previousEditor = editor;
    const draft = previousEditor.getExpandedText();
    const wasFocused = previousEditor.focused;
    const replacement = createEditor(active);
    replacement.setText(draft);
    replacement.disableSubmit = previousEditor.disableSubmit;
    if (previousEditor.onChange !== undefined) {
      replacement.onChange = previousEditor.onChange;
    }
    if (previousEditor.onSubmit !== undefined) {
      replacement.onSubmit = previousEditor.onSubmit;
    }
    editorSlot.clear();
    editorSlot.addChild(replacement);
    editor = replacement;
    projectedPromptHistory = nextHistory;
    projectedHistorySessionId = nextSessionId;
    if (wasFocused) {
      tui.setFocus(editor);
    }
  };

  const clearExitWindow = () => {
    exitArm.reset();
    legacyDuplicateGuard.reset();
  };

  const targetForState = (
    state: ReturnType<PresentationSession["getState"]>,
  ): TargetDisplay | undefined => {
    const targetId = state.authoritative.active?.session.targetId ?? state.draft?.targetId;
    return state.authoritative.targets.items.find((target) => target.targetId === targetId);
  };
  const selectedThinkingLevel = (
    target: TargetDisplay | undefined,
  ): ThinkingCapabilityDisplay["levels"][number] | undefined => {
    const capability = target?.thinking;
    if (capability === null || capability === undefined) {
      return undefined;
    }
    const selectedId = selectedThinkingLevels.get(capability.capabilityId);
    const selected = capability.levels.find((level) => level.id === selectedId);
    if (selected !== undefined) {
      return selected;
    }
    const defaultLevel = capability.levels.find((level) => level.id === capability.defaultLevelId);
    if (defaultLevel !== undefined) {
      selectedThinkingLevels.set(capability.capabilityId, defaultLevel.id);
    }
    return defaultLevel;
  };
  const thinkingSelectionFor = (
    target: TargetDisplay | undefined,
    level: ThinkingCapabilityDisplay["levels"][number] | undefined,
  ): ThinkingPolicySelectionDisplay | null => {
    const capability = target?.thinking;
    if (capability === null || capability === undefined || level === undefined) {
      return null;
    }
    return {
      requestedLevelId: level.id,
      capability: {
        id: capability.capabilityId,
        version: capability.capabilityVersion,
        digest: capability.capabilityDigest,
      },
    };
  };

  const renderState = () => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    if (statusNotice?.sessionId !== undefined && statusNotice.sessionId !== active?.session.id) {
      clearNotice();
    }
    synchronizePromptHistory(active);
    const activeSessionChanged = active?.session.id !== previousActiveSessionId;
    if (activeSessionChanged) {
      transcriptViewport.followEnd();
      pendingOperationBaseline = null;
      expandedReasoningIds.clear();
      expandedToolIds.clear();
      reasoningArtifactReads.clear();
      reasoningArtifactTexts.clear();
      largeReasoningViews.clear();
      selectedSkills.clear();
      hideSessionScopedOverlays();
      if (active !== null) {
        sessionPickerDismissed = false;
        targetPickerDismissed = false;
      }
      previousActiveSessionId = active?.session.id;
    }
    if (active?.mcp !== null && active?.mcp !== undefined && mcpWizard !== undefined) {
      mcpWizard.wizard.setState(active.mcp);
    }
    if (active !== null && sessionInspector !== undefined) {
      const continuity = state.authoritative.continuity;
      sessionInspector.inspector.setState({
        active,
        runStatus: sessionRunStatus(state.transient?.activity ?? null, active, cancelSettling),
        throughSequence: continuity.status === "current" ? continuity.sessionThroughSequence : null,
      });
    }
    const startupTrustBlocked = state.authoritative.project.workspaceTrust.status !== "trusted";
    if (startupTrustBlocked) {
      sessionPicker?.hide();
      sessionPicker = undefined;
      targetPicker?.hide();
      targetPicker = undefined;
      if (workspaceTrustPage?.mode !== "startup") {
        showWorkspaceTrustPage("startup");
      }
    } else if (workspaceTrustPage?.mode === "startup") {
      workspaceTrustPage.hide();
      workspaceTrustPage = undefined;
      tui.setFocus(editor);
    }
    const needsSessionChoice =
      active === null && state.authoritative.sessions.items.length > 0 && !newSessionSelected;
    if (
      !startupTrustBlocked &&
      active === null &&
      !needsSessionChoice &&
      startupTargetId !== null &&
      startupTargetId !== undefined &&
      !defaultTargetAttempted
    ) {
      defaultTargetAttempted = true;
      void options.presentation
        .dispatch({ type: "create_session", targetId: startupTargetId })
        .then((receipt) => {
          if (receipt.status === "rejected") {
            defaultTargetRejected = true;
            startupTargetFailure = receipt.message;
            renderState();
          }
        })
        .catch(() => {
          defaultTargetRejected = true;
          renderState();
        });
    }
    if (active !== null && targetPicker !== undefined && !targetPickerRequested) {
      targetPicker.hide();
      targetPicker = undefined;
      tui.setFocus(editor);
    }
    if (active !== null && sessionPicker !== undefined && !sessionPickerRequested) {
      sessionPicker.hide();
      sessionPicker = undefined;
      tui.setFocus(editor);
    } else if (
      !startupTrustBlocked &&
      (needsSessionChoice || sessionPickerRequested) &&
      sessionPicker === undefined &&
      !sessionPickerDismissed
    ) {
      let handle: { hide(): void } | undefined;
      const close = (selectedSessionId?: string) => {
        handle?.hide();
        sessionPicker = undefined;
        sessionPickerRequested = false;
        sessionPickerDismissed = true;
        clearNotice();
        if (selectedSessionId !== undefined) {
          showNotice("success", "Session selected.", "until_next_action", selectedSessionId);
        }
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new SessionPicker({
        sessions: state.authoritative.sessions.items,
        hasMore: state.authoritative.sessions.nextCursor !== null,
        theme,
        onClose: () => close(),
        onNewSession() {
          newSessionSelected = true;
          sessionPickerRequested = false;
          sessionPicker?.hide();
          sessionPicker = undefined;
          targetPickerDismissed = false;
          targetPickerIntent = "create";
          targetPickerRequested = true;
          renderState();
        },
        onSelect(session) {
          void options.presentation
            .dispatch({ type: "select_session", sessionId: session.id })
            .then((receipt) => {
              if (receipt.status === "admitted") {
                expandedReasoningIds.clear();
                reasoningArtifactReads.clear();
                reasoningArtifactTexts.clear();
                close(session.id);
                renderState();
              } else if (sessionPicker?.picker === picker) {
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            })
            .catch(() => {
              if (sessionPicker?.picker === picker) {
                picker.setNotice("The project session could not be opened.");
                tui.requestRender();
              }
            });
        },
        onLoadMore() {
          const after = options.presentation.getState().authoritative.sessions.nextCursor;
          if (after === null) {
            return;
          }
          void options.presentation
            .dispatch({ type: "load_more_sessions", after })
            .then((receipt) => {
              if (receipt.status === "admitted") {
                sessionPicker?.hide();
                sessionPicker = undefined;
                renderState();
              } else if (sessionPicker?.picker === picker) {
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            });
        },
        onRename(session) {
          void options.presentation
            .dispatch({ type: "select_session", sessionId: session.id })
            .then((receipt) => {
              if (receipt.status === "admitted") {
                editor.setText("/name ");
                tui.setFocus(editor);
              } else if (sessionPicker?.picker === picker) {
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            });
        },
      });
      handle = showOverlay(picker, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      sessionPicker = { close, picker, hide: () => handle?.hide() };
    } else if (
      !startupTrustBlocked &&
      targetPicker === undefined &&
      !targetPickerDismissed &&
      (targetPickerRequested ||
        (active === null &&
          state.draft === null &&
          !needsSessionChoice &&
          (startupTargetId === null || startupTargetId === undefined || defaultTargetRejected))) &&
      state.authoritative.targets.items.length > 0
    ) {
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        targetPicker = undefined;
        targetPickerRequested = false;
        targetPickerDismissed = true;
        clearNotice();
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new TargetPicker({
        defaultTargetId: state.authoritative.targets.defaultTargetId,
        targets: state.authoritative.targets.items,
        theme,
        mode: targetPickerIntent,
        ...(targetPickerIntent === "transition" && active !== null
          ? { currentTargetId: active.session.targetId }
          : {}),
        onClose: close,
        ...(state.authoritative.targets.diagnostic !== null
          ? { initialNotice: state.authoritative.targets.diagnostic.message }
          : startupTargetFailure === null
            ? {}
            : { initialNotice: startupTargetFailure }),
        onSelect(target) {
          if (targetPickerIntent === "transition") {
            picker.setNotice(
              `Selected ${target.targetId} · press Ctrl+N for New Session or Ctrl+F to Fork the current complete boundary.`,
            );
            tui.requestRender();
            return;
          }
          createSessionFromTarget(target);
        },
        onCreate(target) {
          createSessionFromTarget(target, () => editor.setText(""));
        },
        onFork(target) {
          if (target.readiness.status !== "available") {
            picker.setNotice(
              `The exact target ${target.targetId} is missing its required credential.`,
            );
            tui.requestRender();
            return;
          }
          const source =
            active === null
              ? undefined
              : completeChronologyBoundaries(active.transcript.items).at(-1);
          if (active === null || source === undefined) {
            picker.setNotice("No complete authoritative chronology boundary is visible.");
            tui.requestRender();
            return;
          }
          void options.presentation
            .dispatch({
              type: "branch_session",
              parentSessionId: active.session.id,
              sourceBoundary: source.boundary,
              targetId: target.targetId,
            })
            .then((receipt) => {
              if (receipt.status === "admitted") {
                close();
                editor.setText("");
              } else if (targetPicker?.picker === picker) {
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            })
            .catch(() => {
              if (targetPicker?.picker === picker) {
                picker.setNotice("The exact target fork could not be created.");
                tui.requestRender();
              }
            });
        },
        onSetDefault(target) {
          if (target !== null && target.readiness.status !== "available") {
            picker.setNotice(
              `The exact target ${target.targetId} is missing its required credential.`,
            );
            tui.requestRender();
            return;
          }
          const targetId = target?.targetId ?? null;
          void options.presentation
            .dispatch({ type: "set_default_target", targetId })
            .then((receipt) => {
              if (targetPicker?.picker !== picker) {
                return;
              }
              if (receipt.status === "admitted") {
                picker.setDefaultTargetId(targetId);
              }
              picker.setNotice(
                receipt.status !== "admitted"
                  ? receipt.message
                  : target === null
                    ? "Cleared the saved default target."
                    : `Saved ${target.targetId} as the default.`,
              );
              tui.requestRender();
            })
            .catch(() => {
              if (targetPicker?.picker === picker) {
                picker.setNotice("The exact default target could not be saved.");
                tui.requestRender();
              }
            });
        },
      });
      function createSessionFromTarget(target: TargetDisplay, afterAdmission?: () => void): void {
        if (target.readiness.status !== "available") {
          picker.setNotice(
            `The exact target ${target.targetId} is missing its required credential.`,
          );
          tui.requestRender();
          return;
        }
        const previousDraftTargetId = options.presentation.getState().draft?.targetId;
        void options.presentation
          .dispatch({ type: "create_session", targetId: target.targetId })
          .then((receipt) => {
            if (receipt.status === "admitted") {
              const targetChanged =
                previousDraftTargetId !== undefined && previousDraftTargetId !== target.targetId;
              if (targetChanged) {
                selectedSkills.clear();
              }
              close();
              if (targetChanged) {
                renderState();
              }
              afterAdmission?.();
            } else if (targetPicker?.picker === picker) {
              picker.setNotice(receipt.message);
              tui.requestRender();
            }
          })
          .catch(() => {
            if (targetPicker?.picker === picker) {
              picker.setNotice("The session could not be created.");
              tui.requestRender();
            }
          });
      }
      handle = showOverlay(picker, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      targetPicker = { close, picker, hide: () => handle?.hide() };
    }
    header.setText(
      `${theme.brand("Adam")}${theme.primary(" · ")}${theme.sessionTitle(
        safeTerminalText(
          active?.session.label ?? (state.draft === null ? "No session" : "New session"),
        ),
      )}`,
    );
    transcriptViewport.clear();
    largeReasoningBoundaryOwners.clear();
    const visibleRunningOperations = new Set<string>();
    let activeReasoningVisible = false;
    const durableReasoningIds = new Set<string>();
    const renderReasoning = (
      reasoning: ReasoningBlockDisplay | NonNullable<PresentationTransientState["reasoning"]>,
      artifact: ArtifactReference | null,
    ): void => {
      const oversized = isLargeReasoning({ artifact, text: reasoning.text });
      if (reasoning.text !== null && reasoning.text.length > 0 && !oversized) {
        reasoningArtifactTexts.set(reasoning.id, reasoning.text);
      } else if (oversized) {
        reasoningArtifactTexts.delete(reasoning.id);
      }
      const expanded = expandedReasoningIds.has(reasoning.id);
      const title = reasoningFoldTitle({
        expanded,
        provider: reasoning.provider,
        status: reasoning.status,
        theme,
      });
      if (reasoning.status === "active") {
        activeReasoningVisible = true;
        thinking.setMessage(title);
      }
      if (!expanded) {
        largeReasoningViews.close(reasoning.id);
        if (reasoning.status === "active") {
          transcript.addChild(thinking);
          transcriptViewport.setAnchor(reasoningAnchorId(reasoning.id), thinking, 1);
          transcriptViewport.setSemanticAnchor(transcriptItemAnchorId(reasoning.id), thinking);
        } else {
          transcript.addChild(new Spacer(1));
          const collapsed = new ResponsiveLine(title);
          transcript.addChild(collapsed);
          transcriptViewport.setAnchor(reasoningAnchorId(reasoning.id), collapsed);
          transcriptViewport.setSemanticAnchor(transcriptItemAnchorId(reasoning.id), collapsed);
        }
        return;
      }
      if (oversized) {
        const view = largeReasoningViews.sync({
          artifact,
          id: reasoning.id,
          preferEnd: transcriptViewport.scrollView.isFollowingEnd,
          text: reasoning.text,
        });
        if (view !== null) {
          renderLargeReasoning({
            contentTitle: reasoning.status === "active" ? thinking : new ResponsiveLine(title),
            reasoningId: reasoning.id,
            theme,
            transcript,
            transcriptViewport,
            view,
            boundaryOwners: largeReasoningBoundaryOwners,
            active: reasoning.status === "active",
          });
          return;
        }
      }
      const text =
        reasoning.text ??
        reasoningArtifactTexts.get(reasoning.id) ??
        (artifact === null
          ? reasoning.status === "active"
            ? "Waiting for provider reasoning…"
            : "Provider reasoning content was not retained."
          : reasoningArtifactReads.has(reasoning.id)
            ? "Loading provider reasoning…"
            : "Provider reasoning is available as an artifact · Ctrl+T to retry loading");
      const content = new Container();
      content.addChild(reasoning.status === "active" ? thinking : new ResponsiveLine(title));
      content.addChild(new Markdown(safeTerminalText(text), 0, 0, theme.markdown));
      transcript.addChild(new Spacer(1));
      const expandedFrame = new RoundedFrame(content, theme.editor.borderColor);
      transcript.addChild(expandedFrame);
      transcriptViewport.setAnchor(
        reasoningAnchorId(reasoning.id),
        expandedFrame,
        reasoning.status === "active" ? 2 : 1,
      );
      transcriptViewport.setSemanticAnchor(transcriptItemAnchorId(reasoning.id), expandedFrame);
    };
    let previousWasAssistant = false;
    let currentPromptAnchor: Component | undefined;
    for (const item of active?.transcript.items ?? []) {
      let itemAnchor: Component | undefined;
      if (item.type === "user_message") {
        if (previousWasAssistant) {
          transcript.addChild(new Spacer(1));
        }
        const user = new Box(1, 1, theme.userBackground);
        user.addChild(
          new Text(theme.userText(`${theme.userMarker}${safeTerminalText(item.text)}`)),
        );
        transcript.addChild(user);
        itemAnchor = user;
        currentPromptAnchor = user;
        previousWasAssistant = false;
      } else if (item.type === "assistant_message") {
        transcript.addChild(new Spacer(1));
        if (item.text !== null) {
          const assistant = new Markdown(safeTerminalText(item.text), 0, 0, theme.markdown);
          transcript.addChild(assistant);
          itemAnchor = assistant;
        } else if (item.artifact !== null) {
          const assistant = new Text(
            theme.muted(
              `Assistant response stored as artifact · ${item.artifact.byteCount} bytes · /artifacts to inspect`,
            ),
          );
          transcript.addChild(assistant);
          itemAnchor = assistant;
        }
        previousWasAssistant = true;
      } else if (item.type === "reasoning_block") {
        durableReasoningIds.add(item.id);
        renderReasoning(item, item.artifact);
        previousWasAssistant = false;
      } else if (item.type === "tool_call") {
        const expanded = expandedToolIds.has(item.id);
        const tool = new Box(1, 1, theme.toolBackground);
        const subject = item.subject?.value;
        const label = safeTerminalText(item.label);
        const baseTitle =
          item.kind === "shell"
            ? subject === undefined
              ? "$"
              : `$ ${safeTerminalText(subject)}`
            : subject === undefined
              ? label
              : `${label} ${safeTerminalText(subject)}`;
        const action = `Ctrl+O ${expanded ? "fold" : "expand"}`;
        const titleWithAction = (baseWidth: number): string =>
          theme.toolTitle(`${truncateToWidth(baseTitle, baseWidth)} · ${action}`);
        const toolTitle = new ResponsiveText(() => physicalTerminal.columns);
        toolTitle.setText({
          narrow: titleWithAction(14),
          standard: titleWithAction(32),
          wide: theme.toolTitle(`${baseTitle} · ${action}`),
        });
        tool.addChild(toolTitle);
        if (item.preview !== null) {
          tool.addChild(new ToolPreview(item.preview, expanded, theme));
        }
        const detail = item.resultSummary ?? toolStatusText(item.status, item.outcome?.status);
        if (detail !== null) {
          tool.addChild(new ResponsiveLine(theme.toolOutput(safeTerminalText(detail))));
        }
        if (expanded) {
          const replay = item.source?.replay ?? "unavailable";
          tool.addChild(
            new Text(theme.muted(safeTerminalText(`safe summary · ${detail ?? "unavailable"}`))),
          );
          tool.addChild(
            new Text(
              theme.muted(
                safeTerminalText(
                  `${item.qualifiedName} · ${item.effect ?? "effect unknown"} · ${item.status} · replay ${replay} · duration ${item.durationMs === null ? "unavailable" : `${item.durationMs} ms`}`,
                ),
              ),
            ),
          );
          if (item.source !== null) {
            tool.addChild(
              new Text(
                theme.muted(
                  safeTerminalText(
                    `provider model response · response ${item.source.responseSequence} · arguments ${item.source.argumentsDigest} · definition ${item.source.definitionDigest ?? "unknown"}`,
                  ),
                ),
              ),
            );
          }
          tool.addChild(
            new Text(
              theme.muted(
                `${item.artifacts.length} artifact${item.artifacts.length === 1 ? "" : "s"} · change preview ${item.changePreviewRef === null ? "none" : "available"}`,
              ),
            ),
          );
        }
        transcript.addChild(new Spacer(1));
        transcript.addChild(tool);
        itemAnchor = tool;
        transcriptViewport.setAnchor(toolAnchorId(item.id), tool, 1);
        previousWasAssistant = false;
      } else if (item.type === "compaction_marker") {
        transcript.addChild(new Spacer(1));
        const marker = new Text(
          theme.muted(
            `Context compacted · window ${item.windowNumber} · through ${item.sourceThrough} · retained from ${item.retainedFrom}`,
          ),
        );
        transcript.addChild(marker);
        itemAnchor = marker;
        previousWasAssistant = false;
      } else if (item.type === "session_notice") {
        const message =
          item.status === "interrupted"
            ? item.reason
            : item.status === "incomplete"
              ? item.reason
              : `${item.code}: ${item.message}`;
        transcript.addChild(new Spacer(1));
        const notice = new Text(theme.muted(safeTerminalText(message)));
        transcript.addChild(notice);
        itemAnchor = notice;
        previousWasAssistant = false;
      } else if (item.type === "operation_link") {
        const operation = active?.linkedOperations.find(
          (candidate) => candidate.operationId === item.operationId,
        );
        transcript.addChild(new Spacer(1));
        const card = new Box(1, 1, theme.toolBackground);
        if (operation === undefined) {
          card.addChild(new ResponsiveLine(theme.toolTitle("Linked operation")));
          card.addChild(
            new ResponsiveLine(theme.muted("Authoritative operation details are unavailable.")),
          );
        } else {
          card.addChild(
            new ResponsiveLine(theme.toolTitle(safeTerminalText(operation.provenance.title))),
          );
          const status = operationStatusText(operation);
          if (operation.status === "running" || operation.status === "cancel_requested") {
            visibleRunningOperations.add(operation.operationId);
            let loader = operationLoaders.get(operation.operationId);
            if (loader === undefined) {
              loader = new Loader(tui, theme.keyword, theme.muted, status, { intervalMs: 80 });
              operationLoaders.set(operation.operationId, loader);
              loader.start();
            } else {
              loader.setMessage(status);
            }
            card.addChild(loader);
          } else {
            card.addChild(new ResponsiveLine(theme.toolOutput(safeTerminalText(status))));
          }
          const actions = operationActionText(operation);
          if (actions.length > 0) {
            card.addChild(new ResponsiveLine(theme.muted(actions)));
          }
          card.addChild(
            new Text(
              theme.muted(
                safeTerminalText(
                  `Extension · ${operation.provenance.extensionId}@${operation.provenance.extensionVersion}`,
                ),
              ),
            ),
          );
          card.addChild(
            new Text(
              theme.muted(
                safeTerminalText(`Contribution · ${operation.provenance.contributionId}`),
              ),
            ),
          );
          card.addChild(
            new Text(
              theme.muted(safeTerminalText(`Presentation · ${operation.provenance.presentation}`)),
            ),
          );
          card.addChild(new ResponsiveLine(theme.muted("Operation ID")));
          card.addChild(new ResponsiveLine(theme.muted(safeTerminalText(operation.operationId))));
          for (const artifact of operation.artifacts) {
            card.addChild(
              new ResponsiveLine(
                theme.muted(
                  safeTerminalText(
                    `${operationArtifactLabel(artifact.role)} · ${artifact.contract.id}@${artifact.contract.version} · ${artifact.reference.mediaType} · ${artifact.reference.byteCount} bytes`,
                  ),
                ),
              ),
            );
          }
        }
        transcript.addChild(card);
        itemAnchor = card;
        transcriptViewport.setAnchor(operationAnchorId(item.operationId), card, 1);
        previousWasAssistant = false;
      }
      if (itemAnchor !== undefined) {
        transcriptViewport.setSemanticAnchor(transcriptItemAnchorId(item.id), itemAnchor);
      }
      if (item.branchBoundary !== null) {
        const anchor = currentPromptAnchor ?? transcript.children.at(0);
        if (anchor !== undefined) {
          transcriptViewport.setAnchor(
            chronologyAnchorId(item.branchBoundary),
            anchor,
            anchor === currentPromptAnchor ? 1 : 0,
          );
        }
      }
    }
    for (const [operationId, loader] of operationLoaders) {
      if (!visibleRunningOperations.has(operationId)) {
        loader.stop();
        operationLoaders.delete(operationId);
      }
    }
    if (
      pendingOperationBaseline !== null &&
      active?.session.id === pendingOperationBaseline.sessionId
    ) {
      const operation = active.linkedOperations.findLast(
        (candidate) => !pendingOperationBaseline?.operationIds.has(candidate.operationId),
      );
      if (operation !== undefined) {
        pendingOperationBaseline = null;
        transcriptViewport.focus(operationAnchorId(operation.operationId), terminal.columns);
      }
    } else if (activeSessionChanged && active !== null) {
      const operation = active.linkedOperations.at(-1);
      if (operation !== undefined) {
        transcriptViewport.focus(operationAnchorId(operation.operationId), terminal.columns);
      }
    }
    if (state.composer.resources.length > 0) {
      transcript.addChild(new Spacer(1));
      const resources = new Box(1, 1, theme.toolBackground);
      resources.addChild(new ResponsiveLine(theme.toolTitle("Linked input resources")));
      for (const [index, resource] of state.composer.resources.entries()) {
        const size = resource.byteCount === null ? "size pending" : `${resource.byteCount} bytes`;
        const support = resource.support === null ? "support pending" : resource.support;
        resources.addChild(
          new ResponsiveLine(
            theme.toolOutput(
              safeTerminalText(
                `${index + 1} · ${resource.state} · ${resource.displayName} · ${size} · ${support}`,
              ),
            ),
          ),
        );
        if (resource.diagnostic !== null) {
          resources.addChild(
            new ResponsiveLine(theme.muted(safeTerminalText(resource.diagnostic))),
          );
        }
      }
      resources.addChild(
        new ResponsiveLine(theme.muted("/detach <index> · /cancelattach <index>")),
      );
      transcript.addChild(resources);
    }
    const transientReasoning = state.transient?.reasoning;
    if (
      transientReasoning !== null &&
      transientReasoning !== undefined &&
      !durableReasoningIds.has(transientReasoning.id)
    ) {
      renderReasoning(transientReasoning, null);
    }
    const transientAssistant = state.transient?.assistant?.text;
    const showWorking = state.transient?.activity === "working" && transientReasoning === null;
    if (showWorking) {
      transcript.addChild(new Spacer(1));
      transcript.addChild(working);
    } else if (transientAssistant !== undefined && transientAssistant.length > 0) {
      transcript.addChild(new Spacer(1));
      transcript.addChild(new Markdown(safeTerminalText(transientAssistant), 0, 0, theme.markdown));
    }
    if (showWorking && !workingVisible) {
      working.start();
    } else if (!showWorking && workingVisible) {
      working.stop();
    }
    workingVisible = showWorking;
    if (activeReasoningVisible && !thinkingVisible) {
      thinking.start();
    } else if (!activeReasoningVisible && thinkingVisible) {
      thinking.stop();
    }
    thinkingVisible = activeReasoningVisible;
    const pending = active?.pendingInteractions[0];
    if (
      cancelSettling &&
      state.transient === null &&
      (active === null ||
        (active.pendingInteractions.length === 0 && active.session.status !== "idle"))
    ) {
      cancelSettling = false;
    }
    const runActive = state.transient !== null || pending !== undefined || cancelSettling;
    if (previousRunActive !== undefined && previousRunActive !== runActive) {
      clearExitWindow();
    }
    previousRunActive = runActive;
    if (pending === undefined && permission !== undefined) {
      clearExitWindow();
      permission.hide();
      permission = undefined;
      tui.requestRender(true);
    } else if (pending !== undefined && permission?.requestId !== pending.requestId) {
      clearExitWindow();
      permission?.hide();
      const overlay = new PermissionOverlay({
        interaction: pending,
        theme,
        onDecision(decision) {
          void options.presentation.dispatch({
            type: "decide_permission",
            requestId: pending.requestId,
            decision,
          });
        },
      });
      const handle = showOverlay(overlay, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      permission = { overlay, requestId: pending.requestId, hide: () => handle.hide() };
      if (pending.changePreviewRef === null) {
        overlay.setPreview({ readable: pending.effect !== "write", text: "No preview available." });
      } else {
        void options.presentation
          .dispatch({ type: "read_artifact", artifact: pending.changePreviewRef, range: null })
          .then((receipt) => {
            if (permission?.requestId !== pending.requestId) {
              return;
            }
            overlay.setPreview(
              receipt.status === "admitted" && receipt.resource !== null
                ? { readable: true, text: receipt.resource.text }
                : { readable: false, text: "Canonical preview unavailable." },
            );
            tui.requestRender();
          });
      }
    }
    if (startupTrustBlocked || (active === null && state.draft === null)) {
      editor.disableSubmit = true;
    } else {
      editor.disableSubmit = false;
    }
    if (exitArm.armed) {
      footer.setText(
        theme.muted(
          `Press Ctrl+C again within two seconds to exit${
            editor.getExpandedText().length === 0 ? "" : " · draft will be copied"
          }`,
        ),
      );
    } else if (startupTrustBlocked) {
      footer.setText(theme.muted("Choose No to exit or explicitly trust this exact project"));
    } else if (active === null && state.draft === null) {
      footer.setText(theme.muted("Choose an exact model target to create a session"));
    } else if (active === null && state.draft !== null) {
      const draft = state.draft;
      const target = state.authoritative.targets.items.find(
        (candidate) => candidate.targetId === draft.targetId,
      );
      const thinkingLevel = selectedThinkingLevel(target);
      const upstreamSummary =
        target?.upstreamLifecycle === undefined
          ? ""
          : ` · Upstream ${safeTerminalText(target.upstreamLifecycle)}`;
      const connectionSummary =
        target?.connection === undefined
          ? ""
          : ` · ${safeTerminalText(target.connection.configured)} · ${safeTerminalText(target.connection.reachability)}`;
      const thinkingSummary =
        thinkingLevel === undefined
          ? ""
          : ` · Next thinking ${safeTerminalText(thinkingLevel.label)}`;
      const selectedSkillSummary =
        selectedSkills.size === 0
          ? ""
          : ` · ${selectedSkills.size} Skill${selectedSkills.size === 1 ? "" : "s"} selected`;
      footer.setText({
        wide: theme.muted(
          `${safeTerminalText(state.authoritative.project.label)} · New session draft · idle\n${safeTerminalText(draft.targetId)} · ${target?.certification ?? "Experimental"}${upstreamSummary}${connectionSummary}${thinkingSummary}${selectedSkillSummary} · /help · Tab complete`,
        ),
        standard: theme.muted(
          `New session draft · idle\n${safeTerminalText(draft.targetId)} · ${target?.certification ?? "Experimental"}${upstreamSummary}${connectionSummary}${thinkingSummary}${selectedSkillSummary} · /help · Tab complete`,
        ),
        narrow: theme.muted(
          `draft · idle\n${safeTerminalText(draft.targetId)}\n/help · Tab complete`,
        ),
      });
    } else if (active !== null) {
      const runStatus = sessionRunStatus(state.transient?.activity ?? null, active, cancelSettling);
      const activeTarget = state.authoritative.targets.items.find(
        (target) => target.targetId === active.session.targetId,
      );
      const targetCertification =
        activeTarget?.certification ?? options.targetStatus?.certification ?? "Experimental";
      const targetUpstreamLifecycle =
        activeTarget?.upstreamLifecycle ?? options.targetStatus?.upstreamLifecycle;
      const upstreamSummary =
        targetUpstreamLifecycle === undefined
          ? ""
          : ` · Upstream ${safeTerminalText(targetUpstreamLifecycle)}`;
      const connectionSummary =
        activeTarget?.connection === undefined
          ? ""
          : ` · ${safeTerminalText(activeTarget.connection.configured)} · ${safeTerminalText(activeTarget.connection.reachability)}`;
      const thinkingLevel = selectedThinkingLevel(activeTarget);
      const thinkingSummary =
        thinkingLevel === undefined
          ? ""
          : ` · Next thinking ${safeTerminalText(thinkingLevel.label)}`;
      const selectedSkillSummary =
        selectedSkills.size === 0
          ? ""
          : ` · ${selectedSkills.size} Skill${selectedSkills.size === 1 ? "" : "s"} selected`;
      const olderHistorySummary =
        active.transcript.olderCursor === null ? "" : " · older history available";
      const planSummary = active.plan === undefined ? "" : " · Plan exploring · read-only";
      const compactPlanSummary = active.plan === undefined ? "" : " · plan read-only";
      footer.setText({
        wide: theme.muted(
          `${safeTerminalText(state.authoritative.project.label)} · ${footerContextText(active)}${planSummary} · ${runStatus}\n${safeTerminalText(active.session.targetId)} · ${targetCertification}${upstreamSummary}${connectionSummary}${thinkingSummary}${selectedSkillSummary}${olderHistorySummary} · ${commandRegistry.footerHint()}`,
        ),
        standard: theme.muted(
          `${safeTerminalText(state.authoritative.project.label)} · ${footerContextText(active)}${planSummary} · ${runStatus}\n${safeTerminalText(active.session.targetId)} · ${targetCertification}${upstreamSummary}${connectionSummary}${thinkingSummary}${selectedSkillSummary}${olderHistorySummary} · /help · Tab complete`,
        ),
        narrow: theme.muted(
          `${runStatus}${compactPlanSummary} · ${footerContextCompactText(active)}\n${safeTerminalText(active.session.targetId)} · ${targetCertification}${upstreamSummary}\n/help · Tab complete`,
        ),
      });
    }
    if (statusNotice !== null) {
      const prefix =
        statusNotice.kind === "success"
          ? "✓"
          : statusNotice.kind === "error"
            ? "✗"
            : statusNotice.kind === "warning"
              ? "!"
              : statusNotice.kind === "progress"
                ? "…"
                : "•";
      const noticeText = `${prefix} ${safeTerminalText(statusNotice.text)}`;
      const style =
        statusNotice.kind === "success"
          ? theme.statusSuccess
          : statusNotice.kind === "error"
            ? theme.statusError
            : statusNotice.kind === "warning"
              ? theme.statusWarning
              : theme.statusInfo;
      statusLine.setText(style(noticeText));
    } else {
      statusLine.setText("");
    }
    tui.requestRender();
  };
  const handleThinkingCommand = (argumentsText: string): void => {
    const state = options.presentation.getState();
    const target = targetForState(state);
    const capability = target?.thinking;
    editor.setText("");
    editor.disableSubmit = false;
    if (capability === null || capability === undefined) {
      showNotice("error", "Thinking policy is unavailable for this exact target.", "until_edit");
      renderState();
      return;
    }
    const requested = argumentsText.trim().toLocaleLowerCase();
    if (requested.length > 0) {
      const level = capability.levels.find(
        (candidate) =>
          candidate.id.toLocaleLowerCase() === requested ||
          candidate.label.toLocaleLowerCase() === requested,
      );
      if (level === undefined) {
        showNotice(
          "warning",
          `Thinking level ${safeTerminalText(argumentsText)} is unavailable · choose ${capability.levels.map((candidate) => candidate.id).join(", ")}.`,
          "until_edit",
        );
        renderState();
        return;
      }
      selectedThinkingLevels.set(capability.capabilityId, level.id);
      showNotice(
        "success",
        `Thinking ${safeTerminalText(level.label)} selected for the next prompt.`,
        "until_next_action",
      );
      renderState();
      return;
    }
    const selected = selectedThinkingLevel(target);
    if (selected === undefined) {
      showNotice("error", "The exact target has no valid default thinking level.", "until_edit");
      renderState();
      return;
    }
    thinkingPicker?.hide();
    let handle: { hide(): void } | undefined;
    const close = () => {
      handle?.hide();
      thinkingPicker = undefined;
      tui.setFocus(editor);
      tui.requestRender();
    };
    const picker = new ThinkingPicker({
      capability,
      selectedLevelId: selected.id,
      onClose: close,
      onSelect(levelId) {
        const level = capability.levels.find((candidate) => candidate.id === levelId);
        if (level === undefined) {
          return;
        }
        selectedThinkingLevels.set(capability.capabilityId, level.id);
        showNotice(
          "success",
          `Thinking ${safeTerminalText(level.label)} selected for the next prompt.`,
          "until_next_action",
        );
        close();
        renderState();
      },
      theme,
    });
    handle = showOverlay(picker, {
      width: "70%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    thinkingPicker = { close, hide: () => handle?.hide() };
    clearNotice();
    tui.requestRender();
  };
  editor.onChange = () => {
    void options.presentation.dispatch({
      type: "update_draft_text",
      text: editor.getExpandedText(),
    });
    if (statusNotice?.lifetime === "until_edit" || statusNotice?.lifetime === "until_next_action") {
      clearNotice();
      renderState();
    }
    if (exitArm.armed) {
      clearExitWindow();
      renderState();
    }
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    const projectPaths = active?.projectPaths ?? state.draft?.projectPaths;
    if (
      pathPicker === undefined &&
      projectPaths !== undefined &&
      projectPaths.items.length > 0 &&
      isProjectPathTrigger(editor.getExpandedText())
    ) {
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        pathPicker = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new ProjectPathPicker({
        catalog: projectPaths,
        onClose: close,
        onSelect(path) {
          const draft = editor.getExpandedText();
          const trigger = draft.lastIndexOf("@");
          if (trigger >= 0) {
            editor.setText(
              `${draft.slice(0, trigger)}\`${safeTerminalText(path)}\`${draft.slice(trigger + 1)}`,
            );
          }
          close();
        },
        theme,
      });
      handle = showOverlay(picker, {
        width: "90%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      pathPicker = { close, hide: () => handle?.hide() };
    }
  };
  const showChronologyPicker = (mode: "fork" | "read_only"): void => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    if (active === null) {
      return;
    }
    const boundaries = completeChronologyBoundaries(active.transcript.items);
    if (boundaries.length === 0 && active.transcript.olderCursor === null) {
      showNotice(
        "warning",
        "No complete authoritative chronology boundary is available.",
        "until_next_action",
        active.session.id,
      );
      renderState();
      return;
    }
    chronologyPicker?.hide();
    let handle: { hide(): void } | undefined;
    const close = () => {
      handle?.hide();
      chronologyPicker = undefined;
      tui.setFocus(editor);
      tui.requestRender();
    };
    const picker = new ChronologyPicker({
      boundaries,
      hasOlder: active.transcript.olderCursor !== null,
      mode,
      onClose: close,
      onLoadOlder() {
        const current = options.presentation.getState().authoritative.active;
        const before = current?.transcript.olderCursor;
        if (current?.session.id !== active.session.id || before === null || before === undefined) {
          picker.setNotice("The older chronology cursor is no longer current.");
          tui.requestRender();
          return;
        }
        void options.presentation
          .dispatch({ type: "load_older_transcript", before })
          .then((receipt) => {
            if (receipt.status === "admitted") {
              if (chronologyPicker?.picker === picker) {
                chronologyPicker.hide();
                chronologyPicker = undefined;
                showChronologyPicker(mode);
              }
            } else if (chronologyPicker?.picker === picker) {
              picker.setNotice(receipt.message);
              tui.requestRender();
            }
          })
          .catch(() => {
            if (chronologyPicker?.picker === picker) {
              picker.setNotice("The older chronology page could not be loaded.");
              tui.requestRender();
            }
          });
      },
      onSelect(source) {
        if (mode === "read_only") {
          close();
          const anchorId = chronologyAnchorId(source.boundary);
          let focused = transcriptViewport.focus(anchorId, terminal.columns);
          if (!focused) {
            renderState();
            tui.renderNow();
            focused = transcriptViewport.focus(anchorId, terminal.columns);
          }
          if (!focused) {
            showNotice(
              "error",
              "The selected chronology boundary is no longer visible.",
              "until_next_action",
              active.session.id,
            );
            renderState();
          }
          tui.renderNow(true);
          return;
        }
        const current = options.presentation.getState().authoritative.active;
        if (current?.session.id !== active.session.id) {
          picker.setNotice("The active session changed before fork admission.");
          tui.requestRender();
          return;
        }
        void options.presentation
          .dispatch({
            type: "branch_session",
            parentSessionId: current.session.id,
            sourceBoundary: source.boundary,
            targetId: null,
          })
          .then((receipt) => {
            if (receipt.status === "admitted") {
              close();
              editor.setText(safeTerminalText(source.prompt ?? ""));
              editor.disableSubmit = false;
              renderState();
            } else if (chronologyPicker?.picker === picker) {
              picker.setNotice(receipt.message);
              tui.requestRender();
            }
          })
          .catch(() => {
            if (chronologyPicker?.picker === picker) {
              picker.setNotice("The exact branch boundary could not be opened.");
              tui.requestRender();
            }
          });
      },
      theme,
    });
    handle = showOverlay(picker, {
      width: "90%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    chronologyPicker = { close, hide: () => handle?.hide(), picker };
    tui.requestRender();
  };
  const showArtifactNavigator = (diffs: boolean, expectedSessionId: string): void => {
    const current = options.presentation.getState().authoritative.active;
    if (current?.session.id !== expectedSessionId) {
      showNotice(
        "error",
        "The active session changed before its output picker opened.",
        "until_next_action",
      );
      renderState();
      return;
    }
    const entries = diffs
      ? activeChronologyDiffs(current.transcript.items)
      : activeChronologyArtifacts(current.transcript.items, current.linkedOperations);
    const olderCursor = current.transcript.olderCursor;
    if (entries.length === 0 && olderCursor === null) {
      showNotice(
        "info",
        diffs
          ? "No settled diffs are visible in the active chronology."
          : "No artifacts are visible in the active chronology.",
        "until_next_action",
        current.session.id,
      );
      renderState();
      return;
    }
    artifactNavigator?.hide();
    let handle: { hide(): void } | undefined;
    const close = () => {
      navigator.cancelPendingRead();
      handle?.hide();
      artifactNavigator = undefined;
      tui.setFocus(editor);
      tui.requestRender();
    };
    const navigator = new ArtifactNavigator({
      ...(diffs ? { detailTitle: "Diff detail", title: "Settled diffs" } : {}),
      entries,
      onChange: () => tui.requestRender(),
      onClose: close,
      ...(olderCursor === null
        ? {}
        : {
            onLoadOlder() {
              navigator.setNotice("Loading one older authoritative chronology page…");
              void options.presentation
                .dispatch({ type: "load_older_transcript", before: olderCursor })
                .then((receipt) => {
                  if (artifactNavigator?.close !== close) {
                    return;
                  }
                  if (receipt.status === "rejected") {
                    navigator.setNotice(receipt.message);
                    return;
                  }
                  artifactNavigator.hide();
                  artifactNavigator = undefined;
                  showArtifactNavigator(diffs, expectedSessionId);
                })
                .catch(() => {
                  if (artifactNavigator?.close === close) {
                    navigator.setNotice("The older chronology page could not be loaded.");
                  }
                });
            },
          }),
      async onRead(artifact, range) {
        const receipt = await options.presentation.dispatch({
          type: "read_artifact",
          artifact,
          range,
        });
        if (receipt.status === "rejected" || receipt.resource === null) {
          throw new Error(
            receipt.status === "rejected" ? receipt.message : "The artifact page is unavailable.",
          );
        }
        return receipt.resource;
      },
      theme,
    });
    handle = showOverlay(navigator, {
      width: "90%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    artifactNavigator = {
      close,
      hide: () => {
        navigator.cancelPendingRead();
        handle?.hide();
      },
    };
    clearNotice();
    tui.requestRender();
  };
  const showHelpNavigator = (commandId: "help" | "hotkeys", argumentsText: string): void => {
    const requestedTopic = commandId === "hotkeys" ? "hotkeys" : argumentsText.trim();
    const initialPage: HelpPage =
      requestedTopic.length === 0
        ? "root"
        : (commandRegistry.helpTopics().find((topic) => topic.id === requestedTopic)?.id ?? "root");
    if (requestedTopic.length > 0 && initialPage === "root") {
      const suggestions = commandRegistry.suggestHelpTopics(requestedTopic);
      showNotice(
        "warning",
        `Unknown Help topic ${safeTerminalText(requestedTopic)}${
          suggestions.length === 0
            ? ""
            : ` · Did you mean ${suggestions.map((topic) => topic.id).join(", ")}?`
        }`,
        "until_edit",
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    editor.setText("");
    editor.disableSubmit = false;
    helpNavigator?.hide();
    let handle: { hide(): void } | undefined;
    const close = () => {
      handle?.hide();
      helpNavigator = undefined;
      tui.setFocus(editor);
      tui.requestRender();
    };
    const navigator = new HelpNavigator({
      commands: commandRegistry.entries(),
      initialPage,
      keybindings: commandRegistry.keybindings(),
      onClose: close,
      theme,
      topics: commandRegistry.helpTopics(),
    });
    handle = showOverlay(navigator, {
      width: "80%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    helpNavigator = { close, hide: () => handle?.hide(), navigator };
    tui.requestRender();
  };
  const applyConfigurationMutation = (
    field: ConfigurationField,
    value: number | null,
    onAdmitted?: () => void,
  ): void => {
    clearExitWindow();
    editor.disableSubmit = true;
    const actionId = showNotice(
      "progress",
      `Saving ${configurationFieldLabel(field)} limit…`,
      "until_replaced",
    );
    void options.presentation
      .dispatch({ type: "set_model_policy", field, value })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          editor.setText("");
          onAdmitted?.();
          settleNotice(
            actionId,
            "success",
            `Saved ${configurationFieldLabel(field)} limit: ${value === null ? "default" : `${value} tokens`}.`,
            "until_next_action",
          );
        } else {
          settleNotice(actionId, "error", receipt.message, "until_edit");
        }
      })
      .catch(() => {
        settleNotice(
          actionId,
          "error",
          "The owner-local model configuration could not be saved.",
          "until_edit",
        );
      })
      .finally(() => {
        editor.disableSubmit = false;
        renderState();
      });
  };
  const showConfigurationPage = (): void => {
    const state = options.presentation.getState();
    const configuration = state.authoritative.targets.configuration;
    if (configuration === undefined) {
      showNotice("error", "Owner-local model configuration is unavailable.", "until_edit");
      editor.disableSubmit = false;
      renderState();
      return;
    }
    editor.setText("");
    editor.disableSubmit = false;
    configurationPage?.hide();
    let handle: { hide(): void } | undefined;
    const close = (preserveNotice = false) => {
      handle?.hide();
      configurationPage = undefined;
      if (!preserveNotice) {
        clearNotice();
      }
      tui.setFocus(editor);
      renderState();
    };
    const page = new ConfigurationPage({
      diagnostic: state.authoritative.targets.diagnostic,
      modelPolicy: configuration.modelPolicy,
      onClose: () => close(),
      onReset(field) {
        applyConfigurationMutation(field, null, () => close(true));
      },
      target: targetForState(state),
      theme,
    });
    handle = showOverlay(page, {
      width: "90%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    configurationPage = { close, hide: () => handle?.hide() };
    clearNotice();
    tui.requestRender();
  };
  const handleConfigurationCommand = (argumentsText: string): void => {
    if (argumentsText.length === 0) {
      showConfigurationPage();
      return;
    }
    const mutation = parseConfigurationMutation(argumentsText);
    if (mutation === null) {
      showNotice(
        "warning",
        "Usage: /config [context|output|compaction <tokens|default>]",
        "until_edit",
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    applyConfigurationMutation(mutation.field, mutation.value);
  };
  const applyWorkspaceTrustMutation = (
    trusted: boolean,
    callbacks: {
      readonly onAdmitted?: () => void;
      readonly onRejected?: (message: string) => void;
    } = {},
  ): void => {
    if (workspaceTrustMutationPending) {
      return;
    }
    const project = options.presentation.getState().authoritative.project;
    clearExitWindow();
    editor.disableSubmit = true;
    workspaceTrustMutationPending = true;
    const actionId = showNotice(
      "progress",
      trusted ? "Saving workspace trust…" : "Revoking workspace trust…",
      "until_replaced",
    );
    void options.presentation
      .dispatch({
        type: "set_workspace_trust",
        projectId: project.id,
        trusted,
      })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          editor.setText("");
          callbacks.onAdmitted?.();
          settleNotice(
            actionId,
            "success",
            trusted ? "Workspace trust granted." : "Workspace trust revoked.",
            "until_next_action",
          );
        } else {
          settleNotice(actionId, "error", receipt.message, "until_edit");
          callbacks.onRejected?.(receipt.message);
        }
      })
      .catch(() => {
        const message = "The owner-local workspace trust configuration could not be saved.";
        settleNotice(actionId, "error", message, "until_edit");
        callbacks.onRejected?.(message);
      })
      .finally(() => {
        workspaceTrustMutationPending = false;
        editor.disableSubmit = false;
        renderState();
      });
  };
  const showWorkspaceTrustPage = (mode: "manage" | "startup" = "manage"): void => {
    const project = options.presentation.getState().authoritative.project;
    editor.setText("");
    editor.disableSubmit = mode === "startup";
    workspaceTrustPage?.hide();
    let handle: { hide(): void } | undefined;
    let page: WorkspaceTrustPage;
    const close = () => {
      handle?.hide();
      if (workspaceTrustPage?.page === page) {
        workspaceTrustPage = undefined;
      }
      if (mode === "startup") {
        stopFromCommand?.();
        return;
      }
      clearNotice();
      tui.setFocus(editor);
      renderState();
    };
    page = new WorkspaceTrustPage({
      diagnostic: project.workspaceTrust.diagnostic,
      mode,
      onChange(trusted) {
        page.setNotice("Saving the owner-local trust decision…");
        tui.requestRender();
        applyWorkspaceTrustMutation(trusted, {
          ...(mode === "manage"
            ? {
                onAdmitted: () => {
                  handle?.hide();
                  if (workspaceTrustPage?.page === page) {
                    workspaceTrustPage = undefined;
                  }
                  tui.setFocus(editor);
                },
              }
            : {}),
          onRejected(message) {
            page.setNotice(message);
            tui.requestRender();
          },
        });
      },
      onClose: close,
      projectId: project.id,
      projectLabel: project.label,
      status: project.workspaceTrust.status,
      theme,
    });
    handle = showOverlay(page, {
      width: mode === "startup" ? "80%" : "90%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    workspaceTrustPage = { close, hide: () => handle?.hide(), mode, page };
    clearNotice();
    tui.requestRender();
  };
  const handleWorkspaceTrustCommand = (argumentsText: string): void => {
    const project = options.presentation.getState().authoritative.project;
    if (argumentsText.length === 0) {
      showWorkspaceTrustPage();
      return;
    }
    if (argumentsText === "status") {
      editor.setText("");
      editor.disableSubmit = false;
      showNotice(
        "info",
        `Workspace trust: ${project.workspaceTrust.status} · ${safeTerminalText(project.label)} · ${safeTerminalText(project.id)}`,
        "until_next_action",
      );
      renderState();
      return;
    }
    if (argumentsText !== "grant" && argumentsText !== "revoke") {
      showNotice("warning", "Usage: /trust [status|grant|revoke]", "until_edit");
      editor.disableSubmit = false;
      renderState();
      return;
    }
    applyWorkspaceTrustMutation(argumentsText === "grant");
  };
  let stopFromCommand: (() => void) | undefined;
  const handleExitCommand = (argumentsText: string): void => {
    if (argumentsText.length > 0) {
      showNotice("warning", "Usage: /exit", "until_edit");
      editor.disableSubmit = false;
      renderState();
      return;
    }
    editor.setText("");
    stopFromCommand?.();
  };
  const handleConnectionCommand = (
    argumentsText: string,
    targetId: string,
    sessionId?: string,
  ): void => {
    if (argumentsText.length > 0) {
      showNotice("warning", "Usage: /connection", "until_edit", sessionId);
      editor.disableSubmit = false;
      renderState();
      return;
    }
    const target = options.presentation
      .getState()
      .authoritative.targets.items.find((candidate) => candidate.targetId === targetId);
    if (target?.connection === undefined || target.connection.configured !== "Configured") {
      showNotice(
        "warning",
        "This exact target has no configured explicit connection test.",
        "until_edit",
        sessionId,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    const cancelling = target.connection.reachability === "Testing";
    editor.setText("");
    editor.disableSubmit = false;
    const actionId = showNotice(
      "progress",
      cancelling ? "Cancelling target connection test…" : "Testing target connection…",
      "until_replaced",
      sessionId,
    );
    const command = {
      type: cancelling
        ? ("cancel_target_connection_test" as const)
        : ("test_target_connection" as const),
      targetId,
    };
    void options.presentation
      .dispatch(command)
      .then((receipt) => {
        if (receipt.status !== "admitted") {
          settleNotice(
            actionId,
            receipt.code === "authority_rejected" ? "info" : "error",
            receipt.message,
            receipt.code === "authority_rejected" ? "until_next_action" : "until_edit",
            sessionId,
          );
          return;
        }
        if (cancelling) {
          settleNotice(
            actionId,
            "success",
            "Target connection test cancelled.",
            "until_next_action",
            sessionId,
          );
          return;
        }
        const settled = options.presentation
          .getState()
          .authoritative.targets.items.find(
            (candidate) => candidate.targetId === targetId,
          )?.connection;
        if (settled === undefined) {
          settleNotice(
            actionId,
            "error",
            "The exact target connection state became unavailable.",
            "until_edit",
            sessionId,
          );
          return;
        }
        const message = `Connection test: ${settled.configured} · ${settled.reachability} · ${target.certification}.${
          settled.diagnostic === null ? "" : ` ${settled.diagnostic.message}`
        }`;
        settleNotice(
          actionId,
          settled.reachability === "Reachable" ? "success" : "warning",
          message,
          settled.reachability === "Reachable" ? "until_next_action" : "until_edit",
          sessionId,
        );
      })
      .catch(() => {
        settleNotice(
          actionId,
          "error",
          "The exact target connection test could not be dispatched safely.",
          "until_edit",
          sessionId,
        );
      })
      .finally(() => {
        editor.disableSubmit = false;
        renderState();
      });
    renderState();
  };
  const handleAttachCommand = (path: string, sessionId?: string): void => {
    const composer = options.presentation.getState().composer;
    if (path.length === 0) {
      showNotice("warning", "Usage: /attach <path>", "until_edit", sessionId);
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (!composer.attachmentAvailable) {
      showNotice(
        "warning",
        composer.unavailableReason ?? "Input resources are unavailable for this session.",
        "until_edit",
        sessionId,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    editor.setText("");
    editor.disableSubmit = false;
    const actionId = showNotice("progress", "Staging input resource…", "until_replaced", sessionId);
    void options.presentation
      .dispatch({ type: "stage_input_resource", path })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          settleNotice(
            actionId,
            "success",
            "Input resource staged.",
            "until_next_action",
            sessionId,
          );
        } else {
          settleNotice(actionId, "error", receipt.message, "until_edit", sessionId);
        }
      })
      .catch(() => {
        settleNotice(
          actionId,
          "error",
          "The selected input resource could not be staged.",
          "until_edit",
          sessionId,
        );
      })
      .finally(() => {
        renderState();
      });
    renderState();
  };
  const handleStagedResourceCommand = (command: {
    readonly action: "remove_input_resource" | "cancel_input_resource";
    readonly failure: string;
    readonly indexText: string;
    readonly progress: string;
    readonly sessionId: string | undefined;
    readonly success: string;
    readonly usage: string;
  }): void => {
    const index = Number(command.indexText);
    const resource = options.presentation.getState().composer.resources[index - 1];
    if (!Number.isSafeInteger(index) || index < 1 || resource === undefined) {
      showNotice("warning", command.usage, "until_edit", command.sessionId);
      editor.disableSubmit = false;
      renderState();
      return;
    }
    editor.setText("");
    const actionId = showNotice("progress", command.progress, "until_replaced", command.sessionId);
    void options.presentation
      .dispatch({ type: command.action, resourceId: resource.id })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          settleNotice(
            actionId,
            "success",
            command.success,
            "until_next_action",
            command.sessionId,
          );
        } else {
          settleNotice(actionId, "error", receipt.message, "until_edit", command.sessionId);
        }
      })
      .catch(() => {
        settleNotice(actionId, "error", command.failure, "until_edit", command.sessionId);
      })
      .finally(() => {
        editor.disableSubmit = false;
        renderState();
      });
  };
  const handleDetachCommand = (indexText: string, sessionId?: string): void => {
    handleStagedResourceCommand({
      action: "remove_input_resource",
      failure: "The input resource could not be removed.",
      indexText,
      progress: "Removing input resource…",
      sessionId,
      success: "Input resource removed.",
      usage: "Usage: /detach <visible-index>",
    });
  };
  const handleCancelAttachmentCommand = (indexText: string, sessionId?: string): void => {
    handleStagedResourceCommand({
      action: "cancel_input_resource",
      failure: "The input resource could not be cancelled.",
      indexText,
      progress: "Cancelling input resource…",
      sessionId,
      success: "Input resource cancelled.",
      usage: "Usage: /cancelattach <visible-index>",
    });
  };
  const handleAttachmentCommand = (parsed: AdamCommandParseResult, sessionId?: string): boolean => {
    if (parsed.kind !== "known") {
      return false;
    }
    if (parsed.command.id === "attach") {
      handleAttachCommand(parsed.argumentsText, sessionId);
      return true;
    }
    if (parsed.command.id === "detach") {
      handleDetachCommand(parsed.argumentsText, sessionId);
      return true;
    }
    if (parsed.command.id === "cancelattach") {
      handleCancelAttachmentCommand(parsed.argumentsText, sessionId);
      return true;
    }
    return false;
  };
  editor.onSubmit = (text) => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    if (text.trim().length === 0) {
      return;
    }
    beginNoticeAction();
    if (active === null) {
      if (state.draft === null) {
        return;
      }
      const parsedDraft = commandRegistry.parse(text);
      if (parsedDraft.kind === "known" && parsedDraft.command.id === "exit") {
        handleExitCommand(parsedDraft.argumentsText);
        return;
      }
      if (parsedDraft.kind === "known" && parsedDraft.command.id === "thinking") {
        handleThinkingCommand(parsedDraft.argumentsText);
        return;
      }
      if (parsedDraft.kind === "known" && parsedDraft.command.id === "config") {
        handleConfigurationCommand(parsedDraft.argumentsText);
        return;
      }
      if (parsedDraft.kind === "known" && parsedDraft.command.id === "trust") {
        handleWorkspaceTrustCommand(parsedDraft.argumentsText);
        return;
      }
      if (parsedDraft.kind === "known" && parsedDraft.command.id === "connection") {
        handleConnectionCommand(parsedDraft.argumentsText, state.draft.targetId);
        return;
      }
      if (handleAttachmentCommand(parsedDraft)) {
        return;
      }
      if (
        parsedDraft.kind === "known" &&
        (parsedDraft.command.id === "help" || parsedDraft.command.id === "hotkeys")
      ) {
        showHelpNavigator(parsedDraft.command.id, parsedDraft.argumentsText);
        return;
      }
      if (
        parsedDraft.kind === "known" &&
        parsedDraft.command.id === "resume" &&
        parsedDraft.argumentsText.length === 0
      ) {
        editor.setText("");
        editor.disableSubmit = false;
        sessionPickerDismissed = false;
        sessionPickerRequested = true;
        renderState();
        return;
      }
      if (
        parsedDraft.kind === "known" &&
        (parsedDraft.command.id === "model" ||
          parsedDraft.command.id === "target" ||
          parsedDraft.command.id === "new") &&
        parsedDraft.argumentsText.length === 0
      ) {
        editor.setText("");
        editor.disableSubmit = false;
        targetPickerDismissed = false;
        targetPickerIntent = "create";
        targetPickerRequested = true;
        renderState();
        return;
      }
      if (
        parsedDraft.kind === "known" &&
        parsedDraft.command.id === "skills" &&
        parsedDraft.argumentsText.length === 0
      ) {
        editor.setText("");
        editor.disableSubmit = false;
        let handle: { hide(): void } | undefined;
        const close = () => {
          handle?.hide();
          skillPalette = undefined;
          tui.setFocus(editor);
          tui.requestRender();
        };
        const palette = new SkillPalette({
          catalog: state.draft.skills,
          theme,
          onClose: close,
          onToggle(skill) {
            if (selectedSkills.delete(skill.qualifiedId)) {
              renderState();
              return false;
            }
            selectedSkills.add(skill.qualifiedId);
            renderState();
            return true;
          },
        });
        handle = showOverlay(palette, {
          width: "90%",
          minWidth: 36,
          maxHeight: "80%",
          margin: 1,
        });
        skillPalette = { close, hide: () => handle?.hide() };
        tui.requestRender();
        return;
      }
      if (parsedDraft.kind === "unknown") {
        const suggestions = commandRegistry.suggest(parsedDraft.name);
        showNotice(
          "warning",
          `Unknown command /${parsedDraft.name}${
            suggestions.length === 0
              ? ""
              : ` · Did you mean ${suggestions.map((command) => `/${command.name}`).join(", ")}?`
          }`,
          "until_edit",
        );
        editor.disableSubmit = false;
        renderState();
        return;
      }
      if (parsedDraft.kind === "known") {
        showNotice(
          "warning",
          `/${parsedDraft.command.name} needs a session. Submit the first prompt or use /resume.`,
          "until_edit",
        );
        editor.disableSubmit = false;
        renderState();
        return;
      }
      clearExitWindow();
      editor.disableSubmit = true;
      const draftTarget = targetForState(state);
      const draftThinkingLevel = selectedThinkingLevel(draftTarget);
      const submitActionId = showNotice(
        "progress",
        "Submitting the first prompt…",
        "until_replaced",
      );
      void options.presentation
        .dispatch({
          type: "submit_draft_prompt",
          text,
          skills: [...selectedSkills],
          thinkingSelection: thinkingSelectionFor(draftTarget, draftThinkingLevel),
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            selectedSkills.clear();
            settleNoticeClear(submitActionId);
          } else {
            editor.setText(text);
            settleNotice(submitActionId, "error", receipt.message, "until_edit");
            editor.disableSubmit = false;
          }
        })
        .catch(() => {
          editor.setText(text);
          settleNotice(
            submitActionId,
            "error",
            "The first prompt could not be admitted to a durable session.",
            "until_edit",
          );
          editor.disableSubmit = false;
        })
        .finally(() => {
          renderState();
        });
      return;
    }
    const runActive =
      state.transient !== null || active.pendingInteractions.length > 0 || cancelSettling;
    clearExitWindow();
    editor.disableSubmit = true;
    const parsedCommand = commandRegistry.parse(text);
    if (parsedCommand.kind === "unknown") {
      const suggestions = commandRegistry.suggest(parsedCommand.name);
      showNotice(
        "warning",
        `Unknown command /${parsedCommand.name}${
          suggestions.length === 0
            ? ""
            : ` · Did you mean ${suggestions.map((command) => `/${command.name}`).join(", ")}?`
        }`,
        "until_edit",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      !commandRegistry.isAvailable(parsedCommand.command, {
        attachmentsAvailable: state.composer.attachmentAvailable,
        runActive,
      })
    ) {
      const attachmentUnavailable =
        parsedCommand.command.id === "attach" ||
        parsedCommand.command.id === "detach" ||
        parsedCommand.command.id === "cancelattach";
      showNotice(
        "warning",
        attachmentUnavailable
          ? (state.composer.unavailableReason ??
              "Input resources are unavailable for this session.")
          : `/${parsedCommand.command.name} is unavailable while a run is active.`,
        "until_edit",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "exit") {
      handleExitCommand(parsedCommand.argumentsText);
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "connection") {
      handleConnectionCommand(
        parsedCommand.argumentsText,
        active.session.targetId,
        active.session.id,
      );
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "plan") {
      if (parsedCommand.argumentsText.length > 0) {
        showNotice("warning", "Usage: /plan", "until_edit", active.session.id);
        editor.disableSubmit = false;
        renderState();
        return;
      }
      const plan = active.plan;
      const entering = plan === undefined;
      const planActionId = showNotice(
        "progress",
        entering ? "Entering read-only Plan…" : "Exiting read-only Plan…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch(
          entering
            ? { type: "enter_plan", sessionId: active.session.id }
            : {
                type: "exit_plan",
                sessionId: active.session.id,
                cycleId: plan.cycleId,
                revision: plan.revision,
              },
        )
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            settleNotice(
              planActionId,
              "success",
              entering ? "Entered read-only Plan." : "Exited read-only Plan.",
              "until_next_action",
              active.session.id,
            );
          } else {
            settleNotice(planActionId, "error", receipt.message, "until_edit", active.session.id);
          }
        })
        .catch(() => {
          settleNotice(
            planActionId,
            "error",
            entering
              ? "Read-only Plan could not be entered."
              : "Read-only Plan could not be exited.",
            "until_edit",
            active.session.id,
          );
        })
        .finally(() => {
          editor.disableSubmit = false;
          renderState();
        });
      return;
    }
    if (parsedCommand.kind === "not_command" && runActive) {
      showNotice(
        "warning",
        "A run is active; use a local read-only command or Ctrl+C to abort.",
        "until_edit",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "extension" &&
      parsedCommand.argumentsText.length === 0 &&
      parsedCommand.command.extensionCommand !== undefined
    ) {
      const extensionCommand = parsedCommand.command.extensionCommand;
      pendingOperationBaseline = {
        sessionId: active.session.id,
        operationIds: new Set(active.linkedOperations.map((operation) => operation.operationId)),
      };
      const extensionActionId = showNotice(
        "progress",
        `Admitting ${safeTerminalText(parsedCommand.command.summary)}…`,
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({
          type: "start_project_changes",
          sessionId: active.session.id,
          command: extensionCommand,
        })
        .then((receipt) => {
          editor.disableSubmit = false;
          if (receipt.status === "admitted") {
            editor.setText("");
            settleNotice(
              extensionActionId,
              "success",
              `${safeTerminalText(parsedCommand.command.summary)} admitted.`,
              "until_next_action",
              active.session.id,
            );
          } else {
            pendingOperationBaseline = null;
            settleNotice(
              extensionActionId,
              "error",
              receipt.message,
              "until_edit",
              active.session.id,
            );
          }
          renderState();
        })
        .catch(() => {
          pendingOperationBaseline = null;
          editor.disableSubmit = false;
          settleNotice(
            extensionActionId,
            "error",
            "The extension command could not be admitted safely.",
            "until_edit",
            active.session.id,
          );
          renderState();
        });
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "thinking") {
      handleThinkingCommand(parsedCommand.argumentsText);
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "config") {
      handleConfigurationCommand(parsedCommand.argumentsText);
      return;
    }
    if (parsedCommand.kind === "known" && parsedCommand.command.id === "trust") {
      handleWorkspaceTrustCommand(parsedCommand.argumentsText);
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "skills" &&
      parsedCommand.argumentsText.length > 0 &&
      parsedCommand.argumentsText !== "reload"
    ) {
      const skill = active.skills?.items.find(
        (candidate) => candidate.qualifiedId === parsedCommand.argumentsText,
      );
      if (skill === undefined) {
        showNotice(
          "warning",
          `Skill ${safeTerminalText(parsedCommand.argumentsText)} is not available.`,
          "until_edit",
          active.session.id,
        );
        editor.disableSubmit = false;
        renderState();
        return;
      }
      const selected = !selectedSkills.delete(skill.qualifiedId);
      if (selected) {
        selectedSkills.add(skill.qualifiedId);
      }
      editor.setText("");
      showNotice(
        "success",
        `${safeTerminalText(skill.qualifiedId)} ${selected ? "selected" : "cleared"} for the next prompt.`,
        "until_next_action",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "copy" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      const copyActionId = showNotice(
        "progress",
        "Finding last assistant response for copy…",
        "until_replaced",
        active.session.id,
      );
      renderState();
      void copyLastAssistantResponse({
        clipboard: options.clipboard,
        deadlineScheduler,
        presentation: options.presentation,
        sessionId: active.session.id,
      }).then(
        (resultMessage) => {
          settleNotice(
            copyActionId,
            resultMessage === "Copied last assistant response." ? "success" : "error",
            resultMessage,
            resultMessage === "Copied last assistant response."
              ? "until_next_action"
              : "until_replaced",
            active.session.id,
          );
          renderState();
        },
        () => {
          settleNotice(
            copyActionId,
            "error",
            "The last assistant response could not be read safely for copy.",
            "until_replaced",
            active.session.id,
          );
          renderState();
        },
      );
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      (parsedCommand.command.id === "artifacts" || parsedCommand.command.id === "diffs") &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      const diffs = parsedCommand.command.id === "diffs";
      showArtifactNavigator(diffs, active.session.id);
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      (parsedCommand.command.id === "help" || parsedCommand.command.id === "hotkeys")
    ) {
      showHelpNavigator(parsedCommand.command.id, parsedCommand.argumentsText);
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "tree" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      showChronologyPicker("read_only");
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "session" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      sessionInspector?.hide();
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        sessionInspector = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      };
      const continuity = state.authoritative.continuity;
      const inspector = new SessionInspector({
        active,
        onClose: close,
        runStatus: sessionRunStatus(state.transient?.activity ?? null, active, cancelSettling),
        theme,
        throughSequence: continuity.status === "current" ? continuity.sessionThroughSequence : null,
      });
      handle = showOverlay(inspector, {
        width: "90%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      sessionInspector = { close, hide: () => handle?.hide(), inspector };
      tui.requestRender();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "reload" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      const resources = [
        ...(active.repositoryInstructions?.reloadAvailable === true
          ? [
              {
                id: "instructions" as const,
                label: "Repository instructions",
                description: "Reload active AGENTS.md scopes through SessionLifecycle",
              },
            ]
          : []),
        ...(active.skills?.reloadAvailable === true
          ? [
              {
                id: "skills" as const,
                label: "Skills",
                description: "Reload the bounded active Skill catalog",
              },
            ]
          : []),
        ...(active.mcp?.status === "catalog_stale" && active.mcp.activation !== null
          ? [
              {
                id: "mcp" as const,
                label: "MCP catalog",
                description: "Revalidate the exact stale MCP generation",
              },
            ]
          : []),
      ];
      if (resources.length === 0) {
        showNotice(
          "info",
          "No project resource authority is currently eligible for reload.",
          "until_next_action",
          active.session.id,
        );
        renderState();
        return;
      }
      resourceReloadPicker?.hide();
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        resourceReloadPicker = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new ResourceReloadPicker({
        onClose: close,
        onSelect(resource) {
          const current = options.presentation.getState().authoritative.active;
          if (current === null || current.session.id !== active.session.id) {
            picker.setNotice("The active session changed before reload admission.");
            tui.requestRender();
            return;
          }
          const command: Parameters<PresentationSession["dispatch"]>[0] | null =
            resource.id === "instructions"
              ? { type: "reload_repository_instructions", sessionId: current.session.id }
              : resource.id === "skills"
                ? { type: "reload_skills", sessionId: current.session.id }
                : current.mcp?.status === "catalog_stale" && current.mcp.activation !== null
                  ? {
                      type: "revalidate_mcp_catalog",
                      sessionId: current.session.id,
                      generationId: current.mcp.activation.generationId,
                    }
                  : null;
          if (command === null) {
            picker.setNotice("That resource authority is no longer eligible for reload.");
            tui.requestRender();
            return;
          }
          const reloadActionId = showNotice(
            "progress",
            `Reloading ${safeTerminalText(resource.label)}…`,
            "until_replaced",
            active.session.id,
          );
          void options.presentation
            .dispatch(command)
            .then((receipt) => {
              if (receipt.status === "admitted") {
                settleNotice(
                  reloadActionId,
                  "success",
                  resource.id === "instructions"
                    ? "Reloaded repository instructions."
                    : resource.id === "skills"
                      ? "Reloaded Skills."
                      : "Revalidated the MCP catalog.",
                  "until_next_action",
                  active.session.id,
                );
                close();
                renderState();
              } else if (resourceReloadPicker?.picker === picker) {
                settleNotice(
                  reloadActionId,
                  "error",
                  receipt.message,
                  "until_edit",
                  active.session.id,
                );
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            })
            .catch(() => {
              if (resourceReloadPicker?.picker === picker) {
                settleNotice(
                  reloadActionId,
                  "error",
                  "The selected resource authority could not be reloaded.",
                  "until_edit",
                  active.session.id,
                );
                picker.setNotice("The selected resource authority could not be reloaded.");
                tui.requestRender();
              }
            });
        },
        resources,
        theme,
      });
      handle = showOverlay(picker, {
        width: "90%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      resourceReloadPicker = { close, hide: () => handle?.hide(), picker };
      tui.requestRender();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      (parsedCommand.command.id === "model" || parsedCommand.command.id === "target") &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      targetPickerDismissed = false;
      targetPickerIntent = "transition";
      targetPickerRequested = true;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "new" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      targetPickerDismissed = false;
      targetPickerIntent = "create";
      targetPickerRequested = true;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "resume" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      sessionPickerDismissed = false;
      sessionPickerRequested = true;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "name" &&
      parsedCommand.argumentsText === "--clear"
    ) {
      const clearNameActionId = showNotice(
        "progress",
        "Clearing the manual session name…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({
          type: "clear_session_manual_name",
          sessionId: active.session.id,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            settleNotice(
              clearNameActionId,
              "success",
              "Manual session name cleared.",
              "until_next_action",
              active.session.id,
            );
          } else {
            editor.disableSubmit = false;
            settleNotice(
              clearNameActionId,
              "error",
              receipt.message,
              "until_edit",
              active.session.id,
            );
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          settleNotice(
            clearNameActionId,
            "error",
            "The manual session name could not be cleared.",
            "until_edit",
            active.session.id,
          );
        })
        .finally(() => {
          tui.requestRender();
        });
      return;
    }
    if (handleAttachmentCommand(parsedCommand, active.session.id)) {
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "name" &&
      parsedCommand.argumentsText === "--generate"
    ) {
      const generateTitleActionId = showNotice(
        "progress",
        "Regenerating the session title…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({ type: "regenerate_session_title", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            settleNotice(
              generateTitleActionId,
              "success",
              "Session title regenerated.",
              "until_next_action",
              active.session.id,
            );
          } else {
            editor.disableSubmit = false;
            settleNotice(
              generateTitleActionId,
              "error",
              receipt.message,
              "until_edit",
              active.session.id,
            );
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          settleNotice(
            generateTitleActionId,
            "error",
            "The session title could not be regenerated.",
            "until_edit",
            active.session.id,
          );
        })
        .finally(() => {
          renderState();
        });
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "instructions" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      showNotice(
        "info",
        repositoryStatusText(active.repositoryInstructions),
        "until_next_action",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "instructions" &&
      parsedCommand.argumentsText === "reload"
    ) {
      const instructionsActionId = showNotice(
        "progress",
        "Reloading repository instructions…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({
          type: "reload_repository_instructions",
          sessionId: active.session.id,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            settleNotice(
              instructionsActionId,
              "success",
              repositoryStatusText(
                options.presentation.getState().authoritative.active?.repositoryInstructions ??
                  null,
              ),
              "until_next_action",
              active.session.id,
            );
          } else {
            editor.disableSubmit = false;
            settleNotice(
              instructionsActionId,
              "error",
              receipt.message,
              "until_edit",
              active.session.id,
            );
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          settleNotice(
            instructionsActionId,
            "error",
            "Repository instructions could not be reloaded safely.",
            "until_edit",
            active.session.id,
          );
        })
        .finally(() => {
          renderState();
        });
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "skills" &&
      parsedCommand.argumentsText === "reload"
    ) {
      const skillsActionId = showNotice(
        "progress",
        "Reloading the Skill catalog…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({ type: "reload_skills", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            const skills = options.presentation.getState().authoritative.active?.skills;
            settleNotice(
              skillsActionId,
              "success",
              skills === null || skills === undefined
                ? "Skills unavailable"
                : `Skills r${skills.revision} · ${skills.items.length} visible · ${skills.overflow.omittedCount} omitted · ${skills.diagnostics.length} diagnostics`,
              "until_next_action",
              active.session.id,
            );
          } else {
            editor.disableSubmit = false;
            settleNotice(skillsActionId, "error", receipt.message, "until_edit", active.session.id);
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          settleNotice(
            skillsActionId,
            "error",
            "The Skill catalog could not be reloaded safely.",
            "until_edit",
            active.session.id,
          );
        })
        .finally(() => {
          renderState();
        });
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "mcp" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      if (active.mcp === null) {
        showNotice(
          "info",
          "No project MCP configuration is available.",
          "until_next_action",
          active.session.id,
        );
        renderState();
        return;
      }
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        mcpWizard = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      };
      const dispatchWizard = (command: Parameters<PresentationSession["dispatch"]>[0]) => {
        void options.presentation
          .dispatch(command)
          .then((receipt) => {
            if (receipt.status === "rejected") {
              wizard.setNotice(receipt.message);
              tui.requestRender();
            }
          })
          .catch(() => {
            wizard.setNotice("The MCP authority step could not be completed.");
            tui.requestRender();
          });
      };
      const wizard = new McpWizard({
        state: active.mcp,
        theme,
        onClose: close,
        onAdvance(mcp) {
          const command = mcpAdvanceCommand(active.session.id, mcp);
          if (command !== null) {
            dispatchWizard(command);
          }
        },
        onCommit(mcp, selections) {
          const generationId = mcp.activation?.generationId;
          if (generationId !== undefined) {
            dispatchWizard({
              type: "commit_mcp_tool_profile",
              sessionId: active.session.id,
              generationId,
              selections,
            });
          }
        },
      });
      handle = showOverlay(wizard, {
        width: "95%",
        minWidth: 36,
        maxHeight: "90%",
        margin: 1,
      });
      mcpWizard = { close, wizard, hide: () => handle?.hide() };
      tui.requestRender();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "skills" &&
      parsedCommand.argumentsText.length === 0
    ) {
      const catalog = active.skills;
      editor.setText("");
      editor.disableSubmit = false;
      if (catalog !== null) {
        let handle: { hide(): void } | undefined;
        const close = () => {
          handle?.hide();
          skillPalette = undefined;
          tui.setFocus(editor);
          tui.requestRender();
        };
        const palette = new SkillPalette({
          catalog,
          theme,
          onClose: close,
          onToggle(skill) {
            if (selectedSkills.delete(skill.qualifiedId)) {
              renderState();
              return false;
            }
            selectedSkills.add(skill.qualifiedId);
            renderState();
            return true;
          },
        });
        handle = showOverlay(palette, {
          width: "90%",
          minWidth: 36,
          maxHeight: "80%",
          margin: 1,
        });
        skillPalette = { close, hide: () => handle?.hide() };
      }
      tui.requestRender();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "history" &&
      parsedCommand.argumentsText.length === 0
    ) {
      const before = active.transcript.olderCursor;
      if (before === null) {
        editor.disableSubmit = false;
        tui.requestRender();
        return;
      }
      void options.presentation
        .dispatch({ type: "load_older_transcript", before })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            renderState();
            tui.renderNow();
            const current = options.presentation.getState().authoritative.active;
            const oldest =
              current?.session.id === active.session.id
                ? completeChronologyBoundaries(current.transcript.items).at(0)
                : undefined;
            if (oldest !== undefined) {
              transcriptViewport.focus(chronologyAnchorId(oldest.boundary), terminal.columns);
              tui.renderNow(true);
            }
          } else {
            editor.disableSubmit = false;
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
        })
        .finally(() => {
          tui.requestRender();
        });
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "clone" &&
      parsedCommand.argumentsText.length === 0
    ) {
      const source = completeChronologyBoundaries(active.transcript.items).at(-1);
      if (source === undefined) {
        showNotice(
          "warning",
          "No complete authoritative chronology boundary is visible.",
          "until_next_action",
          active.session.id,
        );
        editor.disableSubmit = false;
        renderState();
        return;
      }
      const cloneActionId = showNotice(
        "progress",
        "Cloning the latest complete chronology boundary…",
        "until_replaced",
        active.session.id,
      );
      void options.presentation
        .dispatch({
          type: "branch_session",
          parentSessionId: active.session.id,
          sourceBoundary: source.boundary,
          targetId: null,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            editor.disableSubmit = false;
            settleNoticeClear(cloneActionId);
          } else {
            settleNotice(cloneActionId, "error", receipt.message, "until_edit", active.session.id);
            editor.disableSubmit = false;
          }
        })
        .catch(() => {
          settleNotice(
            cloneActionId,
            "error",
            "The latest complete boundary could not be cloned.",
            "until_edit",
            active.session.id,
          );
          editor.disableSubmit = false;
        })
        .finally(() => {
          renderState();
        });
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "fork" &&
      parsedCommand.argumentsText.length === 0
    ) {
      editor.setText("");
      editor.disableSubmit = false;
      showChronologyPicker("fork");
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "name" &&
      parsedCommand.argumentsText.length > 0
    ) {
      void options.presentation
        .dispatch({
          type: "set_session_manual_name",
          sessionId: active.session.id,
          name: parsedCommand.argumentsText,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
          } else {
            editor.disableSubmit = false;
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
        })
        .finally(() => {
          tui.requestRender();
        });
      return;
    }
    if (parsedCommand.kind === "known") {
      showNotice(
        "warning",
        `Usage: ${parsedCommand.command.usage}`,
        "until_edit",
        active.session.id,
      );
      editor.disableSubmit = false;
      renderState();
      return;
    }
    const nextTarget = targetForState(state);
    const nextThinkingLevel = selectedThinkingLevel(nextTarget);
    transcriptViewport.followEnd();
    const promptActionId = beginNoticeAction();
    void options.presentation
      .dispatch({
        type: "submit_prompt",
        sessionId: active.session.id,
        text,
        skills: [...selectedSkills],
        thinkingSelection: thinkingSelectionFor(nextTarget, nextThinkingLevel),
      })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          editor.setText("");
          selectedSkills.clear();
          settleNoticeClear(promptActionId);
        } else {
          settleNotice(promptActionId, "error", receipt.message, "until_edit", active.session.id);
          editor.disableSubmit = false;
        }
      })
      .catch(() => {
        editor.disableSubmit = false;
        settleNotice(
          promptActionId,
          "error",
          "The prompt could not be admitted safely.",
          "until_edit",
          active.session.id,
        );
      })
      .finally(() => {
        tui.requestRender();
      });
  };
  requestPolicyRender = renderState;
  renderState();
  const unsubscribe = options.presentation.subscribe(renderState);
  const exited = Promise.withResolvers<void>();
  let stopping = false;
  const removeTerminationListeners = () => {
    process.removeListener("SIGHUP", handleSighup);
    process.removeListener("SIGTERM", handleSigterm);
  };
  const stop = async (copyDraft: boolean) => {
    if (stopping) {
      return;
    }
    stopping = true;
    const failures: unknown[] = [];
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(removeTerminationListeners);
    attempt(clearExitWindow);
    attempt(unsubscribe);
    for (const overlay of closeableOverlaysInPrecedence()) {
      attempt(() => overlay?.hide());
    }
    attempt(() => permission?.hide());
    attempt(() => working.stop());
    attempt(() => thinking.stop());
    for (const loader of operationLoaders.values()) {
      attempt(() => loader.stop());
    }
    operationLoaders.clear();
    attempt(() => tui.stop({ preserveScreen: true }));
    try {
      if (copyDraft) {
        const clipboardResult = await copyDraftToClipboard(
          editor.getExpandedText(),
          options.clipboard,
          deadlineScheduler,
        );
        if (clipboardResult === "unsupported") {
          terminal.write("\r\nClipboard unavailable; draft was not copied.\r\n");
        } else if (clipboardResult === "failed") {
          terminal.write("\r\nClipboard copy failed; draft was not copied.\r\n");
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await options.clipboard?.close?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      await options.closeRuntime();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 0) {
      exited.resolve();
    } else if (failures.length === 1) {
      exited.reject(failures[0]);
    } else {
      exited.reject(new AggregateError(failures, "The TUI could not close every owned resource."));
    }
  };
  stopFromCommand = () => {
    void stop(true);
  };
  const handleTerminationSignal = (signal: "SIGHUP" | "SIGTERM") => {
    process.exitCode = signal === "SIGHUP" ? 129 : 143;
    void stop(false);
  };
  function handleSighup(): void {
    handleTerminationSignal("SIGHUP");
  }
  function handleSigterm(): void {
    handleTerminationSignal("SIGTERM");
  }
  tui.addInputListener((data) => {
    if (commandRegistry.matchesInput(data, "exit")) {
      void stop(true);
      return { consume: true };
    }
    if (
      !terminalSizeIsSupported(physicalTerminal.columns, physicalTerminal.rows) &&
      !commandRegistry.matchesInput(data, "interrupt")
    ) {
      if (commandRegistry.matchesInput(data, "back")) {
        if (permission !== undefined) {
          permission.overlay.handleInput(data);
        } else {
          focusedCloseableOverlay()?.close();
        }
      }
      return { consume: true };
    }
    if (commandRegistry.matchesInput(data, "toggle_tool_details")) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      const tools =
        options.presentation
          .getState()
          .authoritative.active?.transcript.items.filter((item) => item.type === "tool_call") ?? [];
      const visibleAnchorId = transcriptViewport.selectVisibleAnchor(
        tools.map((tool) => toolAnchorId(tool.id)),
        terminal.columns,
      );
      const tool =
        tools.find((candidate) => toolAnchorId(candidate.id) === visibleAnchorId) ?? tools.at(-1);
      if (tool === undefined) {
        return { consume: true };
      }
      const anchorId = toolAnchorId(tool.id);
      if (!transcriptViewport.preserveAnchorRow(anchorId, terminal.columns)) {
        transcriptViewport.focusOnNextLayout(anchorId);
      }
      if (!expandedToolIds.delete(tool.id)) {
        expandedToolIds.add(tool.id);
      }
      renderState();
      tui.renderNow();
      return { consume: true };
    }
    if (
      commandRegistry.matchesInput(data, "rename_session") &&
      permission === undefined &&
      focusedCloseableOverlay() === undefined
    ) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      const operation = options.presentation
        .getState()
        .authoritative.active?.linkedOperations.findLast(
          (candidate) =>
            candidate.status === "recovery_required" &&
            candidate.actions.some((action: "cancel" | "recover") => action === "recover"),
        );
      if (operation !== undefined) {
        clearExitWindow();
        transcriptViewport.focus(operationAnchorId(operation.operationId), terminal.columns);
        const recoveryActionId = showNotice(
          "progress",
          "Recovering the linked operation from durable evidence…",
          "until_replaced",
          options.presentation.getState().authoritative.active?.session.id,
        );
        renderState();
        void options.presentation
          .dispatch({ type: "recover_operation", operationId: operation.operationId })
          .then((receipt) => {
            settleNotice(
              recoveryActionId,
              receipt.status === "admitted" ? "success" : "error",
              receipt.status === "admitted" ? "Operation recovery admitted." : receipt.message,
              receipt.status === "admitted" ? "until_next_action" : "until_edit",
              options.presentation.getState().authoritative.active?.session.id,
            );
            renderState();
          })
          .catch(() => {
            settleNotice(
              recoveryActionId,
              "error",
              "The linked operation could not be recovered safely.",
              "until_edit",
              options.presentation.getState().authoritative.active?.session.id,
            );
            renderState();
          });
        return { consume: true };
      }
    }
    if (commandRegistry.matchesInput(data, "toggle_reasoning")) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      const state = options.presentation.getState();
      const active = state.authoritative.active;
      const transientReasoning = state.transient?.reasoning ?? null;
      const durableReasoning =
        active?.transcript.items.filter((item) => item.type === "reasoning_block") ?? [];
      const reasoningCandidates =
        transientReasoning === null ||
        durableReasoning.some((candidate) => candidate.id === transientReasoning.id)
          ? durableReasoning
          : [...durableReasoning, transientReasoning];
      const visibleAnchorId = transcriptViewport.selectVisibleAnchor(
        reasoningCandidates.map((candidate) => reasoningAnchorId(candidate.id)),
        terminal.columns,
      );
      const reasoning =
        (transientReasoning?.status === "active" ? transientReasoning : null) ??
        reasoningCandidates.find(
          (candidate) => reasoningAnchorId(candidate.id) === visibleAnchorId,
        ) ??
        reasoningCandidates.at(-1);
      if (reasoning === undefined || reasoning === null) {
        showNotice(
          "info",
          "No provider reasoning block is available.",
          "until_next_action",
          active?.session.id,
        );
        renderState();
        return { consume: true };
      }
      const anchorId = reasoningAnchorId(reasoning.id);
      if (!transcriptViewport.preserveAnchorRow(anchorId, terminal.columns)) {
        transcriptViewport.focusOnNextLayout(anchorId);
      }
      if (expandedReasoningIds.delete(reasoning.id)) {
        largeReasoningViews.close(reasoning.id);
        renderState();
        tui.renderNow();
        return { consume: true };
      }
      expandedReasoningIds.add(reasoning.id);
      const artifact = "artifact" in reasoning ? reasoning.artifact : null;
      if (
        !isLargeReasoning({ artifact, text: reasoning.text }) &&
        reasoning.text === null &&
        artifact !== null &&
        !reasoningArtifactTexts.has(reasoning.id) &&
        !reasoningArtifactReads.has(reasoning.id)
      ) {
        reasoningArtifactReads.add(reasoning.id);
        const sessionId = active?.session.id;
        const reasoningReadActionId = beginNoticeAction();
        void options.presentation.dispatch({ type: "read_artifact", artifact, range: null }).then(
          (receipt) => {
            reasoningArtifactReads.delete(reasoning.id);
            if (
              receipt.status === "admitted" &&
              receipt.resource !== null &&
              options.presentation.getState().authoritative.active?.session.id === sessionId
            ) {
              reasoningArtifactTexts.set(reasoning.id, receipt.resource.text);
            } else if (receipt.status === "rejected") {
              settleNotice(
                reasoningReadActionId,
                "error",
                receipt.message,
                "until_edit",
                sessionId,
              );
            }
            renderState();
          },
          () => {
            reasoningArtifactReads.delete(reasoning.id);
            settleNotice(
              reasoningReadActionId,
              "error",
              "Provider reasoning could not be read safely.",
              "until_edit",
              sessionId,
            );
            renderState();
          },
        );
      }
      renderState();
      tui.renderNow();
      return { consume: true };
    }
    if (commandRegistry.matchesInput(data, "interrupt")) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      if (data === "\u0003" && !legacyDuplicateGuard.admit()) {
        return { consume: true };
      }
      const closeOverlay = permission === undefined ? focusedCloseableOverlay() : undefined;
      if (closeOverlay !== undefined) {
        clearExitWindow();
        closeOverlay.close();
        return { consume: true };
      }
      const active = options.presentation.getState().authoritative.active;
      const runActive =
        options.presentation.getState().transient !== null ||
        (active?.pendingInteractions.length ?? 0) > 0;
      const cancellableOperation = active?.linkedOperations.findLast(
        (candidate) => candidate.status === "running" && candidate.actions.includes("cancel"),
      );
      if (!runActive && !cancelSettling && cancellableOperation !== undefined) {
        clearExitWindow();
        transcriptViewport.focus(
          operationAnchorId(cancellableOperation.operationId),
          terminal.columns,
        );
        const cancellationActionId = showNotice(
          "progress",
          "Requesting cancellation of the linked operation…",
          "until_replaced",
          active?.session.id,
        );
        renderState();
        void options.presentation
          .dispatch({
            type: "cancel_operation",
            operationId: cancellableOperation.operationId,
          })
          .then((receipt) => {
            settleNotice(
              cancellationActionId,
              receipt.status === "admitted" ? "success" : "error",
              receipt.status === "admitted" ? "Operation cancellation requested." : receipt.message,
              receipt.status === "admitted" ? "until_next_action" : "until_edit",
              active?.session.id,
            );
            renderState();
          })
          .catch(() => {
            settleNotice(
              cancellationActionId,
              "error",
              "The linked operation could not be cancelled safely.",
              "until_edit",
              active?.session.id,
            );
            renderState();
          });
        return { consume: true };
      }
      if (runActive || cancelSettling) {
        if (!cancelSettling) {
          cancelSettling = true;
          void options.presentation
            .dispatch({ type: "cancel_run", sessionId: active?.session.id ?? null })
            .then((receipt) => {
              const state = options.presentation.getState();
              const current = state.authoritative.active;
              if (
                receipt.status === "rejected" ||
                (state.transient === null &&
                  (current === null ||
                    (current.pendingInteractions.length === 0 &&
                      current.session.status !== "idle")))
              ) {
                cancelSettling = false;
                renderState();
              }
            })
            .catch(() => {
              cancelSettling = false;
              renderState();
            });
        }
        return { consume: true };
      }
      if (exitArm.press() === "confirmed") {
        void stop(true);
        return { consume: true };
      }
      renderState();
      return { consume: true };
    }
    return undefined;
  });
  process.once("SIGHUP", handleSighup);
  process.once("SIGTERM", handleSigterm);
  try {
    tui.start();
    await exited.promise;
  } catch (error) {
    if (!stopping) {
      await stop(false);
      const cleanupError = await exited.promise.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          "The TUI failed during startup and cleanup.",
        );
      }
    }
    throw error;
  } finally {
    removeTerminationListeners();
  }
}

function parseConfigurationMutation(argumentsText: string): {
  readonly field: ConfigurationField;
  readonly value: number | null;
} | null {
  const [name, rawValue, extra] = argumentsText.split(/\s+/u);
  if (name === undefined || rawValue === undefined || extra !== undefined) {
    return null;
  }
  const field: ConfigurationField | undefined =
    name === "context"
      ? "contextWindowTokens"
      : name === "output"
        ? "maximumOutputTokens"
        : name === "compaction"
          ? "automaticCompactionWindowTokens"
          : undefined;
  if (field === undefined) {
    return null;
  }
  if (rawValue === "default") {
    return { field, value: null };
  }
  if (!/^[1-9][0-9]*$/u.test(rawValue)) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isSafeInteger(value) ? { field, value } : null;
}

function reasoningAnchorId(reasoningId: string): string {
  return `reasoning:${reasoningId}`;
}

function transcriptItemAnchorId(itemId: string): string {
  return `item:${itemId}`;
}

function renderLargeReasoning(options: {
  readonly active: boolean;
  readonly boundaryOwners: Map<
    string,
    { readonly direction: "up" | "down"; readonly reasoningId: string }
  >;
  readonly contentTitle: Component;
  readonly reasoningId: string;
  readonly theme: AdamTuiTheme;
  readonly transcript: Container;
  readonly transcriptViewport: TranscriptViewport;
  readonly view: LargeReasoningView;
}): void {
  const content = new Container();
  content.addChild(options.contentTitle);
  const firstPage = options.view.pages[0];
  const lastPage = options.view.pages.at(-1);
  const visibleRange =
    firstPage === undefined || lastPage === undefined
      ? `0 of ${options.view.totalByteCount} bytes`
      : `${firstPage.offset + 1}-${lastPage.offset + lastPage.byteCount} of ${options.view.totalByteCount} bytes`;
  content.addChild(
    new Text(options.theme.keyword(`Large reasoning · plain view · ${visibleRange}`)),
  );
  const availableDirections = [
    ...(options.view.moreAbove ? ["↑ More reasoning above"] : []),
    ...(options.view.moreBelow ? ["↓ More reasoning below"] : []),
  ];
  if (availableDirections.length > 0) {
    content.addChild(new Text(options.theme.muted(availableDirections.join(" · "))));
  }
  const trackedChildren: {
    readonly anchorId: string;
    readonly child: Component;
    readonly height?: (width: number) => number;
    readonly kind: "page" | "up" | "down";
  }[] = [];
  const addBoundary = (direction: "up" | "down", text: string) => {
    const child = new Text(options.theme.muted(text));
    const anchorId = largeReasoningBoundaryAnchorId(options.reasoningId, direction);
    content.addChild(child);
    trackedChildren.push({ anchorId, child, kind: direction });
  };
  if (options.view.loadingInitial) {
    content.addChild(new Text(options.theme.muted("Loading bounded reasoning range…")));
  } else if (options.view.failureInitial) {
    content.addChild(
      new Text(options.theme.danger("Reasoning range unavailable · Ctrl+T retry loading")),
    );
  } else {
    if (options.view.failureAbove) {
      addBoundary("up", "More reasoning above unavailable · Wheel/PageUp retry");
    } else if (options.view.loadingAbove) {
      addBoundary("up", "Loading reasoning above…");
    } else if (options.view.moreAbove) {
      addBoundary("up", "↑ More reasoning above · Wheel/PageUp");
    }
    for (const page of options.view.pages) {
      const pageRange = new Text(
        options.theme.muted(`Reasoning bytes ${page.offset + 1}-${page.offset + page.byteCount}`),
      );
      const pageText = new Text(safeTerminalText(page.text));
      content.addChild(pageRange);
      content.addChild(pageText);
      trackedChildren.push({
        anchorId: page.anchorId,
        child: pageRange,
        height: (width) =>
          pageRange.render(roundedFrameInnerWidth(width)).length +
          pageText.render(roundedFrameInnerWidth(width)).length,
        kind: "page",
      });
    }
    if (options.view.failureBelow) {
      addBoundary("down", "More reasoning below unavailable · Wheel/PageDown retry");
    } else if (options.view.loadingBelow) {
      addBoundary("down", "Loading reasoning below…");
    } else if (options.view.moreBelow) {
      addBoundary("down", "↓ More reasoning below · Wheel/PageDown");
    }
  }
  options.transcript.addChild(new Spacer(1));
  const frame = new RoundedFrame(content, options.theme.editor.borderColor);
  options.transcript.addChild(frame);
  options.transcriptViewport.setAnchor(
    reasoningAnchorId(options.reasoningId),
    frame,
    options.active ? 2 : 1,
  );
  options.transcriptViewport.setSemanticAnchor(transcriptItemAnchorId(options.reasoningId), frame);
  for (const tracked of trackedChildren) {
    const line = (width: number) => framedChildLine(content, tracked.child, width);
    const height =
      tracked.height ??
      ((width: number) => tracked.child.render(roundedFrameInnerWidth(width)).length);
    if (tracked.kind === "page") {
      options.transcriptViewport.setSemanticAnchor(tracked.anchorId, frame, line, height);
      continue;
    }
    options.transcriptViewport.setAnchor(tracked.anchorId, frame, line, height);
    options.boundaryOwners.set(tracked.anchorId, {
      direction: tracked.kind,
      reasoningId: options.reasoningId,
    });
  }
}

function framedChildLine(content: Container, child: Component, width: number): number {
  const innerWidth = roundedFrameInnerWidth(width);
  const childIndex = content.children.indexOf(child);
  const borderRows = width < 4 ? 0 : 1;
  return (
    borderRows +
    content.children
      .slice(0, Math.max(0, childIndex))
      .reduce((rows, candidate) => rows + candidate.render(innerWidth).length, 0)
  );
}

function roundedFrameInnerWidth(width: number): number {
  return Math.max(1, width < 4 ? width : width - 4);
}

function chronologyAnchorId(boundary: BranchSourceBoundary): string {
  return `chronology:${boundary.sessionId}:${boundary.sequence}`;
}

function toolAnchorId(toolId: string): string {
  return `tool:${toolId}`;
}

function operationAnchorId(operationId: string): string {
  return `operation:${operationId}`;
}

function configurationFieldLabel(field: ConfigurationField): string {
  return field === "contextWindowTokens"
    ? "context"
    : field === "maximumOutputTokens"
      ? "output"
      : "compaction";
}

function operationStatusText(operation: OperationDisplay): string {
  switch (operation.status) {
    case "running":
      return operation.progress === null ? "Running" : `Running · ${operation.progress.summary}`;
    case "cancel_requested":
      return "Cancellation requested · waiting for durable settlement";
    case "completed":
      return operation.settlement.summary === null
        ? "Completed"
        : `Completed · ${operation.settlement.summary}`;
    case "failed":
      return `Failed · ${operation.settlement.code} · ${operation.settlement.message}`;
    case "cancelled":
      return `Cancelled · ${operation.settlement.reason}`;
    case "inspection_required":
      return `Inspection required · ${operation.settlement.message}`;
    case "recovery_required":
      return `Recovery required · ${operation.settlement.message}`;
  }
}

function operationArtifactLabel(role: OperationDisplay["artifacts"][number]["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function operationActionText(operation: OperationDisplay): string {
  const actions = [
    ...(operation.actions.some((action: "cancel" | "recover") => action === "cancel")
      ? ["Ctrl+C cancel"]
      : []),
    ...(operation.actions.some((action: "cancel" | "recover") => action === "recover")
      ? ["Ctrl+R recover"]
      : []),
    ...(operation.artifacts.some((artifact) => artifact.role === "report")
      ? ["/artifacts inspect report"]
      : operation.artifacts.length > 0
        ? ["/artifacts inspect artifacts"]
        : []),
  ];
  return actions.join(" · ");
}

function resolvePhysicalOverlayWidth(
  options: OverlayOptions,
  physicalColumns: number,
  renderColumns: number,
): OverlayOptions {
  if (typeof options.width !== "string") {
    return options;
  }
  const match = options.width.match(/^(\d+(?:\.\d+)?)%$/u);
  if (match === null) {
    return options;
  }
  const requested = Math.floor((physicalColumns * Number.parseFloat(match[1] as string)) / 100);
  return { ...options, width: Math.max(1, Math.min(requested, renderColumns)) };
}

function resolveOverlayMaximumHeight(
  options: OverlayOptions,
  terminalRows: number,
): number | undefined {
  let requested: number | undefined;
  if (typeof options.maxHeight === "number") {
    requested = options.maxHeight;
  } else if (options.maxHeight !== undefined) {
    const match = options.maxHeight.match(/^(\d+(?:\.\d+)?)%$/u);
    requested =
      match === null
        ? undefined
        : Math.floor((terminalRows * Number.parseFloat(match[1] as string)) / 100);
  }
  if (requested === undefined) {
    return undefined;
  }
  const margin = options.margin;
  const top = typeof margin === "number" ? margin : (margin?.top ?? 0);
  const bottom = typeof margin === "number" ? margin : (margin?.bottom ?? 0);
  const available = Math.max(1, terminalRows - Math.max(0, top) - Math.max(0, bottom));
  return Math.max(1, Math.min(requested, available));
}

function clipboardAssistantStatus(result: "copied" | "failed" | "unsupported" | null): string {
  return result === "copied"
    ? "Copied last assistant response."
    : result === "unsupported"
      ? "Clipboard unavailable; assistant response was not copied."
      : "Clipboard copy failed; assistant response was not copied.";
}

async function copyLastAssistantResponse(options: {
  readonly clipboard: ClipboardAdapter | undefined;
  readonly deadlineScheduler: DeadlineScheduler;
  readonly presentation: PresentationSession;
  readonly sessionId: string;
}): Promise<string> {
  const assistant = await findLastAssistantResponse(options.presentation, options.sessionId);
  if (assistant === undefined) {
    return "No assistant response is available to copy.";
  }
  if (assistant.text !== null) {
    return clipboardAssistantStatus(
      await copyTextToClipboard(assistant.text, options.clipboard, options.deadlineScheduler),
    );
  }
  if (assistant.artifact === null) {
    return "The last assistant response is unavailable to copy.";
  }
  const text = await readCompleteArtifact(options.presentation, assistant.artifact);
  return clipboardAssistantStatus(
    await copyTextToClipboard(text, options.clipboard, options.deadlineScheduler),
  );
}

async function findLastAssistantResponse(
  presentation: PresentationSession,
  sessionId: string,
): Promise<
  | Extract<
      ActiveSessionDisplay["transcript"]["items"][number],
      { readonly type: "assistant_message" }
    >
  | undefined
> {
  while (true) {
    const active = presentation.getState().authoritative.active;
    if (active?.session.id !== sessionId) {
      throw new TypeError("The active session changed while locating its last assistant response.");
    }
    const assistant = active.transcript.items.findLast((item) => item.type === "assistant_message");
    if (assistant !== undefined) {
      return assistant;
    }
    const before = active.transcript.olderCursor;
    if (before === null) {
      return undefined;
    }
    const receipt = await presentation.dispatch({ type: "load_older_transcript", before });
    if (receipt.status === "rejected") {
      throw new TypeError("The older transcript page is unavailable.");
    }
    const refreshed = presentation.getState().authoritative.active;
    if (refreshed?.session.id !== sessionId || refreshed.transcript.olderCursor === before) {
      throw new TypeError("The older transcript page did not advance.");
    }
  }
}

async function readCompleteArtifact(
  presentation: PresentationSession,
  artifact: ArtifactReference,
): Promise<string> {
  const receipt = await presentation.dispatch({ type: "read_artifact", artifact, range: null });
  if (
    receipt.status === "rejected" ||
    receipt.resource === null ||
    receipt.resource.offset !== 0 ||
    receipt.resource.byteCount !== artifact.byteCount ||
    receipt.resource.totalByteCount !== artifact.byteCount ||
    !receipt.resource.eof ||
    receipt.resource.nextRange !== null
  ) {
    throw new TypeError("The complete artifact is unavailable for copy.");
  }
  return receipt.resource.text;
}

function footerContextText(active: ActiveSessionDisplay): string {
  const context = active.context;
  if (context === null) {
    return "context unavailable";
  }
  if (context.active.source === "unknown") {
    return `?/${context.profile.contextWindowTokens} context · unknown`;
  }
  const source = context.active.source === "provider_reported" ? "provider reported" : "estimated";
  return `${context.active.tokens}/${context.profile.contextWindowTokens} context · ${source}`;
}

function footerContextCompactText(active: ActiveSessionDisplay): string {
  const context = active.context;
  if (context === null) {
    return "ctx unavailable";
  }
  const maximum = compactTokenCount(context.profile.contextWindowTokens);
  if (context.active.source === "unknown") {
    return `ctx ?/${maximum} unknown`;
  }
  const source = context.active.source === "provider_reported" ? "reported" : "est";
  return `ctx ${compactTokenCount(context.active.tokens)}/${maximum} ${source}`;
}

function compactTokenCount(tokens: number): string {
  if (tokens >= 999_950) {
    return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(1))}k`;
  }
  return String(tokens);
}

function toolStatusText(
  status: "completed" | "denied" | "failed" | "permission_required" | "requested" | "running",
  outcome: "completed" | "denied" | "failed" | "indeterminate" | undefined,
): string | null {
  if (outcome === "indeterminate") {
    return "indeterminate · inspect before retry";
  }
  if (status === "permission_required") {
    return "permission required";
  }
  if (status === "denied") {
    return "denied";
  }
  if (status === "failed") {
    return "failed";
  }
  return status === "running" || status === "requested" ? status : null;
}

function sessionRunStatus(
  activity: "replying" | "using_tool" | "working" | null,
  active: ActiveSessionDisplay,
  cancelSettling: boolean,
): SessionRunStatus {
  if (cancelSettling) {
    return "cancelling";
  }
  if (active.pendingInteractions.length > 0) {
    return "permission required";
  }
  return activity === "using_tool" ? "using tool" : (activity ?? "idle");
}

function isProjectPathTrigger(draft: string): boolean {
  if (!draft.endsWith("@")) {
    return false;
  }
  const beforeTrigger = draft.at(-2);
  return beforeTrigger === undefined || /\s/u.test(beforeTrigger);
}

function authoritativePromptHistory(active: ActiveSessionDisplay | null): readonly string[] {
  const prompts =
    active?.transcript.items.flatMap((item) => {
      if (item.type !== "user_message") {
        return [];
      }
      const prompt = safeTerminalText(item.text);
      return prompt.trim().length > 0 ? [prompt] : [];
    }) ?? [];
  const collapsed: string[] = [];
  for (const prompt of prompts) {
    if (collapsed.at(-1) !== prompt) {
      collapsed.push(prompt);
    }
  }
  return collapsed.slice(-100);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function repositoryStatusText(instructions: RepositoryInstructionsDisplay | null): string {
  if (instructions === null) {
    return "Instructions unavailable";
  }
  const scopes = instructions.activeScopes.join(", ");
  const sources = instructions.sources.map((source) => source.path).join(", ") || "no files";
  const diagnostics = instructions.diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.code}${diagnostic.scope === undefined ? "" : ` · scope ${diagnostic.scope}`}${
          diagnostic.path === undefined ? "" : ` · path ${diagnostic.path}`
        }${diagnostic.candidate === undefined ? "" : ` · candidate ${diagnostic.candidate}`}`,
    )
    .join(" · ");
  return `Instructions r${instructions.revision} · scopes ${scopes} · ${sources} · ${
    instructions.reloadAvailable ? "reload available" : "reload unavailable"
  }${diagnostics.length === 0 ? "" : ` · ${diagnostics}`}`;
}
