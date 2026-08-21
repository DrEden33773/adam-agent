export type DeadlineHandle = { cancel(): void };

export type DeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): DeadlineHandle;
};

export type ClipboardAdapter = {
  writeText(text: string): Promise<"copied" | "failed" | "unsupported">;
};

export const nodeDeadlineScheduler: DeadlineScheduler = {
  schedule(delayMilliseconds, onDeadline) {
    const timer = setTimeout(onDeadline, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export class ExitArm {
  #armed = false;
  #deadline: DeadlineHandle | undefined;
  readonly #onExpired: () => void;
  readonly #scheduler: DeadlineScheduler;

  constructor(scheduler: DeadlineScheduler, onExpired: () => void) {
    this.#scheduler = scheduler;
    this.#onExpired = onExpired;
  }

  get armed(): boolean {
    return this.#armed;
  }

  press(): "armed" | "confirmed" {
    if (this.#armed) {
      this.reset();
      return "confirmed";
    }
    this.#armed = true;
    this.#deadline = this.#scheduler.schedule(2_000, () => {
      this.#armed = false;
      this.#deadline = undefined;
      this.#onExpired();
    });
    return "armed";
  }

  reset(): boolean {
    const wasArmed = this.#armed;
    this.#armed = false;
    this.#deadline?.cancel();
    this.#deadline = undefined;
    return wasArmed;
  }
}

export class LegacyDuplicateGuard {
  #deadline: DeadlineHandle | undefined;
  readonly #scheduler: DeadlineScheduler;

  constructor(scheduler: DeadlineScheduler) {
    this.#scheduler = scheduler;
  }

  admit(): boolean {
    if (this.#deadline !== undefined) {
      return false;
    }
    this.#deadline = this.#scheduler.schedule(50, () => {
      this.#deadline = undefined;
    });
    return true;
  }

  reset(): void {
    this.#deadline?.cancel();
    this.#deadline = undefined;
  }
}

export async function copyDraftToClipboard(
  draft: string,
  adapter: ClipboardAdapter | undefined,
  scheduler: DeadlineScheduler,
): Promise<"copied" | "failed" | "unsupported" | null> {
  const text = boundedUtf8(draft, 64 * 1024);
  if (text.length === 0) {
    return null;
  }
  if (adapter === undefined) {
    return "unsupported";
  }
  let guard: DeadlineHandle | undefined;
  try {
    return await Promise.race([
      adapter.writeText(text).catch(() => "failed" as const),
      new Promise<"failed">((resolve) => {
        guard = scheduler.schedule(250, () => resolve("failed"));
      }),
    ]);
  } finally {
    guard?.cancel();
  }
}

function boundedUtf8(value: string, maximumBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximumBytes) {
      break;
    }
    result += character;
  }
  return result;
}
