#!/usr/bin/env node

import { AgentSession } from "@adam-agent/agent";
import { FakeModelDriver } from "@adam-agent/testkit";

const prompt = process.argv.slice(2).join(" ");
const model = new FakeModelDriver([
  { type: "text_delta", text: `Adam Agent received: ${prompt}` },
  { type: "finish", reason: "stop" },
]);
const session = new AgentSession({ model });
const result = await session.run({ text: prompt });

if (result.status === "completed") {
  process.stdout.write(`${result.answer}\n`);
} else {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
}
