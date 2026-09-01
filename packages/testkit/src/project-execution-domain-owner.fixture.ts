const { createProjectExecutionDomain, createProjectLifecycleOwner } = await import(
  "@adam-agent/agent/internal-testing"
);

const workspaceRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_WORKSPACE_ROOT");
const stateRoot = requiredEnvironment("ADAM_AGENT_FIXTURE_STATE_ROOT");
const domain = createProjectExecutionDomain({
  lifecycleOwner: createProjectLifecycleOwner({ stateRoot, workspaceRoot }),
});
const root = await domain.claimRoot({ rootId: "parent-session" });
await root.claimChild({ childId: "child-1" });
await root.release();
process.send?.("child-held");
await new Promise<void>(() => {});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}
