/**
 * Tracker adapter registry (spec 11.1). Selection is by `tracker.kind`, exactly as agent adapters
 * are selected by `runner.kind`.
 */

import { err, ok, type Result } from "../errors.ts";
import type { TrackerConfig } from "../config/schema.ts";
import type { Logger } from "../logging.ts";
import type { TrackerAdapter, TrackerFactory } from "./types.ts";
import { createMemoryTracker } from "./memory.ts";
import { createGitHubTracker } from "./github.ts";

export class TrackerRegistry {
  #factories = new Map<string, TrackerFactory>();

  register(kind: string, factory: TrackerFactory): this {
    this.#factories.set(kind, factory);
    return this;
  }

  kinds(): string[] {
    return [...this.#factories.keys()].sort();
  }

  has(kind: string): boolean {
    return this.#factories.has(kind);
  }

  create(config: TrackerConfig, logger: Logger): Result<TrackerAdapter> {
    const factory = this.#factories.get(config.kind);
    if (!factory) {
      return err(
        "unsupported_tracker_kind",
        `tracker.kind '${config.kind}' is not registered; known kinds: ${this.kinds().join(", ") || "(none)"}`,
      );
    }
    return factory({ config, logger });
  }
}

export function defaultTrackerRegistry(): TrackerRegistry {
  return new TrackerRegistry()
    .register("memory", createMemoryTracker)
    .register("github", createGitHubTracker);
}
