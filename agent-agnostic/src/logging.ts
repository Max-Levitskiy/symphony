/**
 * Structured logging (spec 13.1, 13.2).
 *
 * Stable `key=value` phrasing, required issue and session context, redaction of values an adapter
 * declared sensitive, and sink failures that never take the orchestrator down.
 */

import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  agent_kind?: string;
  [key: string]: unknown;
};

export type LoggerOptions = {
  level?: LogLevel;
  filePath?: string | null;
  /** Values that must never be printed. Populated from adapter secret declarations. */
  redact?: Iterable<string>;
  now?: () => Date;
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

export class Logger {
  #level: number;
  #filePath: string | null;
  #redact: string[];
  #context: LogContext;
  #now: () => Date;
  #fileSinkBroken = false;

  constructor(options: LoggerOptions = {}, context: LogContext = {}) {
    this.#level = LEVELS[options.level ?? "info"];
    this.#filePath = options.filePath ?? null;
    this.#redact = [...(options.redact ?? [])].filter((v) => v.length >= 4);
    this.#context = context;
    this.#now = options.now ?? (() => new Date());
  }

  /** Derive a logger that carries extra context on every line. */
  child(context: LogContext): Logger {
    const next = new Logger(
      {
        level: (Object.keys(LEVELS) as LogLevel[]).find((k) => LEVELS[k] === this.#level) ?? "info",
        filePath: this.#filePath,
        redact: this.#redact,
        now: this.#now,
      },
      { ...this.#context, ...context },
    );
    return next;
  }

  /** Add values that must be scrubbed from every subsequent line. */
  redactValues(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length >= 4 && !this.#redact.includes(value)) this.#redact.push(value);
    }
  }

  #scrub(line: string): string {
    let out = line;
    for (const secret of this.#redact) out = out.split(secret).join("[redacted]");
    return out;
  }

  #emit(level: LogLevel, message: string, context: LogContext): void {
    if (LEVELS[level] < this.#level) return;
    const merged = { ...this.#context, ...context };
    const pairs = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`);
    const line = this.#scrub(
      `${this.#now().toISOString()} level=${level} msg=${formatValue(message)}${
        pairs.length ? ` ${pairs.join(" ")}` : ""
      }`,
    );

    // stderr is the sink of last resort and is never disabled: an operator must be able to see
    // startup and dispatch failures without attaching a debugger (spec 13.2).
    process.stderr.write(`${line}\n`);

    if (this.#filePath && !this.#fileSinkBroken) {
      try {
        appendFileSync(this.#filePath, `${line}\n`);
      } catch (error) {
        this.#fileSinkBroken = true;
        process.stderr.write(
          `${this.#now().toISOString()} level=warn msg="log file sink disabled" path=${formatValue(
            this.#filePath,
          )} reason=${formatValue(error instanceof Error ? error.message : String(error))}\n`,
        );
      }
    }
  }

  debug(message: string, context: LogContext = {}) {
    this.#emit("debug", message, context);
  }
  info(message: string, context: LogContext = {}) {
    this.#emit("info", message, context);
  }
  warn(message: string, context: LogContext = {}) {
    this.#emit("warn", message, context);
  }
  error(message: string, context: LogContext = {}) {
    this.#emit("error", message, context);
  }
}
