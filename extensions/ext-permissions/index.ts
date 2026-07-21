/**
 * yes-my-pi Permission System — Pi Extension Entry Point
 *
 * Integrates the rule engine + approval mode into Pi's tool_call event.
 *
 * Hooks:
 *   - tool_call event : intercepts tool calls, evaluates permissions
 *   - /mode command   : switches approval mode
 *   - /permissions cmd: views current rules and session overrides
 *   - Status bar      : displays the active mode
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
  ALL_MODES,
} from "./src/mode.js";
import type { ToolCallInfo, MatchResult } from "./src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Path Resolution ───────────────────────────────────────

function getConfigPaths() {
  const home = homedir();
  const cwd = process.cwd();

  return {
    // Factory default rules (distributed with the extension)
    default: join(__dirname, "permissions.default.yaml"),

    // Global user rules (~/.pi/agent/permissions.yaml)
    global: join(home, ".pi", "agent", "permissions.yaml"),

    // Project-level rules (<project>/.pi/permissions.yaml)
    project: join(cwd, ".pi", "permissions.yaml"),
  };
}

// ── Session Overrides ─────────────────────────────────────

interface SessionOverrides {
  /** Operations always allowed in this session */
  alwaysAllow: Set<string>;
  /** Operations always denied in this session */
  alwaysDeny: Set<string>;
}

/**
 * Generates a unique signature for a specific tool call, used as the key
 * for session-level overrides. This scopes "always allow/deny" to the
 * exact command/path rather than the whole tool name, preventing a user's
 * "always allow" on `npm test` from accidentally allowing `rm -rf /`.
 */
function getCallSignature(call: ToolCallInfo): string {
  const args = call.args;

  if (call.toolName === "bash" && typeof args.command === "string") {
    return `${call.toolName}:${args.command}`;
  }

  const pathKey = ["path", "file", "filePath"].find(
    (k) => typeof args[k] === "string",
  );
  if (pathKey) {
    return `${call.toolName}:${args[pathKey]}`;
  }

  return `${call.toolName}:${JSON.stringify(args)}`;
}

// ── Extension Main ────────────────────────────────────────

export default function extPermissions(pi: ExtensionAPI): void {
  // 1. Initialization
  const paths = getConfigPaths();
  let configs: ConfigSet = loadAllConfigs(paths);
  const modeManager = new ModeManager("auto-edit");
  const overrides: SessionOverrides = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
  };

  // 2. Set initial status bar
  pi.on("session_start", () => {
    updateStatus();
  });

  // 3. Watch for configuration hot-reloads
  const stopWatching = watchConfigs(
    { global: paths.global, project: paths.project },
    (newConfigs) => {
      configs = { ...newConfigs, default: configs.default };
      pi.appendSystemMessage?.("[ymp] Permission configurations reloaded.");
    },
  );

  pi.on("session_shutdown", () => {
    stopWatching();
  });

  // ── Core: tool_call Interceptor ─────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const call: ToolCallInfo = {
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    };
    const signature = getCallSignature(call);

    // 3a. Rule Engine Evaluation. Deny is an absolute floor.
    // We must evaluate rules FIRST so that session overrides cannot
    // bypass a hard `deny` set by config.
    const matchResult: MatchResult = evaluateToolCall(call, configs);

    if (matchResult.action === "deny") {
      return {
        blocked: true,
        reason: formatDenyReason(call, matchResult),
      };
    }

    // 3b. Check session-level overrides for this exact operation
    if (overrides.alwaysDeny.has(signature)) {
      return {
        blocked: true,
        reason: `[ymp] Operation "${signature}" marked as always deny in this session.`,
      };
    }

    if (overrides.alwaysAllow.has(signature)) {
      return; // Allow bypassing the mode/ask prompt
    }

    // 3c. Apply current Approval Mode mapping
    const finalAction = applyMode(modeManager.mode, matchResult.action);

    // 3d. Execute action
    switch (finalAction) {
      case "allow":
        return; // Pass through, do not block

      case "deny":
        return {
          blocked: true,
          reason: formatDenyReason(call, matchResult),
        };

      case "ask": {
        const approved = await askUser(call, matchResult, ctx);
        if (approved === "allow") return;
        if (approved === "always-allow") {
          overrides.alwaysAllow.add(signature);
          return;
        }
        if (approved === "always-deny") {
          overrides.alwaysDeny.add(signature);
          return {
            blocked: true,
            reason: `[ymp] Operation "${signature}" marked as always deny in this session.`,
          };
        }
        // "deny"
        return {
          blocked: true,
          reason: `[ymp] User denied the ${call.toolName} operation. Adjust your approach or use an alternative method.`,
        };
      }
    }
  });

  // ── User Confirmation Dialog ────────────────────────────

  async function askUser(
    call: ToolCallInfo,
    match: MatchResult,
    ctx: any,
  ): Promise<"allow" | "deny" | "always-allow" | "always-deny"> {
    const argsSummary = formatArgsSummary(call);
    const message =
      `⚠️  ${call.toolName}\n` +
      `   ${argsSummary}\n` +
      (match.reason ? `   Rule: ${match.reason}\n` : "") +
      `   Mode: ${modeManager.mode} | Scope: ${match.scope}`;

    try {
      // Attempt to use Pi's confirmation UI
      if (ctx?.ui?.confirm) {
        const result = await ctx.ui.confirm(message, {
          choices: [
            { key: "y", label: "Allow once", value: "allow" },
            { key: "n", label: "Deny once", value: "deny" },
            {
              key: "a",
              label: "Always allow this operation this session",
              value: "always-allow",
            },
            {
              key: "d",
              label: "Always deny this operation this session",
              value: "always-deny",
            },
          ],
        });
        return result ?? "deny";
      }
    } catch {
      // ctx.ui.confirm unavailable or user pressed Escape
    }

    // Fallback: default to deny (safety-first)
    return "deny";
  }

  // ── Command Registration ────────────────────────────────

  // /mode - Switch approval mode
  pi.registerCommand("mode", {
    description: `Switch approval mode (${ALL_MODES.join(" | ")})`,
    handler: async (args: string) => {
      const target = args?.trim().toLowerCase();

      // No args: show current mode
      if (!target) {
        const lines = ALL_MODES.map((m) => {
          const active = m === modeManager.mode ? " ← current" : "";
          return `  ${m === modeManager.mode ? "●" : "○"} ${m}: ${MODE_DESCRIPTIONS[m]}${active}`;
        });
        return `Approval Modes:\n${lines.join("\n")}\n\nUsage: /mode <${ALL_MODES.join("|")}>`;
      }

      // Has args: switch mode
      try {
        modeManager.setMode(target as any);
        updateStatus();
        return `✅ Approval mode switched to: ${modeManager.statusText}\n   ${MODE_DESCRIPTIONS[modeManager.mode]}`;
      } catch (err) {
        return `❌ ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  // /permissions - View permission status
  pi.registerCommand("permissions", {
    description: "View current permission rules and session overrides",
    handler: async () => {
      const lines: string[] = [];

      lines.push(`Mode: ${modeManager.statusText}`);
      lines.push("");

      // Config sources
      lines.push("Config Sources:");
      lines.push(
        `  Default rules: ${configs.default ? `${configs.default.rules.length} rules` : "Not loaded"}`,
      );
      lines.push(
        `  Global rules:  ${configs.global ? `${configs.global.rules.length} rules (${paths.global})` : "None"}`,
      );
      lines.push(
        `  Project rules: ${configs.project ? `${configs.project.rules.length} rules (${paths.project})` : "None"}`,
      );
      lines.push("");

      // Session overrides
      if (overrides.alwaysAllow.size > 0 || overrides.alwaysDeny.size > 0) {
        lines.push("Session Overrides:");
        if (overrides.alwaysAllow.size > 0) {
          lines.push("  Always Allow:");
          [...overrides.alwaysAllow].forEach((s) => lines.push(`    - ${s}`));
        }
        if (overrides.alwaysDeny.size > 0) {
          lines.push("  Always Deny:");
          [...overrides.alwaysDeny].forEach((s) => lines.push(`    - ${s}`));
        }
      } else {
        lines.push("Session Overrides: None");
      }

      return lines.join("\n");
    },
  });

  // ── Status Bar ──────────────────────────────────────────

  function updateStatus(): void {
    try {
      // Pi's ctx.ui.setStatus or equivalent API
      pi.setStatus?.(modeManager.statusText);
    } catch {
      // Ignore silently if status bar API is unavailable
    }
  }

  // Update status bar on mode change
  modeManager.onChange(() => {
    updateStatus();
  });

  // ── Helpers ─────────────────────────────────────────────

  function formatDenyReason(call: ToolCallInfo, match: MatchResult): string {
    const base =
      match.reason ?? `Tool "${call.toolName}" blocked by permission rules`;
    return `[ymp] ${base}. Adjust your approach, do not retry the exact same operation.`;
  }

  function formatArgsSummary(call: ToolCallInfo): string {
    const args = call.args;

    // bash: show command
    if (call.toolName === "bash" && typeof args.command === "string") {
      const cmd = args.command as string;
      return cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd;
    }

    // File tools: show path
    const pathKey = ["path", "file", "filePath"].find(
      (k) => typeof args[k] === "string",
    );
    if (pathKey) {
      return String(args[pathKey]);
    }

    // Others: show JSON summary
    const json = JSON.stringify(args);
    return json.length > 120 ? json.slice(0, 120) + "…" : json;
  }
}
