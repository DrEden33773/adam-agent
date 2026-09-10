import { SelectList, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { McpWizard } from "./mcp-wizard.js";
import { OverlayFrame } from "./overlay-frame.js";
import { SessionPicker } from "./session-picker.js";
import { createAdamTuiTheme } from "./theme.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test("late restored rows preserve explicit search and per-view selection intent", () => {
  const [restored, other] = ["Restored", "Other"].map((label) => ({
    id: label,
    label,
    targetId: "fixture",
    status: "settled" as const,
    naming: {
      manualName: label,
      generatedTitle: null,
      fallbackTitle: label,
      displayLabel: label,
      generation: { status: "not_started" as const },
    },
  }));
  if (restored === undefined || other === undefined) throw new Error("Missing picker fixtures.");
  const onSelect = vi.fn();
  const onNewSession = vi.fn();
  const picker = new SessionPicker({
    sessions: [],
    hasMore: false,
    view: "active",
    loading: true,
    theme: createAdamTuiTheme(true),
    onSelect,
    onNewSession,
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
  });
  picker.rememberSession(restored.id, "active");
  picker.setCatalog({ sessions: [other], hasMore: false, view: "active", loading: true });
  picker.handleInput("\r");
  expect(onNewSession).not.toHaveBeenCalled();
  picker.handleInput("Other");
  picker.handleInput("\r");
  expect(onSelect).toHaveBeenLastCalledWith(other);
  picker.setCatalog({
    sessions: [restored, other],
    hasMore: false,
    view: "active",
    loading: false,
  });
  expect(picker.render(80).join("\n")).toContain("> Other");
  picker.setCatalog({ sessions: [restored], hasMore: false, view: "archived", loading: false });
  for (let i = 0; i < "Other".length; i++) picker.handleInput("\u007f");
  picker.handleInput("Restored");
  expect(picker.render(80).join("\n")).toContain("> Restored");
  picker.setCatalog({
    sessions: [restored, other],
    hasMore: false,
    view: "active",
    loading: false,
  });
  expect(picker.render(80).join("\n")).toContain("Search: Other");
  expect(picker.render(80).join("\n")).toContain("> Other");
});

test.each([40, 80, 120])(
  "archive picker actions preserve search and exact revision at %i columns",
  (width) => {
    const session = {
      id: "00000000-0000-4000-8000-000000000001",
      label: "Named history",
      targetId: "test",
      status: "settled" as const,
      naming: {
        manualName: "Named history",
        generatedTitle: null,
        fallbackTitle: "History",
        displayLabel: "Named history",
        generation: { status: "not_started" as const },
      },
    };
    const onArchive = vi.fn();
    const onView = vi.fn();
    const onUndo = vi.fn();
    const picker = new SessionPicker({
      sessions: [session],
      hasMore: false,
      view: "active",
      visibility: { status: "ready", revision: 7, archived: [] },
      theme: createAdamTuiTheme(true),
      onArchive,
      onView,
      onUndo,
      onNewSession: vi.fn(),
      onLoadMore: vi.fn(),
      onRename: vi.fn(),
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    picker.handleInput("Named");
    picker.handleInput("\u0001");
    expect(onArchive).toHaveBeenLastCalledWith(session, "archived", 7);
    picker.handleInput("\t");
    expect(onView).toHaveBeenLastCalledWith("archived");
    picker.setCatalog({
      sessions: [session],
      hasMore: false,
      view: "archived",
      visibility: { status: "ready", revision: 8, archived: [session.id] },
    });
    picker.handleInput("\u0001");
    expect(onArchive).toHaveBeenLastCalledWith(session, "active", 8);
    picker.handleInput("\u0015");
    expect(onUndo).toHaveBeenCalledOnce();
    picker.setNotice(
      "Child work is waiting. Close this list and open Agents to inspect or stop it.",
    );
    const lines = picker.render(width);
    expect(lines.join("\n")).toContain("Search: Named");
    expect(lines.join("\n")).toContain("[Archived]");
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("\u001b[");
    picker.setCatalog({
      sessions: [session],
      hasMore: false,
      visibility: {
        status: "unknown",
        message: "Archive state is unknown; retained history is available for inspection.",
      },
    });
    picker.handleInput("\u0001");
    expect(onArchive).toHaveBeenCalledTimes(2);
    expect(picker.render(width).join("\n")).toContain("archive state unknown");
  },
);

test("the pinned New Session row remains a complete narrow-width selection", () => {
  const picker = new SessionPicker({
    sessions: [
      {
        id: "session-1",
        label: "New session",
        targetId: "deepseek-v4-flash.direct",
        status: "idle",
        naming: {
          manualName: null,
          generatedTitle: null,
          fallbackTitle: "New session",
          displayLabel: "New session",
          generation: { status: "not_started" },
        },
      },
    ],
    theme: createAdamTuiTheme(false),
    onNewSession: vi.fn(),
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    hasMore: false,
  });

  const lines = new OverlayFrame(picker, createAdamTuiTheme(false)).render(36);
  const rendered = lines.join("\n");
  expect(rendered.indexOf("New Session")).toBeLessThan(rendered.indexOf("Search:"));
  const inverseStart = "\u001b[48;2;205;214;244m\u001b[38;2;17;17;27m";
  const inverseEnd = "\u001b[39m\u001b[49m";
  const pinnedLine = lines.find((line) => line.includes("> New Session"));
  expect(pinnedLine).toBeDefined();
  const pinnedStart = pinnedLine?.indexOf(inverseStart) ?? -1;
  const pinnedEnd = pinnedLine?.indexOf(inverseEnd, pinnedStart + inverseStart.length) ?? -1;
  expect(pinnedStart).toBeGreaterThanOrEqual(0);
  expect(pinnedEnd).toBeGreaterThan(pinnedStart);
  const pinnedContent = pinnedLine?.slice(pinnedStart + inverseStart.length, pinnedEnd) ?? "";
  expect(pinnedContent).toBe(`> New Session${" ".repeat(19)}`);
  expect(visibleWidth(pinnedContent)).toBe(32);
  expect(rendered).toContain("┌");
  expect(rendered).toContain("└");
  expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
});

test("the pinned row keeps explicit selection semantics without color", () => {
  const theme = createAdamTuiTheme(true);
  const picker = new SessionPicker({
    sessions: [],
    theme,
    onNewSession: vi.fn(),
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    hasMore: false,
  });

  const lines = new OverlayFrame(picker, theme).render(40);
  const rendered = lines.join("\n");
  expect(rendered).toContain("> New Session");
  expect(rendered).not.toContain("→ New Session");
  expect(rendered).toContain("Search:");
  expect(rendered).not.toContain("\u001b[38;");
  expect(rendered).not.toContain("\u001b[48;");
  expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
});

test("the shared selection list uses the same ASCII marker without changing its width", () => {
  const theme = createAdamTuiTheme(true);
  const list = new SelectList(
    [
      { value: "alpha", label: "Alpha", description: "first" },
      { value: "beta", label: "Beta", description: "second" },
    ],
    2,
    theme.editor.selectList,
  );

  const lines = list.render(80);
  expect(lines[0]).toMatch(/^> Alpha/);
  expect(lines[0]).not.toContain("→");
  expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(80);
  expect(lines[1]).toMatch(/^ {2}Beta/);
});

test("the framed picker composites into a synchronized 40-column terminal frame", async () => {
  const terminal = new VirtualTerminal();
  const theme = createAdamTuiTheme(false);
  const picker = new SessionPicker({
    sessions: [
      {
        id: "session-1",
        label: "New session",
        targetId: "deepseek-v4-flash.direct",
        status: "idle",
        naming: {
          manualName: null,
          generatedTitle: null,
          fallbackTitle: "New session",
          displayLabel: "New session",
          generation: { status: "not_started" },
        },
      },
    ],
    theme,
    onNewSession: vi.fn(),
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    hasMore: false,
  });
  const tui = new TuiMainScreen(terminal, true);
  tui.addChild(new Text("base"));
  tui.showOverlay(new OverlayFrame(picker, theme), {
    width: "80%",
    minWidth: 36,
    maxHeight: "80%",
    margin: 1,
  });

  try {
    tui.start();
    await terminal.waitForRecordedOutput("\u001b[?2026l");
    let offset = terminal.output().length;
    terminal.resize(120, 40);
    await terminal.waitForFrameAfter("New Session", offset);
    offset = terminal.output().length;
    terminal.resize(40, 12);
    await terminal.waitForFrameAfter("New Session", offset);
  } finally {
    tui.stop();
  }
});

test("the shared frame preserves both borders when overlay height is bounded", () => {
  const content = {
    invalidate() {},
    render: () => ["one", "two", "three", "four", "five", "six"],
  };
  const frame = new OverlayFrame(content, createAdamTuiTheme(true), () => 5);

  expect(frame.render(20)).toEqual([
    "┌──────────────────┐",
    "│ one              │",
    "│ two              │",
    "│ three            │",
    "└──────────────────┘",
  ]);
});

test("the MCP overlay family renders its authority title inside the shared frame", () => {
  const digest = `sha256:${"0".repeat(64)}` as const;
  const theme = createAdamTuiTheme(true);
  const wizard = new McpWizard({
    state: {
      schemaVersion: 1,
      status: "workspace_confirmation_required",
      workspaceConfirmed: false,
      source: { path: ".mcp.json", digest },
      servers: [
        {
          serverId: "fixture",
          status: "approval_required",
          transport: "stdio",
          command: { kind: "executable", path: "/usr/bin/fixture" },
          arguments: [],
          cwd: ".",
          requestedEnvironmentNames: [],
          startupEffects: ["execute"],
          definitionDigest: digest,
        },
      ],
      activation: null,
      catalog: null,
      profile: null,
      diagnostics: [],
    },
    theme,
    onAdvance: vi.fn(),
    onClose: vi.fn(),
    onCommit: vi.fn(),
  });

  const lines = new OverlayFrame(wizard, theme).render(80);
  const titleIndex = lines.findIndex((line) => line.includes("MCP authority"));
  expect(titleIndex).toBeGreaterThan(0);
  expect(lines[titleIndex]).toMatch(/│ .*MCP authority.* │/u);
  expect(lines.at(0)).toContain("┌");
  expect(lines.at(-1)).toContain("└");
});

test("the MCP wizard accepts Kitty printable classification and commit keys", () => {
  const digest = `sha256:${"0".repeat(64)}` as const;
  let height = 8;
  const onCommit = vi.fn();
  const wizard = new McpWizard({
    state: {
      schemaVersion: 1,
      status: "tool_selection_required",
      workspaceConfirmed: true,
      source: { path: ".mcp.json", digest },
      servers: [
        {
          serverId: "fixture",
          status: "ready",
          transport: "stdio",
          command: { kind: "executable", path: "/usr/bin/fixture" },
          arguments: [],
          cwd: ".",
          requestedEnvironmentNames: [],
          startupEffects: ["execute"],
          definitionDigest: digest,
        },
        {
          serverId: "fixture-two",
          status: "ready",
          transport: "stdio",
          command: { kind: "executable", path: "/usr/bin/fixture-two" },
          arguments: [],
          cwd: ".",
          requestedEnvironmentNames: [],
          startupEffects: ["execute"],
          definitionDigest: digest,
        },
      ],
      activation: { attempt: 1, generationId: "generation-1", status: "ready" },
      catalog: {
        status: "ready",
        digest,
        tools: [
          {
            serverId: "fixture",
            originalName: "inspect",
            qualifiedName: "fixture.inspect",
            description: "Inspect one exact source.",
            rawSchemaDigest: digest,
            modelProjectionDigest: digest,
            definitionDigest: digest,
          },
        ],
      },
      profile: null,
      diagnostics: [],
    },
    theme: createAdamTuiTheme(true),
    maximumContentHeight: () => height,
    onAdvance: vi.fn(),
    onClose: vi.fn(),
    onCommit,
  });

  wizard.handleInput("\u001b[49;1:1u");
  for (height of [8, 12, 13, 14]) {
    const frame = wizard.render(36);
    const rendered = frame.join("\n");
    expect(frame.length, `height ${height}`).toBeLessThanOrEqual(height);
    expect(rendered, `height ${height}`).toContain("fixture.inspect");
    expect(rendered, `height ${height}`).toContain("1 read");
    expect(rendered, `height ${height}`).toContain("6 administrative");
    expect(rendered, `height ${height}`).toContain("c commit");
  }
  wizard.handleInput("\u001b[99;1:1u");
  wizard.handleInput("\u001b[99;1:2u");
  wizard.handleInput("\u001b[99;1:3u");
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith(
    expect.objectContaining({ status: "tool_selection_required" }),
    [expect.objectContaining({ qualifiedName: "fixture.inspect", effect: "read" })],
  );
});

function namedSession(id: string, label: string) {
  return {
    id,
    label,
    targetId: "deepseek-v4-flash.direct",
    status: "idle" as const,
    naming: {
      manualName: label,
      generatedTitle: null,
      fallbackTitle: label,
      displayLabel: label,
      generation: { status: "not_started" as const },
    },
  };
}

function pickerFixture(sessions = [namedSession("alpha", "Alpha"), namedSession("beta", "Beta")]) {
  const actions = {
    onNewSession: vi.fn(),
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
  };
  const picker = new SessionPicker({
    sessions,
    hasMore: false,
    theme: createAdamTuiTheme(true),
    ...actions,
  });
  return { picker, actions };
}

test("catalog updates preserve search and selected session identity without opening a replacement", () => {
  const { picker, actions } = pickerFixture();
  picker.handleInput("a");
  picker.handleInput("\u001b[B");
  picker.setCatalog({
    sessions: [
      namedSession("new", "A new entry"),
      namedSession("beta", "Beta"),
      namedSession("alpha", "Alpha"),
    ],
    hasMore: true,
  });
  expect(picker.render(80).join("\n")).toContain("Search: a");
  expect(picker.render(80).join("\n")).toContain("> Beta");
  expect(actions.onSelect).not.toHaveBeenCalled();
  picker.handleInput("\r");
  expect(actions.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "beta" }));

  picker.setCatalog({ sessions: [namedSession("alpha", "Alpha")], hasMore: false });
  expect(actions.onSelect).toHaveBeenCalledTimes(1);
  expect(picker.render(80).join("\n")).toContain("> Alpha");
  picker.handleInput("\r");
  expect(actions.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "alpha" }));
});

test("catalog updates retain the diagnostic selection and keep incomplete checks explicit", () => {
  const { picker, actions } = pickerFixture([]);
  const diagnostic = (sessionId: string) => ({
    sessionId,
    code: "invalid_log" as const,
    stage: "read" as const,
    retained: true as const,
    message: "Invalid log retained.",
  });
  picker.setCatalog({
    sessions: [],
    hasMore: false,
    diagnostics: {
      items: [diagnostic("bad-a"), diagnostic("bad-b")],
      totalCount: 2,
      truncated: false,
    },
    health: { status: "running", checked: 2, total: 4 },
  });
  picker.handleInput("\u001b[B");
  picker.handleInput("\r");
  picker.handleInput("\u001b[B");
  picker.setCatalog({
    sessions: [],
    hasMore: false,
    diagnostics: {
      items: [diagnostic("bad-b"), diagnostic("bad-new"), diagnostic("bad-a")],
      totalCount: 3,
      truncated: false,
    },
    health: { status: "running", checked: 3, total: 4 },
  });
  const rendered = picker.render(80).join("\n");
  expect(rendered).toContain("Invalid sessions");
  expect(rendered).toContain("> bad-b");
  expect(rendered).toContain("Checking history: 3 / 4 sessions.");
  expect(rendered).not.toContain("complete");
  expect(actions.onSelect).not.toHaveBeenCalled();
});

test("a loading catalog keeps New Session, search and close available without claiming empty history", () => {
  const { picker, actions } = pickerFixture([]);
  picker.setCatalog({
    sessions: [],
    hasMore: false,
    loading: true,
    health: { status: "not_started", checked: 0, total: null },
  });
  const rendered = picker.render(36).join("\n");
  expect(rendered).toContain("New Session");
  expect(rendered).toContain("Loading sessions…");
  expect(rendered).toContain("History check not started.");
  expect(rendered).not.toContain("No matching sessions");
  picker.handleInput("query");
  expect(picker.render(80).join("\n")).toContain("Search: query");
  expect(picker.hasInteracted).toBe(true);
  picker.handleInput("\r");
  expect(actions.onNewSession).toHaveBeenCalledTimes(1);
  picker.handleInput("\u001b");
  expect(actions.onClose).toHaveBeenCalledTimes(1);
  picker.setCatalog({
    sessions: [],
    hasMore: false,
    loading: false,
    health: { status: "failed", checked: 2, total: 4 },
    error: { code: "read_failed", message: "Saved sessions could not be read." },
  });
  expect(picker.render(80).join("\n")).toContain("Saved sessions could not be read.");
  expect(picker.render(80).join("\n")).toContain("Session list unavailable");
});
