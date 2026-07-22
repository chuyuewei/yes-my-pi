/**
 * yes-my-pi Permission System — Approval Mode State Machine
 *
 * An "approval mode" applies a second layer of mapping on top of the
 * rule engine's output, controlling how much friction the user
 * experiences for otherwise-`allow`/`ask` decisions.
 *
 * `deny` is an iron rule: no mode can ever turn a `deny` into anything
 * else. Modes only adjust the friction between `allow` and `ask`.
 *
 * The transition table below is the single source of truth — it IS
 * the documentation. Keeping it as data (rather than a `switch`
 * statement) means it can never drift out of sync with the comment
 * above, and it can be iterated over directly in tests.
 *
 *              allow ->     ask ->      deny ->
 *   suggest      ask         ask         deny
 *   auto-edit    allow       ask         deny
 *   full-auto    allow       allow       deny      (iron rule)
 *   always-yes   allow       allow       allow     (BREAKS the iron rule)
 *
 * `always-yes` is the only mode that overrides `deny`. Activation is
 * gated behind an out-of-band confirmation because, e.g., a `deny` rule
 * matching `rm -rf /` would otherwise be silently bypassed.
 */

import type { PermissionAction } from "./types.js";

const LOG_PREFIX = "[ymp-permissions]";

export type ApprovalMode =
  | "suggest"
  | "auto-edit"
  | "full-auto"
  | "always-yes";

export const ALL_MODES: readonly ApprovalMode[] = [
  "suggest",
  "auto-edit",
  "full-auto",
  "always-yes",
];

/**
 * Modes that override the permission system's deny rules. Switching to
 * one of these requires an explicit second confirmation. Always-allow
 * tool overrides ("/allow <tool>") are session-scoped and do NOT count
 * as dangerous — only mode-level overrides do.
 */
export const DANGEROUS_MODES: ReadonlySet<ApprovalMode> = new Set([
  "always-yes",
]);

export const DEFAULT_MODE: ApprovalMode = "auto-edit";

export const MODE_DESCRIPTIONS: Readonly<Record<ApprovalMode, string>> = {
  suggest: "Every tool call requires user confirmation",
  "auto-edit":
    "Read-only operations auto-approved, writes require confirmation",
  "full-auto": "Everything auto-approved (deny rules still apply)",
  "always-yes":
    "Everything auto-approved, including deny rules. Session-only. Requires confirmation to activate.",
};

export const MODE_ICONS: Readonly<Record<ApprovalMode, string>> = {
  suggest: "[LOCK]",
  "auto-edit": "[UNLOCK]",
  "full-auto": "[BOLT]",
  "always-yes": "[FIRE]",
};

export const MODE_PERMISSIVENESS: Readonly<Record<ApprovalMode, number>> = {
  suggest: 0,
  "auto-edit": 1,
  "full-auto": 2,
  "always-yes": 3,
};

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === "string" &&
    (ALL_MODES as readonly string[]).includes(value)
  );
}

const MODE_TRANSITIONS: Readonly<
  Record<ApprovalMode, Readonly<Record<PermissionAction, PermissionAction>>>
> = {
  suggest: { allow: "ask", ask: "ask", deny: "deny" },
  "auto-edit": { allow: "allow", ask: "ask", deny: "deny" },
  "full-auto": { allow: "allow", ask: "allow", deny: "deny" },
  "always-yes": { allow: "allow", ask: "allow", deny: "allow" },
};

/**
 * Whether the given mode overrides `deny` rules.
 *
 * Used by the activation gate: only "dangerous" modes require the
 * out-of-band confirmation prompt.
 */
export function isDangerousMode(mode: ApprovalMode): boolean {
  return DANGEROUS_MODES.has(mode);
}

export function applyMode(
  mode: ApprovalMode,
  ruleAction: PermissionAction,
): PermissionAction {
  return MODE_TRANSITIONS[mode][ruleAction];
}

export function getNextMode(mode: ApprovalMode): ApprovalMode {
  const idx = ALL_MODES.indexOf(mode);
  return ALL_MODES[(idx + 1) % ALL_MODES.length];
}

export type ModeChangeListener = (mode: ApprovalMode) => void;
type UnsubscribeFn = () => void;

export class ModeManager {
  private _mode: ApprovalMode;
  private readonly _listeners = new Set<ModeChangeListener>();

  constructor(initialMode: ApprovalMode = DEFAULT_MODE) {
    this.assertValidMode(initialMode);
    this._mode = initialMode;
  }

  get mode(): ApprovalMode {
    return this._mode;
  }

  setMode(mode: ApprovalMode): void {
    this.assertValidMode(mode);
    // No-op when unchanged, to avoid spurious listener notifications.
    if (mode === this._mode) return;
    this._mode = mode;
    this.notifyListeners(mode);
  }

  /** Cycles to the next mode in `ALL_MODES` order and returns it. */
  cycleMode(): ApprovalMode {
    const next = getNextMode(this._mode);
    this.setMode(next);
    return next;
  }

  /** Registers a mode-change listener. Returns an unsubscribe function. */
  onChange(listener: ModeChangeListener): UnsubscribeFn {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Short status-bar text, e.g. "[UNLOCK] auto-edit". */
  get statusText(): string {
    return `${MODE_ICONS[this._mode]} ${this._mode}`;
  }

  get description(): string {
    return MODE_DESCRIPTIONS[this._mode];
  }

  private assertValidMode(mode: ApprovalMode): void {
    if (!isApprovalMode(mode)) {
      throw new Error(
        `${LOG_PREFIX} Invalid approval mode: "${mode}". Valid options: ${ALL_MODES.join(" | ")}`,
      );
    }
  }

  /**
   * Notifies listeners, isolating failures so one broken listener can't
   * prevent others from receiving the update.
   */
  private notifyListeners(mode: ApprovalMode): void {
    for (const listener of this._listeners) {
      try {
        listener(mode);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Mode-change listener threw an error:`,
          err,
        );
      }
    }
  }
}
