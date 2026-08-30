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
