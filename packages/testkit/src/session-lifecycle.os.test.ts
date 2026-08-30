import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCodingToolRegistry,
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  type ModelTargets,
  type RuntimeEvent,
  SessionLifecycleError,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  assessPlanCommandExecutionV1,
  createPlanShellEnvironmentV1,
  digestPromptRequestV1,
  inputResourceIngestBarrier,
  openJsonlSessionStore,
  planShellEnvironmentFactory,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  sessionLifecycleAnswerOnlyDeepSeekStream as answerOnlyDeepSeekStream,
  sessionLifecycleBasePrompt as basePrompt,
  createSessionLifecycleForTests as createSessionLifecycle,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const lifecycleOwnerFixturePath = fileURLToPath(
  new URL("../dist/session-lifecycle-owner.fixture.js", import.meta.url),
);

type ChildObservation = {
  readonly messages: unknown[];
  stderr: string;
};

const childObservations = new WeakMap<ChildProcess, ChildObservation>();

const visionResponsesIdentity = {
  targetId: "deepseek-v4-flash-vision-exp.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash-vision-exp",
  route: "direct",
  profileVersion: 2,
  certification: "certified",
} as const;

const planTestContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
} as const;

test("SessionLifecycle hybrid Plan automatically executes one exact simple inspection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-hybrid-inspection-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  process.env[executablePathName] = "/usr/bin:/bin";
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "plan-uname", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "plan-uname",
          json: JSON.stringify({ command: "uname -s" }),
        },
        { type: "tool_call_end", id: "plan-uname" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    const completedAutomatically =
      latestMessage?.role === "tool" &&
      latestMessage.name === "run_shell" &&
      latestMessage.result.status === "completed" &&
      JSON.stringify(latestMessage.result.output) ===
        JSON.stringify({
          termination: { type: "exited", exitCode: 0 },
          stdout: { tail: "Linux\n", totalBytes: 6, omittedBytes: 0 },
          stderr: { tail: "", totalBytes: 0, omittedBytes: 0 },
        });
    return [
      {
        type: "text_delta",
        text: completedAutomatically
          ? "The Plan inspection completed automatically."
          : "The Plan inspection did not complete automatically.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: planTestContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: planTestContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect the Linux system name without changing anything." },
      limits: { maxTurns: 2 },
    });

    expect({
      result: continued.result,
      plan: continued.snapshot.plan,
      permissionRequests: events.filter((event) => event.type === "tool_permission_requested")
        .length,
      permissionSubject: events.find((event) => event.type === "tool_permission_requested")
        ?.subject,
      toolStarted: events.some(
        (event) =>
          event.type === "tool_started" &&
          event.callId === "plan-uname" &&
          event.name === "run_shell",
      ),
    }).toMatchObject({
      result: { status: "completed", answer: "The Plan inspection completed automatically." },
      plan: {
        state: "exploring",
        policyVersion: "plan-policy.hybrid-v1",
        shellPolicyVersion: "plan-shell-policy.v1",
      },
      permissionRequests: 0,
      permissionSubject: undefined,
      toolStarted: true,
    });
  } finally {
    await lifecycle.close();
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan durably freezes its shell environment identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-shell-environment-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const { PATH: executablePath = "" } = process.env;
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: created.sessionId });

    expect(entered.plan).toMatchObject({
      policyVersion: "plan-policy.hybrid-v1",
      shellPolicyVersion: "plan-shell-policy.v1",
      shellEnvironment: {
        version: "plan-shell-env.v1",
        pathEntries: executablePath.split(":"),
        variables: {
          PATH: executablePath,
          LANG: "C",
          LC_ALL: "C",
          TERM: "dumb",
        },
        home: { allocation: "owner-only-empty-per-call" },
        shell: {
          lookupPath: "/bin/sh",
          canonicalPath: "/usr/bin/dash",
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan executes an approved call with only its frozen environment", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-shell-execution-env-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const sentinelName = "ADAM_PLAN_SECRET_SENTINEL";
  const previousSentinel = process.env[sentinelName];
  const { PATH: executablePath = "" } = process.env;
  process.env[sentinelName] = "must-not-reach-plan-shell";
  await mkdir(workspaceRoot);
  const canonicalTemporaryRoot = await realpath(tmpdir());
  let requestCount = 0;
  const command = `/usr/bin/env && /usr/bin/stat -c 'HOME_MODE=%a' "$HOME" && /usr/bin/find "$HOME" -mindepth 1 -print`;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "plan-env", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "plan-env",
          json: JSON.stringify({ command }),
        },
        { type: "tool_call_end", id: "plan-env" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    const toolOutput =
      latestMessage?.role === "tool" &&
      latestMessage.name === "run_shell" &&
      latestMessage.result.status === "completed" &&
      typeof latestMessage.result.output === "object" &&
      latestMessage.result.output !== null
        ? (latestMessage.result.output as { readonly stdout?: { readonly tail?: unknown } })
        : undefined;
    const stdout = toolOutput?.stdout;
    const lines = typeof stdout?.tail === "string" ? stdout.tail.trimEnd().split("\n") : [];
    const environment = Object.fromEntries(
      lines
        .filter((line) => line.includes("=") && !line.startsWith("HOME_MODE="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const {
      PATH: observedPath,
      LANG: observedLang,
      LC_ALL: observedLcAll,
      TERM: observedTerm,
      TMPDIR: observedTemporaryRoot,
      HOME: observedHome,
    } = environment;
    return [
      {
        type: "text_delta",
        text:
          observedPath === executablePath &&
          observedLang === "C" &&
          observedLcAll === "C" &&
          observedTerm === "dumb" &&
          observedTemporaryRoot === canonicalTemporaryRoot &&
          environment[sentinelName] === undefined &&
          observedHome?.startsWith(`${canonicalTemporaryRoot}/adam-agent-shell-home-`) === true &&
          lines.at(-1) === "HOME_MODE=700"
            ? "The approved Plan shell used only its frozen environment."
            : "The approved Plan shell environment drifted.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: planTestContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: planTestContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect the frozen Plan shell environment." },
      limits: { maxTurns: 2 },
    });
    const request = events.find(
      (event) => event.type === "tool_permission_requested" && event.callId === "plan-env",
    );

    expect({ result: continued.result, request }).toMatchObject({
      result: {
        status: "completed",
        answer: "The approved Plan shell used only its frozen environment.",
      },
      request: {
        subject: {
          type: "plan_command",
          shellEnvironmentVersion: "plan-shell-env.v1",
          shellEnvironmentDigest: entered.plan?.shellEnvironment?.digest,
        },
      },
    });
  } finally {
    if (previousSentinel === undefined) {
      delete process.env[sentinelName];
    } else {
      process.env[sentinelName] = previousSentinel;
    }
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan asks before a workspace PATH shadow can execute", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-shell-shadow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const executableRoot = join(workspaceRoot, "bin");
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  await mkdir(executableRoot, { recursive: true });
  await writeFile(
    join(executableRoot, "uname"),
    "#!/bin/sh\n/usr/bin/printf 'shadowed\\n'\n",
    "utf8",
  );
  await chmod(join(executableRoot, "uname"), 0o755);
  process.env[executablePathName] = `${executableRoot}:/usr/bin:/bin`;
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "plan-shadow", name: "run_shell" },
        { type: "tool_call_delta", id: "plan-shadow", json: '{"command":"uname -s"}' },
        { type: "tool_call_end", id: "plan-shadow" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    const shadowExecuted =
      latestMessage?.role === "tool" &&
      latestMessage.name === "run_shell" &&
      latestMessage.result.status === "completed" &&
      typeof latestMessage.result.output === "object" &&
      latestMessage.result.output !== null &&
      JSON.stringify(latestMessage.result.output).includes("shadowed\\n");
    return [
      {
        type: "text_delta",
        text: shadowExecuted
          ? "The PATH shadow executed only after exact approval."
          : "The PATH shadow did not execute as approved.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: planTestContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: planTestContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect the system identity." },
      limits: { maxTurns: 2 },
    });
    const requests = events.filter(
      (event) => event.type === "tool_permission_requested" && event.callId === "plan-shadow",
    );

    expect({ result: continued.result, requests }).toMatchObject({
      result: {
        status: "completed",
        answer: "The PATH shadow executed only after exact approval.",
      },
      requests: [
        {
          subject: {
            type: "plan_command",
            assessment: {
              disposition: "ask_ambiguous",
              reasons: ["environment_untrusted"],
            },
          },
        },
      ],
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan hard-denies one recognized shell mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-hybrid-mutation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const markerPath = join(workspaceRoot, "forbidden.txt");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "plan-touch", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "plan-touch",
          json: JSON.stringify({ command: "touch forbidden.txt" }),
        },
        { type: "tool_call_end", id: "plan-touch" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    const deniedByPlan =
      latestMessage?.role === "tool" &&
      latestMessage.name === "run_shell" &&
      latestMessage.result.status === "failed" &&
      latestMessage.result.error.code === "permission_denied";
    return [
      {
        type: "text_delta",
        text: deniedByPlan
          ? "The shell mutation was denied by Plan."
          : "The shell mutation escaped Plan denial.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: planTestContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: planTestContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Try to create forbidden.txt while Plan is active." },
      limits: { maxTurns: 2 },
    });

    expect({
      result: continued.result,
      permissionRequests: events.filter((event) => event.type === "tool_permission_requested")
        .length,
      toolStarted: events.some(
        (event) => event.type === "tool_started" && event.callId === "plan-touch",
      ),
    }).toEqual({
      result: { status: "completed", answer: "The shell mutation was denied by Plan." },
      permissionRequests: 0,
      toolStarted: false,
    });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan asks once for one exact ambiguous diagnostic", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-hybrid-ambiguous-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const command = "/usr/bin/printf 'approved diagnostic\\n'";
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  process.env[executablePathName] = "/usr/bin:/bin";
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "plan-diagnostic", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "plan-diagnostic",
          json: JSON.stringify({ command }),
        },
        { type: "tool_call_end", id: "plan-diagnostic" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    const approvedExactCall =
      latestMessage?.role === "tool" &&
      latestMessage.name === "run_shell" &&
      latestMessage.result.status === "completed" &&
      JSON.stringify(latestMessage.result.output) ===
        JSON.stringify({
          termination: { type: "exited", exitCode: 0 },
          stdout: { tail: "approved diagnostic\n", totalBytes: 20, omittedBytes: 0 },
          stderr: { tail: "", totalBytes: 0, omittedBytes: 0 },
        });
    return [
      {
        type: "text_delta",
        text: approvedExactCall
          ? "The exact ambiguous diagnostic was approved once."
          : "The ambiguous diagnostic approval was not exact.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: planTestContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: planTestContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: created.sessionId });
    const plan = entered.plan;
    if (plan === undefined) {
      throw new Error("Expected the entered hybrid Plan cycle.");
    }
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Run the exact diagnostic only after asking me." },
      limits: { maxTurns: 2 },
    });
    const permissionRequest = events.find(
      (event) => event.type === "tool_permission_requested" && event.callId === "plan-diagnostic",
    );

    expect({ result: continued.result, permissionRequest }).toMatchObject({
      result: {
        status: "completed",
        answer: "The exact ambiguous diagnostic was approved once.",
      },
      permissionRequest: {
        name: "run_shell",
        effect: "execute",
        scope: "call",
        subject: {
          type: "plan_command",
          command,
          cwd: ".",
          planCycleId: plan.cycleId,
          planPolicyVersion: "plan-policy.hybrid-v1",
          shellPolicyVersion: "plan-shell-policy.v1",
          toolProfileDigest: plan.eligibleToolProfile.digest,
          assessment: {
            disposition: "ask_ambiguous",
            reasons: ["unclassified_command"],
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          },
        },
      },
    });
    expect(
      events.filter(
        (event) => event.type === "tool_permission_requested" && event.callId === "plan-diagnostic",
      ),
    ).toHaveLength(1);
  } finally {
    await lifecycle.close();
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold resume reads an immutable input resource after its source is deleted", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "cold-source.txt");
  const runId = "30000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  const content = "Cold resume keeps these immutable bytes.\n";
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "text_delta", text: "The immutable resource is linked." },
        { type: "finish", reason: "stop" },
      ];
    }
    if (providerCalls === 2) {
      expect(request.messages.filter((message) => message.role === "user")[0]?.content).toContain(
        occurrenceId,
      );
      return [
        { type: "tool_call_start", id: "cold-resource-call", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "cold-resource-call",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "cold-resource-call" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "read_input_resource",
      result: { status: "completed", output: { occurrenceId, content } },
    });
    return [
      { type: "text_delta", text: "The deleted source is still readable." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver,
        contextProfile: {
          version: 1,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 32_768,
          compactAtTokens: 800_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: {
              version: 1,
              contextWindowTokens: 1_000_000,
              maximumOutputTokens: 32_768,
              compactAtTokens: 800_000,
              postCompactTargetTokens: 200_000,
              retainedTargetTokens: 20_000,
              estimatorVersion: 1,
            },
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link this source." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      runId,
    });
    await first.close();
    await unlink(selectedPath);

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Read the linked source after restart." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The deleted source is still readable." },
    });
    expect(providerCalls).toBe(3);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle blocks a cold Vision Responses continuation when its JSONL image artifact is missing", async () => {
  await exerciseColdVisionResponsesArtifactFailure("missing");
});

test("SessionLifecycle blocks a cold Vision Responses continuation when its JSONL image artifact is corrupt", async () => {
  await exerciseColdVisionResponsesArtifactFailure("corrupt");
});

test("SessionLifecycle cold resume reconstructs the exact historical Vision Chat image bytes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-vision-chat-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "cold-image.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const contextProfile = {
    version: 2,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 384_000,
    ordinaryOutputReserveTokens: 4_096,
    compactionSummaryMaximumOutputTokens: 32_768,
    compactAtTokens: 900_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1,
  } as const;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    const firstUser = request.messages.find((message) => message.role === "user");
    expect(firstUser).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Remember this image." },
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return providerCalls === 1
      ? [
          { type: "text_delta" as const, text: "The image is remembered." },
          { type: "finish" as const, reason: "stop" as const },
        ]
      : [
          { type: "text_delta" as const, text: "The same image survived restart." },
          { type: "finish" as const, reason: "stop" as const },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const warm = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await warm.admit({
      targetIdentity: visionIdentity,
      input: { text: "Remember this image." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await warm.close();
    await unlink(selectedPath);
    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "What image survived restart?" },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The same image survived restart." },
    });
    expect(providerCalls).toBe(2);
  } finally {
    await cold?.close();
    await warm.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a corrupt immutable input resource before cold provider projection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-corrupt-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "corrupt-source.txt");
  const content = "Integrity must remain exact.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Linked." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link integrity evidence." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await first.close();
    const artifactPath = join(stateRoot, "artifacts", digest);
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, "same-size-corrupt-bytes!!\n", "utf8");

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Do not project corrupt bytes." },
      }),
    ).rejects.toMatchObject({ code: "input_resource_corrupt" });
    expect(providerCalls).toBe(1);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a missing immutable input resource before cold provider projection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-missing-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "missing-source.txt");
  const content = "The immutable artifact must remain present.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Linked." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const first = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const admitted = await first.admit({
      targetIdentity,
      input: { text: "Link presence evidence." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    await first.close();
    await unlink(join(stateRoot, "artifacts", digest));

    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: admitted.snapshot.sessionId,
        input: { text: "Do not project a missing artifact." },
      }),
    ).rejects.toMatchObject({ code: "input_resource_corrupt" });
    expect(providerCalls).toBe(1);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a selected FIFO without waiting for a writer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-fifo-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const fifoPath = join(testRoot, "selected.pipe");
  await mkdir(workspaceRoot);
  execFileSync("mkfifo", [fifoPath]);
  let providerCalls = 0;
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          providerCalls += 1;
          return [{ type: "finish", reason: "stop" }];
        }),
        contextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the FIFO." },
        resourceSelections: [{ type: "local_file", path: fifoPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an input resource above the exact eight MiB file bound", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-file-bound-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "too-large.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "", "utf8");
  await truncate(selectedPath, 8 * 1024 * 1024 + 1);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for an over-limit resource.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject this over-limit resource." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_too_large" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects input resources above the exact sixteen MiB run aggregate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-aggregate-bound-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const secondPath = join(testRoot, "second.txt");
  const overflowPath = join(testRoot, "overflow.txt");
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "", "utf8");
  await writeFile(secondPath, "", "utf8");
  await writeFile(overflowPath, "x", "utf8");
  await truncate(firstPath, 8 * 1024 * 1024);
  await truncate(secondPath, 8 * 1024 * 1024);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for aggregate overflow.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the aggregate overflow." },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
          { type: "local_file", path: overflowPath },
        ],
      }),
    ).rejects.toMatchObject({ code: "input_resource_aggregate_too_large" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects input resources above the exact sixty-four MiB lineage aggregate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-lineage-aggregate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const secondPath = join(testRoot, "second.txt");
  const overflowPath = join(testRoot, "overflow.txt");
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "", "utf8");
  await writeFile(secondPath, "", "utf8");
  await writeFile(overflowPath, "x", "utf8");
  await truncate(firstPath, 8 * 1024 * 1024);
  await truncate(secondPath, 8 * 1024 * 1024);
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Accepted the exact lineage byte boundary." },
      { type: "finish", reason: "stop" },
    ];
  });
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    let lastSequence = created.lastSequence;
    for (let index = 0; index < 4; index += 1) {
      const continued = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: `Commit lineage byte batch ${index + 1}.` },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
        ],
      });
      lastSequence = continued.snapshot.lastSequence;
    }

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject the lineage aggregate overflow." },
        resourceSelections: [{ type: "local_file", path: overflowPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_aggregate_too_large" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence,
    });
    expect(providerCalls).toBe(4);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle follows one selected symlink without persisting its source path", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const targetPath = join(testRoot, "private-target.txt");
  const selectedPath = join(testRoot, "selected-link.txt");
  await mkdir(workspaceRoot);
  await writeFile(targetPath, "selected through one controlled symlink\n", "utf8");
  await symlink(targetPath, selectedPath);
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Link the explicitly selected file." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    expect(admitted.result).toMatchObject({ status: "completed" });
    expect(JSON.stringify(requests)).not.toContain(testRoot);
    const store = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: admitted.snapshot.sessionId,
    });
    const serializedRecords = JSON.stringify(await store.read());
    expect(serializedRecords).not.toContain(testRoot);
    expect(serializedRecords).toContain('"displayName":"selected-link.txt"');
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a dangling selected symlink before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-dangling-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "dangling-link.txt");
  await mkdir(workspaceRoot);
  await symlink(join(testRoot, "missing-target.txt"), selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for a dangling symlink.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the dangling selection." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a looping selected symlink before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-looping-symlink-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "looping-link.txt");
  await mkdir(workspaceRoot);
  await symlink(selectedPath, selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden for a looping symlink.");
    },
  });
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the looping selection." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a final symlink substituted after controlled resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-input-resource-symlink-race-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const targetPath = join(testRoot, "accepted-target.txt");
  const replacementPath = join(testRoot, "replacement.txt");
  const selectedPath = join(testRoot, "selected-link.txt");
  await mkdir(workspaceRoot);
  await writeFile(targetPath, "accepted target\n", "utf8");
  await writeFile(replacementPath, "must not be followed\n", "utf8");
  await symlink(targetPath, selectedPath);
  let providerCalls = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider dispatch is forbidden after final-path substitution.");
    },
  });
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterResolved() {
        await unlink(targetPath);
        await symlink(replacementPath, targetPath);
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Do not follow a substituted final symlink." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_invalid_selection" });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold resume keeps a Direct DeepSeek v2 session on its historical profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-deepseek-v2-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const historicalIdentity = { ...targetIdentity, profileVersion: 2 } as const;
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const currentTools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const historicalToolNames = new Set([
    "read_file",
    "write_file",
    "edit_file",
    "run_shell",
    "activate_skill",
    "read_skill_resource",
  ]);
  const historicalTools: ToolRegistry = {
    definitions: () =>
      currentTools.definitions().filter((definition) => historicalToolNames.has(definition.name)),
    resolve: (name) => (historicalToolNames.has(name) ? currentTools.resolve(name) : undefined),
  };
  const first = createSessionLifecycle({
    modelTargets,
    stateRoot,
    tools: historicalTools,
    workspaceRoot,
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await first.create({ targetIdentity: historicalIdentity });
    await expect(
      first.continue({
        sessionId: created.sessionId,
        input: { text: "Record one historical turn." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });
    await first.close();

    cold = createSessionLifecycle({ modelTargets, stateRoot, tools: currentTools, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Continue the historical session." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });

    expect(
      requests.map((request) => {
        const body = request as {
          readonly max_tokens?: number;
          readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
          readonly model?: string;
          readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
        };
        return {
          maxTokens: body.max_tokens,
          model: body.model,
          toolNames: body.tools?.map((tool) => tool.function?.name),
          userMessages: body.messages
            ?.filter((message) => message.role === "user")
            .map((message) => message.content),
        };
      }),
    ).toEqual([
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn."],
      },
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn.", "Continue the historical session."],
      },
    ]);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a competing project writer before model dispatch and takes over after owner death", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-owner-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const bootstrap = createSessionLifecycle({ stateRoot, workspaceRoot });
  const created = await bootstrap.create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    const inspectedWhileOwned = await bootstrap.inspect({ sessionId: created.sessionId });
    let competingModelRequests = 0;
    const contender = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          competingModelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      stateRoot,
      workspaceRoot,
    });

    const competing = contender.continue({ sessionId: created.sessionId });
    await expect(competing).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(competing).rejects.toMatchObject({ code: "project_in_use" });
    expect(inspectedWhileOwned).toEqual(
      expect.objectContaining({ sessionId: created.sessionId, status: "interrupted" }),
    );
    expect(competingModelRequests).toBe(0);

    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const takeover = await contender.resume({ sessionId: created.sessionId });

    expect({ competingModelRequests, takeover }).toEqual({
      competingModelRequests: 0,
      takeover: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process continuation preserves a completed safe read and starts a new attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-safe-replay-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Real restart\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "safe-read-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const requests: unknown[] = [];
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools: createReadToolRegistry({ workspaceRoot }),
      workspaceRoot,
    });
    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const persisted = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    }).then((store) => store.read());

    expect({
      hydrated,
      continued,
      providerMessages: requests,
      userMessages: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ).length,
      completedReads: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed" &&
          record.record.event.name === "read_file",
      ).length,
    }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 2, status: "completed" },
          }),
        }),
      }),
      providerMessages: [
        expect.objectContaining({
          messages: [
            { role: "system", content: basePrompt },
            { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
            { role: "user", content: "Read the project" },
            expect.objectContaining({ role: "assistant" }),
            expect.objectContaining({ role: "tool", tool_call_id: "read-before-crash" }),
          ],
        }),
      ],
      userMessages: 1,
      completedReads: 1,
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process restart marks a killed structured patch as indeterminate without replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-patch-crash-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "source.txt"), "source\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "patch-rename-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "patch-renamed");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    let modelRequests = 0;
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          modelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      stateRoot,
      tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
      workspaceRoot,
    });
    const resumed = await lifecycle.resume({ sessionId: created.sessionId });

    expect({
      modelRequests,
      resumed,
      source: await readFile(join(workspaceRoot, "source.txt"), "utf8"),
      destination: await readFile(join(workspaceRoot, "destination.txt"), "utf8"),
    }).toEqual({
      modelRequests: 0,
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            result: {
              status: "failed",
              error: {
                code: "tool_effect_indeterminate",
                reason: "process_restart",
                message:
                  "The edit_file effect started before restart and cannot be replayed safely.",
              },
            },
          }),
        }),
      }),
      source: "source\n",
      destination: "source\n",
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process branch writes independently, survives restart, and stays project-scoped", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const otherWorkspaceRoot = join(testRoot, "other-workspace");
  await mkdir(workspaceRoot);
  await mkdir(otherWorkspaceRoot);
  const lifecycle = createSessionLifecycle({
    modelTargets: createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () =>
        new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    }),
    stateRoot,
    workspaceRoot,
  });
  const parent = await lifecycle.create({ targetIdentity });
  const parentRun = await lifecycle.continue({
    sessionId: parent.sessionId,
    input: { text: "Create the parent boundary" },
  });
  const parentPath = join(
    stateRoot,
    "projects",
    parent.projectId.replace(/^sha256:/u, ""),
    "sessions",
    `${parent.sessionId}.jsonl`,
  );
  const parentBefore = await readFile(parentPath, "utf8");
  const branchProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_AT_SEQUENCE: String(parentRun.snapshot.lastSequence),
      ADAM_AGENT_FIXTURE_MODE: "branch-child-complete",
      ADAM_AGENT_FIXTURE_SESSION_ID: parent.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(branchProcess);

  try {
    // Terminal IPC is causally published before close and must remain observable afterward.
    await waitForChildClose(branchProcess);
    const branchMessage = await waitForFixtureRecord<{
      readonly type: "branch-child-completed";
      readonly child: CurrentSessionSnapshotForFixture;
      readonly continued: { readonly result: { readonly status: string } };
    }>(branchProcess, "branch-child-completed");
    const childId = branchMessage.child.sessionId;
    const childStore = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: childId,
    });
    const childRecords = await childStore.read();
    const inspectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(inspectProcess);
    const inspected = await waitForFixtureRecord<{
      readonly type: "session-inspected";
      readonly resumed: { readonly status: string; readonly snapshot: { readonly status: string } };
    }>(inspectProcess, "session-inspected");
    await waitForChildClose(inspectProcess);
    const crossProjectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: otherWorkspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(crossProjectProcess);
    const crossProject = await waitForFixtureRecord<{
      readonly type: "session-inspection-failed";
      readonly code: string;
    }>(crossProjectProcess, "session-inspection-failed");
    await waitForChildClose(crossProjectProcess);

    expect({
      branchMessage,
      inspected,
      crossProject,
      parentUnchanged: (await readFile(parentPath, "utf8")) === parentBefore,
      childRecordCount: childRecords.length,
    }).toEqual({
      branchMessage: expect.objectContaining({
        child: expect.objectContaining({
          sessionId: expect.not.stringMatching(new RegExp(`^${parent.sessionId}$`, "u")),
          lineage: expect.objectContaining({
            parentSessionId: parent.sessionId,
            parentEventPosition: parentRun.snapshot.lastSequence,
          }),
        }),
        continued: expect.objectContaining({
          result: { status: "completed", answer: "Child completed." },
        }),
      }),
      inspected: expect.objectContaining({
        resumed: expect.objectContaining({
          status: "ready",
          snapshot: expect.objectContaining({ sessionId: childId, status: "settled" }),
        }),
      }),
      crossProject: { type: "session-inspection-failed", code: "session_not_found" },
      parentUnchanged: true,
      childRecordCount: 8,
    });
  } finally {
    for (const child of [branchProcess]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildClose(child);
      }
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle hybrid Plan binds repository Git automation to the frozen installed build", async () => {
  const installedGitVersion = execFileSync("/usr/bin/git", ["--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  }).trimEnd();
  const supportedGitBuild = installedGitVersion === "git version 2.43.0";
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-git-families-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "Git Plan fixture\n", "utf8");
  await runGitFixtureCommand(workspaceRoot, ["init"]);
  await runGitFixtureCommand(workspaceRoot, ["config", "user.name", "Adam Test"]);
  await runGitFixtureCommand(workspaceRoot, ["config", "user.email", "adam@example.test"]);
  await runGitFixtureCommand(workspaceRoot, ["add", "README.md"]);
  await runGitFixtureCommand(workspaceRoot, ["commit", "-m", "fixture"]);
  const commands = [
    "git --version",
    "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
    "git --no-pager rev-parse --is-inside-work-tree",
    "git --no-pager log --oneline --decorate=no -n 1",
    "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all --name-only -- README.md",
    "git --no-pager show --no-ext-diff --no-textconv --ignore-submodules=all --stat HEAD",
  ] as const;
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    const command = commands[requestCount];
    requestCount += 1;
    if (command !== undefined) {
      const callId = `plan-git-${requestCount}`;
      return [
        { type: "tool_call_start", id: callId, name: "run_shell" },
        { type: "tool_call_delta", id: callId, json: JSON.stringify({ command }) },
        { type: "tool_call_end", id: callId },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latestMessage = request.messages.at(-1);
    return [
      {
        type: "text_delta",
        text:
          latestMessage?.role === "tool" && latestMessage.result.status === "completed"
            ? "Every mandatory Git family executed automatically after attestation."
            : "A mandatory Git family did not execute automatically.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
    }
  });

  try {
    process.env[executablePathName] = "/usr/bin:/bin";
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect this ordinary Git repository." },
      limits: { maxTurns: commands.length + 1 },
    });

    expect(continued.result).toEqual({
      status: "completed",
      answer: supportedGitBuild
        ? "Every mandatory Git family executed automatically after attestation."
        : "A mandatory Git family did not execute automatically.",
    });
    const completedShellEvents = events.filter(
      (event): event is Extract<RuntimeEvent, { readonly type: "tool_completed" }> =>
        event.type === "tool_completed" && event.name === "run_shell",
    );
    const permissionRequests = events.filter(
      (event): event is Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }> =>
        event.type === "tool_permission_requested" && event.name === "run_shell",
    );
    expect(completedShellEvents).toHaveLength(supportedGitBuild ? commands.length : 1);
    expect(
      permissionRequests.map((event) =>
        event.subject.type === "plan_command" ? event.subject.command : undefined,
      ),
    ).toEqual(supportedGitBuild ? [] : commands.slice(1));
    for (const event of completedShellEvents) {
      expect(event.output).toMatchObject({
        termination: { type: "exited", exitCode: 0 },
        stderr: { tail: "", omittedBytes: 0 },
      });
    }
    expect(completedShellEvents[0]?.output).toMatchObject({
      stdout: { tail: `${installedGitVersion}\n`, omittedBytes: 0 },
    });
    if (supportedGitBuild) {
      expect(continued.snapshot.plan?.gitAttestation).toMatchObject({
        version: "git-auto-attestation.v1",
        gitVersion: "git version 2.43.0",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(completedShellEvents[1]?.output).toMatchObject({
        stdout: { tail: "", omittedBytes: 0 },
      });
      expect(completedShellEvents[2]?.output).toMatchObject({
        stdout: { tail: "true\n", omittedBytes: 0 },
      });
      expect(completedShellEvents[3]?.output).toMatchObject({
        stdout: { tail: expect.stringContaining("fixture"), omittedBytes: 0 },
      });
      expect(completedShellEvents[4]?.output).toMatchObject({
        stdout: { tail: "", omittedBytes: 0 },
      });
      expect(completedShellEvents[5]?.output).toMatchObject({
        stdout: { tail: expect.stringContaining("README.md"), omittedBytes: 0 },
      });
    } else {
      expect(continued.snapshot.plan?.gitAttestation).toBeUndefined();
      expect(permissionRequests).toHaveLength(commands.length - 1);
      for (const request of permissionRequests) {
        expect(request.subject).toMatchObject({
          type: "plan_command",
          assessment: {
            disposition: "ask_ambiguous",
            reasons: ["git_attestation_required"],
          },
        });
      }
    }
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: continued.snapshot.lastSequence,
    });
    expect(child.plan?.gitAttestation).toEqual(continued.snapshot.plan?.gitAttestation);
  } finally {
    await lifecycle.close();
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hybrid Plan asks for a near miss from each mandatory Git family", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-git-near-misses-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  const contextProfile = {
    version: 1 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 32_768,
    compactAtTokens: 800_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "Git Plan near misses\n", "utf8");
  await runGitFixtureCommand(workspaceRoot, ["init"]);
  process.env[executablePathName] = "/usr/bin:/bin";
  const commands = [
    "git --version",
    "git status",
    "git --no-pager rev-parse HEAD",
    "git --no-pager log --oneline --decorate=short -n 1",
    "git --no-pager diff --cached --no-ext-diff --no-textconv --ignore-submodules=all",
    "git --no-pager show --no-ext-diff --no-textconv --ignore-submodules=all --stat HEAD~1",
  ] as const;
  let requestCount = 0;
  const driver = new FakeModelDriver(() => {
    const command = commands[requestCount];
    requestCount += 1;
    if (command !== undefined) {
      const callId = `plan-git-near-${requestCount}`;
      return [
        { type: "tool_call_start", id: callId, name: "run_shell" },
        { type: "tool_call_delta", id: callId, json: JSON.stringify({ command }) },
        { type: "tool_call_end", id: callId },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Every mandatory Git near miss required exact approval." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Try one near miss from every Git family." },
      limits: { maxTurns: commands.length + 1 },
    });
    const permissionRequests = events.filter(
      (event): event is Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }> =>
        event.type === "tool_permission_requested" && event.name === "run_shell",
    );

    expect(continued.result).toEqual({
      status: "completed",
      answer: "Every mandatory Git near miss required exact approval.",
    });
    expect(permissionRequests).toHaveLength(5);
    expect(
      permissionRequests.map((event) =>
        event.subject.type === "plan_command" ? event.subject.command : undefined,
      ),
    ).toEqual(commands.slice(1));
    expect(
      events.filter((event) => event.type === "tool_completed" && event.name === "run_shell"),
    ).toHaveLength(1);
  } finally {
    await lifecycle.close();
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "the exact durable assessment",
    assessmentMatches: true,
    omitPermissionRequest: false,
    started: false,
  },
])(
  "SessionLifecycle hybrid Plan recovery reuses $label only before shell start",
  async ({ assessmentMatches, omitPermissionRequest, started }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-shell-recovery-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    const executablePathName = "PATH";
    const previousPath = process.env[executablePathName];
    process.env[executablePathName] = "/usr/bin:/bin";
    await mkdir(workspaceRoot);
    const command = "/usr/bin/printf 'recovered diagnostic\\n'";
    const call = {
      id: "plan-shell-recovery",
      name: "run_shell",
      argumentsJson: JSON.stringify({ command }),
    } as const;
    const runId = assessmentMatches
      ? "123e4567-e89b-42d3-a456-426614176001"
      : "123e4567-e89b-42d3-a456-426614176002";
    let cold:
      | ReturnType<ReturnType<typeof createInMemorySessionLifecycleHarness>["createLifecycle"]>
      | undefined;
    const driver = new FakeModelDriver((request) => {
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        callId: call.id,
        name: call.name,
        result: assessmentMatches
          ? { status: "completed" }
          : { status: "failed", error: { code: "permission_denied" } },
      });
      return [
        { type: "text_delta", text: "Recovered the exact Plan shell boundary." },
        { type: "finish", reason: "stop" },
      ];
    });
    const modelTargets: ModelTargets = {
      async resolve() {
        return {
          identity: targetIdentity,
          driver,
          contextProfile: {
            version: 1,
            contextWindowTokens: 1_000_000,
            maximumOutputTokens: 32_768,
            compactAtTokens: 800_000,
            postCompactTargetTokens: 200_000,
            retainedTargetTokens: 20_000,
            estimatorVersion: 1,
          },
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile: {
                version: 1,
                contextWindowTokens: 1_000_000,
                maximumOutputTokens: 32_768,
                compactAtTokens: 800_000,
                postCompactTargetTokens: 200_000,
                retainedTargetTokens: 20_000,
                estimatorVersion: 1,
              },
            },
          ],
        };
      },
    };
    const harness = createInMemorySessionLifecycleHarness();
    const tools = createCodingToolRegistry({ workspaceRoot });
    const warm = harness.createLifecycle({
      modelTargets,
      stateRoot,
      tools,
      workspaceRoot,
      [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
    });

    try {
      const created = await warm.create({ targetIdentity });
      const entered = await warm.enterPlan({ sessionId: created.sessionId });
      const plan = entered.plan;
      const shellTool = tools.resolve("run_shell");
      if (
        plan?.shellEnvironment === undefined ||
        plan.gitPolicyVersion !== "git-auto-policy.v1" ||
        plan.gitPolicyDigest === undefined ||
        shellTool === undefined
      ) {
        throw new Error("Expected the hybrid Plan shell authority.");
      }
      const assessment = await assessPlanCommandExecutionV1({
        rawCommand: command,
        shellEnvironment: plan.shellEnvironment,
        workspaceRoot,
      });
      if (assessment.status !== "assessed" || assessment.disposition !== "ask_ambiguous") {
        throw new Error("Expected one ambiguous Plan shell assessment.");
      }
      const subject = {
        type: "plan_command" as const,
        command,
        cwd: "." as const,
        planCycleId: plan.cycleId,
        planPolicyVersion: "plan-policy.hybrid-v1" as const,
        shellPolicyVersion: "plan-shell-policy.v1" as const,
        shellEnvironmentVersion: "plan-shell-env.v1" as const,
        shellEnvironmentDigest: plan.shellEnvironment.digest,
        toolProfileDigest: plan.eligibleToolProfile.digest,
        gitPolicyVersion: plan.gitPolicyVersion,
        gitPolicyDigest: plan.gitPolicyDigest,
        assessment: {
          version: 1 as const,
          disposition: assessment.disposition,
          reasons: assessment.reasons,
          digest: assessmentMatches ? assessment.digest : (`sha256:${"0".repeat(64)}` as const),
        },
      };
      const planToolNames = new Set(
        plan.eligibleToolProfile.definitions.map((definition) => definition.name),
      );
      const requestTools = tools
        .definitions()
        .filter((definition) => planToolNames.has(definition.name));
      const store = await harness.sessions.open(created.sessionId);
      if (store === undefined || entered.promptContext === undefined) {
        throw new Error("Expected the created Plan session store and prompt context.");
      }
      const records = [
        {
          schemaVersion: 3,
          record: {
            type: "logical_run_started",
            runId,
            userMessage: "Recover one exact Plan diagnostic.",
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "user_message", text: "Recover one exact Plan diagnostic." },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "provider_attempt_started",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            promptProjection: {
              version: 1,
              assemblyIdentityDigest: entered.promptContext.assemblyIdentityDigest,
              requestProjectionDigest: digestPromptRequestV1(
                [
                  { role: "system", content: basePrompt },
                  { role: "developer", content: skillUsagePrompt },
                  { role: "user", content: "Recover one exact Plan diagnostic." },
                ],
                requestTools,
              ),
            },
          },
        },
        {
          schemaVersion: 3,
          record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
        },
        {
          schemaVersion: 3,
          record: {
            type: "model_response_completed",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            response: {
              text: "",
              toolCalls: [call],
              toolIntents: [
                {
                  callId: call.id,
                  name: call.name,
                  argumentsDigest: `sha256:${createHash("sha256")
                    .update(call.argumentsJson)
                    .digest("hex")}`,
                  effect: "execute",
                  definitionDigest: shellTool.definitionDigest,
                  replay: "never",
                },
              ],
              finishReason: "tool_calls",
            },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_completed", text: "" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "tool_requested", callId: call.id, name: call.name },
          },
        },
        ...(!omitPermissionRequest
          ? [
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: {
                    type: "tool_permission_requested",
                    requestId: `${runId}:${call.id}`,
                    callId: call.id,
                    name: call.name,
                    effect: "execute",
                    scope: "call",
                    subject,
                  },
                },
              } as const,
            ]
          : []),
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: {
              type: "tool_permission_decided",
              ...(omitPermissionRequest ? {} : { requestId: `${runId}:${call.id}` }),
              callId: call.id,
              name: call.name,
              decision: "allow",
              effect: "execute",
              scope: "call",
              subject,
            },
          },
        },
        ...(started
          ? [
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: { type: "tool_started", callId: call.id, name: call.name },
                },
              } as const,
            ]
          : []),
      ] satisfies readonly Omit<
        Extract<SessionRecord, { readonly schemaVersion: 3 }>,
        "sequence"
      >[];
      for (const [index, record] of records.entries()) {
        await store.append({
          ...record,
          sequence: entered.lastSequence + index + 1,
        } as SessionRecord);
      }
      await warm.close();
      cold = harness.createLifecycle({
        modelTargets,
        stateRoot,
        tools,
        workspaceRoot,
        [planShellEnvironmentFactory]: createPlanShellEnvironmentV1,
      });
      const publicEvents: RuntimeEvent[] = [];
      cold.subscribe((event) => {
        publicEvents.push(event);
        if (event.type === "tool_permission_requested") {
          cold?.decidePermission({ requestId: event.requestId, decision: "deny" });
        }
      });

      if (omitPermissionRequest) {
        await expect(cold.resume({ sessionId: created.sessionId })).rejects.toMatchObject({
          code: "session_invalid",
        });
        return;
      }
      if (started) {
        await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
          status: "ready",
          snapshot: {
            status: "settled",
            run: { result: { status: "failed", error: { code: "tool_effect_indeterminate" } } },
          },
        });
        expect(publicEvents).toHaveLength(0);
        return;
      }
      await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
        status: "ready",
        snapshot: { status: "interrupted", plan: { cycleId: plan.cycleId } },
      });
      await expect(cold.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
        result: { status: "completed", answer: "Recovered the exact Plan shell boundary." },
      });
      expect(
        publicEvents.filter((event) => event.type === "tool_permission_requested"),
      ).toHaveLength(assessmentMatches ? 0 : 1);
      expect(publicEvents.filter((event) => event.type === "tool_started")).toHaveLength(
        assessmentMatches ? 1 : 0,
      );
    } finally {
      await warm.close();
      await cold?.close();
      if (previousPath === undefined) {
        delete process.env[executablePathName];
      } else {
        process.env[executablePathName] = previousPath;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

type CurrentSessionSnapshotForFixture = {
  readonly sessionId: string;
  readonly lineage?: {
    readonly parentSessionId: string;
    readonly parentEventPosition: number;
  };
};

async function exerciseColdVisionResponsesArtifactFailure(
  mutation: "corrupt" | "missing",
): Promise<void> {
  const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-vision-responses-${mutation}-`));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "durable-image.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const runId =
    mutation === "missing"
      ? "81000000-0000-4000-8000-000000000001"
      : "81000000-0000-4000-8000-000000000002";
  const occurrenceId = `${runId}:input:1`;
  const contextProfile = {
    version: 2 as const,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 384_000,
    ordinaryOutputReserveTokens: 4_096,
    compactionSummaryMaximumOutputTokens: 32_768,
    compactAtTokens: 900_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1 as const,
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "tool_call_start", id: "durable-image-read", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "durable-image-read",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "durable-image-read" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      callId: "durable-image-read",
      result: {
        status: "completed",
        output: { type: "image", occurrenceId, artifactId },
      },
      content: [
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The image is durably materialized." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionResponsesIdentity,
        driver,
        contextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "unsupported",
          imageToolResults: "supported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionResponsesIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const warm = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await warm.create({ targetIdentity: visionResponsesIdentity });
    await expect(
      warm.continue({
        sessionId: created.sessionId,
        input: { text: "Materialize this image through the resource tool." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The image is durably materialized." },
    });
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    expect(
      (await store.read()).filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "input_resource_image_read_committed",
      ),
    ).toHaveLength(1);
    await warm.close();
    await unlink(selectedPath);
    const artifactPath = join(stateRoot, "artifacts", artifactId.replace(/^sha256:/u, ""));
    if (mutation === "missing") {
      await unlink(artifactPath);
    } else {
      await chmod(artifactPath, 0o600);
      await writeFile(artifactPath, Buffer.alloc(pngBytes.byteLength));
    }

    cold = createSessionLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Continue from the canonical image history." },
      }),
    ).rejects.toMatchObject({
      code: "input_resource_corrupt",
      message: expect.stringContaining("immutable input-resource"),
    });
    expect(providerCalls).toBe(2);
  } finally {
    await cold?.close();
    await warm.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}

async function runGitFixtureCommand(
  workspaceRoot: string,
  arguments_: readonly string[],
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/git", arguments_, {
      cwd: workspaceRoot,
      env: {
        HOME: workspaceRoot,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`Git fixture command failed (${String(code)}/${String(signal)}): ${stderr}`),
        );
      }
    });
  });
}

function observeChild(child: ChildProcess): void {
  const observation: ChildObservation = { messages: [], stderr: "" };
  childObservations.set(child, observation);
  child.on("message", (message) => observation.messages.push(message));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    observation.stderr += chunk;
  });
}

async function waitForChildMessage(
  child: ReturnType<typeof spawn>,
  expectedMessage: string,
): Promise<void> {
  const observation = requiredChildObservation(child);
  if (observation.messages.includes(expectedMessage)) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before readiness: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedMessage}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (message === expectedMessage) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Child closed before readiness: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForFixtureRecord<RecordType extends { readonly type: string }>(
  child: ReturnType<typeof spawn>,
  expectedType: RecordType["type"],
): Promise<RecordType> {
  const observation = requiredChildObservation(child);
  const existing = observation.messages.find(
    (message) => isFixtureRecord(message) && message.type === expectedType,
  );
  if (isFixtureRecord(existing)) {
    return existing as RecordType;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before ${expectedType}: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  return new Promise<RecordType>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (isFixtureRecord(message) && message.type === expectedType) {
        cleanup();
        resolve(message as RecordType);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Child closed before ${expectedType}: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForChildClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("Timed out waiting for child closure."));
    }, 10_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function requiredChildObservation(child: ChildProcess): ChildObservation {
  const observation = childObservations.get(child);
  if (observation === undefined) {
    throw new Error("The child process was not registered with the fixture collector.");
  }
  return observation;
}

function isFixtureRecord(value: unknown): value is Record<string, unknown> & {
  readonly type?: unknown;
} {
  return typeof value === "object" && value !== null;
}
