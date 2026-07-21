/**
 * yes-my-pi 权限系统 - 规则匹配引擎
 *
 * 纯函数，不依赖 Pi API，可独立测试。
 *
 * 求值优先级：deny > ask > allow
 * 作用域优先级：project > global > default
 * 兜底链：YAML 规则 → bash 分类器 → 工具注册表 → defaultAction
 */

import type {
  MatchResult,
  PermissionAction,
  PermissionConfig,
  PermissionRule,
  ToolCallInfo,
} from "./types.js";
import { classifyBashCommand } from "./bash-analyzer.js";
import { getToolCategory } from "./tool-registry.js";

// ── 通配符匹配 ────────────────────────────────────────────

/**
 * 简单模式匹配
 *
 * 支持：
 *   "*"           匹配所有
 *   "npm test*"   前缀通配
 *   "src/**"      路径 glob（** 跨目录，* 单目录）
 *   无通配符      精确匹配或前缀匹配
 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;

  // 前缀通配："npm test*" → startsWith("npm test")
  if (pattern.endsWith("*") && !pattern.includes("**")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  // 路径 glob：包含 ** 或 *
  if (pattern.includes("**") || pattern.includes("*")) {
    const regexStr =
      "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // 转义正则特殊字符
        .replace(/\*\*/g, "§GLOBSTAR§") // 保护 **
        .replace(/\*/g, "[^/]*") // * → 非斜杠
        .replace(/§GLOBSTAR§/g, ".*") + // ** → 任意
      "$";
    try {
      return new RegExp(regexStr).test(value);
    } catch {
      return value.startsWith(pattern);
    }
  }

  // 精确匹配或前缀匹配
  return value === pattern || value.startsWith(pattern);
}

/** 匹配字符串或字符串数组（任一命中即 true，undefined 视为不限制） */
function matchStringOrArray(
  pattern: string | string[] | undefined,
  value: string,
): boolean {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, value));
}

// ── 单条规则匹配 ──────────────────────────────────────────

/**
 * 判断一条规则是否匹配给定的工具调用
 */
export function matchRule(rule: PermissionRule, call: ToolCallInfo): boolean {
  // 1. 工具名匹配
  if (rule.tool !== "*" && rule.tool !== call.toolName) {
    return false;
  }

  // 2. 无 match 条件 = 匹配该工具的所有调用
  if (!rule.match) {
    return true;
  }

  const { command, path, args } = rule.match;

  // 3. bash 命令匹配
  if (command !== undefined && call.toolName === "bash") {
    const cmd = String(call.args.command ?? "");
    if (!matchStringOrArray(command, cmd)) {
      return false;
    }
  }

  // 4. 文件路径匹配（兼容多种参数名）
  if (path !== undefined) {
    const filePath = String(
      call.args.path ?? call.args.file ?? call.args.filePath ?? "",
    );
    if (!matchStringOrArray(path, filePath)) {
      return false;
    }
  }

  // 5. 通用参数键值匹配
  if (args !== undefined) {
    for (const [key, pattern] of Object.entries(args)) {
      const value = String(call.args[key] ?? "");
      if (!matchStringOrArray(pattern, value)) {
        return false;
      }
    }
  }

  return true;
}

// ── 动作优先级 ────────────────────────────────────────────

const ACTION_PRIORITY: Record<PermissionAction, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

// ── 单配置求值 ────────────────────────────────────────────

/**
 * 在单个配置中查找匹配的规则
 * 同作用域内：deny 优先级最高，先遇到 deny 立即返回
 */
function evaluateConfig(
  config: PermissionConfig,
  call: ToolCallInfo,
  scope: MatchResult["scope"],
): MatchResult | undefined {
  let bestMatch: { rule: PermissionRule; action: PermissionAction } | undefined;

  for (const rule of config.rules) {
    if (!matchRule(rule, call)) continue;

    if (
      !bestMatch ||
      ACTION_PRIORITY[rule.action] > ACTION_PRIORITY[bestMatch.action]
    ) {
      bestMatch = { rule, action: rule.action };
    }

    // deny 是最高优先级，无需继续扫描
    if (rule.action === "deny") break;
  }

  if (bestMatch) {
    return {
      action: bestMatch.action,
      rule: bestMatch.rule,
      scope,
      reason: bestMatch.rule.reason,
    };
  }

  return undefined;
}

// ── bash 分类器兜底 ───────────────────────────────────────

/**
 * 对 bash 工具调用，基于命令分类生成隐式规则
 * 当 YAML 中没有显式 bash 规则命中时使用
 */
function evaluateBashClassifier(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName !== "bash") return undefined;

  const cmd = String(call.args.command ?? "");
  const cls = classifyBashCommand(cmd);
  const cmdPreview = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;

  switch (cls) {
    case "dangerous":
      return {
        action: "deny",
        scope: "default",
        reason: `命令被分类为危险操作: "${cmdPreview}"`,
      };
    case "write":
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason: `命令包含写操作或无法判断: "${cmdPreview}"`,
      };
    case "read":
      return {
        action: "allow",
        scope: "default",
      };
  }
}

// ── 工具注册表兜底 ────────────────────────────────────────

/**
 * 对非 bash 工具，基于注册表分类推断默认动作
 * 当 YAML 规则未命中时使用
 */
function evaluateToolRegistry(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName === "bash") return undefined; // bash 有自己的分类器

  const category = getToolCategory(call.toolName);

  switch (category) {
    case "read":
      return {
        action: "allow",
        scope: "default",
      };
    case "write":
      return {
        action: "ask",
        scope: "default",
        reason: `写操作工具 "${call.toolName}" 需要确认`,
      };
    case "mixed":
      return {
        action: "ask",
        scope: "default",
        reason: `混合工具 "${call.toolName}" 需要确认`,
      };
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason:
          `未分类工具 "${call.toolName}"（可能来自扩展），默认需要确认。` +
          `可在 permissions.yaml 中添加规则。`,
      };
  }
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 对工具调用求值
 *
 * 求值链（按顺序，取最严格结果）：
 *   1. project 配置（项目级 .pi/permissions.yaml）
 *   2. global 配置（全局 ~/.pi/agent/permissions.yaml）
 *   3. default 配置（出厂 permissions.default.yaml）
 *   4. bash 分类器兜底（仅 bash 工具）
 *   5. 工具注册表兜底（非 bash 工具）
 *   6. defaultAction 最终兜底
 *
 * 跨来源取最严格：deny > ask > allow
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

  // 1-3. YAML 规则（按作用域）
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

  // 4. bash 分类器兜底
  const bashResult = evaluateBashClassifier(call);
  if (bashResult) results.push(bashResult);

  // 5. 工具注册表兜底
  const registryResult = evaluateToolRegistry(call);
  if (registryResult) results.push(registryResult);

  // 6. 无结果 → defaultAction
  if (results.length === 0) {
    const defaultAction = configs.default?.defaultAction ?? "ask";
    return {
      action: defaultAction,
      scope: "default",
    };
  }

  // 取最严格结果
  results.sort((a, b) => ACTION_PRIORITY[b.action] - ACTION_PRIORITY[a.action]);
  return results[0];
}
