import type {
  ActiveSessionDisplay,
  ArtifactReference,
  PresentationSession,
  RepositoryInstructionsDisplay,
  TargetDisplay,
} from "@adam-agent/presentation";
import {
  Box,
  Container,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Loader,
  Markdown,
  ProcessTerminal,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
  ArtifactNavigator,
  activeChronologyArtifacts,
  activeChronologyDiffs,
} from "./artifact-navigator.js";
import { ChronologyPicker, completeChronologyBoundaries } from "./chronology-picker.js";
import { AdamAutocompleteProvider } from "./command-autocomplete.js";
import { adamCommandRegistry } from "./command-registry.js";
import {
  type ClipboardAdapter,
  copyDraftToClipboard,
  copyTextToClipboard,
  type DeadlineScheduler,
  ExitArm,
  LegacyDuplicateGuard,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { HelpNavigator, type HelpPage } from "./help-navigator.js";
import { mcpAdvanceCommand } from "./mcp-advance.js";
import { McpWizard } from "./mcp-wizard.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { ProjectPathPicker } from "./project-path-picker.js";
import { ResourceReloadPicker } from "./resource-reload-picker.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { SessionInspector, type SessionRunStatus } from "./session-inspector.js";
import { SessionPicker } from "./session-picker.js";
import { SkillPalette } from "./skill-palette.js";
import { TargetPicker } from "./target-picker.js";
import { createAdamTuiTheme } from "./theme.js";

export type { ClipboardAdapter, DeadlineScheduler } from "./exit-policy.js";

export type TuiTargetStatus = {
  readonly certification: "Certified" | "Experimental";
  readonly targetId: string;
};

export type RunTuiOptions = {
  readonly presentation: PresentationSession;
  readonly startupTargetId?: string;
  readonly targetStatus?: TuiTargetStatus;
  readonly terminal?: Terminal;
  readonly clipboard?: ClipboardAdapter;
  readonly deadlineScheduler?: DeadlineScheduler;
};

export async function runTui(options: RunTuiOptions): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const deadlineScheduler = options.deadlineScheduler ?? nodeDeadlineScheduler;
  const startupTargetId =
    options.startupTargetId ??
    options.presentation.getState().authoritative.targets.defaultTargetId;
  let newSessionSelected =
    options.presentation.getState().authoritative.sessions.items.length === 0;
  const tui: TUI = new TuiMainScreen(terminal, true);
  const theme = createAdamTuiTheme();
  const root = new Container();
  const header = new Text();
  const transcript = new Container();
  const editorSlot = new Container();
  const createEditor = (active: ActiveSessionDisplay | null): Editor => {
    const created = new Editor(tui, theme.editor, { paddingX: 1 });
    created.setAutocompleteProvider(
      new AdamAutocompleteProvider({
        getProjectPaths: () =>
          options.presentation.getState().authoritative.active?.projectPaths.items ?? [],
        getRunActive: () => {
          const state = options.presentation.getState();
          return (
            state.transient !== null ||
            (state.authoritative.active?.pendingInteractions.length ?? 0) > 0
          );
        },
        getSkills: () =>
          options.presentation.getState().authoritative.active?.skills?.items.map((skill) => ({
            description: skill.description,
            qualifiedId: skill.qualifiedId,
          })) ?? [],
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
  const footer = new Text();
  const working = new Loader(tui, theme.toolTitle, theme.muted, "Working", { intervalMs: 80 });
  let workingVisible = false;
  let cancelSettling = false;
  let requestPolicyRender: () => void = () => undefined;
  const exitArm = new ExitArm(deadlineScheduler, () => requestPolicyRender());
  const legacyDuplicateGuard = new LegacyDuplicateGuard(deadlineScheduler);
  let previousRunActive: boolean | undefined;
  let toolDetailsExpanded = false;
  let statusMessage: string | null = null;
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
  const selectedSkills = new Set<string>();
  let previousActiveSessionId = options.presentation.getState().authoritative.active?.session.id;
  let sessionPickerDismissed = false;
  let sessionPickerRequested = false;
  let targetPickerDismissed = false;
  let targetPickerIntent: "create" | "transition" = "create";
  let targetPickerRequested = false;
  let defaultTargetAttempted = false;
  let defaultTargetRejected = false;
  let startupTargetFailure: string | null = null;
  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(transcript);
  editorSlot.addChild(editor);
  root.addChild(editorSlot);
  root.addChild(statusLine);
  root.addChild(footer);
  tui.addChild(root);
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

  const renderState = () => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    synchronizePromptHistory(active);
    if (active?.session.id !== previousActiveSessionId) {
      selectedSkills.clear();
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
      artifactNavigator?.hide();
      artifactNavigator = undefined;
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
    const needsSessionChoice =
      active === null && state.authoritative.sessions.items.length > 0 && !newSessionSelected;
    if (
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
      (needsSessionChoice || sessionPickerRequested) &&
      sessionPicker === undefined &&
      !sessionPickerDismissed
    ) {
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        sessionPicker = undefined;
        sessionPickerRequested = false;
        sessionPickerDismissed = true;
        statusMessage = "Session selection closed.";
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new SessionPicker({
        sessions: state.authoritative.sessions.items,
        hasMore: state.authoritative.sessions.nextCursor !== null,
        theme,
        onClose: close,
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
                close();
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
      handle = tui.showOverlay(picker, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      sessionPicker = { close, picker, hide: () => handle?.hide() };
    } else if (
      targetPicker === undefined &&
      !targetPickerDismissed &&
      (targetPickerRequested ||
        (active === null &&
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
        statusMessage = "Target selection closed.";
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new TargetPicker({
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
        onSaveDefault(target) {
          if (target.readiness.status !== "available") {
            picker.setNotice(
              `The exact target ${target.targetId} is missing its required credential.`,
            );
            tui.requestRender();
            return;
          }
          void options.presentation
            .dispatch({ type: "set_default_target", targetId: target.targetId })
            .then((receipt) => {
              if (targetPicker?.picker !== picker) {
                return;
              }
              picker.setNotice(
                receipt.status === "admitted"
                  ? `Saved ${target.targetId} as the default.`
                  : receipt.message,
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
        void options.presentation
          .dispatch({ type: "create_session", targetId: target.targetId })
          .then((receipt) => {
            if (receipt.status === "admitted") {
              close();
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
      handle = tui.showOverlay(picker, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      targetPicker = { close, picker, hide: () => handle?.hide() };
    }
    header.setText(
      theme.primary(`Adam · ${safeTerminalText(active?.session.label ?? "No session")}`),
    );
    transcript.clear();
    let previousWasAssistant = false;
    for (const item of active?.transcript.items ?? []) {
      if (item.type === "user_message") {
        if (previousWasAssistant) {
          transcript.addChild(new Spacer(1));
        }
        const user = new Box(1, 1, theme.userBackground);
        user.addChild(
          new Text(theme.userText(`${theme.userMarker}${safeTerminalText(item.text)}`)),
        );
        transcript.addChild(user);
        previousWasAssistant = false;
      } else if (item.type === "assistant_message") {
        transcript.addChild(new Spacer(1));
        if (item.text !== null) {
          transcript.addChild(new Markdown(safeTerminalText(item.text), 0, 0, theme.markdown));
        } else if (item.artifact !== null) {
          transcript.addChild(
            new Text(
              theme.muted(
                `Assistant response stored as artifact · ${item.artifact.byteCount} bytes · /artifacts to inspect`,
              ),
            ),
          );
        }
        previousWasAssistant = true;
      } else if (item.type === "tool_call") {
        const tool = new Box(1, 1, theme.toolBackground);
        const subject = item.subject?.value;
        const label = safeTerminalText(item.label);
        const title =
          item.kind === "shell"
            ? subject === undefined
              ? "$"
              : `$ ${safeTerminalText(subject)}`
            : subject === undefined
              ? label
              : `${label} ${safeTerminalText(subject)}`;
        tool.addChild(new Text(theme.toolTitle(title)));
        const detail = item.resultSummary ?? toolStatusText(item.status, item.outcome?.status);
        if (detail !== null) {
          tool.addChild(new Text(theme.toolOutput(safeTerminalText(detail))));
        }
        if (toolDetailsExpanded) {
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
        previousWasAssistant = false;
      } else if (item.type === "compaction_marker") {
        transcript.addChild(new Spacer(1));
        transcript.addChild(
          new Text(
            theme.muted(
              `Context compacted · window ${item.windowNumber} · through ${item.sourceThrough} · retained from ${item.retainedFrom}`,
            ),
          ),
        );
        previousWasAssistant = false;
      } else if (item.type === "session_notice") {
        const message =
          item.status === "interrupted"
            ? item.reason
            : item.status === "incomplete"
              ? item.reason
              : `${item.code}: ${item.message}`;
        transcript.addChild(new Spacer(1));
        transcript.addChild(new Text(theme.muted(safeTerminalText(message))));
        previousWasAssistant = false;
      }
    }
    const transientAssistant = state.transient?.assistant?.text;
    const showWorking = state.transient?.activity === "working";
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
    const pending = active?.pendingInteractions[0];
    if (
      cancelSettling &&
      state.transient === null &&
      active?.pendingInteractions.length === 0 &&
      active.session.status !== "idle"
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
      tui.setFocus(helpNavigator?.navigator ?? editor);
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
      const handle = tui.showOverlay(overlay, {
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
    if (active === null) {
      editor.disableSubmit = true;
    } else {
      editor.disableSubmit = false;
    }
    footer.setText(
      exitArm.armed
        ? theme.muted(
            `Press Ctrl+C again within two seconds to exit${
              editor.getExpandedText().length === 0 ? "" : " · draft will be copied"
            }`,
          )
        : active === null
          ? theme.muted("Choose an exact model target to create a session")
          : theme.muted(
              `${safeTerminalText(state.authoritative.project.label)} · ${footerContextText(active)} · ${sessionRunStatus(state.transient?.activity ?? null, active, cancelSettling)}\n${safeTerminalText(active.session.targetId)} · ${
                state.authoritative.targets.items.find(
                  (target) => target.targetId === active.session.targetId,
                )?.certification ??
                options.targetStatus?.certification ??
                "Experimental"
              }${
                selectedSkills.size === 0
                  ? ""
                  : ` · ${selectedSkills.size} Skill${selectedSkills.size === 1 ? "" : "s"} selected`
              }${active.transcript.olderCursor === null ? "" : " · older history available"} · ${adamCommandRegistry.footerHint()}`,
            ),
    );
    statusLine.setText(statusMessage === null ? "" : theme.muted(safeTerminalText(statusMessage)));
    tui.requestRender();
  };
  editor.onChange = () => {
    if (exitArm.armed) {
      clearExitWindow();
      renderState();
    }
    const active = options.presentation.getState().authoritative.active;
    if (
      pathPicker === undefined &&
      active !== null &&
      active.projectPaths.items.length > 0 &&
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
        catalog: active.projectPaths,
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
      handle = tui.showOverlay(picker, {
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
      statusMessage = "No complete authoritative chronology boundary is available.";
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
    handle = tui.showOverlay(picker, {
      width: "90%",
      minWidth: 36,
      maxHeight: "80%",
      margin: 1,
    });
    chronologyPicker = { close, hide: () => handle?.hide(), picker };
    tui.setFocus(picker);
    tui.requestRender();
  };
  const showArtifactNavigator = (diffs: boolean, expectedSessionId: string): void => {
    const current = options.presentation.getState().authoritative.active;
    if (current?.session.id !== expectedSessionId) {
      statusMessage = "The active session changed before its output picker opened.";
      renderState();
      return;
    }
    const entries = diffs
      ? activeChronologyDiffs(current.transcript.items)
      : activeChronologyArtifacts(current.transcript.items);
    const olderCursor = current.transcript.olderCursor;
    if (entries.length === 0 && olderCursor === null) {
      statusMessage = diffs
        ? "No settled diffs are visible in the active chronology."
        : "No artifacts are visible in the active chronology.";
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
    handle = tui.showOverlay(navigator, {
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
    statusMessage = null;
    tui.setFocus(navigator);
    tui.requestRender();
  };
  editor.onSubmit = (text) => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    if (active === null || text.trim().length === 0) {
      return;
    }
    const runActive =
      state.transient !== null || active.pendingInteractions.length > 0 || cancelSettling;
    clearExitWindow();
    editor.disableSubmit = true;
    const parsedCommand = adamCommandRegistry.parse(text);
    if (parsedCommand.kind === "unknown") {
      const suggestions = adamCommandRegistry.suggest(parsedCommand.name);
      statusMessage = `Unknown command /${parsedCommand.name}${
        suggestions.length === 0
          ? ""
          : ` · Did you mean ${suggestions.map((command) => `/${command.name}`).join(", ")}?`
      }`;
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      !adamCommandRegistry.isAvailable(parsedCommand.command, { runActive })
    ) {
      statusMessage = `/${parsedCommand.command.name} is unavailable while a run is active.`;
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (parsedCommand.kind === "not_command" && runActive) {
      statusMessage = "A run is active; use a local read-only command or Ctrl+C to abort.";
      editor.disableSubmit = false;
      renderState();
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
        statusMessage = `Skill ${safeTerminalText(parsedCommand.argumentsText)} is not available.`;
        editor.disableSubmit = false;
        renderState();
        return;
      }
      const selected = !selectedSkills.delete(skill.qualifiedId);
      if (selected) {
        selectedSkills.add(skill.qualifiedId);
      }
      statusMessage = `${safeTerminalText(skill.qualifiedId)} ${selected ? "selected" : "cleared"} for the next prompt.`;
      editor.setText("");
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
      statusMessage = "Finding last assistant response for copy…";
      renderState();
      void copyLastAssistantResponse({
        clipboard: options.clipboard,
        deadlineScheduler,
        presentation: options.presentation,
        sessionId: active.session.id,
      }).then(
        (resultMessage) => {
          statusMessage = resultMessage;
          renderState();
        },
        () => {
          statusMessage = "The last assistant response could not be read safely for copy.";
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
      const requestedTopic =
        parsedCommand.command.id === "hotkeys" ? "hotkeys" : parsedCommand.argumentsText.trim();
      const initialPage: HelpPage =
        requestedTopic.length === 0
          ? "root"
          : (adamCommandRegistry.helpTopics().find((topic) => topic.id === requestedTopic)?.id ??
            "root");
      if (requestedTopic.length > 0 && initialPage === "root") {
        const suggestions = adamCommandRegistry.suggestHelpTopics(requestedTopic);
        statusMessage = `Unknown Help topic ${safeTerminalText(requestedTopic)}${
          suggestions.length === 0
            ? ""
            : ` · Did you mean ${suggestions.map((topic) => topic.id).join(", ")}?`
        }`;
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
        commands: adamCommandRegistry.entries(),
        initialPage,
        keybindings: adamCommandRegistry.keybindings(),
        onClose: close,
        theme,
        topics: adamCommandRegistry.helpTopics(),
      });
      handle = tui.showOverlay(navigator, {
        width: "80%",
        minWidth: 36,
        maxHeight: "80%",
        margin: 1,
      });
      helpNavigator = { close, hide: () => handle?.hide(), navigator };
      tui.requestRender();
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
      handle = tui.showOverlay(inspector, {
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
        statusMessage = "No project resource authority is currently eligible for reload.";
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
          void options.presentation
            .dispatch(command)
            .then((receipt) => {
              if (receipt.status === "admitted") {
                statusMessage =
                  resource.id === "instructions"
                    ? "Reloaded repository instructions."
                    : resource.id === "skills"
                      ? "Reloaded Skills."
                      : "Revalidated the MCP catalog.";
                close();
                renderState();
              } else if (resourceReloadPicker?.picker === picker) {
                picker.setNotice(receipt.message);
                tui.requestRender();
              }
            })
            .catch(() => {
              if (resourceReloadPicker?.picker === picker) {
                picker.setNotice("The selected resource authority could not be reloaded.");
                tui.requestRender();
              }
            });
        },
        resources,
        theme,
      });
      handle = tui.showOverlay(picker, {
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
      void options.presentation
        .dispatch({
          type: "clear_session_manual_name",
          sessionId: active.session.id,
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
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "name" &&
      parsedCommand.argumentsText === "--generate"
    ) {
      void options.presentation
        .dispatch({ type: "regenerate_session_title", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
          } else {
            editor.disableSubmit = false;
            statusMessage = receipt.message;
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          statusMessage = "The session title could not be regenerated.";
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
      statusMessage = repositoryStatusText(active.repositoryInstructions);
      editor.setText("");
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (
      parsedCommand.kind === "known" &&
      parsedCommand.command.id === "instructions" &&
      parsedCommand.argumentsText === "reload"
    ) {
      void options.presentation
        .dispatch({
          type: "reload_repository_instructions",
          sessionId: active.session.id,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            statusMessage = repositoryStatusText(
              options.presentation.getState().authoritative.active?.repositoryInstructions ?? null,
            );
          } else {
            editor.disableSubmit = false;
            statusMessage = receipt.message;
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          statusMessage = "Repository instructions could not be reloaded safely.";
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
      void options.presentation
        .dispatch({ type: "reload_skills", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.setText("");
            const skills = options.presentation.getState().authoritative.active?.skills;
            statusMessage =
              skills === null || skills === undefined
                ? "Skills unavailable"
                : `Skills r${skills.revision} · ${skills.items.length} visible · ${skills.overflow.omittedCount} omitted · ${skills.diagnostics.length} diagnostics`;
          } else {
            editor.disableSubmit = false;
            statusMessage = receipt.message;
          }
        })
        .catch(() => {
          editor.disableSubmit = false;
          statusMessage = "The Skill catalog could not be reloaded safely.";
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
        statusMessage = "No project MCP configuration is available.";
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
      handle = tui.showOverlay(wizard, {
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
        handle = tui.showOverlay(palette, {
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
        statusMessage = "No complete authoritative chronology boundary is visible.";
        editor.disableSubmit = false;
        renderState();
        return;
      }
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
          } else {
            statusMessage = receipt.message;
            editor.disableSubmit = false;
          }
        })
        .catch(() => {
          statusMessage = "The latest complete boundary could not be cloned.";
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
      statusMessage = `Usage: ${parsedCommand.command.usage}`;
      editor.disableSubmit = false;
      renderState();
      return;
    }
    void options.presentation
      .dispatch({
        type: "submit_prompt",
        sessionId: active.session.id,
        text,
        skills: [...selectedSkills],
      })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          editor.setText("");
          selectedSkills.clear();
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
  };
  requestPolicyRender = renderState;
  renderState();
  const unsubscribe = options.presentation.subscribe(renderState);
  const exited = Promise.withResolvers<void>();
  let stopping = false;
  const stop = async (copyDraft: boolean) => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearExitWindow();
    unsubscribe();
    sessionPicker?.hide();
    sessionInspector?.hide();
    chronologyPicker?.hide();
    resourceReloadPicker?.hide();
    skillPalette?.hide();
    pathPicker?.hide();
    mcpWizard?.hide();
    helpNavigator?.hide();
    artifactNavigator?.hide();
    targetPicker?.hide();
    permission?.hide();
    working.stop();
    tui.stop();
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
      await options.presentation.close();
      exited.resolve();
    } catch (error) {
      exited.reject(error);
    }
  };
  tui.addInputListener((data) => {
    if (adamCommandRegistry.matchesInput(data, "exit")) {
      void stop(true);
      return { consume: true };
    }
    if (adamCommandRegistry.matchesInput(data, "toggle_tool_details")) {
      toolDetailsExpanded = !toolDetailsExpanded;
      renderState();
      return { consume: true };
    }
    if (adamCommandRegistry.matchesInput(data, "interrupt")) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      if (data === "\u0003" && !legacyDuplicateGuard.admit()) {
        return { consume: true };
      }
      const closeOverlay =
        permission === undefined
          ? (helpNavigator?.close ??
            artifactNavigator?.close ??
            mcpWizard?.close ??
            pathPicker?.close ??
            skillPalette?.close ??
            sessionInspector?.close ??
            chronologyPicker?.close ??
            resourceReloadPicker?.close ??
            sessionPicker?.close ??
            targetPicker?.close)
          : undefined;
      if (closeOverlay !== undefined) {
        clearExitWindow();
        closeOverlay();
        return { consume: true };
      }
      const active = options.presentation.getState().authoritative.active;
      const runActive =
        options.presentation.getState().transient !== null ||
        (active?.pendingInteractions.length ?? 0) > 0;
      if (runActive || cancelSettling) {
        if (!cancelSettling && active !== null) {
          cancelSettling = true;
          void options.presentation
            .dispatch({ type: "cancel_run", sessionId: active.session.id })
            .then((receipt) => {
              const state = options.presentation.getState();
              const current = state.authoritative.active;
              if (
                receipt.status === "rejected" ||
                (state.transient === null &&
                  current?.pendingInteractions.length === 0 &&
                  current.session.status !== "idle")
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
  tui.start();
  await exited.promise;
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
  return `${context.active.tokens}/${context.profile.contextWindowTokens} context · ${context.active.source}`;
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
