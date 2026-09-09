#!/usr/bin/env node

import { writeSync } from "node:fs";

import { cliUsage, parseCliCommand } from "./command.js";

const command = parseCliCommand(process.argv.slice(2));
if (command.type === "help") {
  writeSync(1, `${cliUsage()}\n`);
} else {
  const { run } = await import("./run.js");
  await run(command);
}
