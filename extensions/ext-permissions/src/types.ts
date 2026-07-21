/**
 * yes-my-pi Permission System — Data Model
 *
 * This module is the single source of truth for the permission system's
 * type definitions AND the invariant constants derived from them
 * (valid actions, evaluation priority, scope precedence). Other modules
 * (config validator, rule engine) should import from here rather than
 * redefining these constants locally, to avoid drift.
 *
 * Core invariants:
 * - Action evaluation priority:  deny > ask > allow
 * - Scope precedence:            project > global > default
 */

// ── Actions ───────────────────────────────────────────────

/**
 * A permission action decides what happens when a rule matches a tool call.
 * - `allow` — execute without prompting the user.
 * - `ask`   — prompt the user for approval before executing.
 * - `deny`  — block execution unconditionally.
 */
export type PermissionAction = "allow" | "deny" | "ask";

/**
 * Canonical, ordered list of all valid actions.
 * Order here is purely for iteration/display; see `ACTION_SEVERITY` for
 * evaluation priority.
 */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  "allow",
  "ask",
  "deny",
];

/**
 * Runtime type guard for `PermissionAction`.
 * Use this instead of re-implementing `.includes()` checks in every module.
 */
export function isPermissionAction(value: unknown): value is PermissionAction {
  return (
    typeof value === "string" &&
    (PERMISSION_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Severity ranking used when multiple rules/scopes produce different
 * actions for the same call. Higher number = stricter = wins.
 *
 * `deny` is intentionally the highest and is treated as an absolute floor
 * by the rule engine: no less-strict action can override it, regardless
 * of which scope it came from.
 */
export const ACTION_SEVERITY: Readonly<Record<PermissionAction, number>> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

// ── Scopes ────────────────────────────────────────────────

/**
 * Where a matched rule (or fallback) originated from.
 * Precedence for cascading overrides: project > global > default.
 */
export type PermissionScope = "project" | "global" | "default";

/**
 * Canonical scope precedence order, highest priority first.
 * The rule engine iterates scopes in this exact order when resolving
 * cascading (non-deny) overrides.
 */
export const SCOPE_PRECEDENCE: readonly PermissionScope[] = [
  "project",
  "global",
  "default",
];

export function isPermissionScope(value: unknown): value is PermissionScope {
  return (
    typeof value === "string" &&
    (SCOPE_PRECEDENCE as readonly string[]).includes(value)
  );
}

// ── Config Versioning ─────────────────────────────────────

/**
 * Currently supported config schema version.
 * Bump this and add migration logic in the loader when the schema changes.
 */
export const CURRENT_CONFIG_VERSION = 1;

// ── Well-known Tool Names ─────────────────────────────────

/**
 * Built-in tool names recognized by Pi. This is NOT an exhaustive/closed
 * set — `PermissionRule.tool` remains a plain `string` (plus `"*"` wildcard)
 * so third-party or future tools work without a type change here. This
 * list exists purely for documentation, editor autocomplete hints, and
 * config-authoring tooling (e.g. a JSON schema generator).
 */
export const KNOWN_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

/** Sentinel value matching any tool name in `PermissionRule.tool`. */
export const WILDCARD_TOOL = "*" as const;

// ── Rule Matching ─────────────────────────────────────────

/**
 * A single pattern or a list of patterns. When a list is given, the rule
 * matches if ANY pattern matches (logical OR).
 */
export type PatternOrList = string | string[];

/**
 * Argument-level match conditions for a permission rule.
 *
 * All specified fields must match for the rule to apply (logical AND
 * across fields; logical OR within each field's pattern list).
 *
 * Pattern syntax (see `matchPattern` in rule-engine.ts):
 * - No wildcard  → exact match only (safer default for security rules).
 * - `*`          → matches any sequence except `/` (single path segment).
 * - `**`         → matches any sequence, including `/` (any depth).
 * - `?`          → matches exactly one character except `/`.
 */
export interface RuleMatch {
  /**
   * Bash command pattern(s). Only applies when `tool` is `"bash"`.
   * @example "npm test*"       matches "npm test", "npm test -- --watch"
   * @example ["npm test*", "pnpm test*"]
   */
  command?: PatternOrList;

  /**
   * File path pattern(s). Applies to tools that operate on a file path
   * (typically `"read"`, `"write"`, `"edit"`).
   * @example "src/**\/*.ts"    matches any .ts file under src/, any depth
   */
  path?: PatternOrList;

  /**
   * Generic key → pattern map for matching arbitrary tool-call arguments
   * not covered by `command`/`path`. All keys must match.
   */
  args?: Record<string, PatternOrList>;
}

// ── Rules & Config ────────────────────────────────────────

/**
 * A single permission rule.
 *
 * Within one config's `rules` array, evaluation is **first-match-wins**:
 * the engine walks the array in order and stops at the first rule whose
 * `tool` + `match` conditions are satisfied. Author more specific rules
 * *before* more general ones.
 */
export interface PermissionRule {
  /**
   * Tool name this rule applies to, or `"*"` (see `WILDCARD_TOOL`) to
   * match every tool. See `KNOWN_TOOL_NAMES` for common built-ins —
   * any string is accepted to support future/custom tools.
   */
  tool: string;

  /** Additional match conditions. Omit to match all calls to `tool`. */
  match?: RuleMatch;

  /** Action to take when this rule matches. */
  action: PermissionAction;

  /**
   * Human-readable explanation shown to the user (and passed to the LLM)
   * when this rule results in `ask` or `deny`.
   */
  reason?: string;
}

/**
 * Shape of a permission config file (parsed from YAML).
 *
 * A config is a static, load-time snapshot — `rules` is declared
 * `readonly` to signal it should not be mutated after loading. Reload
 * via the config loader instead of patching in place.
 */
export interface PermissionConfig {
  /** Schema version. Currently only `1` is supported. */
  version: number;

  /** Fallback action when no rule in this config matches a call. */
  defaultAction: PermissionAction;

  /** Ordered rule list. See `PermissionRule` for evaluation semantics. */
  rules: readonly PermissionRule[];
}

// ── Evaluation Result ─────────────────────────────────────

/**
 * The outcome of evaluating a tool call against all configured scopes.
 */
export interface MatchResult {
  /** Final resolved action. */
  action: PermissionAction;

  /** The rule that produced this result. Absent for pure fallback results
   *  (e.g. `defaultAction` fallback, or the bash classifier heuristic). */
  rule?: PermissionRule;

  /** Which scope this result came from. */
  scope: PermissionScope;

  /** Explanation to surface to the user/LLM, if any. */
  reason?: string;
}

// ── Tool Call Input ───────────────────────────────────────

/**
 * Normalized representation of a tool call, extracted from Pi's
 * `tool_call` event, that the rule engine evaluates against.
 */
export interface ToolCallInfo {
  /** Name of the tool being invoked (e.g. `"bash"`, `"read"`, `"edit"`). */
  toolName: string;

  /** Raw arguments passed to the tool call, as provided by Pi. */
  args: Record<string, unknown>;
}
