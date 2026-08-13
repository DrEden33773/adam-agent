#!/usr/bin/env node

import {
  AgentSession,
  createPermissionPolicy,
  createReadToolRegistry,
  type JsonValue,
} from "@adam-agent/agent";
import { FakeModelDriver } from "@adam-agent/testkit";

const prompt = process.argv.slice(2).join(" ");
const model = new FakeModelDriver((request) => {
  const latestMessage = request.messages.at(-1);
  if (latestMessage?.role === "user") {
    return [
      { type: "tool_call_start", id: "read-readme", name: "read_file" },
      { type: "tool_call_delta", id: "read-readme", json: '{"path":"README.md"}' },
      { type: "tool_call_end", id: "read-readme" },
      { type: "finish", reason: "tool_calls" },
    ];
  }

  const answer =
    latestMessage?.role === "tool" && latestMessage.result.status === "completed"
      ? firstReadmeParagraph(latestMessage.result.output)
      : "I could not read README.md.";
  return [
    { type: "text_delta", text: answer },
    { type: "finish", reason: "stop" },
  ];
});
const session = new AgentSession({
  model,
  tools: createReadToolRegistry({ workspaceRoot: process.cwd() }),
  permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
});
const result = await session.run({ text: prompt });

if (result.status === "completed") {
  await writeStream(process.stdout, `${result.answer}\n`);
} else {
  await writeStream(process.stderr, `${result.error.message}\n`);
  process.exitCode = 1;
}

function firstReadmeParagraph(output: JsonValue): string {
  const content = readFileContent(output);
  return (
    content
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? "README.md was empty."
  );
}

function readFileContent(output: JsonValue): string | undefined {
  if (!isJsonObject(output)) {
    return undefined;
  }
  const content = output.content;
  return typeof content === "string" ? content : undefined;
}

function isJsonObject(value: JsonValue): value is { readonly content?: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
