#!/usr/bin/env bun
/**
 * CLI and host lifecycle (spec 17.7).
 *
 * Usage: symphony [path-to-WORKFLOW.md] [--port N] [--log-level debug|info|warn|error]
 */

import { resolve } from "node:path";
import { Logger, type LogLevel } from "./logging.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { startHttpServer } from "./http/server.ts";
import { defaultAgentRegistry } from "./agent/registry.ts";
import { defaultTrackerRegistry } from "./tracker/registry.ts";

export type ParsedArgs = {
  workflowPath: string;
  port: number | null;
  logLevel: LogLevel;
  help: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    workflowPath: "./WORKFLOW.md",
    port: null,
    logLevel: "info",
    help: false,
  };
  let sawPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--port") {
      parsed.port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      parsed.port = Number(arg.slice("--port=".length));
    } else if (arg === "--log-level") {
      parsed.logLevel = argv[++i] as LogLevel;
    } else if (arg.startsWith("--log-level=")) {
      parsed.logLevel = arg.slice("--log-level=".length) as LogLevel;
    } else if (!arg.startsWith("-") && !sawPositional) {
      parsed.workflowPath = arg;
      sawPositional = true;
    }
  }
  return parsed;
}

const USAGE = `symphony — agent-agnostic workflow orchestrator

Usage:
  symphony [path-to-WORKFLOW.md] [options]

Options:
  --port N               start the OPTIONAL HTTP observability server (overrides server.port)
  --log-level LEVEL      debug | info | warn | error   (default: info)
  -h, --help             show this message

The workflow path defaults to ./WORKFLOW.md.
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const workflowPath = resolve(args.workflowPath);
  const logger = new Logger({ level: args.logLevel });

  if (!(await Bun.file(workflowPath).exists())) {
    logger.error("workflow file not found", { path: workflowPath });
    return 1;
  }

  const orchestrator = new Orchestrator({
    workflowPath,
    logger,
    agents: defaultAgentRegistry(),
    trackers: defaultTrackerRegistry(),
  });

  const started = await orchestrator.start();
  if (!started.ok) {
    logger.error("startup failed", {
      category: started.error.category,
      reason: started.error.message,
    });
    return 1;
  }

  // CLI --port overrides server.port when both are present (spec 13.7).
  const port = args.port ?? orchestrator.config?.server.port ?? null;
  const http = port === null ? null : startHttpServer(orchestrator, port);
  if (http) logger.info("http server listening", { url: `http://127.0.0.1:${http.port}` });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    http?.stop();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Hold the process open; the orchestrator owns its own tick timer.
  await new Promise<void>(() => {});
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
