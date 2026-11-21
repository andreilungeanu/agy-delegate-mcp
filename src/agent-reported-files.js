import path from "node:path";

// Attribution rule: a path is agent-reported only via a native ACP diff event.
// Never add paths from git, the final message, or shell output — the orchestrator
// owns workspace diff review.

// agy reports a finished edit's diff path as /C:/Users/… on Windows (leading slash, forward
// slashes) while the same call's args carry C:\Users\…. The slash before the drive letter makes
// path.resolve read it as rooted on the current drive, so it is stripped before resolving.
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
