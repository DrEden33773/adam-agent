import { writeSync } from "node:fs";
import { open } from "node:fs/promises";
import {
  createPermissionPolicy,
  type ModelDriver,
  type ModelTargets,
  type SessionContinueResult,
  type SessionLifecycle,
} from "@adam-agent/agent";
import { type JobConfig, parseJobConfig } from "./job-config.js";
import { createCliLifecycle } from "./lifecycle.js";
import { createCliModelTargets } from "./models.js";

/** A single Main task. The controller owns isolation, approval and grading. */
export async function runJob(path: string): Promise<void> {
  const abort = new AbortController();
  let sequence = 0;
  let stopReason: string | null = null;
  let lifecycle: SessionLifecycle | undefined;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let inputBuffer = "";
  let receipt: { sessionId: string; runId: string; sequence: number } | null = null;
  let continued: SessionContinueResult | undefined;
  const pending = new Set<string>();
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    unknownCalls: 0,
  };
  let configured: unknown = null;
  let closeStatus = "not_started";
  let failure: { code: string; message: string } | null = null;
  const { DEEPSEEK_API_KEY, ADAM_AGENT_RELAY_TOKEN } = process.env;
  const sensitive = [DEEPSEEK_API_KEY, ADAM_AGENT_RELAY_TOKEN].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  function stop(reason: string) {
    stopReason ??= reason;
    abort.abort();
  }
  function emit(type: string, value: unknown) {
    let line = JSON.stringify({ version: 1, sequence: ++sequence, type, value });
    for (const secret of sensitive) line = line.split(secret).join("[REDACTED]");
    try {
      writeSync(1, `${line}\n`);
    } catch {
      stop("output_closed");
    }
  }
  const onSignal = () => stop("signal");
  const onEnd = () => stop("controller_closed");
  const onInput = (chunk: string) => {
    inputBuffer += chunk;
    if (Buffer.byteLength(inputBuffer, "utf8") > 65_536) {
      stop("control_invalid");
      return;
    }
    let end = inputBuffer.indexOf("\n");
    while (end !== -1) {
      const line = inputBuffer.slice(0, end);
      inputBuffer = inputBuffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as {
          type?: unknown;
          requestId?: unknown;
          decision?: unknown;
        };
        if (message.type === "cancel") {
          stop("controller_cancelled");
        } else if (
          message.type === "permission" &&
          typeof message.requestId === "string" &&
          (message.decision === "allow" || message.decision === "deny") &&
          pending.has(message.requestId) &&
          lifecycle !== undefined
        ) {
          const result = lifecycle.decidePermission({
            requestId: message.requestId,
            decision: message.decision,
          });
          if (result.status === "accepted") pending.delete(message.requestId);
          emit("control_result", result);
        } else {
          stop("control_invalid");
        }
      } catch {
        stop("control_invalid");
      }
      end = inputBuffer.indexOf("\n");
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onInput);
  process.stdin.once("end", onEnd);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const file = await open(path, "r");
    let config: JobConfig;
    try {
      if ((await file.stat()).size > 1_048_576) throw new Error("Job configuration exceeds 1 MiB.");
      config = parseJobConfig(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
    configured = config;
    timeout = setTimeout(() => stop("deadline"), config.timeoutMs);
    const relayToken = ADAM_AGENT_RELAY_TOKEN;
    if (config.modelRelay !== undefined && !relayToken)
      throw new Error("Model relay token is required.");
    const targets = createCliModelTargets({
      environment: config.modelRelay === undefined ? process.env : { DEEPSEEK_API_KEY: relayToken },
      ...(config.modelRelay === undefined
        ? {}
        : {
            fetch: async (input: string | URL | Request, init?: RequestInit) => {
              if (String(input) !== "https://api.deepseek.com/responses")
                throw new Error("Unsupported relay destination.");
              const headers = new Headers(init?.headers);
              headers.set("authorization", `Bearer ${relayToken}`);
              return fetch(new URL("/responses", config.modelRelay), {
                ...init,
                headers,
                redirect: "error",
              });
            },
          }),
    });
    function observe(driver: ModelDriver): ModelDriver {
      return {
        async *stream(request) {
          const call = ++usage.calls;
          let known = false;
          try {
            for await (const event of driver.stream({
              ...request,
              signal: AbortSignal.any([request.signal, abort.signal]),
            })) {
              if (event.type === "usage") {
                const values = [
                  event.inputTokens,
                  event.outputTokens,
                  event.reasoningTokens ?? 0,
                  event.cachedInputTokens ?? 0,
                  event.cacheMissInputTokens ?? 0,
                ];
                const totals = [
                  usage.inputTokens + event.inputTokens,
                  usage.outputTokens + event.outputTokens,
                  usage.cachedInputTokens + (event.cachedInputTokens ?? 0),
                  usage.reasoningTokens + (event.reasoningTokens ?? 0),
                  usage.inputTokens + usage.outputTokens + event.inputTokens + event.outputTokens,
                ];
                if (
                  ![...values, ...totals].every(
                    (value) => Number.isSafeInteger(value) && value >= 0,
                  )
                ) {
                  known = false;
                  yield event;
                  continue;
                }
                known = true;
                usage.inputTokens += event.inputTokens;
                usage.outputTokens += event.outputTokens;
                usage.cachedInputTokens += event.cachedInputTokens ?? 0;
                usage.reasoningTokens += event.reasoningTokens ?? 0;
                emit("model_usage", { call, purpose: request.purpose ?? "ordinary", ...event });
              }
              yield event;
            }
          } finally {
            if (!known) usage.unknownCalls++;
          }
        },
      };
    }
    const modelTargets: ModelTargets = {
      async resolve(input) {
        const resolved = await targets.resolve(input);
        return { ...resolved, driver: observe(resolved.driver) };
      },
      snapshot: (input) => targets.snapshot(input),
    };
    const resolved = await modelTargets.resolve({
      targetId: config.target,
      allowExperimental: false,
      signal: abort.signal,
    });
    if (config.thinking !== undefined && resolved.thinkingCapability === undefined) {
      throw new Error("This target does not expose a thinking capability.");
    }
    emit("configured", {
      config,
      identity: resolved.identity,
      contextProfile: resolved.contextProfile,
      thinkingCapability: resolved.thinkingCapability,
    });
    lifecycle = await createCliLifecycle({
      workspaceRoot: process.cwd(),
      stateRoot: config.stateRoot,
      configurationEnvironment: { XDG_CONFIG_HOME: config.configurationRoot },
      modelTargets,
      managed: false,
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["write", "execute"],
      }),
    });
    if (config.trustWorkspace) {
      const { createWorkspaceTrust } = await import("@adam-agent/agent");
      const trust = await createWorkspaceTrust({
        workspaceRoot: process.cwd(),
        environment: { XDG_CONFIG_HOME: config.configurationRoot },
      }).load();
      if (trust.projectId === null || trust.diagnostic !== null)
        throw new Error("Workspace identity is unavailable.");
      await lifecycle.configureWorkspaceTrust({ type: "grant", projectId: trust.projectId });
    }
    unsubscribe = lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") pending.add(event.requestId);
      emit("event", event);
    });
    if (abort.signal.aborted) throw new Error("Controller closed before admission.");
    continued = await lifecycle.admit({
      targetIdentity: resolved.identity,
      input: { text: config.prompt },
      limits: {
        maxTurns: config.maxTurns,
        ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      },
      signal: abort.signal,
      ...(config.thinking === undefined || resolved.thinkingCapability === undefined
        ? {}
        : {
            thinkingSelection: {
              requestedLevelId: config.thinking,
              capability: {
                id: resolved.thinkingCapability.capabilityId,
                version: resolved.thinkingCapability.capabilityVersion,
                digest: resolved.thinkingCapability.capabilityDigest,
              },
            },
          }),
      onAdmitted(value) {
        receipt = value;
        emit("admitted", value);
      },
    });
  } catch (error) {
    failure = {
      code: "job_failed",
      message: error instanceof Error ? error.message : "Job failed.",
    };
  } finally {
    unsubscribe?.();
    if (lifecycle !== undefined) {
      try {
        closeStatus = (await lifecycle.close()).status;
      } catch {
        closeStatus = "failed";
      }
    }
    if (timeout !== undefined) clearTimeout(timeout);
    process.stdin.removeListener("data", onInput);
    process.stdin.removeListener("end", onEnd);
    process.stdin.pause();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    emit("result", {
      config: configured,
      receipt,
      result: continued?.result ?? null,
      usage,
      closeStatus,
      stopReason,
      failure,
    });
    process.exitCode =
      failure === null &&
      continued?.result.status === "completed" &&
      closeStatus === "closed" &&
      stopReason === null
        ? 0
        : 1;
  }
}
