/**
 * yes-my-pi Permission System — Approval Mode State Machine
 *
 * An "approval mode" applies a second layer of mapping on top of the
 * rule engine's output, controlling how much friction the user
 * experiences for otherwise-`allow`/`ask` decisions.
 *
 * `deny` is an iron rule: no mode can ever turn a `deny` into anything
 * else. Modes can only adjust the friction between `allow` and `ask`.
 *
 * `MODE_TRANSITIONS` below is the single source of truth for this
 * mapping — it IS the documentation. Keeping it as data (rather than
 * a `switch` statement) means it can never drift out of sync with what
 * this comment describes, and it can be iterated over directly in tests.
 *
 *              allow →      ask →       deny →
 *   suggest      ask         ask         deny
 *   auto-edit    allow       ask         deny
 *   full-auto    allow       allow       deny   (iron rule)
 */

import type { PermissionAction } from "./types.js";

const LOG_PREFIX = "[ymp-permissions]";

// ── Mode Definition ───────────────────────────────────────

export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

/** Canonical, ordered list of all approval modes (also defines cycle order). */
export const ALL_MODES: readonly ApprovalMode[] = [
  "suggest",
  "auto-edit",
  "full-auto",
];

/** Mode used when no explicit mode is configured. */
export const DEFAULT_MODE: ApprovalMode = "auto-edit";

export const MODE_DESCRIPTIONS: Readonly<Record<ApprovalMode, string>> = {
  suggest: "Every tool call requires user confirmation",
  "auto-edit":
    "Read-only operations auto-approved, writes require confirmation",
  "full-auto": "Everything auto-approved (deny rules still apply)",
};

export const MODE_ICONS: Readonly<Record<ApprovalMode, string>> = {
  suggest: "🔒",
  "auto-edit": "🔓",
  "full-auto": "⚡",
};

/**
 * Relative permissiveness ranking of each mode (higher = fewer prompts).
 * Useful for UI warnings, e.g. "switching to full-auto will auto-approve
 * N pending requests" when moving to a strictly more permissive mode.
 */
export const MODE_PERMISSIVENESS: Readonly<Record<ApprovalMode, number>> = {
  suggest: 0,
  "auto-edit": 1,
  "full-auto": 2,
};

/**
 * Runtime type guard for `ApprovalMode`.
 * Use this when a mode value comes from an untrusted source (persisted
 * config, CLI args, env vars) rather than re-implementing an
 * `.includes()` check inline.
 */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === "string" &&
    (ALL_MODES as readonly string[]).includes(value)
  );
}

// ── Transition Table ──────────────────────────────────────

/**
 * The authoritative mode → action → action mapping.
 * See the module doc comment above for the human-readable table this
 * mirrors exactly.
 */
const MODE_TRANSITIONS: Readonly<
  Record<ApprovalMode, Readonly<Record<PermissionAction, PermissionAction>>>
> = {
  suggest: { allow: "ask", ask: "ask", deny: "deny" },
  "auto-edit": { allow: "allow", ask: "ask", deny: "deny" },
  "full-auto": { allow: "allow", ask: "allow", deny: "deny" },
};

/**
 * Applies the current approval mode's transformation to a rule engine's
 * output action.
 *
 * `deny` always passes through unchanged — this is enforced structurally
 * by `MODE_TRANSITIONS` (every mode maps `deny → deny`), not by a special
 * case in this function, so it cannot be broken by an incomplete edit to
 * the table.
 */
export function applyMode(
  mode: ApprovalMode,
  ruleAction: PermissionAction,
): PermissionAction {
  return MODE_TRANSITIONS[mode][ruleAction];
}

/**
 * Returns the mode that `cycleMode()` would switch to, without mutating
 * any state. Useful for UI previews (e.g. "next: auto-edit" tooltips).
 */
export function getNextMode(mode: ApprovalMode): ApprovalMode {
  const idx = ALL_MODES.indexOf(mode);
  return ALL_MODES[(idx + 1) % ALL_MODES.length];
}

// ── Mode Manager ──────────────────────────────────────────

export type ModeChangeListener = (mode: ApprovalMode) => void;
type UnsubscribeFn = () => void;

/**
 * Stateful manager for the currently active approval mode.
 * Notifies registered listeners whenever the mode changes.
 */
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

  /**
   * Sets the active mode and notifies all listeners.
   * Throws if `mode` is not a recognized `ApprovalMode`.
   */
  setMode(mode: ApprovalMode): void {
    this.assertValidMode(mode);

    if (mode === this._mode) return; // no-op, avoid spurious notifications

    this._mode = mode;
    this.notifyListeners(mode);
  }

  /** Cycles to the next mode in `ALL_MODES` order and returns it. */
  cycleMode(): ApprovalMode {
    const next = getNextMode(this._mode);
    this.setMode(next);
    return next;
  }

  /**
   * Registers a mode-change listener. Returns an unsubscribe function.
   * Registering the same listener reference twice is a no-op (it will
   * only be invoked once per change).
   */
  onChange(listener: ModeChangeListener): UnsubscribeFn {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Short status-bar text, e.g. "🔓 auto-edit". */
  get statusText(): string {
    return `${MODE_ICONS[this._mode]} ${this._mode}`;
  }

  /** Human-readable description of the current mode's behavior. */
  get description(): string {
    return MODE_DESCRIPTIONS[this._mode];
  }

  // ── Internals ─────────────────────────────────────────

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
