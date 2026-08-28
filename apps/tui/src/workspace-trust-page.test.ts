import { expect, test, vi } from "vitest";

import { createAdamTuiTheme } from "./theme.js";
import { WorkspaceTrustPage } from "./workspace-trust-page.js";

test("workspace trust confirmation defaults Enter to cancel", () => {
  const onClose = vi.fn();
  const onChange = vi.fn();
  const page = new WorkspaceTrustPage({
    diagnostic: null,
    onChange,
    onClose,
    projectId: `sha256:${"a".repeat(64)}`,
    projectLabel: "fixture",
    status: "untrusted",
    theme: createAdamTuiTheme(true),
  });

  page.handleInput("\r");

  expect(onClose).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});

test("startup workspace trust defaults Enter to No and admits only an explicit Yes", () => {
  const onClose = vi.fn();
  const onChange = vi.fn();
  const page = new WorkspaceTrustPage({
    diagnostic: null,
    mode: "startup",
    onChange,
    onClose,
    projectId: `sha256:${"b".repeat(64)}`,
    projectLabel: "untrusted-project",
    status: "untrusted",
    theme: createAdamTuiTheme(true),
  });

  expect(page.render(80).join("\n")).toContain("Workspace trust required");
  expect(page.render(80).join("\n")).toContain("No — Exit Adam");
  expect(page.render(80).join("\n")).toContain("Yes — Trust and continue");
  page.handleInput("\r");
  expect(onClose).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();

  onClose.mockClear();
  page.handleInput("\u001b[B");
  page.handleInput("\r");
  expect(onChange).toHaveBeenCalledWith(true);
  expect(onClose).not.toHaveBeenCalled();
});

test("narrow startup trust keeps both decisions inside the first bounded content rows", () => {
  const page = new WorkspaceTrustPage({
    diagnostic: null,
    mode: "startup",
    onChange() {},
    onClose() {},
    projectId: `sha256:${"e".repeat(64)}`,
    projectLabel: "narrow-project",
    status: "untrusted",
    theme: createAdamTuiTheme(true),
  });

  const bounded = page.render(28).slice(0, 7).join("\n");
  expect(bounded).toContain("No — Exit Adam");
  expect(bounded).toContain("Yes — Trust and continue");
});

test("startup workspace trust uses permission-semantic colors for No and Yes", () => {
  const page = new WorkspaceTrustPage({
    diagnostic: null,
    mode: "startup",
    onChange() {},
    onClose() {},
    projectId: `sha256:${"d".repeat(64)}`,
    projectLabel: "colored-project",
    status: "untrusted",
    theme: createAdamTuiTheme(false),
  });

  const rendered = page.render(80).join("\n");
  expect(rendered).toContain("\u001b[38;2;243;139;168mNo — Exit Adam\u001b[39m");
  expect(rendered).toContain("\u001b[38;2;166;227;161mYes — Trust and continue\u001b[39m");
});

test("unavailable startup trust exposes only the fail-closed exit", () => {
  const onClose = vi.fn();
  const onChange = vi.fn();
  const page = new WorkspaceTrustPage({
    diagnostic: { code: "workspace_trust_unavailable", message: "Owner trust is unavailable." },
    mode: "startup",
    onChange,
    onClose,
    projectId: `sha256:${"c".repeat(64)}`,
    projectLabel: "unavailable-project",
    status: "unavailable",
    theme: createAdamTuiTheme(true),
  });

  const rendered = page.render(80).join("\n");
  expect(rendered).toContain("No — Exit Adam");
  expect(rendered).not.toContain("Yes — Trust and continue");
  page.handleInput("\u001b[B");
  page.handleInput("\r");
  expect(onClose).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});
