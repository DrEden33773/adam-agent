import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlOperationStore,
  createPermissionPolicy,
  createPresentationPreferences,
  createProductionManagedControlComposition,
  createSessionLifecycle,
  createWebSearchConfiguration,
  createWorkspaceTrust,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createExtensionRecordStore,
  createRecoverableTurnDraftRepository,
  sessionAutomaticTitlesEnabled,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { runTui } from "./tui-app.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

const identity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;
const contextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8000,
  estimatorVersion: 1,
} as const;

async function guarded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          terminalObservationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each([40, 80, 120])(
  "production picker restores Main and every owned Child attempt at %i columns",
  async (columns) => {
    const root = await mkdtemp(join(tmpdir(), "adam-trash-production-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    vi.stubEnv("NO_COLOR", "1");
    const environment = { XDG_CONFIG_HOME: join(root, "config") };
    const trust = createWorkspaceTrust({ environment, workspaceRoot });
    const trustState = await trust.load();
    if (trustState.projectId === null) throw new Error("Missing project identity");
    await trust.setTrusted({ projectId: trustState.projectId, trusted: true });
    let phase = "Main";
    let calls = 0;
    const modelTargets: ModelTargets = {
      async resolve() {
        return {
          identity,
          contextProfile,
          driver: {
            async *stream() {
              calls += 1;
              yield { type: "text_delta", text: `${phase} retained evidence.` };
              yield { type: "finish", reason: "stop" };
            },
          },
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity,
              contextProfile,
              readiness: { status: "available", credentialSource: "external fixture" },
            },
          ],
        };
      },
    };
    const composition = await createProductionManagedControlComposition({
      workspaceRoot,
      stateRoot,
    });
    const permissions = createPermissionPolicy({ allowedEffects: ["read", "delegate"] });
    const seed = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      permissions,
      workspaceTrust: trust,
      managedControl: composition,
      webSearchConfiguration: createWebSearchConfiguration({ environment }),
      [sessionAutomaticTitlesEnabled]: false,
    });
    let runtime: Awaited<ReturnType<typeof createProductionProjectRuntime>> | undefined;
    let running: Promise<void> | undefined;
    const terminal = new VirtualTerminal({ columns, rows: 24 });
    try {
      const main = await seed.create({ targetIdentity: identity });
      await seed.continue({
        sessionId: main.sessionId,
        input: { text: "Keep Main and the shared keep record" },
      });
      await seed.setSessionManualName({ sessionId: main.sessionId, name: "Unit Parent" });
      const control = await seed[sessionManagedControl](main.sessionId);
      if (control === undefined) throw new Error("Missing production Control");
      phase = "First Child";
      const first = await control.dispatch({
        type: "spawn_agents",
        parentSessionId: main.sessionId,
        entries: [
          { role: "builtin:explore", task: "First owned attempt", description: "Owned child" },
        ],
      });
      if (first.status !== "admitted" || first.turns[0] === undefined)
        throw new Error(JSON.stringify(first));
      const firstTurn = first.turns[0];
      expect(
        (
          await guarded(
            control.dispatch({
              type: "wait_agents",
              parentSessionId: main.sessionId,
              targets: [{ threadId: firstTurn.threadId, expectedTurnId: firstTurn.turnId }],
              mode: "all",
            }),
            "first Child settlement",
          )
        ).status,
      ).toBe("completed");
      phase = "Second Child";
      const second = await control.dispatch({
        type: "next_turn",
        parentSessionId: main.sessionId,
        threadId: firstTurn.threadId,
        expectedTurnId: firstTurn.turnId,
        task: "Second owned attempt",
      });
      if (second.status !== "accepted") throw new Error(JSON.stringify(second));
      const secondTurn = second;
      expect(
        (
          await guarded(
            control.dispatch({
              type: "wait_agents",
              parentSessionId: main.sessionId,
              targets: [{ threadId: secondTurn.threadId, expectedTurnId: secondTurn.turnId }],
              mode: "all",
            }),
            "second Child settlement",
          )
        ).status,
      ).toBe("completed");
      await control.configureBackgroundCapacity({ parentSessionId: main.sessionId, running: 4 });
      const drafts = await createRecoverableTurnDraftRepository({
        stateRoot,
        projectId: main.projectId,
      });
      await drafts.save({
        schemaVersion: 4,
        scope: { type: "session", sessionId: main.sessionId },
        nextOrdinal: 1,
        resources: [],
        pastedTexts: [],
        elements: [{ type: "text", elementId: "main-draft", text: "Saved Main draft" }],
      });
      const childDraft = {
        parentSessionId: main.sessionId,
        threadId: firstTurn.threadId,
        expectedTurnId: secondTurn.turnId,
        mode: "new_turn" as const,
        text: "Saved Child draft",
      };
      await drafts.saveManaged(childDraft);
      const archived = columns === 40;
      if (archived)
        expect(
          (
            await seed.setSessionVisibility({
              sessionId: main.sessionId,
              visibility: "archived",
              expectedRevision: 0,
            })
          ).status,
        ).toBe("updated");
      phase = "Other Main";
      const other = await seed.create({ targetIdentity: identity });
      await seed.continue({
        sessionId: other.sessionId,
        input: { text: "Unrelated Main remains" },
      });
      await seed.setSessionManualName({ sessionId: other.sessionId, name: "Other Parent" });
      const project = main.projectId.slice("sha256:".length);
      const reportText = "Shared Operation report retained after Restore.";
      const reportId = `sha256:${createHash("sha256").update(reportText).digest("hex")}`;
      await mkdir(join(stateRoot, "artifacts"), { recursive: true, mode: 0o700 });
      await writeFile(join(stateRoot, "artifacts", reportId.slice(7)), reportText, { mode: 0o400 });
      const operationId = randomUUID();
      const provenance = {
        contributionId: "fixture.report",
        extensionId: "fixture.records",
        extensionVersion: "1.0.0",
        operationId,
        projectId: main.projectId,
      };
      const report = {
        id: reportId,
        byteCount: Buffer.byteLength(reportText),
        mediaType: "text/plain",
        contract: { id: "fixture.report", version: 1 },
        provenance,
      };
      const operations = await createJsonlOperationStore({ workspaceRoot, stateRoot });
      const source = await seed.inspect({ sessionId: main.sessionId });
      await operations.append({
        schemaVersion: 3,
        operationId,
        sequence: 1,
        recordedAt: "2026-09-10T00:00:00.000Z",
        origin: {
          invocation: { id: "review", kind: "presentation_command", version: 1 },
          sessionId: main.sessionId,
          sourceSequence: source.lastSequence,
        },
        event: {
          type: "operation_started",
          contributionId: provenance.contributionId,
          extensionId: provenance.extensionId,
          extensionVersion: provenance.extensionVersion,
          projectId: main.projectId,
          definitionDigest: `sha256:${"a".repeat(64)}`,
          deadlineAt: "2026-09-10T00:01:00.000Z",
          idempotencyKey: "retained",
          input: {},
          inputDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
        },
      });
      await operations.append({
        schemaVersion: 2,
        operationId,
        sequence: 2,
        recordedAt: "2026-09-10T00:00:01.000Z",
        event: { type: "operation_artifact_published", artifact: report },
      });
      await operations.append({
        schemaVersion: 2,
        operationId,
        sequence: 3,
        recordedAt: "2026-09-10T00:00:02.000Z",
        event: { type: "operation_completed", output: { recordKey: "keep" }, artifacts: [report] },
      });
      const records = createExtensionRecordStore(stateRoot);
      const value = "Shared Extension record retained after Restore.";
      await records.create({
        key: "keep",
        contract: { id: "fixture.value", version: 1 },
        byteCount: Buffer.byteLength(JSON.stringify(value)),
        digest: `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`,
        provenance,
        value,
      });
      await seed.resume({ sessionId: main.sessionId });
      runtime = await createProductionProjectRuntime({
        environment,
        workspaceRoot,
        stateRoot,
        workspaceTrust: trust,
        modelTargets,
        preferences: createPresentationPreferences({ environment }),
        permissions,
        extensionPermissions: createPermissionPolicy({ allowedEffects: [] }),
        projectLabel: "Trash production",
        reservedCommandNames: [],
      });
      const presentation = await runtime.createPresentation({ openProject: true });
      const mainLog = join(stateRoot, "projects", project, "sessions", `${main.sessionId}.jsonl`);
      const otherLog = join(stateRoot, "projects", project, "sessions", `${other.sessionId}.jsonl`);
      const childLogs = [firstTurn, secondTurn].map((turn) =>
        join(
          stateRoot,
          "managed-agent-sessions",
          "projects",
          project,
          "sessions",
          `${turn.childSessionId}.jsonl`,
        ),
      );
      const originalMain = await readFile(mainLog);
      const originalOther = await readFile(otherLog);
      const originalChildren = await Promise.all(childLogs.map((path) => readFile(path)));
      const beforeRestoreCalls = calls;
      running = runTui({
        presentation,
        terminal,
        closeRuntime: () => runtime?.close() ?? Promise.resolve(),
      });
      const press = async (keys: string, frame: string, absent?: string) => {
        const offset = terminal.output().length;
        terminal.input(keys);
        await terminal.waitForFrameAfter(frame, offset, absent);
      };
      await terminal.waitForScreen("Other Parent");
      if (archived) await press("\t", "[Archived]");
      await press("Unit", "> Unit Parent");
      await press("\u0004", "Move session to Trash?");
      expect(terminal.lines().join("\n")).toContain("> Cancel");
      expect(terminal.lines().join("\n")).toContain("Owned Child histories: 2");
      await press("\r", "Select a project session", "Move session to Trash?");
      expect((await readFile(mainLog)).equals(originalMain)).toBe(true);
      await press("\u0004", "Move session to Trash?");
      await press("\u001b[C", "> Move to Trash");
      await press("\r", "Session unit moved to Trash.");
      expect(presentation.getState().authoritative.sessions.view).toBe("trash");
      expect(presentation.getState().authoritative.sessions.trash?.items[0]?.children).toHaveLength(
        2,
      );
      for (const path of [
        mainLog,
        ...childLogs,
        join(stateRoot, "projects", project, "managed-agents", `events-v3-${main.sessionId}.jsonl`),
        join(stateRoot, "projects", project, "managed-agents", `capacity-${main.sessionId}.json`),
      ])
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        control.configureBackgroundCapacity({ parentSessionId: main.sessionId, running: 3 }),
      ).rejects.toMatchObject({ code: "session_in_trash" });
      expect(
        (
          await control.dispatch({
            type: "spawn_agents",
            parentSessionId: main.sessionId,
            entries: [
              { role: "builtin:explore", task: "Must not recreate", description: "Stale handle" },
            ],
          })
        ).status,
      ).toBe("rejected");
      expect((await readFile(otherLog)).equals(originalOther)).toBe(true);
      await press("\r", "Session unit restored.");
      expect((await readFile(mainLog)).equals(originalMain)).toBe(true);
      for (const [index, path] of childLogs.entries())
        expect((await readFile(path)).equals(originalChildren[index] as Buffer)).toBe(true);
      expect(
        (
          await records.get(
            {
              extensionId: provenance.extensionId,
              extensionVersion: provenance.extensionVersion,
              projectId: main.projectId,
            },
            "keep",
          )
        )?.value,
      ).toBe(value);
      expect((await operations.read(operationId)).at(-1)?.event).toMatchObject({
        type: "operation_completed",
        output: { recordKey: "keep" },
      });
      expect(await readFile(join(stateRoot, "artifacts", reportId.slice(7)), "utf8")).toBe(
        reportText,
      );
      expect(await drafts.loadManaged(childDraft)).toEqual(childDraft);
      expect(presentation.getState().authoritative.sessions.view).toBe(
        archived ? "archived" : "active",
      );
      await press("\r", "Saved Main draft", "Select a project session");
      await press("\u001b[5~".repeat(5), "Main retained evidence.");
      expect(presentation.getState().authoritative.managedControl?.threads[0]?.turn.turnId).toBe(
        secondTurn.turnId,
      );
      expect(
        presentation.getState().authoritative.managedControl?.threads[0]?.previousTurns?.[0]
          ?.turnId,
      ).toBe(firstTurn.turnId);
      expect(calls).toBe(beforeRestoreCalls);
    } finally {
      if (running !== undefined) {
        if (terminal.running()) terminal.input("\u0011");
        await guarded(running, "production Trash TUI shutdown");
      }
      await runtime?.close();
      await seed.close();
      await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
