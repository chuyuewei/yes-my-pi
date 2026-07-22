/**
 * yes-my-pi Permission System — Pi Extension Entry
 *
 * Wires the rule engine (T3), approval mode (T4), and edge cases (T5)
 * into Pi's extension event surface.
 *
 * Hook points:
 *   - tool_call          intercept every tool invocation
 *   - /mode              cycle or set the approval mode
 *   - /permissions       inspect rules and session overrides
 *   - footer status      reflect the current mode
 *
 * Iron rule (suggest / auto-edit / full-auto): `deny` is absolute — no
 * mode, scope, or user override can regenerate it into anything else.
 * The lone exception is `always-yes`, which converts `deny` to `allow`
 * AND requires out-of-band confirmation to activate. See
 * `confirmDangerousMode` below.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIDialogOptions,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { evaluateToolCall } from "./src/matcher.js";
import { loadAllConfigs, watchConfigs, type ConfigSet } from "./src/loader.js";
import {
  ModeManager,
  applyMode,
  isDangerousMode,
  MODE_DESCRIPTIONS,
  MODE_ICONS,
  ALL_MODES,
  getNextMode,
  type ApprovalMode,
} from "./src/mode.js";
import { getToolInfo } from "./src/tool-registry.js";
import type { MatchResult, ToolCallInfo } from "./src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_ARGS_DISPLAY = 200;
const STATUS_KEY = "ymp-mode";
const ASK_TIMEOUT_MS = 60_000;

const DIR = { READ: "read", WRITE: "write", MIXED: "mixed", UNKNOWN: "unknown" };

function getConfigPaths() {
  return {
    /** Factory-shipped defaults (lives next to the extension). */
    default: join(__dirname, "permissions.default.yaml"),
    /** Global user rules: ~/.pi/agent/permissions.yaml */
    global: join(homedir(), ".pi", "agent", "permissions.yaml"),
    /** Project-level rules: <cwd>/.pi/permissions.yaml */
    project: join(process.cwd(), ".pi", "permissions.yaml"),
  };
}

interface SessionOverrides {
  alwaysAllow: Set<string>;
  alwaysDeny: Set<string>;
}

// Serializes confirmation dialogs so concurrent tool calls don't stack
// overlapping prompts.
let confirmQueue: Promise<unknown> = Promise.resolve();

function enqueueConfirm<T>(fn: () => Promise<T>): Promise<T> {
  const result = confirmQueue.then(fn, fn);
  confirmQueue = result.catch(() => {});
  return result;
}

type UserDecision = "allow" | "deny" | "always-allow" | "always-deny";

export default function extPermissions(pi: ExtensionAPI): void {
  const paths = getConfigPaths();
  let configs: ConfigSet = loadAllConfigs(paths);
  const modeManager = new ModeManager("auto-edit");
  const overrides: SessionOverrides = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
  };
  const loggedUnknownTools = new Set<string>();

  // Tracks the last mode we pushed to the footer so we only refresh
  // when the mode actually changed (avoids re-rendering the status bar
  // on every single tool_call).
  let lastStatusMode: ApprovalMode | null = null;

  // ── Lifecycle ──────────────────────────────────────────

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    updateStatus(ctx);
  });

  const stopWatching = watchConfigs(
    { global: paths.global, project: paths.project },
    (newConfigs) => {
      // Preserve the factory default; reload only project + global.
      configs = { ...newConfigs, default: configs.default };
      notify("[ymp] Permission configuration reloaded.", "info");
    },
  );

  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    stopWatching();
  });

  // ── Core: tool_call interceptor ───────────────────────

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const call: ToolCallInfo = {
      toolName: event.toolName,
      args: (event.input ?? {}) as Record<string, unknown>,
    };

    // 1. Session overrides (highest priority).
    if (overrides.alwaysDeny.has(call.toolName)) {
      const result: ToolCallEventResult = {
        block: true,
        reason:
          `[ymp] Tool "${call.toolName}" was marked always-deny for this session. ` +
          `Adjust your approach.`,
      };
      return result;
    }
    if (overrides.alwaysAllow.has(call.toolName)) return;

    // 2. Rule engine.
    const matchResult: MatchResult = evaluateToolCall(call, configs);

    // 3. First-time notice for uncategorized extension tools.
    const toolInfo = getToolInfo(call.toolName);
    if (toolInfo.category === DIR.UNKNOWN && !toolInfo.builtin) {
      if (!loggedUnknownTools.has(call.toolName)) {
        loggedUnknownTools.add(call.toolName);
        notify(
          `[ymp] Detected uncategorized tool "${call.toolName}" (from an extension). ` +
            `It will require confirmation by default. Add a rule in ` +
            `permissions.yaml to override.`,
          "warning",
          ctx,
        );
      }
    }

    // 4. Apply approval mode.
    const finalAction = applyMode(modeManager.mode, matchResult.action);

    // 5. Refresh footer (cheap when unchanged; see updateStatus).
    updateStatus(ctx);

    // 6. Dispatch.
    switch (finalAction) {
      case "allow":
        return;

      case "deny": {
        const result: ToolCallEventResult = {
          block: true,
          reason: formatDenyReason(call, matchResult),
        };
        return result;
      }

      case "ask": {
        const decision = await askUser(call, matchResult, ctx);

        switch (decision) {
          case "allow":
            return;

          case "always-allow":
            overrides.alwaysAllow.add(call.toolName);
            return;

          case "always-deny":
            overrides.alwaysDeny.add(call.toolName);
            return {
              block: true,
              reason:
                `[ymp] Tool "${call.toolName}" was marked always-deny for ` +
                `this session. Adjust your approach.`,
            };

          case "deny":
          default:
            return {
              block: true,
              reason:
                `[ymp] User denied the ${call.toolName} call. Adjust your ` +
                `approach or use an alternative; do not retry the same action.`,
            };
        }
      }
    }
  });

  // ── User confirmation ──────────────────────────────────

  async function askUser(
    call: ToolCallInfo,
    match: MatchResult,
    ctx: ExtensionContext,
  ): Promise<UserDecision> {
    return enqueueConfirm(async () => {
      const argsSummary = formatArgsSummary(call);
      const title = `Confirm ${call.toolName}`;
      const body = [
        `${argsSummary}`,
        match.reason ? `\nReason: ${match.reason}` : "",
        `\nMode: ${modeManager.mode}   Scope: ${match.scope}`,
        "\n[Y] Allow once   [N] Deny once   [A] Always allow   [D] Always deny",
      ].join("");

      const opts: ExtensionUIDialogOptions = { timeout: ASK_TIMEOUT_MS };

      try {
        if (ctx.ui.confirm) {
          const ok = await ctx.ui.confirm(title, body, opts);
          // Boolean confirms from Pi do not carry the A/D variant, so we
          // treat Y -> allow and N -> deny. Users wanting A/D can use the
          // /permissions command to add a session override explicitly.
          return ok ? "allow" : "deny";
        }
      } catch {
        // confirm() may throw on Escape/timeout. Fall through to deny.
      }

      // Safe fallback: deny. Users can still flip to full-auto to skip
      // prompts entirely.
      return "deny";
    });
  }

  // ── Command: /mode ────────────────────────────────────

  /**
   * Out-of-band confirmation gate for entering "dangerous" modes
   * (currently just `always-yes`). The gate exists because `always-yes`
   * is the only mode that overrides `deny` rules — e.g. a `deny: rm` or
   * `deny: curl|bash` rule would otherwise be silently bypassed.
   *
   * The gate MUST be confirmed before `setMode` is called; otherwise
   * the caller's request is ignored. If the confirmation UI is
   * unavailable, the activation is refused.
   */
  async function confirmDangerousMode(
    target: ApprovalMode,
    ctx: ExtensionCommandContext,
  ): Promise<boolean> {
    if (!isDangerousMode(target)) return true;

    const title = `Confirm: enter ${target} mode`;
    const body = [
      `${MODE_ICONS[target]} ${target}: ${MODE_DESCRIPTIONS[target]}`,
      "",
      "WARNING: This mode overrides ALL deny rules, including:",
      "  - destructive commands (rm -rf, sudo, ...)",
      "  - network/download patterns (curl|bash, wget, ...)",
      "  - any custom deny rules in permissions.yaml",
      "",
      "This change is session-only and lasts until you switch mode again",
      "or the session ends.",
      "",
      "Activate now?",
    ].join("\n");

    const ui = ctx.ui;
    if (!ui?.confirm) {
      notify(
        `[ERR] Cannot activate ${target}: confirmation UI is unavailable. ` +
          `Refusing to bypass deny rules.`,
        "error",
        ctx,
      );
      return false;
    }

    try {
      return await ui.confirm(title, body, { timeout: ASK_TIMEOUT_MS });
    } catch {
      return false;
    }
  }

  pi.registerCommand("mode", {
    description: `Switch approval mode (${ALL_MODES.join(" | ")})`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args?.trim().toLowerCase();

      let output: string;

      if (!target || target === "list") {
        const lines = ALL_MODES.map((m) => {
          const active = m === modeManager.mode;
          const marker = active ? "*" : " ";
          const dangerous = isDangerousMode(m) ? "  ⚠ breaks deny rules" : "";
          const suffix = active ? "  (current)" : "";
          return `  [${marker}] ${MODE_ICONS[m]} ${m}: ${MODE_DESCRIPTIONS[m]}${dangerous}${suffix}`;
        });
        output = [
          "Approval modes:",
          ...lines,
          "",
          `Usage: /mode <${ALL_MODES.join(" | ")}>  (or /mode next to cycle)`,
          "Note: modes marked ⚠ require an extra confirmation to activate.",
        ].join("\n");
      } else if (target === "next") {
        const prev = modeManager.mode;
        const next = modeManager.cycleMode();
        // Cycling may have landed on a dangerous mode in one step (e.g.
        // full-auto -> always-yes). We don't gate the cycle itself —
        // the user explicitly invoked it — but we DO guard the switch.
        if (isDangerousMode(next)) {
          const ok = await confirmDangerousMode(next, ctx);
          if (!ok) {
            modeManager.setMode(prev);
            updateStatus(ctx);
            output = `[CANCEL] Activation of ${MODE_ICONS[next]} ${next} aborted. Mode restored to ${MODE_ICONS[prev]} ${prev}.`;
            notify(output, "warning", ctx);
            return;
          }
        }
        updateStatus(ctx);
        output = [
          `[OK] Cycled to: ${MODE_ICONS[next]} ${next}`,
          `     ${MODE_DESCRIPTIONS[next]}`,
          `     (next: ${MODE_ICONS[getNextMode(next)]} ${getNextMode(next)})`,
        ].join("\n");
      } else if (!(ALL_MODES as readonly string[]).includes(target)) {
        output =
          `[ERR] Unknown mode "${target}". Valid options: ${ALL_MODES.join(" | ")}.`;
      } else {
        const apiTarget = target as ApprovalMode;
        if (modeManager.mode === apiTarget) {
          output = `[OK] Already in ${MODE_ICONS[apiTarget]} ${apiTarget}.`;
        } else {
          const ok = await confirmDangerousMode(apiTarget, ctx);
          if (!ok) {
            output =
              `[CANCEL] Activation of ${MODE_ICONS[apiTarget]} ${apiTarget} aborted. ` +
              `Current mode unchanged: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}.`;
            notify(output, "warning", ctx);
            return;
          }
          modeManager.setMode(apiTarget);
          updateStatus(ctx);
          output = [
            `[OK] Mode set to: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`,
            `     ${MODE_DESCRIPTIONS[modeManager.mode]}`,
          ].join("\n");
        }
      }

      notify(output, "info", ctx);
      return;
    },
  });

  // ── Command: /permissions ─────────────────────────────

  pi.registerCommand("permissions", {
    description: "Inspect current permission rules and session state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines: string[] = [];

      lines.push(`Mode: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`);
      lines.push(`  ${MODE_DESCRIPTIONS[modeManager.mode]}`);
      lines.push("");

      lines.push("Configuration sources:");
      lines.push(
        `  default: ${configs.default ? `${configs.default.rules.length} rule(s)` : "not loaded"}`,
      );
      lines.push(
        `  global:  ${configs.global ? `${configs.global.rules.length} rule(s)` : "none"} (${paths.global})`,
      );
      lines.push(
        `  project: ${configs.project ? `${configs.project.rules.length} rule(s)` : "none"} (${paths.project})`,
      );
      lines.push("");

      lines.push("Session overrides:");
      if (overrides.alwaysAllow.size > 0) {
        lines.push(`  always-allow: ${[...overrides.alwaysAllow].join(", ")}`);
      }
      if (overrides.alwaysDeny.size > 0) {
        lines.push(`  always-deny:  ${[...overrides.alwaysDeny].join(", ")}`);
      }
      if (
        overrides.alwaysAllow.size === 0 &&
        overrides.alwaysDeny.size === 0
      ) {
        lines.push("  (none)");
      }

      if (loggedUnknownTools.size > 0) {
        lines.push("");
        lines.push(
          `Uncategorized tools: ${[...loggedUnknownTools].join(", ")}`,
        );
        lines.push("  Tip: add explicit rules for these in permissions.yaml");
      }

      const output = lines.join("\n");
      notify(output, "info", ctx);
      updateStatus(ctx);
      return;
    },
  });

  // ── Always-allow / always-deny helpers ────────────────

  pi.registerCommand("allow", {
    description: "Mark a tool as always-allow for this session",
    handler: async (args: string) => {
      const name = args.trim();
      if (!name) {
        notify("Usage: /allow <tool-name>", "warning");
        return;
      }
      overrides.alwaysAllow.add(name);
      overrides.alwaysDeny.delete(name);
      notify(`[OK] ${name}: always-allow for this session.`);
      return;
    },
  });

  pi.registerCommand("deny", {
    description: "Mark a tool as always-deny for this session",
    handler: async (args: string) => {
      const name = args.trim();
      if (!name) {
        notify("Usage: /deny <tool-name>", "warning");
        return;
      }
      overrides.alwaysDeny.add(name);
      overrides.alwaysAllow.delete(name);
      notify(`[OK] ${name}: always-deny for this session.`);
      return;
    },
  });

  // ── Output channel ────────────────────────────────────

  /**
   * Pi's UI exposes exactly one cross-mode channel for transient text
   * from extensions: `ctx.ui.notify(message, type)`. Other probes used
   * by earlier versions of this extension (`print`, `appendSystemMessage`,
   * `pi.appendEntry`) either don't exist or don't render to the user.
   *
   * Callers always pass the relevant `ctx` explicitly; this wrapper just
   * funnels errors through to stderr so operators tee'ing logs see
   * something even when the UI channel is unavailable.
   */
  function notify(
    message: string,
    type: "info" | "warning" | "error" = "info",
    ctx?: ExtensionContext,
  ): void {
    const ui = ctx?.ui;
    if (ui?.notify) {
      try {
        ui.notify(message, type);
        return;
      } catch {
        // fall through to stderr
      }
    }
    console.error(`\n${message}\n`);
  }

  // ── Footer status ─────────────────────────────────────

  /**
   * Push the current mode to the UI status bar. Skips UI calls when the
   * mode hasn't changed since the last push, so this is safe to invoke
   * on every tool_call without causing visible flicker. On the very
   * first invocation we always push, since `lastStatusMode` is null.
   */
  function updateStatus(ctx?: ExtensionContext): void {
    if (!ctx?.ui?.setStatus) return;
    const current = modeManager.mode;
    if (lastStatusMode === current) return;
    lastStatusMode = current;
    try {
      ctx.ui.setStatus(STATUS_KEY, modeManager.statusText);
    } catch {
      // setStatus may not exist in some contexts; non-fatal.
    }
  }

  // ── Helpers ───────────────────────────────────────────

  function formatDenyReason(call: ToolCallInfo, match: MatchResult): string {
    const base = match.reason ?? `Tool "${call.toolName}" was denied by a rule`;
    return `[ymp] ${base}. Adjust your approach; do not retry the same action.`;
  }

  function formatArgsSummary(call: ToolCallInfo): string {
    const args = call.args;

    if (call.toolName === "bash" && typeof args.command === "string") {
      return truncate(args.command);
    }

    const pathKey = ["path", "file", "filePath"].find(
      (k) => typeof args[k] === "string",
    );
    if (pathKey) return truncate(String(args[pathKey]));

    try {
      return truncate(JSON.stringify(args));
    } catch {
      return truncate(String(args));
    }
  }

  function truncate(text: string): string {
    if (text.length <= MAX_ARGS_DISPLAY) return text;
    return `${text.slice(0, MAX_ARGS_DISPLAY)}... (${text.length} chars)`;
  }
}
