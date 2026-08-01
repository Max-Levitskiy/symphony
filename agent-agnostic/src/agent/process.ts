/**
 * Subprocess and line-protocol helpers shared by the stdio-based agent adapters.
 *
 * Nothing here is agent-specific. Spec 10.5 requires bounded line buffering and separating the
 * protocol stream from diagnostic stderr; both are implemented once, here.
 */

import { SymphonyError } from "../errors.ts";
import type { Logger } from "../logging.ts";

export const MAX_LINE_BYTES = 10 * 1024 * 1024; // spec 10.5 RECOMMENDED maximum

export type SpawnOptions = {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Shell used to interpret `command`; matches the workspace hook shell contract (spec 9.4). */
  shell?: string[];
  logger: Logger;
  onStderr?: (line: string) => void;
};

export type SpawnedAgent = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  pid: string | null;
  /** Lines from stdout, framed on `\n`. */
  lines: AsyncGenerator<string>;
  write(text: string): void;
  kill(): void;
  exited: Promise<number>;
};

export function spawnAgentProcess(options: SpawnOptions): SpawnedAgent {
  const shell = options.shell ?? ["bash", "-lc"];
  const proc = Bun.spawn([...shell, options.command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;

  // Diagnostic stderr is drained separately so it can never desynchronize the protocol stream.
  void (async () => {
    for await (const line of readLines(proc.stderr)) {
      if (line.trim().length === 0) continue;
      if (options.onStderr) options.onStderr(line);
      else options.logger.debug("agent stderr", { line: line.slice(0, 500) });
    }
  })().catch(() => {});

  const encoder = new TextEncoder();
  return {
    proc,
    pid: proc.pid ? String(proc.pid) : null,
    lines: readLines(proc.stdout),
    write(text: string) {
      proc.stdin.write(encoder.encode(text));
      proc.stdin.flush();
    },
    kill() {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    },
    exited: proc.exited,
  };
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LINE_BYTES) {
        throw new SymphonyError(
          "response_error",
          `agent produced a line larger than ${MAX_LINE_BYTES} bytes`,
        );
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Reject with `category` if `promise` does not settle within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  category: "response_timeout" | "turn_timeout",
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SymphonyError(category, message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A promise plus its resolvers, for handing a value across the message pump boundary. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Bound and stringify a value for a log line or an event message. */
export function briefly(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
