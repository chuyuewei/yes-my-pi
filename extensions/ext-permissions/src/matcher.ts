/**
 * yes-my-pi Permission System — Rule Matching Engine
 *
 * Pure functions; no Pi dependencies, fully testable in isolation.
 *
 * Evaluation semantics:
 *   - Deny Floor:          A 'deny' in ANY scope is an absolute floor.
 *   - Cascading Override:  project > global > default (first-match-wins).
 *   - Fallback chain:      YAML rule -> bash classifier -> tool registry -> defaultAction
 *
 * v2 changes (Maintainability Refactor):
 *   - Reduced Cognitive Complexity of evaluateToolCall by extracting
 *     collectScopedConfigs, findDenyMatch, findCascadingMatch, and
 *     resolveFallbackAction into single-purpose helper functions.
 */

import {
  type MatchResult,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
  type ToolCallInfo,
} from "./types.js";
import { classifyBashCommand } from "./bash-analyzer.js";
import { getToolCategory } from "./tool-registry.js";

interface MatchOptions {
  /** If true, `*` matches `/` (useful for commands/URLs). Default: false (path semantics). */
  crossSlashes?: boolean;
}

const patternRegexCache = new Map<string, RegExp>();

/**
 * Pattern matching:
 *   "*"           -> matches everything
 *   "npm test*"   -> prefix wildcard
 *   "src/**"      -> path glob (** crosses directories, * single segment)
 *   no wildcard   -> EXACT match only (no implicit startsWith for security)
 */
export function matchPattern(
  pattern: string,
  value: string,
  options: MatchOptions = {},
): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;

  // No wildcards means strict exact match.
  // This prevents accidental prefix matches on security-sensitive paths.
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return false;
  }

  const cacheKey = pattern + (options.crossSlashes ? ":cmd" : ":path");
  let regex = patternRegexCache.get(cacheKey);

  if (!regex) {
    const starMatch = options.crossSlashes ? ".*" : "[^/]*";
    const questionMatch = options.crossSlashes ? "." : "[^/]";

    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
      .replace(/\*\*/g, ".*") // ** always matches everything
      .replace(/\*/g, starMatch) // * respects crossSlashes option
      .replace(/\?/g, questionMatch); // ? respects crossSlashes option

    regex = new RegExp(`^${source}$`);
    patternRegexCache.set(cacheKey, regex);
  }

  return regex.test(value);
}

function matchStringOrArray(
  pattern: string | string[] | undefined,
  value: string,
  options?: MatchOptions,
): boolean {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, value, options));
}

export function matchRule(rule: PermissionRule, call: ToolCallInfo): boolean {
  if (rule.tool !== "*" && rule.tool !== call.toolName) return false;
  if (!rule.match) return true;

  const { command, path, args } = rule.match;

  if (command !== undefined && call.toolName === "bash") {
    const cmd = String(call.args.command ?? "");
    // Commands can contain slashes (e.g. URLs), so * should cross slashes
    if (!matchStringOrArray(command, cmd, { crossSlashes: true })) return false;
  }

  if (path !== undefined) {
    const filePath = String(
      call.args.path ?? call.args.file ?? call.args.filePath ?? "",
    );
    // Paths use standard glob semantics where * doesn't cross /
    if (!matchStringOrArray(path, filePath)) return false;
  }

  if (args !== undefined) {
    for (const [key, pattern] of Object.entries(args)) {
      const value = String(call.args[key] ?? "");
      if (!matchStringOrArray(pattern, value)) return false;
    }
  }

  return true;
}

function evaluateBashClassifier(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName !== "bash") return undefined;

  const cmd = String(call.args.command ?? "");
  const cls = classifyBashCommand(cmd);

  // Collapse whitespaces for clean logging preview
  const safeCmd = cmd.replace(/\s+/g, " ").trim();
  const preview = safeCmd.length > 80 ? safeCmd.slice(0, 80) + "..." : safeCmd;

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
        reason: `Command contains a write or unclassifiable operation: "${preview}"`,
      };
    case "read":
      return { action: "allow", scope: "default" };
  }
}

function evaluateToolRegistry(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName === "bash") return undefined;

  switch (getToolCategory(call.toolName)) {
    case "read":
      return { action: "allow", scope: "default" };
    case "write":
      return {
        action: "ask",
        scope: "default",
        reason: `Write tool "${call.toolName}" requires confirmation`,
      };
    case "mixed":
      return {
        action: "ask",
        scope: "default",
        reason: `Mixed tool "${call.toolName}" requires confirmation`,
      };
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason:
          `Uncategorized tool "${call.toolName}" (likely from an extension); ` +
          `defaults to ask. Add an explicit rule in permissions.yaml to override.`,
      };
  }
}

// ── evaluateToolCall helpers ──────────────────────────────
//
// Each helper below owns exactly one "pass" of the resolution model
// documented on evaluateToolCall. Splitting them out keeps every
// function's cognitive complexity low: no function combines more than
// one loop with more than one level of conditional nesting.

interface ScopedConfig {
  scope: MatchResult["scope"];
  config: PermissionConfig;
}

interface ToolCallConfigs {
  project?: PermissionConfig;
  global?: PermissionConfig;
  default?: PermissionConfig;
}

/** Collects present configs in cascade priority order: project > global > default. */
function collectScopedConfigs(configs: ToolCallConfigs): ScopedConfig[] {
  const scopes: ScopedConfig[] = [];
  if (configs.project)
    scopes.push({ scope: "project", config: configs.project });
  if (configs.global) scopes.push({ scope: "global", config: configs.global });
  if (configs.default)
    scopes.push({ scope: "default", config: configs.default });
  return scopes;
}

/**
 * Pass 1: deny is an absolute floor across ALL scopes. Returns the first
 * matching `deny` rule found (scanning scopes in priority order), or
 * undefined if no scope has a matching deny rule.
 */
function findDenyMatch(
  scopes: ScopedConfig[],
  call: ToolCallInfo,
): MatchResult | undefined {
  for (const { scope, config } of scopes) {
    const denyRule = config.rules.find(
      (rule) => rule.action === "deny" && matchRule(rule, call),
    );
    if (denyRule) {
      return { action: "deny", rule: denyRule, scope, reason: denyRule.reason };
    }
  }
  return undefined;
}

/**
 * Pass 2: cascading override for non-deny actions. Scopes are checked in
 * priority order (project -> global -> default); within a scope, the
 * first matching rule wins.
 */
function findCascadingMatch(
  scopes: ScopedConfig[],
  call: ToolCallInfo,
): MatchResult | undefined {
  for (const { scope, config } of scopes) {
    const rule = config.rules.find((r) => matchRule(r, call));
    if (rule) {
      return { action: rule.action, rule, scope, reason: rule.reason };
    }
  }
  return undefined;
}

/** Pass 4: defaultAction fallback, project overrides global overrides default. */
function resolveFallbackAction(configs: ToolCallConfigs): PermissionAction {
  return (
    configs.project?.defaultAction ??
    configs.global?.defaultAction ??
    configs.default?.defaultAction ??
    "ask"
  );
}

/**
 * Evaluate a tool call against all configured scopes + falls-through classifiers.
 *
 * Resolution Model:
 * 1. Deny Floor: If ANY scope has a matching 'deny', deny immediately.
 * 2. Cascading Override: Check scopes in priority (project > global > default).
 *    First matching rule in the highest priority scope wins.
 * 3. Fallbacks: Bash classifier -> Tool registry -> defaultAction.
 */
export function evaluateToolCall(
  call: ToolCallInfo,
  configs: ToolCallConfigs,
): MatchResult {
  const scopes = collectScopedConfigs(configs);

  const denyMatch = findDenyMatch(scopes, call);
  if (denyMatch) return denyMatch;

  const cascadingMatch = findCascadingMatch(scopes, call);
  if (cascadingMatch) return cascadingMatch;

  const bashResult = evaluateBashClassifier(call);
  if (bashResult) return bashResult;

  const registryResult = evaluateToolRegistry(call);
  if (registryResult) return registryResult;

  return { action: resolveFallbackAction(configs), scope: "default" };
}
