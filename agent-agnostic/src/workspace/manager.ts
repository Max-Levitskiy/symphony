/**
 * Workspace management and safety (spec section 9).
 *
 * Section 9.5 calls the safety invariants "the most important portability constraint", so they are
 * enforced here rather than trusted to callers: sanitized collision-resistant keys, containment
 * under the workspace root, and a workspace path that agents cannot escape by naming.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SymphonyError, toSymphonyError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import type { HooksConfig } from "../config/schema.ts";
import type { Workspace } from "../types.ts";

const ALLOWED = /^[A-Za-z0-9._-]+$/;

/**
 * Derive the workspace directory name (spec 4.2, 9.5 invariant 3).
 *
 * When sanitization changes the identifier we append a stable 64-bit hash of the *original*
 * identifier, so `feature/AB-1` and `feature_AB-1` cannot collide on disk.
 */
export function workspaceKey(identifier: string): string {
  if (identifier.length === 0) {
    throw new SymphonyError("workspace_error", "issue identifier is empty");
  }
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === identifier && ALLOWED.test(sanitized)) return sanitized;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(identifier);
  const suffix = hasher.digest("hex").slice(0, 16); // 64 bits, all allowed characters
  return `${sanitized}-${suffix}`;
}

/** Spec 9.5 invariant 2: the workspace path must stay inside the workspace root. */
export function assertInsideRoot(root: string, path: string): void {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new SymphonyError(
      "invalid_workspace_cwd",
      `workspace path escapes workspace root: path=${absolutePath} root=${absoluteRoot}`,
    );
  }
  if (rel.includes(`..${sep}`)) {
    throw new SymphonyError("invalid_workspace_cwd", `workspace path contains traversal: ${absolutePath}`);
  }
}

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export type HookOutcome = { ran: boolean; ok: boolean; code: number | null; output: string };

export class WorkspaceManager {
  constructor(
    private readonly options: { root: string; hooks: HooksConfig; logger: Logger; shell?: string[] },
  ) {}

  get root(): string {
    return this.options.root;
  }

  pathFor(identifier: string): string {
    const path = resolve(this.options.root, workspaceKey(identifier));
    assertInsideRoot(this.options.root, path);
    return path;
  }

  /** Spec 9.2: create or reuse, and run `after_create` only on genuine creation. */
  async ensure(identifier: string, context: Record<string, unknown> = {}): Promise<Workspace> {
    const key = workspaceKey(identifier);
    const path = this.pathFor(identifier);

    await mkdir(this.options.root, { recursive: true });

    let createdNow = false;
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new SymphonyError(
          "workspace_error",
          `workspace path exists and is not a directory: ${path}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw toSymphonyError("workspace_error", error);
      await mkdir(path, { recursive: true });
      createdNow = true;
    }

    if (createdNow) {
      const outcome = await this.runHook("after_create", path, context);
      if (outcome.ran && !outcome.ok) {
        // Fatal to workspace creation (spec 9.4). Remove the half-prepared directory so the next
        // attempt starts clean rather than inheriting a broken bootstrap.
        await rm(path, { recursive: true, force: true });
        throw new SymphonyError(
          "hook_failed",
          `after_create hook failed for ${identifier}: ${outcome.output.slice(0, 500)}`,
        );
      }
    }

    return { path, workspace_key: key, created_now: createdNow };
  }

  /** Spec 9.4. Failure semantics are the caller's business; this reports, it does not decide. */
  async runHook(
    name: HookName,
    cwd: string,
    context: Record<string, unknown> = {},
  ): Promise<HookOutcome> {
    const script = this.options.hooks[name];
    if (!script) return { ran: false, ok: true, code: 0, output: "" };

    assertInsideRoot(this.options.root, cwd);
    const shell = this.options.shell ?? ["sh", "-lc"];
    const logger = this.options.logger;
    logger.debug("hook started", { hook: name, cwd, ...context });

    const proc = Bun.spawn([...shell, script], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SYMPHONY_WORKSPACE: cwd },
    });

    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    // A hook that spawns its own children can hold the output pipes open after the shell is
    // killed, so the timeout must win the race outright rather than wait for the streams.
    const finished = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      output = `${stdout}${stderr}`.trim();
      await proc.exited;
      return "done" as const;
    })();
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve("timeout");
      }, this.options.hooks.timeout_ms);
    });

    const raced = await Promise.race([finished, expired]);
    if (timer) clearTimeout(timer);
    finished.catch(() => {}); // the losing branch must not surface as an unhandled rejection

    const timedOut = raced === "timeout";
    const code = timedOut ? null : proc.exitCode;
    const success = !timedOut && code === 0;
    if (!success) {
      logger.warn(timedOut ? "hook timed out" : "hook failed", {
        hook: name,
        cwd,
        exit_code: code,
        timeout_ms: timedOut ? this.options.hooks.timeout_ms : undefined,
        output: output.slice(0, 500),
        ...context,
      });
    }
    return { ran: true, ok: success, code, output };
  }

  /** Best-effort hook: failures are logged and swallowed (`after_run`, `before_remove`). */
  async runHookBestEffort(name: HookName, cwd: string, context: Record<string, unknown> = {}) {
    try {
      return await this.runHook(name, cwd, context);
    } catch (error) {
      this.options.logger.warn("hook raised", {
        hook: name,
        cwd,
        reason: error instanceof Error ? error.message : String(error),
        ...context,
      });
      return { ran: true, ok: false, code: null, output: "" } satisfies HookOutcome;
    }
  }

  /** Spec 8.6 / 9.4: remove a terminal issue's workspace, running `before_remove` first. */
  async remove(identifier: string, context: Record<string, unknown> = {}): Promise<boolean> {
    let path: string;
    try {
      path = this.pathFor(identifier);
    } catch {
      return false;
    }
    try {
      const info = await stat(path);
      if (!info.isDirectory()) return false;
    } catch {
      return false;
    }

    await this.runHookBestEffort("before_remove", path, context);
    await rm(path, { recursive: true, force: true });
    this.options.logger.info("workspace removed", { workspace: path, ...context });
    return true;
  }
}
