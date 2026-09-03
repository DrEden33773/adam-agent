import type { TargetDisplay, UserModelPolicyDisplay } from "@adam-agent/presentation";
import { expect, test, vi } from "vitest";

import { type ConfigurationField, ConfigurationPage } from "./configuration-page.js";
import { createAdamTuiTheme } from "./theme.js";

const modelPolicy: UserModelPolicyDisplay = {
  contextWindowTokens: null,
  maximumOutputTokens: 1_234,
  automaticCompactionWindowTokens: null,
};

const target: TargetDisplay = {
  targetId: "deepseek-v4-flash.direct",
  label: "DeepSeek V4 Flash",
  provider: "deepseek",
  displayName: "DeepSeek V4 Flash",
  summary: "Fast general-purpose coding model.",
  capabilities: ["reasoning", "tool-use"],
  modalities: ["text"],
  recommended: true,
  route: "direct",
  certification: "Certified",
  readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
  thinking: null,
  context: {
    official: contextProfile(1_000_000, 384_000, 900_000),
    effective: contextProfile(1_000_000, 1_234, 900_000),
    source: {
      contextWindowTokens: "default",
      maximumOutputTokens: "user",
      compactAtTokens: "default",
    },
    diagnostic: null,
  },
};

test("Escape closes owner-local configuration without resetting a field", () => {
  const onClose = vi.fn();
  const onReset = vi.fn();
  const page = createPage(onClose, onReset);

  page.handleInput("\u001b");

  expect(onClose).toHaveBeenCalledOnce();
  expect(onReset).not.toHaveBeenCalled();
});

test("Enter resets exactly the focused owner-local policy field", () => {
  const onClose = vi.fn();
  const onReset = vi.fn();
  const page = createPage(onClose, onReset);

  page.handleInput("\u001b[B");
  page.handleInput("\r");

  expect(onReset).toHaveBeenCalledOnce();
  expect(onReset).toHaveBeenCalledWith("maximumOutputTokens");
  expect(onClose).not.toHaveBeenCalled();
});

test("Web Search is one configuration row whose editor keeps endpoint activation explicit", () => {
  const onClose = vi.fn();
  const onReset = vi.fn();
  const onEditWebSearch = vi.fn();
  const page = createPage(onClose, onReset, onEditWebSearch);

  const rendered = page.render(100).join("\n");
  expect(rendered).toContain("Web Search");
  expect(rendered).toContain("Unconfigured · Fetch, open, and find remain available");
  page.handleInput("\u001b[B");
  page.handleInput("\u001b[B");
  page.handleInput("\u001b[B");
  page.handleInput("\r");

  expect(onEditWebSearch).toHaveBeenCalledOnce();
  expect(onReset).not.toHaveBeenCalled();
});

function createPage(
  onClose: () => void,
  onReset: (field: ConfigurationField) => void,
  onEditWebSearch = vi.fn(),
): ConfigurationPage {
  return new ConfigurationPage({
    diagnostic: null,
    modelPolicy,
    onClose,
    onEditWebSearch,
    onReset,
    target,
    theme: createAdamTuiTheme(true),
    webSearch: {
      status: "Unconfigured",
      endpoint: null,
      syntheticDnsRange: null,
      diagnostic: null,
    },
  });
}

function contextProfile(
  contextWindowTokens: number,
  maximumOutputTokens: number,
  compactAtTokens: number,
) {
  return {
    version: 1,
    contextWindowTokens,
    maximumOutputTokens,
    compactAtTokens,
    postCompactTargetTokens: 400_000,
    retainedTargetTokens: 200_000,
    estimatorVersion: 1,
  };
}
