import { SelectList, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { McpWizard } from "./mcp-wizard.js";
import { OverlayFrame } from "./overlay-frame.js";
import { SessionPicker } from "./session-picker.js";
import { createAdamTuiTheme } from "./theme.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

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
    await terminal.nextOutputContaining("\u001b[?2026l");
    let offset = terminal.output().length;
    terminal.resize(120, 40);
    await terminal.nextSynchronizedFrameContaining("New Session", offset);
    offset = terminal.output().length;
    terminal.resize(40, 12);
    await terminal.nextSynchronizedFrameContaining("New Session", offset);
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
