/**
 * Agent adapter registry (spec 10.1).
 *
 * Selection is configuration, never host probing: a deployment that resolves `runner.kind` by
 * looking for installed executables is not reproducible.
 */

import { err, ok, type Result } from "../errors.ts";
import type { AgentAdapter } from "./types.ts";
import { codexAppServerAdapter } from "./codex-app-server.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { cliExecAdapter } from "./cli-exec.ts";

export class AgentRegistry {
  #adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    this.#adapters.set(adapter.kind, adapter);
    return this;
  }

  kinds(): string[] {
    return [...this.#adapters.keys()].sort();
  }

  has(kind: string): boolean {
    return this.#adapters.has(kind);
  }

  resolve(kind: string): Result<AgentAdapter> {
    const adapter = this.#adapters.get(kind);
    if (!adapter) {
      return err(
        "unsupported_agent_kind",
        `runner.kind '${kind}' is not registered; known kinds: ${this.kinds().join(", ") || "(none)"}`,
      );
    }
    return ok(adapter);
  }
}

/** The adapters this implementation ships (forked spec Appendix B). */
export function defaultAgentRegistry(): AgentRegistry {
  return new AgentRegistry()
    .register(codexAppServerAdapter)
    .register(claudeCodeAdapter)
    .register(cliExecAdapter);
}
