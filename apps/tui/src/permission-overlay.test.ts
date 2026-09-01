import type { PendingInteraction } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { PermissionOverlay } from "./permission-overlay.js";
import { createAdamTuiTheme } from "./theme.js";

test("Plan shell permission renders the exact command and truthful execution warning", () => {
  const interaction: PendingInteraction = {
    type: "permission",
    requestId: "run:plan-shell",
    callId: "plan-shell",
    effect: "execute",
    subject: { type: "command", value: "unknown --diagnose" },
    warning:
      "Plan parsing is not a sandbox. Approval may run project code, write cache or artifacts, read accessible data, or use network.",
    canAllow: true,
    changePreviewRef: null,
  };
  const overlay = new PermissionOverlay({
    interaction,
    onDecision() {},
    theme: createAdamTuiTheme(true),
  });
  overlay.setPreview({ readable: true, text: "No preview available." });

  const rendered = overlay.render(200).join("\n");

  expect(rendered).toContain("Action execute · Subject unknown --diagnose");
  expect(rendered).toContain("Plan parsing is not a sandbox.");
  expect(rendered).toContain(
    "Approval may run project code, write cache or artifacts, read accessible data, or use network.",
  );
  expect(rendered).toContain("Allow");
  expect(rendered).toContain("Deny");
});

test("Plan shell permission preserves the exact command and complete warning at 80 columns", () => {
  const command = `unknown --diagnose ${"x".repeat(100)}`;
  const warning =
    "Plan parsing is not a sandbox. Approval may run project code, write cache or artifacts, read accessible data, or use network.";
  const overlay = new PermissionOverlay({
    interaction: {
      type: "permission",
      requestId: "run:plan-shell-narrow",
      callId: "plan-shell-narrow",
      effect: "execute",
      subject: { type: "command", value: command },
      warning,
      canAllow: true,
      changePreviewRef: null,
    },
    onDecision() {},
    theme: createAdamTuiTheme(true),
  });
  overlay.setPreview({ readable: true, text: "No preview available." });

  const lines = overlay.render(80);
  const withoutVisualLineBreaks = lines.join("");

  expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  expect(withoutVisualLineBreaks).toContain(`Action execute · Subject ${command}`);
  expect(withoutVisualLineBreaks).toContain(warning);
});

test("Plan shell permission renders a reversible exact representation of unsafe raw text", () => {
  const command = "unknown\t--diagnose\u202e";
  const overlay = new PermissionOverlay({
    interaction: {
      type: "permission",
      requestId: "run:plan-shell-unsafe",
      callId: "plan-shell-unsafe",
      effect: "execute",
      subject: { type: "command", value: command },
      canAllow: true,
      changePreviewRef: null,
    },
    onDecision() {},
    theme: createAdamTuiTheme(true),
  });
  overlay.setPreview({ readable: true, text: "No preview available." });

  const withoutVisualLineBreaks = overlay.render(80).join("");

  expect(withoutVisualLineBreaks).toContain(
    'Action execute · Subject "unknown\\t--diagnose\\u202e"',
  );
  expect(withoutVisualLineBreaks).not.toContain("unknown  --diagnose");
});

test("Web permission shows the exact URL and public-operator warning without truncating authority", () => {
  const overlay = new PermissionOverlay({
    interaction: {
      type: "permission",
      requestId: "web-permission",
      callId: "web-fetch",
      effect: "network",
      subject: { type: "generic", value: "https://docs.example.test/evidence?q=exact" },
      warning:
        "This public operator can receive this exact Web request and network address. Adam will not verify, replace, or fall back from this endpoint.",
      canAllow: true,
      changePreviewRef: null,
    },
    onDecision() {},
    theme: createAdamTuiTheme(true),
  });
  overlay.setPreview({ readable: true, text: "No workspace mutation preview is required." });

  const rendered = overlay.render(200).join("\n").replace(/\s+/gu, " ");
  expect(rendered).toContain("Action network · Subject https://docs.example.test/evidence?q=exact");
  expect(rendered).toContain(
    "This public operator can receive this exact Web request and network address. Adam will not verify, replace, or fall back from this endpoint.",
  );
});

test("long Web authority pages while warning and Allow or Deny controls stay visible", () => {
  const exactSubject = `https://search.example.test · query ${JSON.stringify("q".repeat(4 * 1024))} · limit 10`;
  const overlay = new PermissionOverlay({
    interaction: {
      type: "permission",
      requestId: "long-web-permission",
      callId: "long-web-search",
      effect: "network",
      subject: { type: "generic", value: exactSubject },
      warning:
        "This public operator can receive this exact Web request and network address. Adam will not verify, replace, or fall back from this endpoint.",
      canAllow: true,
      changePreviewRef: null,
    },
    onDecision() {},
    theme: createAdamTuiTheme(true),
  });
  overlay.setPreview({ readable: true, text: "No workspace mutation preview is required." });

  const first = overlay.render(80).join("\n");
  expect(first).toContain("Subject 1-4 of");
  expect(first).toContain("This public operator can receive this exact Web request");
  expect(first).toContain("Allow");
  expect(first).toContain("Deny");
  expect(first.length).toBeLessThan(4 * 1024);
  overlay.handleInput("\u001b[6~");
  const second = overlay.render(80).join("\n");
  expect(second).toContain("Subject 5-8 of");
  expect(second).not.toBe(first);
  expect(second).toContain("Allow");
  expect(second).toContain("Deny");
  overlay.setPreview({
    readable: true,
    text: Array.from({ length: 20 }, (_, index) => `preview line ${index + 1}`).join("\n"),
  });
  for (let page = 0; page < 100; page += 1) {
    overlay.handleInput("\u001b[6~");
  }
  const finalPage = overlay.render(80).join("\n");
  expect(finalPage).toContain("limit 10");
  expect(finalPage).toMatch(/Preview (?:9|13)-/u);
});
