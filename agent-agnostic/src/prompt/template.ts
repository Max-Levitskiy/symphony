/**
 * Strict Liquid-compatible template renderer (spec 5.4, 12.2).
 *
 * "Liquid-compatible semantics are sufficient" — this implements the subset workflows actually
 * use, with the two strictness rules the spec requires: unknown variables and unknown filters both
 * fail rendering rather than silently producing an empty string. A prompt that silently loses the
 * issue description is worse than a run that fails loudly.
 *
 * Supported: `{{ path | filter: arg }}`, `{% if %}` / `{% elsif %}` / `{% else %}` / `{% endif %}`,
 * `{% unless %}`, `{% for x in list %}` with `forloop.index`, and `{% comment %}`.
 */

import { SymphonyError } from "../errors.ts";

type Node =
  | { kind: "text"; value: string }
  | { kind: "output"; expr: string }
  | { kind: "if"; branches: { condition: string | null; body: Node[] }[] }
  | { kind: "for"; item: string; collection: string; body: Node[] };

export type TemplateContext = Record<string, unknown>;

const FILTERS: Record<string, (input: unknown, args: unknown[]) => unknown> = {
  default: (input, args) =>
    input === null || input === undefined || input === "" || (Array.isArray(input) && input.length === 0)
      ? args[0]
      : input,
  upcase: (input) => String(input ?? "").toUpperCase(),
  downcase: (input) => String(input ?? "").toLowerCase(),
  strip: (input) => String(input ?? "").trim(),
  size: (input) =>
    Array.isArray(input) ? input.length : input === null || input === undefined ? 0 : String(input).length,
  join: (input, args) => (Array.isArray(input) ? input.join(String(args[0] ?? " ")) : String(input ?? "")),
  first: (input) => (Array.isArray(input) ? (input[0] ?? "") : String(input ?? "").charAt(0)),
  last: (input) => (Array.isArray(input) ? (input.at(-1) ?? "") : String(input ?? "").slice(-1)),
  truncate: (input, args) => {
    const text = String(input ?? "");
    const limit = Number(args[0] ?? 50);
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
  },
  json: (input) => JSON.stringify(input ?? null),
};

const fail = (message: string, category: "template_parse_error" | "template_render_error") => {
  throw new SymphonyError(category, message);
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Token =
  | { type: "text"; value: string }
  | { type: "output"; value: string }
  | { type: "tag"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\{\{(.*?)\}\}|\{%(.*?)%\}/gs;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    if (start > last) tokens.push({ type: "text", value: source.slice(last, start) });
    if (match[1] !== undefined) tokens.push({ type: "output", value: match[1].trim() });
    else tokens.push({ type: "tag", value: match[2]!.trim() });
    last = start + match[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
  return tokens;
}

function parse(tokens: Token[]): Node[] {
  let index = 0;

  const parseBody = (terminators: string[]): { body: Node[]; terminator: string | null } => {
    const body: Node[] = [];
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.type === "tag") {
        const keyword = token.value.split(/\s+/)[0]!;
        if (terminators.includes(keyword)) return { body, terminator: token.value };
      }
      index++;

      if (token.type === "text") {
        body.push({ kind: "text", value: token.value });
        continue;
      }
      if (token.type === "output") {
        body.push({ kind: "output", expr: token.value });
        continue;
      }

      const [keyword, ...rest] = token.value.split(/\s+/);
      const argument = rest.join(" ");
      switch (keyword) {
        case "comment": {
          const inner = parseBody(["endcomment"]);
          if (inner.terminator === null) fail("{% comment %} was never closed", "template_parse_error");
          index++;
          break;
        }
        case "if":
        case "unless": {
          const branches: { condition: string | null; body: Node[] }[] = [];
          let condition: string | null = keyword === "unless" ? `!(${argument})` : argument;
          for (;;) {
            const inner = parseBody(["elsif", "else", "endif", "endunless"]);
            branches.push({ condition, body: inner.body });
            if (inner.terminator === null) {
              fail(`{% ${keyword} %} was never closed`, "template_parse_error");
            }
            const [term, ...termRest] = inner.terminator!.split(/\s+/);
            index++;
            if (term === "endif" || term === "endunless") break;
            condition = term === "else" ? null : termRest.join(" ");
          }
          body.push({ kind: "if", branches });
          break;
        }
        case "for": {
          const match = /^(\w+)\s+in\s+(.+)$/.exec(argument);
          if (!match) fail(`malformed for tag: {% ${token.value} %}`, "template_parse_error");
          const inner = parseBody(["endfor"]);
          if (inner.terminator === null) fail("{% for %} was never closed", "template_parse_error");
          index++;
          body.push({ kind: "for", item: match![1]!, collection: match![2]!.trim(), body: inner.body });
          break;
        }
        default:
          fail(`unknown tag: {% ${token.value} %}`, "template_parse_error");
      }
    }
    return { body, terminator: null };
  };

  const { body, terminator } = parseBody([]);
  if (terminator !== null) fail(`unexpected {% ${terminator} %}`, "template_parse_error");
  return body;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function lookup(path: string, context: TemplateContext): unknown {
  const segments = path.split(".");
  let current: unknown = context;
  const walked: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    if (current === null || current === undefined) {
      fail(
        `unknown variable '${path}': '${walked.slice(0, -1).join(".")}' is null`,
        "template_render_error",
      );
    }
    if (typeof current !== "object") {
      fail(`unknown variable '${path}': '${walked.slice(0, -1).join(".")}' is not an object`, "template_render_error");
    }
    const container = current as Record<string, unknown>;
    if (!(segment in container)) {
      fail(`unknown variable '${path}'`, "template_render_error");
    }
    current = container[segment];
  }
  return current;
}

function parseLiteral(token: string): { literal: true; value: unknown } | { literal: false } {
  if (/^-?\d+(\.\d+)?$/.test(token)) return { literal: true, value: Number(token) };
  if (token === "true") return { literal: true, value: true };
  if (token === "false") return { literal: true, value: false };
  if (token === "nil" || token === "null" || token === "empty") return { literal: true, value: null };
  if (/^"(.*)"$/s.test(token) || /^'(.*)'$/s.test(token)) {
    return { literal: true, value: token.slice(1, -1) };
  }
  return { literal: false };
}

function evaluateTerm(token: string, context: TemplateContext): unknown {
  const literal = parseLiteral(token);
  return literal.literal ? literal.value : lookup(token, context);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function evaluateCondition(expression: string, context: TemplateContext): boolean {
  const source = expression.trim();

  if (source.startsWith("!(") && source.endsWith(")")) {
    return !evaluateCondition(source.slice(2, -1), context);
  }
  for (const [operator, combine] of [
    [" or ", (a: boolean, b: boolean) => a || b],
    [" and ", (a: boolean, b: boolean) => a && b],
  ] as const) {
    const at = source.indexOf(operator);
    if (at !== -1) {
      return combine(
        evaluateCondition(source.slice(0, at), context),
        evaluateCondition(source.slice(at + operator.length), context),
      );
    }
  }

  const comparison = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(source);
  if (comparison) {
    const left = evaluateTerm(comparison[1]!.trim(), context);
    const right = evaluateTerm(comparison[3]!.trim(), context);
    switch (comparison[2]) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case ">":
        return Number(left) > Number(right);
      case "<":
        return Number(left) < Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<=":
        return Number(left) <= Number(right);
    }
  }

  return truthy(evaluateTerm(source, context));
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function evaluateOutput(expression: string, context: TemplateContext): string {
  const parts = expression.split("|").map((p) => p.trim());
  let value = evaluateTerm(parts[0]!, context);

  for (const filterExpr of parts.slice(1)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.*))?$/s.exec(filterExpr);
    if (!match) fail(`malformed filter '${filterExpr}'`, "template_render_error");
    const name = match![1]!;
    const filter = FILTERS[name];
    if (!filter) fail(`unknown filter '${name}'`, "template_render_error");
    const args = (match![2] ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => evaluateTerm(a, context));
    value = filter!(value, args);
  }
  return stringify(value);
}

function renderNodes(nodes: Node[], context: TemplateContext): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "output":
        out += evaluateOutput(node.expr, context);
        break;
      case "if": {
        for (const branch of node.branches) {
          if (branch.condition === null || evaluateCondition(branch.condition, context)) {
            out += renderNodes(branch.body, context);
            break;
          }
        }
        break;
      }
      case "for": {
        const collection = evaluateTerm(node.collection, context);
        if (!Array.isArray(collection)) {
          fail(`'${node.collection}' is not iterable`, "template_render_error");
        }
        const items = collection as unknown[];
        items.forEach((item, index) => {
          out += renderNodes(node.body, {
            ...context,
            [node.item]: item,
            forloop: {
              index: index + 1,
              index0: index,
              first: index === 0,
              last: index === items.length - 1,
              length: items.length,
            },
          });
        });
        break;
      }
    }
  }
  return out;
}

export function renderTemplate(source: string, context: TemplateContext): string {
  return renderNodes(parse(tokenize(source)), context);
}
