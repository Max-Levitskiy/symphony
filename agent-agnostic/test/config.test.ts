/** Workflow loading and config resolution (forked spec 17.1). */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { resolveConfig, coercePath, resolveEnvTokens, normalizeLegacyRunner } from "../src/config/schema.ts";

const workflowPath = join(tmpdir(), "symphony-config-test", "WORKFLOW.md");

const parse = (text: string) => {
  const result = parseWorkflow(text);
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`);
  return result.value;
};

const resolveOk = (text: string, env: Record<string, string | undefined> = {}) => {
  const result = resolveConfig(parse(text), workflowPath, env);
  if (!result.ok) throw new Error(`resolve failed: ${result.error.category}: ${result.error.message}`);
  return result.value;
};

const base = `---
tracker:
  kind: memory
  active_states: [Todo]
  terminal_states: [Done]
`;

describe("workflow loader", () => {
  test("splits front matter from prompt body", () => {
    const workflow = parse(`${base}---\n\nHello {{ issue.identifier }}\n`);
    expect((workflow.config.tracker as Record<string, unknown>).kind).toBe("memory");
    expect(workflow.prompt_template).toBe("Hello {{ issue.identifier }}");
  });

  test("a file without front matter is all prompt", () => {
    const workflow = parse("just a prompt\n");
    expect(workflow.config).toEqual({});
    expect(workflow.prompt_template).toBe("just a prompt");
  });

  test("non-map front matter is a typed error", () => {
    const result = parseWorkflow("---\n- a\n- b\n---\nbody\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("workflow_front_matter_not_a_map");
  });

  test("unterminated front matter is a typed error", () => {
    const result = parseWorkflow("---\nkind: memory\nbody\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("workflow_parse_error");
  });
});

describe("value coercion", () => {
  test("$VAR and ${VAR} resolve; unset names become empty", () => {
    expect(resolveEnvTokens("$A/${B}/c", { A: "one", B: "two" })).toBe("one/two/c");
    expect(resolveEnvTokens("$MISSING", {})).toBe("");
  });

  test("~ expands and relative paths resolve against the workflow directory", () => {
    expect(coercePath("~/x", "/base", {})).toBe(join(homedir(), "x"));
    expect(coercePath("sub/dir", "/base", {})).toBe("/base/sub/dir");
    expect(coercePath("$ROOT/w", "/base", { ROOT: "/abs" })).toBe("/abs/w");
  });
});

describe("runner config", () => {
  test("defaults apply when only kind is given", () => {
    const config = resolveOk(`${base}runner:\n  kind: cli-exec\n---\nbody\n`);
    expect(config.runner.kind).toBe("cli-exec");
    expect(config.runner.turn_timeout_ms).toBe(3_600_000);
    expect(config.runner.read_timeout_ms).toBe(5_000);
    expect(config.runner.stall_timeout_ms).toBe(300_000);
    expect(config.runner.require_client_tools).toBe(false);
    expect(config.runner.provider).toEqual({});
  });

  test("provider keys the core does not recognize are preserved verbatim", () => {
    const config = resolveOk(
      `${base}runner:\n  kind: mock\n  provider:\n    some_future_key: {a: 1}\n    model: gpt-x\n---\nbody\n`,
    );
    expect(config.runner.provider).toEqual({ some_future_key: { a: 1 }, model: "gpt-x" });
  });

  test("runner.env resolves $VAR indirection", () => {
    const config = resolveOk(
      `${base}runner:\n  kind: mock\n  env:\n    TOKEN: $AGENT_TOKEN\n    LITERAL: plain\n---\nbody\n`,
      { AGENT_TOKEN: "sekret" },
    );
    expect(config.runner.env).toEqual({ TOKEN: "sekret", LITERAL: "plain" });
  });

  test("missing runner.kind fails resolution", () => {
    const result = resolveConfig(parse(`${base}---\nbody\n`), workflowPath, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("invalid_config");
  });

  test("stall_timeout_ms <= 0 is allowed and disables stall detection", () => {
    const config = resolveOk(`${base}runner:\n  kind: mock\n  stall_timeout_ms: 0\n---\nbody\n`);
    expect(config.runner.stall_timeout_ms).toBe(0);
  });
});

describe("deprecated codex block (delta D-006)", () => {
  test("a legacy-only workflow normalizes to the codex-app-server adapter", () => {
    const config = resolveOk(
      `${base}codex:\n  command: codex app-server\n  approval_policy: never\n  thread_sandbox: workspace-write\n  turn_sandbox_policy:\n    type: workspaceWrite\n  turn_timeout_ms: 60000\n---\nbody\n`,
    );
    expect(config.runner.kind).toBe("codex-app-server");
    expect(config.runner.command).toBe("codex app-server");
    expect(config.runner.turn_timeout_ms).toBe(60_000);
    expect(config.runner.provider).toEqual({
      approval_policy: "never",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: { type: "workspaceWrite" },
    });
    expect(config.warnings.join(" ")).toContain("deprecated");
  });

  test("runner wins over codex and the two are never merged", () => {
    const config = resolveOk(
      `${base}runner:\n  kind: cli-exec\n  command: echo hi\ncodex:\n  command: codex app-server\n  approval_policy: never\n---\nbody\n`,
    );
    expect(config.runner.kind).toBe("cli-exec");
    expect(config.runner.command).toBe("echo hi");
    expect(config.runner.provider).toEqual({});
    expect(config.warnings.join(" ")).toContain("both");
  });

  test("normalization is a pure function of the front matter", () => {
    const warnings: string[] = [];
    expect(normalizeLegacyRunner({ codex: { command: "x" } }, warnings)).toEqual({
      kind: "codex-app-server",
      provider: {},
      command: "x",
    });
    expect(normalizeLegacyRunner({}, warnings)).toEqual({});
  });
});

describe("scheduling config", () => {
  test("per-state concurrency keys normalize and invalid entries are ignored", () => {
    const config = resolveOk(
      `${base}runner:\n  kind: mock\nagent:\n  max_concurrent_agents_by_state:\n    "  In Progress ": 2\n    Broken: 0\n    AlsoBroken: nope\n---\nbody\n`,
    );
    expect(config.agent.max_concurrent_agents_by_state).toEqual({ "in progress": 2 });
  });

  test("invalid max_turns fails resolution", () => {
    const result = resolveConfig(
      parse(`${base}runner:\n  kind: mock\nagent:\n  max_turns: 0\n---\nbody\n`),
      workflowPath,
      {},
    );
    expect(result.ok).toBe(false);
  });
});
