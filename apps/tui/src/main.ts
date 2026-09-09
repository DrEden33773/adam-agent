#!/usr/bin/env node

import { parseCommand, TuiConfigurationError, usage } from "./command.js";

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.type === "help") {
    process.stdout.write(`${usage()}\n`);
  } else {
    const { run } = await import("./run.js");
    await run(command);
  }
} catch (error) {
  const message =
    error instanceof TuiConfigurationError
      ? error.message
      : (await import("./tui-process-failure.js")).tuiProcessFailureMessage(error);
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exitCode = 1;
}
