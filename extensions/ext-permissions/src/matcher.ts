/**
 * yes-my-pi Permission System — Rule Matching Engine
 *
 * Pure functions; no Pi dependencies, fully testable in isolation.
 *
 * Evaluation semantics:
 *   - Action severity:    deny > ask > allow
 *   - Scope precedence:   project > global > default
 *   - Fallback chain:     YAML rule -> bash classifier -> tool registry -> defaultAction
 */

import {
  ACTION_SEVERITY,
  type MatchResult,
  type PermissionConfig,
  type PermissionRule,
  type ToolCallInfo,
} from "./types.js";
import { classifyBashCommand } from "./bash-analyzer.js";
import { getToolCategory } from "./tool-registry.js";

/**
 * Pattern matching:
 *   "*"           -> matches everything
 *   "npm test*"   -> prefix wildcard
 *   "src/**"      -> path glob (** crosses directories, * single segment)
 *   no wildcard   -> exact match (or startsWith fallback)
 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;

  // Prefix wildcard ("npm test*")
  if (pattern.endsWith("*") && !pattern.includes("**")) {
    return value.startsWith(pattern.slice(0, -1));
  }

  // Glob (** | *)
  if (pattern.includes("**") || pattern.includes("*")) {
    const regexStr =
      "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§GLOBSTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/§GLOBSTAR§/g, ".*") +
      "$";
    try {
      return new RegExp(regexStr).test(value);
    } catch {
      return value.startsWith(pattern);
    }
  }

  return value === pattern || value.startsWith(pattern);
}

function matchStringOrArray(
  pattern: string | string[] | undefined,
  value: string,
): boolean {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, value));
}

export function matchRule(rule: PermissionRule, call: ToolCallInfo): boolean {
  if (rule.tool !== "*" && rule.tool !== call.toolName) return false;
  if (!rule.match) return true;

  const { command, path, args } = rule.match;

  if (command !== undefined && call.toolName === "bash") {
    const cmd = String(call.args.command ?? "");
    if (!matchStringOrArray(command, cmd)) return false;
  }

  if (path !== undefined) {
    const filePath = String(
      call.args.path ?? call.args.file ?? call.args.filePath ?? "",
    );
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

/**
 * Within a single scope: keep the highest-severity match. `deny` short-
 * circuits the scan since no later rule can raise severity further.
 */
function evaluateConfig(
  config: PermissionConfig,
  call: ToolCallInfo,
  scope: MatchResult["scope"],
): MatchResult | undefined {
  let best:
    | { rule: PermissionRule; action: PermissionRule["action"] }
    | undefined;

  for (const rule of config.rules) {
    if (!matchRule(rule, call)) continue;

    if (
      !best ||
      ACTION_SEVERITY[rule.action] > ACTION_SEVERITY[best.action]
    ) {
      best = { rule, action: rule.action };
    }
    if (rule.action === "deny") break;
  }

  if (!best) return undefined;
  return {
    action: best.action,
    rule: best.rule,
    scope,
    reason: best.rule.reason,
  };
}

function evaluateBashClassifier(
  call: ToolCallInfo,
): MatchResult | undefined {
  if (call.toolName !== "bash") return undefined;

  const cmd = String(call.args.command ?? "");
  const cls = classifyBashCommand(cmd);
  const preview = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;

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

function evaluateToolRegistry(
  call: ToolCallInfo,
): MatchResult | undefined {
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

/**
 * Evaluate a tool call against all configured scopes + falls-through
 * classifiers. Returns the strictest (highest-severity) result.
 */
export function evaluateToolCall(
  call: ToolCallInfo,
  configs: {
    project?: PermissionConfig;
    global?: PermissionConfig;
    default?: PermissionConfig;
  },
): MatchResult {
  const results: MatchResult[] = [];

  if (configs.project) {
    const r = evaluateConfig(configs.project, call, "project");
    if (r) results.push(r);
  }
  if (configs.global) {
    const r = evaluateConfig(configs.global, call, "global");
    if (r) results.push(r);
  }
  if (configs.default) {
    const r = evaluateConfig(configs.default, call, "default");
    if (r) results.push(r);
  }

  const bashResult = evaluateBashClassifier(call);
  if (bashResult) results.push(bashResult);

  const registryResult = evaluateToolRegistry(call);
  if (registryResult) results.push(registryResult);

  if (results.length === 0) {
    return {
      action: configs.default?.defaultAction ?? "ask",
      scope: "default",
    };
  }

  results.sort((a, b) => ACTION_SEVERITY[b.action] - ACTION_SEVERITY[a.action]);
  return results[0];
}
