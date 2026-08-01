/**
 * OPTIONAL HTTP observability extension (spec 13.7).
 *
 * Observability and operational control only. Nothing here may become required for orchestrator
 * correctness, so every handler reads from a snapshot and the only write is a refresh trigger.
 */

import type { Orchestrator, Snapshot } from "../orchestrator/orchestrator.ts";

export type HttpServer = { port: number; stop(): void };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const apiError = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

export function startHttpServer(orchestrator: Orchestrator, port: number, hostname = "127.0.0.1"): HttpServer {
  const server = Bun.serve({
    port,
    hostname,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        if (request.method !== "GET") return apiError("method_not_allowed", "use GET", 405);
        return new Response(dashboard(orchestrator.snapshot()), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (path === "/api/v1/state") {
        if (request.method !== "GET") return apiError("method_not_allowed", "use GET", 405);
        return json(orchestrator.snapshot());
      }

      if (path === "/api/v1/refresh") {
        if (request.method !== "POST") return apiError("method_not_allowed", "use POST", 405);
        const result = orchestrator.requestRefresh();
        return json(
          {
            queued: result.queued,
            coalesced: result.coalesced,
            requested_at: new Date().toISOString(),
            operations: ["poll", "reconcile"],
          },
          202,
        );
      }

      const issueMatch = /^\/api\/v1\/(.+)$/.exec(path);
      if (issueMatch) {
        if (request.method !== "GET") return apiError("method_not_allowed", "use GET", 405);
        const detail = orchestrator.issueDetail(decodeURIComponent(issueMatch[1]!));
        if (!detail) {
          return apiError("issue_not_found", `no runtime state for '${issueMatch[1]}'`, 404);
        }
        return json(detail);
      }

      return apiError("not_found", `no route for ${path}`, 404);
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

function dashboard(snapshot: Snapshot): string {
  const runningRows = snapshot.running
    .map(
      (row) => `<tr>
        <td><a href="${escape(row.issue_url ?? "#")}">${escape(row.issue_identifier)}</a></td>
        <td>${escape(row.state)}</td>
        <td><code>${escape(row.agent_kind)}</code></td>
        <td>${escape(row.turn_count)}</td>
        <td>${escape(row.last_event ?? "—")}</td>
        <td>${row.usage_reported ? escape(row.tokens.total_tokens) : "<em>not reported</em>"}</td>
        <td>${escape(row.started_at)}</td>
      </tr>`,
    )
    .join("");

  const retryRows = snapshot.retrying
    .map(
      (row) => `<tr>
        <td>${escape(row.issue_identifier)}</td>
        <td>${escape(row.attempt)}</td>
        <td>${escape(row.due_at)}</td>
        <td>${escape(row.error ?? "continuation")}</td>
      </tr>`,
    )
    .join("");

  const warnings = snapshot.warnings.length
    ? `<div class="warn">${snapshot.warnings.map((w) => `<div>${escape(w)}</div>`).join("")}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony — ${escape(snapshot.agent_kind)}</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 70rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; opacity: .7; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; }
  .cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 2rem; }
  .card { border: 1px solid var(--line); border-radius: .6rem; padding: .8rem 1rem; min-width: 9rem; }
  .card b { display: block; font-size: 1.5rem; font-weight: 600; }
  .card span { opacity: .7; font-size: .85rem; }
  .warn { border-left: 3px solid #d97706; padding: .5rem .8rem; margin-bottom: 1.5rem; opacity: .9; }
  code { font-family: ui-monospace, monospace; font-size: .9em; }
  em { opacity: .6; }
</style>
</head>
<body>
<h1>Symphony</h1>
<div class="sub">agent <code>${escape(snapshot.agent_kind)}</code> · generated ${escape(snapshot.generated_at)}</div>
${warnings}
<div class="cards">
  <div class="card"><b>${snapshot.counts.running}</b><span>running</span></div>
  <div class="card"><b>${snapshot.counts.retrying}</b><span>retrying</span></div>
  <div class="card"><b>${snapshot.agent_totals.total_tokens}</b><span>tokens</span></div>
  <div class="card"><b>${snapshot.agent_totals.seconds_running}s</b><span>agent runtime</span></div>
</div>
<h2>Running</h2>
<table>
  <thead><tr><th>Issue</th><th>State</th><th>Agent</th><th>Turns</th><th>Last event</th><th>Tokens</th><th>Started</th></tr></thead>
  <tbody>${runningRows || '<tr><td colspan="7"><em>nothing running</em></td></tr>'}</tbody>
</table>
<h2>Retry queue</h2>
<table>
  <thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Reason</th></tr></thead>
  <tbody>${retryRows || '<tr><td colspan="4"><em>empty</em></td></tr>'}</tbody>
</table>
</body>
</html>`;
}
