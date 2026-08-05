/** Strict template rendering and capability-aware prompt building (forked spec 17.1, 7.1). */

import { describe, expect, test } from "bun:test";
import { renderTemplate } from "../src/prompt/template.ts";
import { buildTurnPrompt, DEFAULT_PROMPT } from "../src/prompt/builder.ts";
import { issue } from "./support/fixtures.ts";

describe("template rendering", () => {
  const context = { issue: issue({ labels: ["bug", "backend"] }), attempt: null };

  test("renders paths, conditionals, and loops", () => {
    expect(renderTemplate("{{ issue.identifier }}: {{ issue.title }}", context)).toBe(
      "AA-1: Do the thing",
    );
    expect(renderTemplate("{% if issue.description %}has{% else %}none{% endif %}", context)).toBe("has");
    expect(renderTemplate("{% if attempt %}retry{% else %}first{% endif %}", context)).toBe("first");
    expect(renderTemplate("{% for l in issue.labels %}[{{ l }}]{% endfor %}", context)).toBe(
      "[bug][backend]",
    );
    expect(renderTemplate("{% unless attempt %}fresh{% endunless %}", context)).toBe("fresh");
  });

  test("arrays stringify as comma-separated values and filters apply", () => {
    expect(renderTemplate("{{ issue.labels }}", context)).toBe("bug, backend");
    expect(renderTemplate("{{ issue.labels | join: ' & ' }}", context)).toBe("bug & backend");
    expect(renderTemplate("{{ issue.description | default: 'none' | upcase }}", context)).toBe(
      "A DESCRIPTION",
    );
    expect(renderTemplate("{{ issue.branch_name | default: 'main' }}", context)).toBe("main");
  });

  test("forloop metadata is available", () => {
    expect(renderTemplate("{% for l in issue.labels %}{{ forloop.index }}{% endfor %}", context)).toBe("12");
  });

  test("unknown variables fail rendering", () => {
    expect(() => renderTemplate("{{ issue.nope }}", context)).toThrow(/unknown variable/);
    expect(() => renderTemplate("{{ nope }}", context)).toThrow(/unknown variable/);
  });

  test("unknown filters fail rendering", () => {
    expect(() => renderTemplate("{{ issue.title | shout }}", context)).toThrow(/unknown filter/);
  });

  test("unknown and unclosed tags fail parsing", () => {
    expect(() => renderTemplate("{% wat %}", context)).toThrow(/unknown tag/);
    expect(() => renderTemplate("{% if attempt %}x", context)).toThrow(/never closed/);
  });
});

describe("turn prompt construction", () => {
  const template = "Task {{ issue.identifier }}{% if attempt %} (attempt {{ attempt }}){% endif %}";
  const common = { template, issue: issue(), attempt: null, max_turns: 5 };

  test("turn 1 renders the full task prompt", () => {
    const result = buildTurnPrompt({ ...common, turn_number: 1, full_prompt: true });
    expect(result.ok && result.value).toBe("Task AA-1");
  });

  test("a stateful agent gets continuation guidance only", () => {
    const result = buildTurnPrompt({ ...common, turn_number: 2, full_prompt: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain("Task AA-1");
    expect(result.value).toContain("Continue the work");
    expect(result.value).toContain("turn 2 of at most 5");
  });

  test("a stateless agent gets the whole task again plus the guidance", () => {
    const result = buildTurnPrompt({ ...common, turn_number: 2, full_prompt: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("Task AA-1");
    expect(result.value).toContain("Continue the work");
  });

  test("attempt reaches the template on retries", () => {
    const result = buildTurnPrompt({ ...common, attempt: 3, turn_number: 1, full_prompt: true });
    expect(result.ok && result.value).toBe("Task AA-1 (attempt 3)");
  });

  test("an empty template falls back to the minimal default prompt", () => {
    const result = buildTurnPrompt({ ...common, template: "   ", turn_number: 1, full_prompt: true });
    expect(result.ok && result.value).toBe(DEFAULT_PROMPT);
  });

  test("a render failure is returned, not thrown", () => {
    const result = buildTurnPrompt({
      ...common,
      template: "{{ issue.missing }}",
      turn_number: 1,
      full_prompt: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("template_render_error");
  });
});
