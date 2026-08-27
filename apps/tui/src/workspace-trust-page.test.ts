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
