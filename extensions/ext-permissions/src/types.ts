/**
 * yes-my-pi Permission System — Data Model
 *
 * Single source of truth for the permission system's type definitions
 * AND the invariant constants derived from them (valid actions,
 * evaluation priority, scope precedence). Other modules — the config
 * validator and the rule engine — must import from here rather than
 * redefining these constants locally, to prevent drift.
 *
 * Core invariants:
 *   - Action severity:    deny > ask > allow
 *   - Scope precedence:   project > global > default
 *   - `deny` is an absolute floor: no scope can override a `deny`.
 *   - Parsed rules are immutable at runtime (enforced via readonly).
 */

export type PermissionAction = "allow" | "deny" | "ask";

export const PERMISSION_ACTIONS = ["allow", "ask", "deny"] as const;

// Internal Set for O(1) lookup in high-frequency type guards
const PERMISSION_ACTION_SET: ReadonlySet<string> = new Set(PERMISSION_ACTIONS);

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && PERMISSION_ACTION_SET.has(value);
}

export const ACTION_SEVERITY = {
  allow: 1,
  ask: 2,
  deny: 3,
} as const satisfies Record<PermissionAction, number>;

export type PermissionScope = "project" | "global" | "default";

export const SCOPE_PRECEDENCE = ["project", "global", "default"] as const;

// Internal Set for O(1) lookup
const SCOPE_SET: ReadonlySet<string> = new Set(SCOPE_PRECEDENCE);

export function isPermissionScope(value: unknown): value is PermissionScope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

export const CURRENT_CONFIG_VERSION = 1;

export const KNOWN_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export const WILDCARD_TOOL = "*" as const;

export type PatternOrList = string | string[];

export interface RuleMatch {
  readonly command?: PatternOrList;
  readonly path?: PatternOrList;
  readonly args?: Record<string, PatternOrList>;

  /**
   * Pattern syntax (see `matchPattern` in matcher.ts):
   *   - No wildcard  -> exact match only (safer default for security rules)
   *   - "*"          -> matches any sequence except "/"
   *   - "**"         -> matches any sequence, including "/" (any depth)
   */
}

export interface PermissionRule {
  /** Tool name this rule applies to, or "*" to match every tool. */
  readonly tool: string;
  /** Additional match conditions. Omit to match all calls to `tool`. */
  readonly match?: RuleMatch;
  /** Action to take when this rule matches. */
  readonly action: PermissionAction;
  /** Human-readable explanation shown when this rule results in `ask` or `deny`. */
  readonly reason?: string;
}

export interface PermissionConfig {
  /** Schema version. Currently only `1` is supported. */
  readonly version: number;
  /** Fallback action when no rule in this config matches a call. */
  readonly defaultAction: PermissionAction;
  /** Ordered rule list. First-match-wins within a single scope. */
  readonly rules: readonly PermissionRule[];
}

export interface MatchResult {
  readonly action: PermissionAction;
  /** The rule that produced this result, absent for pure fallback results. */
  readonly rule?: PermissionRule;
  readonly scope: PermissionScope;
  readonly reason?: string;
}

export interface ToolCallInfo {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}
