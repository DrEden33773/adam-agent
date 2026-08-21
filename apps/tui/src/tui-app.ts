import type { PresentationSession, RepositoryInstructionsDisplay } from "@adam-agent/presentation";
import {
  Box,
  Container,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

import {
  type ClipboardAdapter,
  copyDraftToClipboard,
  type DeadlineScheduler,
  ExitArm,
  LegacyDuplicateGuard,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { mcpAdvanceCommand } from "./mcp-advance.js";
import { McpWizard } from "./mcp-wizard.js";
import { PermissionOverlay } from "./permission-overlay.js";
import { ProjectPathPicker } from "./project-path-picker.js";
import { safeTerminalText } from "./safe-terminal-text.js";
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
  const editor = new Editor(tui, theme.editor, { paddingX: 1 });
  const statusLine = new Text();
  const footer = new Text();
  const working = new Loader(tui, theme.toolTitle, theme.muted, "Working", { intervalMs: 80 });
  let workingVisible = false;
  let cancelSettling = false;
  let requestPolicyRender: () => void = () => undefined;
  const exitArm = new ExitArm(deadlineScheduler, () => requestPolicyRender());
  const legacyDuplicateGuard = new LegacyDuplicateGuard(deadlineScheduler);
  let previousRunActive: boolean | undefined;
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
  const selectedSkills = new Set<string>();
  let previousActiveSessionId = options.presentation.getState().authoritative.active?.session.id;
  let sessionPickerDismissed = false;
  let targetPickerDismissed = false;
  let defaultTargetAttempted = false;
  let defaultTargetRejected = false;
  let startupTargetFailure: string | null = null;
  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(transcript);
  root.addChild(editor);
  root.addChild(statusLine);
  root.addChild(footer);
  tui.addChild(root);
  tui.setFocus(editor);

  const clearExitWindow = () => {
    exitArm.reset();
    legacyDuplicateGuard.reset();
  };

  const renderState = () => {
    const state = options.presentation.getState();
    const active = state.authoritative.active;
    if (active?.session.id !== previousActiveSessionId) {
      selectedSkills.clear();
      skillPalette?.hide();
      skillPalette = undefined;
      pathPicker?.hide();
      pathPicker = undefined;
      mcpWizard?.hide();
      mcpWizard = undefined;
      if (active !== null) {
        sessionPickerDismissed = false;
        targetPickerDismissed = false;
      }
      previousActiveSessionId = active?.session.id;
    }
    if (active?.mcp !== null && active?.mcp !== undefined && mcpWizard !== undefined) {
      mcpWizard.wizard.setState(active.mcp);
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
    if (active !== null && targetPicker !== undefined) {
      targetPicker.hide();
      targetPicker = undefined;
      tui.setFocus(editor);
    }
    if (active !== null && sessionPicker !== undefined) {
      sessionPicker.hide();
      sessionPicker = undefined;
      tui.setFocus(editor);
    } else if (needsSessionChoice && sessionPicker === undefined && !sessionPickerDismissed) {
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        sessionPicker = undefined;
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
          sessionPicker?.hide();
          sessionPicker = undefined;
          renderState();
        },
        onSelect(session) {
          void options.presentation
            .dispatch({ type: "select_session", sessionId: session.id })
            .then((receipt) => {
              if (receipt.status === "rejected" && sessionPicker?.picker === picker) {
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
      active === null &&
      !needsSessionChoice &&
      targetPicker === undefined &&
      !targetPickerDismissed &&
      (startupTargetId === null || startupTargetId === undefined || defaultTargetRejected) &&
      state.authoritative.targets.items.length > 0
    ) {
      let handle: { hide(): void } | undefined;
      const close = () => {
        handle?.hide();
        targetPicker = undefined;
        targetPickerDismissed = true;
        statusMessage = "Target selection closed.";
        tui.setFocus(editor);
        tui.requestRender();
      };
      const picker = new TargetPicker({
        targets: state.authoritative.targets.items,
        theme,
        onClose: close,
        ...(state.authoritative.targets.diagnostic !== null
          ? { initialNotice: state.authoritative.targets.diagnostic.message }
          : startupTargetFailure === null
            ? {}
            : { initialNotice: startupTargetFailure }),
        onSelect(target) {
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
              if (receipt.status === "rejected" && targetPicker?.picker === picker) {
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
      } else if (item.type === "assistant_message" && item.text !== null) {
        transcript.addChild(new Spacer(1));
        transcript.addChild(new Markdown(safeTerminalText(item.text), 0, 0, theme.markdown));
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
        transcript.addChild(new Spacer(1));
        transcript.addChild(tool);
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
      tui.setFocus(editor);
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
    if (active === null || runActive) {
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
              `${safeTerminalText(active.session.targetId)} · ${
                state.authoritative.targets.items.find(
                  (target) => target.targetId === active.session.targetId,
                )?.certification ??
                options.targetStatus?.certification ??
                "Experimental"
              }${
                selectedSkills.size === 0
                  ? ""
                  : ` · ${selectedSkills.size} Skill${selectedSkills.size === 1 ? "" : "s"} selected`
              }${active.transcript.olderCursor === null ? "" : " · older history available"}`,
            ),
    );
    statusLine.setText(statusMessage === null ? "" : theme.muted(safeTerminalText(statusMessage)));
    tui.requestRender();
  };
  requestPolicyRender = renderState;
  renderState();
  const unsubscribe = options.presentation.subscribe(renderState);
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
      editor.getExpandedText().endsWith("@")
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
  editor.onSubmit = (text) => {
    const active = options.presentation.getState().authoritative.active;
    if (active === null || text.trim().length === 0 || editor.disableSubmit) {
      return;
    }
    clearExitWindow();
    editor.disableSubmit = true;
    if (text.trim() === "/name --clear") {
      void options.presentation
        .dispatch({
          type: "clear_session_manual_name",
          sessionId: active.session.id,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    if (text.trim() === "/name --generate") {
      void options.presentation
        .dispatch({ type: "regenerate_session_title", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    if (text.trim() === "/instructions") {
      statusMessage = repositoryStatusText(active.repositoryInstructions);
      editor.addToHistory(text);
      editor.setText("");
      editor.disableSubmit = false;
      renderState();
      return;
    }
    if (text.trim() === "/instructions reload") {
      void options.presentation
        .dispatch({
          type: "reload_repository_instructions",
          sessionId: active.session.id,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    if (text.trim() === "/skills reload") {
      void options.presentation
        .dispatch({ type: "reload_skills", sessionId: active.session.id })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    if (text.trim() === "/mcp") {
      editor.addToHistory(text);
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
    if (text.trim() === "/skills") {
      const catalog = active.skills;
      editor.addToHistory(text);
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
    if (text.trim() === "/history") {
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
            editor.addToHistory(text);
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
    if (text.trim() === "/branch") {
      const source = active.transcript.items.findLast(
        (item) => item.branchBoundary !== null,
      )?.branchBoundary;
      if (source === null || source === undefined) {
        editor.disableSubmit = false;
        tui.requestRender();
        return;
      }
      void options.presentation
        .dispatch({
          type: "branch_session",
          parentSessionId: active.session.id,
          sourceBoundary: source,
          targetId: null,
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    if (text.startsWith("/name ") && text.slice("/name ".length).trim().length > 0) {
      void options.presentation
        .dispatch({
          type: "set_session_manual_name",
          sessionId: active.session.id,
          name: text.slice("/name ".length),
        })
        .then((receipt) => {
          if (receipt.status === "admitted") {
            editor.addToHistory(text);
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
    void options.presentation
      .dispatch({
        type: "submit_prompt",
        sessionId: active.session.id,
        text,
        skills: [...selectedSkills],
      })
      .then((receipt) => {
        if (receipt.status === "admitted") {
          editor.addToHistory(text);
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
    skillPalette?.hide();
    pathPicker?.hide();
    mcpWizard?.hide();
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
    if (matchesKey(data, Key.ctrl("q"))) {
      void stop(true);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return { consume: true };
      }
      if (data === "\u0003" && !legacyDuplicateGuard.admit()) {
        return { consume: true };
      }
      const closeOverlay =
        mcpWizard?.close ??
        pathPicker?.close ??
        skillPalette?.close ??
        sessionPicker?.close ??
        targetPicker?.close;
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
