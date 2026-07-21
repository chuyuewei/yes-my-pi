/**
 * yes-my-pi 权限系统 - Pi 扩展入口
 *
 * 将规则引擎（T3）+ 审批模式（T4）+ 边界处理（T5）
 * 接入 Pi 的 tool_call 事件。
 *
 * 挂载点：
 *   - tool_call   ：拦截工具调用，执行权限求值
 *   - /mode       ：切换审批模式
 *   - /permissions：查看规则与状态
 *   - 状态栏      ：显示当前模式
 *
 * 铁律：deny 在任何模式下都不可覆盖。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { evaluateToolCall } from "./src/matcher.js";
import { loadAllConfigs, watchConfigs, type ConfigSet } from "./src/loader.js";
import {
  ModeManager,
  applyMode,
  MODE_DESCRIPTIONS,
  MODE_ICONS,
  ALL_MODES,
  type ApprovalMode,
} from "./src/mode.js";
import { getToolInfo } from "./src/tool-registry.js";
import type { ToolCallInfo, MatchResult } from "./src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 常量 ──────────────────────────────────────────────────

const MAX_ARGS_DISPLAY = 200;

// ── 配置路径 ──────────────────────────────────────────────

function getConfigPaths() {
  return {
    /** 出厂默认规则（随扩展包分发） */
    default: join(__dirname, "permissions.default.yaml"),
    /** 全局用户规则 */
    global: join(homedir(), ".pi", "agent", "permissions.yaml"),
    /** 项目级规则 */
    project: join(process.cwd(), ".pi", "permissions.yaml"),
  };
}

// ── 会话级临时覆盖 ────────────────────────────────────────

interface SessionOverrides {
  /** 本会话内始终允许的工具 */
  alwaysAllow: Set<string>;
  /** 本会话内始终拒绝的工具 */
  alwaysDeny: Set<string>;
}

// ── 并发确认队列 ──────────────────────────────────────────
// Pi 可能并行调用多个工具，确认框必须串行显示

let confirmQueue: Promise<unknown> = Promise.resolve();

function enqueueConfirm<T>(fn: () => Promise<T>): Promise<T> {
  const result = confirmQueue.then(fn, fn);
  confirmQueue = result.catch(() => {});
  return result;
}

// ── 扩展主体 ──────────────────────────────────────────────

export default function extPermissions(pi: ExtensionAPI): void {
  // ── 初始化 ────────────────────────────────────────────

  const paths = getConfigPaths();
  let configs: ConfigSet = loadAllConfigs(paths);
  const modeManager = new ModeManager("auto-edit");
  const overrides: SessionOverrides = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
  };
  const loggedUnknownTools = new Set<string>();

  // ── 生命周期 ──────────────────────────────────────────

  pi.on("session_start", (_event: unknown, ctx: any) => {
    updateStatus(ctx);
  });

  const stopWatching = watchConfigs(
    { global: paths.global, project: paths.project },
    (newConfigs) => {
      configs = { ...newConfigs, default: configs.default };
      try {
        pi.appendSystemMessage?.("[ymp] 权限配置已重新加载。");
      } catch {
        // 静默忽略
      }
    },
  );

  pi.on("session_shutdown", () => {
    stopWatching();
  });

  // ── 核心：tool_call 拦截器 ────────────────────────────

  pi.on("tool_call", async (event: any, ctx: any) => {
    const call: ToolCallInfo = {
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    };

    // 1. 会话级临时覆盖（最高优先级）
    if (overrides.alwaysDeny.has(call.toolName)) {
      return {
        blocked: true,
        reason: `[ymp] 工具 "${call.toolName}" 在本会话中已被标记为始终拒绝。请调整方案。`,
      };
    }

    if (overrides.alwaysAllow.has(call.toolName)) {
      return; // 放行
    }

    // 2. 规则引擎求值
    const matchResult: MatchResult = evaluateToolCall(call, configs);

    // 3. 未知工具日志（仅首次）
    const toolInfo = getToolInfo(call.toolName);
    if (toolInfo.category === "unknown" && !toolInfo.builtin) {
      if (!loggedUnknownTools.has(call.toolName)) {
        loggedUnknownTools.add(call.toolName);
        try {
          pi.appendSystemMessage?.(
            `[ymp] 检测到未分类工具 "${call.toolName}"（来自扩展）。` +
              `默认需要确认。可在 permissions.yaml 中添加规则。`,
          );
        } catch {
          // 静默忽略
        }
      }
    }

    // 4. 审批模式二次映射
    const finalAction = applyMode(modeManager.mode, matchResult.action);

    // 5. 更新状态栏
    updateStatus(ctx);

    // 6. 执行动作
    switch (finalAction) {
      case "allow":
        return; // 放行

      case "deny":
        return {
          blocked: true,
          reason: formatDenyReason(call, matchResult),
        };

      case "ask": {
        const decision = await askUser(call, matchResult, ctx);

        switch (decision) {
          case "allow":
            return; // 放行

          case "always-allow":
            overrides.alwaysAllow.add(call.toolName);
            return; // 放行

          case "always-deny":
            overrides.alwaysDeny.add(call.toolName);
            return {
              blocked: true,
              reason: `[ymp] 工具 "${call.toolName}" 已被标记为始终拒绝。请调整方案。`,
            };

          case "deny":
          default:
            return {
              blocked: true,
              reason: `[ymp] 用户拒绝了 ${call.toolName} 操作。请调整方案或使用替代方法，不要重试相同操作。`,
            };
        }
      }
    }
  });

  // ── 用户确认交互 ──────────────────────────────────────

  type UserDecision = "allow" | "deny" | "always-allow" | "always-deny";

  async function askUser(
    call: ToolCallInfo,
    match: MatchResult,
    ctx: any,
  ): Promise<UserDecision> {
    // 通过队列串行化，避免多个确认框同时弹出
    return enqueueConfirm(async () => {
      const argsSummary = formatArgsSummary(call);
      const message = [
        `⚠️  ${call.toolName}`,
        `   ${argsSummary}`,
        match.reason ? `   规则: ${match.reason}` : null,
        `   模式: ${modeManager.mode} | 来源: ${match.scope}`,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        // 尝试使用 Pi 的确认 UI
        if (ctx?.ui?.confirm) {
          const result = await ctx.ui.confirm(message, {
            choices: [
              { key: "y", label: "允许本次", value: "allow" },
              { key: "n", label: "拒绝本次", value: "deny" },
              {
                key: "a",
                label: "本会话始终允许此工具",
                value: "always-allow",
              },
              { key: "d", label: "本会话始终拒绝此工具", value: "always-deny" },
            ],
          });
          if (
            result === "allow" ||
            result === "deny" ||
            result === "always-allow" ||
            result === "always-deny"
          ) {
            return result;
          }
        }
      } catch {
        // ctx.ui.confirm 不可用、用户按了 Escape、或 API 签名不匹配
        // 降级为默认拒绝（安全优先）
      }

      return "deny";
    });
  }

  // ── 命令：/mode ───────────────────────────────────────

  pi.registerCommand("mode", {
    description: `切换审批模式 (${ALL_MODES.join(" | ")})`,
    handler: async (args: string, ctx: any) => {
      const target = args?.trim().toLowerCase();

      // 无参数：显示当前模式
      if (!target) {
        const lines = ALL_MODES.map((m) => {
          const active = m === modeManager.mode;
          const icon = active ? "●" : "○";
          const suffix = active ? " ← 当前" : "";
          return `  ${icon} ${MODE_ICONS[m]} ${m}: ${MODE_DESCRIPTIONS[m]}${suffix}`;
        });
        return [
          "审批模式:",
          ...lines,
          "",
          `用法: /mode <${ALL_MODES.join(" | ")}>`,
        ].join("\n");
      }

      // 有参数：切换模式
      if (!ALL_MODES.includes(target as ApprovalMode)) {
        return `❌ 无效模式 "${target}"。可选: ${ALL_MODES.join(" | ")}`;
      }

      modeManager.setMode(target as ApprovalMode);
      updateStatus(ctx);

      return [
        `✅ 审批模式已切换为: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`,
        `   ${MODE_DESCRIPTIONS[modeManager.mode]}`,
      ].join("\n");
    },
  });

  // ── 命令：/permissions ────────────────────────────────

  pi.registerCommand("permissions", {
    description: "查看当前权限规则与会话状态",
    handler: async (_args: string, _ctx: any) => {
      const lines: string[] = [];

      // 当前模式
      lines.push(`模式: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`);
      lines.push(`  ${MODE_DESCRIPTIONS[modeManager.mode]}`);
      lines.push("");

      // 配置来源
      lines.push("配置来源:");
      lines.push(
        `  默认规则: ${configs.default ? `${configs.default.rules.length} 条` : "未加载"}`,
      );
      lines.push(
        `  全局规则: ${configs.global ? `${configs.global.rules.length} 条` : "无"} (${paths.global})`,
      );
      lines.push(
        `  项目规则: ${configs.project ? `${configs.project.rules.length} 条` : "无"} (${paths.project})`,
      );
      lines.push("");

      // 会话覆盖
      lines.push("会话覆盖:");
      if (overrides.alwaysAllow.size > 0) {
        lines.push(`  始终允许: ${[...overrides.alwaysAllow].join(", ")}`);
      }
      if (overrides.alwaysDeny.size > 0) {
        lines.push(`  始终拒绝: ${[...overrides.alwaysDeny].join(", ")}`);
      }
      if (overrides.alwaysAllow.size === 0 && overrides.alwaysDeny.size === 0) {
        lines.push("  无临时覆盖");
      }
      lines.push("");

      // 未分类工具
      if (loggedUnknownTools.size > 0) {
        lines.push(`未分类工具: ${[...loggedUnknownTools].join(", ")}`);
        lines.push("  提示: 在 permissions.yaml 中为这些工具添加规则");
      }

      return lines.join("\n");
    },
  });

  // ── 状态栏 ────────────────────────────────────────────

  function updateStatus(ctx?: any): void {
    const text = `${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`;
    try {
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus(text);
      }
    } catch {
      // 状态栏 API 不可用时静默忽略
    }
  }

  // ── 辅助函数 ──────────────────────────────────────────

  function formatDenyReason(call: ToolCallInfo, match: MatchResult): string {
    const base = match.reason ?? `工具 "${call.toolName}" 被权限规则拒绝`;
    return `[ymp] ${base}。请调整方案，不要重试相同操作。`;
  }

  function formatArgsSummary(call: ToolCallInfo): string {
    const args = call.args;
    let summary: string;

    // bash：显示命令
    if (call.toolName === "bash" && typeof args.command === "string") {
      summary = args.command;
    } else {
      // 文件工具：显示路径
      const pathKey = ["path", "file", "filePath"].find(
        (k) => typeof args[k] === "string",
      );
      if (pathKey) {
        summary = String(args[pathKey]);
      } else {
        // 其他：JSON 摘要
        try {
          summary = JSON.stringify(args);
        } catch {
          summary = String(args);
        }
      }
    }

    // 截断
    if (summary.length > MAX_ARGS_DISPLAY) {
      return `${summary.slice(0, MAX_ARGS_DISPLAY)}… (${summary.length} chars)`;
    }
    return summary;
  }
}
