// GitHub workflow-command annotations — the ONE place this repo writes them.
//
// Why this exists: template operators have no GitHub access, so api-cloudrun
// reads each failed check run's annotations through the Checks API
// (`checks.listAnnotations`) and shows them in the manager. A guard that only
// prints prose to the log leaves that list holding runner noise ("Process
// completed with exit code 1.", all with path `.github`). So every guard emits
// one `::error` per BLOCKING finding through `annotateError` — and keeps its
// human-readable output exactly as it was, beside it.
//
// ⚠️ Emit only for what makes the check red. An advisory finding annotated as
// `::error` reads to an operator as the reason their change is blocked, and
// it is not. `annotateWarning` exists for the one guard where a non-blocking
// finding is trivially identifiable; do not reach for it to dump notices.
//
// ⚠️ The env read needs `--allow-env=GITHUB_ACTIONS`. Without it, a finding
// prints a one-line stderr warning that annotations were skipped rather than
// throwing — the guard's own verdict and exit code must not depend on whether
// its annotation channel is wired. CI wires every caller; the warning is what
// makes a caller that is not wired visible in the log instead of silently
// annotation-free.
//
// Format: https://docs.github.com/actions/reference/workflow-commands-for-github-actions

export interface Annotation {
  /** Repo-relative path. Omit when the finding is about no single file. */
  file?: string;
  /** 1-based line within `file`. Ignored without `file`. */
  line?: number;
  /** Short STABLE guard id, e.g. `templates-lint › capture-floor`. api-cloudrun groups on it. */
  title: string;
  message: string;
}

/** Escape the message (data) part of a workflow command. */
export function escapeData(s: string): string {
  return s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Escape a property value (`file=`, `title=` …) — data rules plus `:` and `,`. */
export function escapeProperty(s: string): string {
  return escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** Build the workflow-command line, without deciding whether to print it. */
export function formatAnnotation(level: "error" | "warning", a: Annotation): string {
  const props: string[] = [];
  if (a.file) {
    props.push(`file=${escapeProperty(a.file)}`);
    if (a.line !== undefined && a.line > 0) props.push(`line=${a.line}`);
  }
  props.push(`title=${escapeProperty(a.title)}`);
  return `::${level} ${props.join(",")}::${escapeData(a.message)}`;
}

let warnedNoPermission = false;

/** True when running under GitHub Actions. Never throws. */
export function inGitHubActions(): boolean {
  const state = Deno.permissions.querySync({ name: "env", variable: "GITHUB_ACTIONS" }).state;
  if (state !== "granted") {
    if (!warnedNoPermission) {
      warnedNoPermission = true;
      console.error(
        "[annotate] GITHUB_ACTIONS is not readable (run with --allow-env=GITHUB_ACTIONS) — " +
          "no workflow annotations emitted for this run.",
      );
    }
    return false;
  }
  return Deno.env.get("GITHUB_ACTIONS") === "true";
}

/** Emit `::error` to stdout when under GitHub Actions; a no-op elsewhere. */
export function annotateError(a: Annotation): void {
  if (inGitHubActions()) console.log(formatAnnotation("error", a));
}

/** Emit `::warning` to stdout when under GitHub Actions; a no-op elsewhere. */
export function annotateWarning(a: Annotation): void {
  if (inGitHubActions()) console.log(formatAnnotation("warning", a));
}
