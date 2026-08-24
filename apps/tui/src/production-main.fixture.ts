import { writeFile } from "node:fs/promises";

const { ADAM_TEST_TERMINAL_PROCESS_MARKER: marker } = process.env;
if (marker === undefined) {
  throw new TypeError("The production TUI fixture requires its process marker.");
}
await writeFile(marker, `${process.pid}\n`, "utf8");
await import("./main.js");
