import { createHash } from "node:crypto";
import { createPermissionPolicy, type ModelRequest } from "@adam-agent/agent";
import { createWebSearchConfigurationWithStorageForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test.each([
  { role: "Main", allowed: true },
  { role: "Research", allowed: true },
  { role: "Main", allowed: false },
  { role: "Research", allowed: false },
])(
  "$role obeys Web permission allow=$allowed under the delegation Plan policy",
  async ({ role, allowed }) => {
    const requests: ModelRequest[] = [];
    const fetched: string[] = [];
    const configuration = createWebSearchConfigurationWithStorageForTesting({
      async read() {
        return { status: "missing" };
      },
      async write() {},
    });
    const h = await startManagedTui(
      {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call_start", id: "fetch-source", name: "web_fetch" };
            yield {
              type: "tool_call_delta",
              id: "fetch-source",
              json: '{"url":"https://example.com/evidence.txt"}',
            };
            yield { type: "tool_call_end", id: "fetch-source" };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "Web evidence complete." };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "stop" };
          }
        },
      },
      {
        planPolicyVersion: "plan-policy.hybrid-delegation-v1",
        permissions: createPermissionPolicy({
          allowedEffects: allowed ? ["read", "delegate", "network"] : ["read", "delegate"],
        }),
        webSearchConfiguration: configuration,
        webHttp: {
          async fetch(input) {
            fetched.push(input.url);
            return {
              status: 200,
              url: input.url,
              mediaType: "text/plain",
              body: Buffer.from("Exact Web evidence body."),
            };
          },
        },
      },
    );
    try {
      await h.presentation.dispatch({ type: "enter_plan", sessionId: h.parent.sessionId });
      if (role === "Main") {
        await h.press("Fetch the exact Web evidence.", "Fetch the exact Web evidence.");
        await h.press("\r", "Web evidence complete.");
      } else {
        await h.press("@Research", "New agent · Research evidence");
        await h.press("\t", "@Research");
        await h.press(" Fetch the exact Web evidence.", "Fetch the exact Web evidence.");
        await h.press("\r", "Delegation");
        await h.press("\r", "Completed");
      }
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["web_fetch", "web_open", "web_find"]),
      );
      expect(requests[0]?.tools.some((tool) => tool.name === "web_search")).toBe(false);
      expect(fetched).toEqual(allowed ? ["https://example.com/evidence.txt"] : []);
      expect(JSON.stringify(requests[1]?.messages)).toContain(
        allowed ? "Exact Web evidence body." : "permission_denied",
      );
    } finally {
      await h.close();
    }
  },
);

test("cancelling Research aborts its in-flight Web request before settling", async () => {
  const fetching = Promise.withResolvers<AbortSignal>();
  let aborted = false;
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "missing" };
    },
    async write() {},
  });
  const h = await startManagedTui(
    {
      async *stream() {
        yield { type: "tool_call_start", id: "cancel-web", name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: "cancel-web",
          json: '{"url":"https://example.com/held.txt"}',
        };
        yield { type: "tool_call_end", id: "cancel-web" };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "tool_calls" };
      },
    },
    {
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate", "network"] }),
      webSearchConfiguration: configuration,
      webHttp: {
        async fetch(input) {
          const closed = Promise.withResolvers<void>();
          const close = () => {
            aborted = true;
            closed.resolve();
          };
          input.signal.addEventListener("abort", close, { once: true });
          if (input.signal.aborted) close();
          fetching.resolve(input.signal);
          try {
            await closed.promise;
            throw new DOMException("Aborted", "AbortError");
          } finally {
            input.signal.removeEventListener("abort", close);
          }
        },
      },
    },
  );
  try {
    const receipt = await h.presentation.dispatch({
      type: "managed_control",
      commandId: "cancel-research-web",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [
          {
            role: "builtin:research",
            task: "Fetch the held source.",
            description: "Held Web source",
          },
        ],
      },
    });
    expect(receipt.status).toBe("admitted");
    const signal = await fetching.promise;
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing admitted Research thread.");
    const offset = h.terminal.output().length;
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "cancel-held-web",
      command: {
        type: "cancel_agents",
        parentSessionId: h.parent.sessionId,
        targets: [{ threadId: thread.threadId, expectedTurnId: thread.turn.turnId }],
      },
    });
    await h.terminal.waitForFrameAfter("Cancelled", offset);
    expect(signal.aborted).toBe(true);
    expect(aborted).toBe(true);
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.turn).toMatchObject({
      phase: "idle",
      outcome: { status: "cancelled" },
    });
  } finally {
    await h.close();
  }
});

test("Research uses the configured search provider and immutable open/find without another network request", async () => {
  let text: string | undefined;
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return text === undefined ? { status: "missing" } : { status: "available", text };
    },
    async write(next) {
      text = next;
    },
  });
  await configuration.activateSearxng("https://search.example.test/search");
  const body = "Frozen source evidence.\nSecond evidence line.\n";
  const artifactId = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const calls = [
    { name: "web_search", json: '{"query":"exact source","limit":1}' },
    { name: "web_fetch", json: '{"url":"https://example.com/source.txt"}' },
    { name: "web_open", json: JSON.stringify({ artifactId }) },
    { name: "web_find", json: JSON.stringify({ artifactId, text: "Second evidence" }) },
  ];
  const requests: ModelRequest[] = [];
  const fetched: string[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        requests.push(request);
        const call =
          requests.length === 6
            ? { name: "web_search", json: '{"query":"search after configuration revocation"}' }
            : calls[requests.length - 1];
        if (requests.length === 3) await configuration.clear();
        if (call !== undefined) {
          yield { type: "tool_call_start", id: call.name, name: call.name };
          yield { type: "tool_call_delta", id: call.name, json: call.json };
          yield { type: "tool_call_end", id: call.name };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text_delta",
            text:
              requests.length === 5
                ? "Immutable search evidence complete."
                : "Revoked search settled.",
          };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    {
      planPolicyVersion: "plan-policy.hybrid-delegation-v1",
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate", "network"] }),
      webSearchConfiguration: configuration,
      webHttp: {
        async fetch(input) {
          fetched.push(input.url);
          const search = new URL(input.url).origin === "https://search.example.test";
          return {
            status: 200,
            url: input.url,
            mediaType: search ? "application/json" : "text/plain",
            body: Buffer.from(
              search
                ? JSON.stringify({
                    results: [
                      {
                        url: "https://example.com/source.txt",
                        title: "Exact source",
                        content: "Search evidence",
                      },
                    ],
                  })
                : body,
            ),
          };
        },
      },
    },
  );
  try {
    await h.presentation.dispatch({ type: "enter_plan", sessionId: h.parent.sessionId });
    await h.press("@Research", "New agent · Research evidence");
    await h.press("\t", "@Research");
    await h.press(
      " Search and inspect immutable evidence.",
      "Search and inspect immutable evidence.",
    );
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    expect(requests).toHaveLength(5);
    expect(new URL(fetched[0] ?? "").searchParams.get("q")).toBe("exact source");
    expect(fetched).toHaveLength(2);
    expect(fetched[1]).toBe("https://example.com/source.txt");
    for (const [index, name] of ["web_search", "web_fetch", "web_open", "web_find"].entries())
      expect(
        requests[index + 1]?.messages.findLast(
          (message) => message.role === "tool" && message.name === name,
        ),
      ).toMatchObject({ result: { status: "completed" } });
    expect(JSON.stringify(requests[4]?.messages)).toContain("Second evidence line.");
    expect(
      requests[0]?.tools.some((tool) =>
        /shell|mcp|write_file|edit_file|spawn_agents/u.test(tool.name),
      ),
    ).toBe(false);
    await h.openFirstAgent("@research-1");
    await h.press("\r", "New turn");
    await h.press("Search with the original provider.", "Search with the original provider.");
    await h.press("\r", "Revoked search settled.");
    expect(fetched).toHaveLength(2);
    expect(JSON.stringify(requests[6]?.messages)).toContain("web_provider_unavailable");
  } finally {
    await h.close();
  }
});

test.each(["allow", "deny"] as const)(
  "Research asks for one exact Web request and respects %s",
  async (decision) => {
    let networkCalls = 0;
    const requests: ModelRequest[] = [];
    const configuration = createWebSearchConfigurationWithStorageForTesting({
      async read() {
        return { status: "missing" };
      },
      async write() {},
    });
    const h = await startManagedTui(
      {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call_start", id: "exact-web-call", name: "web_fetch" };
            yield {
              type: "tool_call_delta",
              id: "exact-web-call",
              json: '{"url":"https://example.com/exact-request.txt"}',
            };
            yield { type: "tool_call_end", id: "exact-web-call" };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "Permission outcome complete." };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "stop" };
          }
        },
      },
      {
        permissions: createPermissionPolicy({
          allowedEffects: ["read", "delegate"],
          askedEffects: ["network"],
        }),
        planPolicyVersion: "plan-policy.hybrid-delegation-v1",
        webSearchConfiguration: configuration,
        webHttp: {
          async fetch(input) {
            networkCalls += 1;
            return {
              status: 200,
              url: input.url,
              mediaType: "text/plain",
              body: Buffer.from("Confirmed exact Web body."),
            };
          },
        },
      },
    );
    try {
      await h.presentation.dispatch({ type: "enter_plan", sessionId: h.parent.sessionId });
      await h.press("@Research", "New agent · Research evidence");
      await h.press("\t", "@Research");
      await h.press(" Fetch the exact request.", "Fetch the exact request.");
      await h.press("\r", "Delegation");
      await h.press("\r", "1 pending");
      await h.press("\u001ba", "Attention Center");
      const pending = await h.waitForAttention(
        (items) =>
          items.length === 1 &&
          items[0]?.kind === "permission" &&
          items[0].interaction !== null &&
          items[0].available,
      );
      expect(pending[0]).toMatchObject({
        handle: "@research-1",
        displayName: "Research",
        interaction: { callId: "exact-web-call", effect: "network" },
      });
      expect(JSON.stringify(pending)).toContain("https://example.com/exact-request.txt");
      expect(networkCalls).toBe(0);
      await h.press(decision === "allow" ? "a" : "d", "Completed");
      expect(networkCalls).toBe(decision === "allow" ? 1 : 0);
      expect(JSON.stringify(requests[1]?.messages)).toContain(
        decision === "allow" ? "Confirmed exact Web body." : "permission_denied",
      );
    } finally {
      await h.close();
    }
  },
);
