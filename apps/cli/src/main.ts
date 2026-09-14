#!/usr/bin/env node

import { writeSync } from "node:fs";

import { cliUsage, parseCliCommand } from "./command.js";

const command = parseCliCommand(process.argv.slice(2));
if (command.type === "help") {
  writeSync(1, `${cliUsage()}\n`);
} else if (command.type === "job") {
  const { runJob } = await import("./job.js");
  await runJob(command.path);
} else {
  const { run } = await import("./run.js");
  await run(command);
}
