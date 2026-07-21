/**
 * yes-my-pi Permission System — Rule Matching Engine
 *
 * Pure functions, no dependency on the Pi API — fully unit-testable in isolation.
 */

import type {
  MatchResult,
  PermissionAction,
  PermissionConfig,
  PermissionRule,
  ToolCallInfo,
} from "./types.js";
import { classifyBashCommand } from "./bash-analyzer.js";

// ── Pattern Matching ─────────────────────────────────────

/** Cache of compiled glob patterns to avoid recompiling on every call. */
const patternRegexCache = new Map<string, RegExp>();

/**
 * Compiles a glob-like pattern into a cached RegExp.
 *
 * Supported syntax:
 * - `**` matches anything, including path separators (any depth).
 * - `*`  matches anything except `/` (single path segment).
 * - `?`  matches exactly one character except `/`.
 */
function compileGlobPattern(pattern: string): RegExp {
  const cached = patternRegexCache.get(pattern);
  if (cached) return cached;

  const PLACEHOLDER = "\u0000"; // temporary stand-in for "**" during escaping

  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters (not *, ?)
    .replace(/\*\*/g, PLACEHOLDER)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(new RegExp(PLACEHOLDER, "g"), ".*");

  const regex = new RegExp(`^${source}$`);
  patternRegexCache.set(pattern, regex);
  return regex;
}

/**
 * Matches a value against a glob-like pattern.
 *
 * Examples:
 *   matchPattern("npm test*", "npm test -- --watch") → true
 *   matchPattern("src/**\/*.ts", "src/foo/bar.ts")     → true
 *   matchPattern("*.ts", "index.ts")                  → true
 *   matchPattern("npm test", "npm test")              → true  (exact)
 *   matchPattern("npm test", "npm test --watch")      → false (no wildcard = exact only)
 *
 * Design note: patterns WITHOUT any `*`/`?` only match exactly. This is a
 * deliberate safety choice for a permission engine — implicit prefix
 * matching (e.g. "src/secret.ts" silently matching "src/secret.ts.bak")
 * is a real risk in security-sensitive config. If prefix matching is
 * desired, the rule author must write it explicitly with a trailing `*`.
 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true; // fast path, no regex needed

  if (pattern.includes("*") || pattern.includes("?")) {
    return compileGlobPattern(pattern).test(value);
  }

  return false;
}

/** Matches a value against a single pattern or an array of patterns (any-hit = true). */
function matchStringOrArray(
  patterns: string | string[] | undefined,
  value: string,
): boolean {
  if (patterns === undefined) return true; // no constraint specified
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) => matchPattern(p, value));
}

/** Reads a tool-call argument as a string, defaulting to "". */
function argAsString(call: ToolCallInfo, ...keys: string[]): string {
  for (const key of keys) {
    const value = call.args[key];
    if (value !== undefined) return String(value);
  }
  return "";
}

// ── Single Rule Matching ─────────────────────────────────

/**
 * Determines whether a single rule matches a given tool call.
 */
export function matchRule(rule: PermissionRule, call: ToolCallInfo): boolean {
  // 1. Tool name match
  if (rule.tool !== "*" && rule.tool !== call.toolName) {
    return false;
  }

  // 2. No `match` clause → matches every call to this tool
  if (!rule.match) {
    return true;
  }

  const { command, path, args } = rule.match;

  // 3. Bash command match
  if (command !== undefined && call.toolName === "bash") {
    const cmd = argAsString(call, "command");
    if (!matchStringOrArray(command, cmd)) return false;
  }

  // 4. File path match
  if (path !== undefined) {
    const filePath = argAsString(call, "path", "file", "filePath");
    if (!matchStringOrArray(path, filePath)) return false;
  }

  // 5. Generic argument match
  if (args !== undefined) {
    for (const [key, pattern] of Object.entries(args)) {
      const value = argAsString(call, key);
      if (!matchStringOrArray(pattern, value)) return false;
    }
  }

  return true;
}

// ── Rule Set Evaluation ───────────────────────────────────

/**
 * Finds the first rule in a list that matches the call and satisfies
 * an optional predicate. Rule order matters — this is what gives users
 * control via ordering (write specific overrides before general rules).
 */
function findFirstMatchingRule(
  rules: PermissionRule[],
  call: ToolCallInfo,
  predicate?: (rule: PermissionRule) => boolean,
): PermissionRule | undefined {
  for (const rule of rules) {
    if (!matchRule(rule, call)) continue;
    if (predicate && !predicate(rule)) continue;
    return rule;
  }
  return undefined;
}

/**
 * Generates an implicit result for `bash` tool calls based on the
 * command classifier. Used as a fallback when no explicit YAML rule
 * matches in any scope.
 */
function evaluateBashClassifier(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName !== "bash") return undefined;

  const cmd = argAsString(call, "command");
  const cls = classifyBashCommand(cmd);
  const preview = cmd.slice(0, 80);

  switch (cls) {
    case "dangerous":
      return {
        action: "deny",
        scope: "default",
        reason: `Command classified as dangerous: "${preview}"`,
      };
    case "write":
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason: `Command contains a write operation or could not be classified: "${preview}"`,
      };
    case "read":
      return { action: "allow", scope: "default", reason: undefined };
  }
}

interface ScopedConfig {
  scope: MatchResult["scope"];
  config: PermissionConfig;
}

/** Collects present configs in cascade priority order: project > global > default. */
function collectScopedConfigs(configs: {
  project?: PermissionConfig;
  global?: PermissionConfig;
  default?: PermissionConfig;
}): ScopedConfig[] {
  const scopes: ScopedConfig[] = [];
  if (configs.project)
    scopes.push({ scope: "project", config: configs.project });
  if (configs.global) scopes.push({ scope: "global", config: configs.global });
  if (configs.default)
    scopes.push({ scope: "default", config: configs.default });
  return scopes;
}

/**
 * Main entry point: evaluates a tool call against all configuration layers.
 *
 * Resolution model (two passes):
 *
 * **Pass 1 — Deny is an absolute floor.** If *any* scope (project, global,
 * or default) has a rule matching the call with `action: "deny"`, the call
 * is denied immediately. No scope — not even project — can override a deny
 * set by a broader scope. This mirrors admin-enforced hard limits.
 *
 * **Pass 2 — Cascading override for non-deny actions.** Scopes are checked
 * in priority order (project → global → default). Within each scope, the
 * *first* rule that matches wins (rule order is significant — put specific
 * overrides before general rules). This lets a project explicitly relax a
 * global "ask" to "allow" (or tighten it), as long as it doesn't conflict
 * with an established deny.
 *
 * **Pass 3 — Bash classifier fallback.** Only used for `bash` calls with
 * no explicit rule match in any scope.
 *
 * **Pass 4 — `defaultAction` fallback.** Falls back through
 * project → global → default `defaultAction`, defaulting to `"ask"`.
 */
export function evaluateToolCall(
  call: ToolCallInfo,
  configs: {
    project?: PermissionConfig;
    global?: PermissionConfig;
    default?: PermissionConfig;
  },
): MatchResult {
  const scopes = collectScopedConfigs(configs);

  // Pass 1: deny floor — checked across ALL scopes before anything else.
  for (const { scope, config } of scopes) {
    const denyRule = findFirstMatchingRule(
      config.rules,
      call,
      (r) => r.action === "deny",
    );
    if (denyRule) {
      return { action: "deny", rule: denyRule, scope, reason: denyRule.reason };
    }
  }

  // Pass 2: cascading first-match-wins per scope, in priority order.
  for (const { scope, config } of scopes) {
    const rule = findFirstMatchingRule(config.rules, call);
    if (rule) {
      return { action: rule.action, rule, scope, reason: rule.reason };
    }
  }

  // Pass 3: bash classifier fallback.
  const bashResult = evaluateBashClassifier(call);
  if (bashResult) return bashResult;

  // Pass 4: defaultAction fallback (project overrides global overrides default).
  const fallbackAction: PermissionAction =
    configs.project?.defaultAction ??
    configs.global?.defaultAction ??
    configs.default?.defaultAction ??
    "ask";

  return { action: fallbackAction, scope: "default", reason: undefined };
}
