import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createSessionLifecycle,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";
import { type AgentSkillsEvalCaseV1, agentSkillsEvalCorpusV1 } from "./agent-skills-eval-corpus.js";

const {
  ADAM_AGENT_SKILLS_EVAL: evaluationSelection,
  ADAM_AGENT_SKILLS_EVAL_REPORT_PATH: reportPath,
  ADAM_AGENT_SKILLS_EVAL_TARGET: configuredTarget,
  DEEPSEEK_API_KEY: apiKey,
} = process.env;
const evaluationEnabled = evaluationSelection === "1";
const evaluationTest = test.skipIf(
  !evaluationEnabled || apiKey === undefined || apiKey.length === 0,
);
const targetId = configuredTarget ?? "deepseek-v4-flash.direct";
const testEnvironment = process.env as NodeJS.ProcessEnv & { HOME?: string };

test.skipIf(!evaluationEnabled)("requires DEEPSEEK_API_KEY for the Agent Skills evaluation", () => {
  expect(apiKey?.length ?? 0).toBeGreaterThan(0);
});

evaluationTest(
  "records the versioned bilingual Agent Skills trigger evaluation",
  async () => {
    const evaluationRoot = await mkdtemp(join(tmpdir(), "adam-agent-skills-eval-"));
    const isolatedHome = join(evaluationRoot, "home");
    const originalHome = testEnvironment.HOME;
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: apiKey ?? "" },
      deadlineMs: 120_000,
    });
    const resolved = await modelTargets.resolve({
      targetId,
      allowExperimental: false,
      signal: new AbortController().signal,
    });
    expect(resolved.identity.certification).toBe("certified");
    const plans = evaluationPlans();
    const runs: Record<string, unknown>[] = [];

    try {
      await mkdir(isolatedHome);
      testEnvironment.HOME = isolatedHome;
      for (const [index, plan] of plans.entries()) {
        const workspaceRoot = join(evaluationRoot, `run-${String(index + 1).padStart(2, "0")}`);
        const stateRoot = join(workspaceRoot, ".state");
        await mkdir(workspaceRoot);
        if (plan.catalogMode === "enabled") {
          await writeCorpusSkills(workspaceRoot);
        }
        const events: RuntimeEvent[] = [];
        const lifecycle = createSessionLifecycle({
          modelTargets,
          permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
          stateRoot,
          workspaceRoot,
        });
        lifecycle.subscribe((event) => events.push(event));
        const created = await lifecycle.create({ targetIdentity: resolved.identity });
        const startedAt = Date.now();
        const continued = await lifecycle.continue({
          sessionId: created.sessionId,
          input: {
            text: `${plan.case.prompt}\n\nEvaluation constraint: the prompt contains all relevant evidence. Do not inspect the workspace or call file or shell tools.`,
            ...(plan.case.kind === "explicit" && "expectedSkill" in plan.case
              ? { skills: [plan.case.expectedSkill] }
              : {}),
          },
          limits: { maxTurns: 4, maxTokens: 50_000 },
        });
        const durationMs = Date.now() - startedAt;
        const expectedQualifiedId =
          "expectedSkill" in plan.case
            ? `skill:v1:project:.:${plan.case.expectedSkill}`
            : undefined;
        const activatedExpected =
          expectedQualifiedId !== undefined &&
          continued.snapshot.skillContext?.active.some(
            (activation) => activation.qualifiedId === expectedQualifiedId,
          ) === true;
        if (plan.case.kind === "explicit") {
          expect(activatedExpected).toBe(true);
        }
        const requestedActivationIds = events.flatMap((event) =>
          event.type === "tool_requested" && event.name === "activate_skill" ? [event.callId] : [],
        );
        const providerReportedTokens = events
          .flatMap((event) => (event.type === "context_usage" ? [event.ordinary] : []))
          .at(-1);
        const classification = classifyObservation({
          activatedExpected,
          case: plan.case,
          catalogMode: plan.catalogMode,
          requestedActivationIds,
        });
        runs.push({
          promptId: plan.case.id,
          caseKind: plan.case.kind,
          catalogMode: plan.catalogMode,
          repetition: plan.repetition,
          catalogRevision: created.skillContext?.catalog.revision ?? null,
          catalogCandidateCount: created.skillContext?.registry.candidateCount ?? 0,
          activationOutcome: {
            activatedExpected,
            active: continued.snapshot.skillContext?.active.map((activation) => ({
              qualifiedId: activation.qualifiedId,
              reason: activation.reason,
            })),
            requestedActivationIds,
            classification,
          },
          resultStatus: continued.result.status,
          resultError: continued.result.status === "failed" ? continued.result.error : null,
          answer: continued.result.status === "completed" ? continued.result.answer : null,
          qualitySignals: "qualitySignals" in plan.case ? plan.case.qualitySignals : [],
          providerReportedTokens: providerReportedTokens ?? null,
          durationMs,
        });
        process.stdout.write(
          `ADAM_AGENT_SKILLS_EVAL_PROGRESS ${index + 1}/${plans.length} ${plan.case.id} ${plan.catalogMode} ${plan.repetition} ${continued.result.status} ${classification}\n`,
        );
      }
      const report = {
        schemaVersion: 1,
        corpus: {
          version: agentSkillsEvalCorpusV1.version,
          digest: `sha256:${createHash("sha256")
            .update(JSON.stringify(agentSkillsEvalCorpusV1), "utf8")
            .digest("hex")}`,
          caseCount: agentSkillsEvalCorpusV1.cases.length,
          skillCount: agentSkillsEvalCorpusV1.skills.length,
        },
        targetIdentity: resolved.identity,
        controls: {
          freshSessionPerRun: true,
          temperature: "provider_default_not_exposed_by_target_contract",
          maxTurns: 4,
          maxTokens: 50_000,
          automaticAndNegativeRepetitions: 3,
          explicitRepetitions: 1,
        },
        runs,
      };
      if (reportPath !== undefined && reportPath.length > 0) {
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      process.stdout.write(`ADAM_AGENT_SKILLS_EVAL_REPORT ${JSON.stringify(report)}\n`);
    } finally {
      if (originalHome === undefined) {
        delete testEnvironment.HOME;
      } else {
        testEnvironment.HOME = originalHome;
      }
      await rm(evaluationRoot, { recursive: true, force: true });
    }
  },
  30 * 60_000,
);

function evaluationPlans(): readonly {
  readonly case: AgentSkillsEvalCaseV1;
  readonly catalogMode: "enabled" | "disabled";
  readonly repetition: number;
}[] {
  const plans: Array<{
    readonly case: AgentSkillsEvalCaseV1;
    readonly catalogMode: "enabled" | "disabled";
    readonly repetition: number;
  }> = [];
  for (const entry of agentSkillsEvalCorpusV1.cases) {
    if (entry.kind === "explicit") {
      plans.push({ case: entry, catalogMode: "enabled", repetition: 1 });
      continue;
    }
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      plans.push({ case: entry, catalogMode: "enabled", repetition });
      if (entry.kind === "should_activate") {
        plans.push({ case: entry, catalogMode: "disabled", repetition });
      }
    }
  }
  return plans;
}

async function writeCorpusSkills(workspaceRoot: string): Promise<void> {
  for (const skill of agentSkillsEvalCorpusV1.skills) {
    const directory = join(workspaceRoot, ".agents", "skills", skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`,
      "utf8",
    );
  }
}

function classifyObservation(input: {
  readonly activatedExpected: boolean;
  readonly case: AgentSkillsEvalCaseV1;
  readonly catalogMode: "enabled" | "disabled";
  readonly requestedActivationIds: readonly string[];
}): "comparison_baseline" | "false_positive" | "hit" | "miss" | "negative_pass" {
  if (input.catalogMode === "disabled") {
    return "comparison_baseline";
  }
  if (input.case.kind === "negative") {
    return input.requestedActivationIds.length === 0 ? "negative_pass" : "false_positive";
  }
  return input.activatedExpected ? "hit" : "miss";
}
