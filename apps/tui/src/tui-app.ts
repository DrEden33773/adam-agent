import type { PresentationSession } from "@adam-agent/presentation";
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
import { PermissionOverlay } from "./permission-overlay.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { createAdamTuiTheme } from "./theme.js";

export type { ClipboardAdapter, DeadlineScheduler } from "./exit-policy.js";

export type TuiTargetStatus = {
  readonly certification: "Certified" | "Experimental";
  readonly targetId: string;
};

export type RunTuiOptions = {
  readonly presentation: PresentationSession;
  readonly targetStatus: TuiTargetStatus;
  readonly terminal?: Terminal;
  readonly clipboard?: ClipboardAdapter;
  readonly deadlineScheduler?: DeadlineScheduler;
};

export async function runTui(options: RunTuiOptions): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const deadlineScheduler = options.deadlineScheduler ?? nodeDeadlineScheduler;
  const tui: TUI = new TuiMainScreen(terminal, true);
  const theme = createAdamTuiTheme();
  const root = new Container();
  const header = new Text();
  const transcript = new Container();
  const editor = new Editor(tui, theme.editor, { paddingX: 1 });
  const footer = new Text();
  const working = new Loader(tui, theme.toolTitle, theme.muted, "Working", { intervalMs: 80 });
  let workingVisible = false;
  let cancelSettling = false;
  let requestPolicyRender: () => void = () => undefined;
  const exitArm = new ExitArm(deadlineScheduler, () => requestPolicyRender());
  const legacyDuplicateGuard = new LegacyDuplicateGuard(deadlineScheduler);
  let previousRunActive: boolean | undefined;
  let permission:
    | {
        readonly overlay: PermissionOverlay;
        readonly requestId: string;
        readonly hide: () => void;
      }
    | undefined;
  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(transcript);
  root.addChild(editor);
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
    if (runActive) {
      editor.disableSubmit = true;
    } else if (active?.session.status === "settled" || active?.session.status === "interrupted") {
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
          ? "No active session"
          : theme.muted(
              `${safeTerminalText(active.session.targetId)} · ${options.targetStatus.certification}`,
            ),
    );
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
  };
  editor.onSubmit = (text) => {
    const active = options.presentation.getState().authoritative.active;
    if (active === null || text.trim().length === 0 || editor.disableSubmit) {
      return;
    }
    clearExitWindow();
    editor.disableSubmit = true;
    void options.presentation
      .dispatch({
        type: "submit_prompt",
        sessionId: active.session.id,
        text,
        skills: [],
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
