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
 */

export type PermissionAction = "allow" | "deny" | "ask";

export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  "allow",
  "ask",
  "deny",
];

export function isPermissionAction(value: unknown): value is PermissionAction {
  return (
    typeof value === "string" &&
    (PERMISSION_ACTIONS as readonly string[]).includes(value)
  );
}

export const ACTION_SEVERITY: Readonly<Record<PermissionAction, number>> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

export type PermissionScope = "project" | "global" | "default";

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
  command?: PatternOrList;
  path?: PatternOrList;
  args?: Record<string, PatternOrList>;

  /**
   * Pattern syntax (see `matchPattern` in matcher.ts):
   *   - No wildcard  -> exact match only (safer default for security rules)
   *   - "*"          -> matches any sequence except "/"
   *   - "**"         -> matches any sequence, including "/" (any depth)
   */
}

export interface PermissionRule {
  /** Tool name this rule applies to, or "*" to match every tool. */
  tool: string;
  /** Additional match conditions. Omit to match all calls to `tool`. */
  match?: RuleMatch;
  /** Action to take when this rule matches. */
  action: PermissionAction;
  /** Human-readable explanation shown when this rule results in `ask` or `deny`. */
  reason?: string;
}

export interface PermissionConfig {
  /** Schema version. Currently only `1` is supported. */
  version: number;
  /** Fallback action when no rule in this config matches a call. */
  defaultAction: PermissionAction;
  /** Ordered rule list. First-match-wins within a single scope. */
  rules: readonly PermissionRule[];
}

export interface MatchResult {
  action: PermissionAction;
  /** The rule that produced this result, absent for pure fallback results. */
  rule?: PermissionRule;
  scope: PermissionScope;
  reason?: string;
}

export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
}
