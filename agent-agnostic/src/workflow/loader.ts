/**
 * WORKFLOW.md loader (spec 5.1, 5.2).
 *
 * Splits YAML front matter from the prompt body. Nothing here interprets config values; that is
 * the config layer's job.
 */

import { err, ok, type Result } from "../errors.ts";
import type { WorkflowDefinition } from "../types.ts";

export function parseWorkflow(text: string): Result<WorkflowDefinition> {
  const normalized = text.replace(/^﻿/, "");

  if (!normalized.startsWith("---")) {
    // No front matter: whole file is the prompt body, config is empty (spec 5.2).
    return ok({ config: {}, prompt_template: normalized.trim() });
  }

  const lines = normalized.split("\n");
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return err("workflow_parse_error", "front matter opened with --- but was never closed");
  }

  const frontMatter = lines.slice(1, closing).join("\n");
  const body = lines.slice(closing + 1).join("\n");

  let decoded: unknown;
  try {
    decoded = frontMatter.trim().length === 0 ? {} : Bun.YAML.parse(frontMatter);
  } catch (error) {
    return err(
      "workflow_parse_error",
      `front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (decoded === null || decoded === undefined) decoded = {};
  if (typeof decoded !== "object" || Array.isArray(decoded)) {
    return err("workflow_front_matter_not_a_map", "front matter must decode to a map/object");
  }

  return ok({
    config: decoded as Record<string, unknown>,
    prompt_template: body.trim(),
  });
}

export async function loadWorkflowFile(path: string): Promise<Result<WorkflowDefinition>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return err("missing_workflow_file", `workflow file not found: ${path}`);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    return err(
      "missing_workflow_file",
      `workflow file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseWorkflow(text);
}
