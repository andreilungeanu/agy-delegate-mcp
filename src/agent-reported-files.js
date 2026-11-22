import path from "node:path";

// A path is agent-reported only via an ACP diff event, never from git, the message or shell output:
// the orchestrator owns diff review.

// agy writes diff paths as /C:/Users/… on Windows; path.resolve would read the leading slash as
// the current drive's root, so it is stripped.
export function fromAgentPath(p) {
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
}

function relativize(abs, workspace) {
  if (!workspace) return abs;
  const r = path.relative(workspace, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return abs;
  return r.split(path.sep).join("/");
}

export function normalizeAgentReportedFiles(paths, workspace) {
  const abs = paths.map((p) => fromAgentPath(p)).map((p) => (workspace ? path.resolve(workspace, p) : path.resolve(p)));
  return [...new Set(abs)].map((f) => relativize(f, workspace));
}
