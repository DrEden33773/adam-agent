import { expect, test, vi } from "vitest";

import {
  PlanCancellationConfirmation,
  PlanContinuationSelector,
  PlanReviewSelector,
} from "./plan-review-selector.js";
import { createAdamTuiTheme } from "./theme.js";

test("the ready Plan selector presents approve, revise, and cancel as equal-level actions", () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const selector = new PlanReviewSelector({
    contentDigest: `sha256:${"a".repeat(64)}`,
    markdown: "# Exact reviewed Plan\n\n1. Inspect.\n2. Implement.\n",
    onClose,
    onSelect,
    theme: createAdamTuiTheme(false),
    title: "Exact reviewed Plan",
  });

  const rendered = selector.render(160).join("\n");
  expect(rendered).toContain("Review exact submitted plan");
  expect(rendered).toContain("Exact reviewed Plan");
  expect(rendered).toContain("# Exact reviewed Plan");
  expect(rendered).toContain(`sha256:${"a".repeat(64)}`);
  expect(rendered).toContain("Approve and implement");
  expect(rendered).toContain("Request changes…");
  expect(rendered).toContain("Cancel plan");
  expect(rendered).toContain("Esc keep ready");
  selector.handleInput("\u001b[B");
  selector.handleInput("\r");
  expect(onSelect).toHaveBeenCalledWith("revise");
  selector.handleInput("\u001b");
  expect(onClose).toHaveBeenCalledOnce();
});

test("the recovered approval selector requires an explicit Continue implementation action", () => {
  const onClose = vi.fn();
  const onContinue = vi.fn();
  const selector = new PlanContinuationSelector({
    onClose,
    onContinue,
    theme: createAdamTuiTheme(false),
  });

  const rendered = selector.render(80).join("\n");
  expect(rendered).toContain("Approved plan has not started");
  expect(rendered).toContain("Continue implementation");
  selector.handleInput("\r");
  expect(onContinue).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

test("Plan cancellation defaults to returning to review and confirms only the explicit second action", () => {
  const onBack = vi.fn();
  const onConfirm = vi.fn();
  const confirmation = new PlanCancellationConfirmation({
    onBack,
    onConfirm,
    theme: createAdamTuiTheme(false),
  });

  const rendered = confirmation.render(80).join("\n");
  expect(rendered).toContain("Cancel this exact plan?");
  expect(rendered).toContain("Return to review");
  expect(rendered).toContain("Confirm cancellation");
  confirmation.handleInput("\r");
  expect(onBack).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();

  confirmation.handleInput("\u001b[B");
  confirmation.handleInput("\r");
  expect(onConfirm).toHaveBeenCalledOnce();
});
