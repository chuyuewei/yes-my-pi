/**
 * yes-my-pi Permission System — Config Loader / Validator / Merger
 *
 * Handles the lifecycle of permission configuration files:
 * 1. Validates raw config objects against schema.
 * 2. Loads and parses YAML configuration from disk.
 * 3. Resolves and merges layered configurations (Default < Global < Project).
 * 4. Implements hot-reloading with debounced file watching.
 */

import { watchFile, unwatchFile, readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import type {
  PermissionAction,
  PermissionConfig,
  PermissionRule,
} from "./types.js";

// ── Constants ──────────────────────────────────────────────

const VALID_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  "allow",
  "deny",
  "ask",
]);
const WATCH_DEBOUNCE_MS = 150;
const WATCH_POLL_INTERVAL_MS = 1000;
const LOG_PREFIX = "[ymp-permissions]";

// ── Types ─────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ConfigSet {
  project?: PermissionConfig;
  global?: PermissionConfig;
  default?: PermissionConfig;
}

type UnsubscribeFn = () => void;

// ── Validation ────────────────────────────────────────────

function isValidAction(value: unknown): value is PermissionAction {
  return (
    typeof value === "string" && VALID_ACTIONS.has(value as PermissionAction)
  );
}

/**
 * Validates a parsed configuration object and normalizes it if valid.
 */
export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof config !== "object" || config === null) {
    return {
      valid: false,
      errors: [`${LOG_PREFIX} Configuration must be a JSON/YAML object.`],
      warnings,
    };
  }

  const cfg = config as Record<string, unknown>;

  // 1. Version check (Graceful degradation)
  if (cfg.version !== undefined && cfg.version !== 1) {
    warnings.push(
      `Unsupported config version: ${cfg.version}. Treating as v1.`,
    );
  }

  // 2. Default Action check
  if (cfg.defaultAction !== undefined && !isValidAction(cfg.defaultAction)) {
    errors.push(
      `Invalid defaultAction "${cfg.defaultAction}". Must be one of: ${[...VALID_ACTIONS].join(", ")}.`,
    );
  }

  // 3. Rules Array check
  if (!Array.isArray(cfg.rules)) {
    errors.push(`"rules" must be an array. Received ${typeof cfg.rules}.`);
    return { valid: false, errors, warnings };
  }

  // 4. Individual Rule validation
  cfg.rules.forEach((ruleRaw, index) => {
    const prefix = `rules[${index}]`;

    if (typeof ruleRaw !== "object" || ruleRaw === null) {
      errors.push(`${prefix}: Rule must be an object.`);
      return;
    }

    const rule = ruleRaw as Record<string, unknown>;

    // 'tool' field (required)
    if (typeof rule.tool !== "string" || rule.tool.trim().length === 0) {
      errors.push(
        `${prefix}: "tool" is required and must be a non-empty string.`,
      );
    }

    // 'action' field (required)
    if (!isValidAction(rule.action)) {
      errors.push(
        `${prefix}: Invalid action "${rule.action}". Allowed: ${[...VALID_ACTIONS].join(", ")}.`,
      );
    }

    // 'match' field (optional)
    if (
      rule.match !== undefined &&
      (typeof rule.match !== "object" || rule.match === null)
    ) {
      errors.push(`${prefix}: "match" must be an object if provided.`);
    }

    // 'reason' field (optional)
    if (rule.reason !== undefined && typeof rule.reason !== "string") {
      warnings.push(
        `${prefix}: "reason" should be a string, but got ${typeof rule.reason}.`,
      );
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

// ── Loading ────────────────────────────────────────────────

/**
 * Attempts to read and parse a file safely.
 * Returns undefined if file is missing or unreadable.
 */
function readYamlFile(filePath: string): unknown | undefined {
  try {
    // Using statSync to check existence throws naturally if missing,
    // avoiding race conditions between existsSync and readFileSync.
    statSync(filePath);
    const raw = readFileSync(filePath, "utf-8");
    return parse(raw);
  } catch (err) {
    // Silently ignore ENOENT (file not found), but log other IO/parse errors
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `${LOG_PREFIX} Failed to read/parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return undefined;
  }
}

/**
 * Loads, parses, and validates a permission configuration file.
 */
export function loadConfigFromFile(
  filePath: string,
): PermissionConfig | undefined {
  const parsed = readYamlFile(filePath);
  if (parsed === undefined) {
    return undefined;
  }

  const result = validateConfig(parsed);

  result.errors.forEach((msg) =>
    console.error(`${LOG_PREFIX} Config Error [${filePath}]: ${msg}`),
  );
  result.warnings.forEach((msg) =>
    console.warn(`${LOG_PREFIX} Warning [${filePath}]: ${msg}`),
  );

  if (!result.valid) {
    return undefined;
  }

  // Safe cast and normalization to strict PermissionConfig
  const data = parsed as Record<string, unknown>;
  return {
    version: 1,
    defaultAction: isValidAction(data.defaultAction)
      ? data.defaultAction
      : "ask",
    rules: Array.isArray(data.rules) ? (data.rules as PermissionRule[]) : [],
  };
}

// ── Resolution & Merging ─────────────────────────────────

/**
 * Loads configuration from all three layers:
 * 1. Built-in Defaults
 * 2. User Global Settings
 * 3. Project Local Overrides
 */
export function loadAllConfigs(paths: {
  global: string;
  project: string;
  default: string;
}): ConfigSet {
  return {
    project: loadConfigFromFile(paths.project),
    global: loadConfigFromFile(paths.global),
    default: loadConfigFromFile(paths.default),
  };
}

// ── Hot Reload (File Watcher) ─────────────────────────────

/**
 * Watches specific configuration files for changes and triggers a reload callback.
 * Uses a debounce strategy to avoid excessive reloads during batch writes.
 *
 * Note: We intentionally do NOT filter by `existsSync` before watching.
 * `fs.watchFile` handles files that don't exist yet and will trigger
 * once they are created.
 */
export function watchConfigs(
  paths: { global: string; project: string; default: string },
  onChange: (configs: ConfigSet) => void,
): UnsubscribeFn {
  const targets = [paths.global, paths.project];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleFileChange = () => {
    // Debounce: collapse multiple rapid triggers into a single reload
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      console.log(`${LOG_PREFIX} Configuration change detected, reloading...`);
      const updatedConfigs = loadAllConfigs(paths);
      onChange(updatedConfigs);
    }, WATCH_DEBOUNCE_MS);
  };

  // Attach native FS watchers
  for (const file of targets) {
    try {
      // persistent: false ensures the watcher doesn't keep the Node.js event loop alive
      // if the app is trying to exit.
      watchFile(
        file,
        { persistent: false, interval: WATCH_POLL_INTERVAL_MS },
        handleFileChange,
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to watch ${file}:`, err);
    }
  }

  // Return Cleanup Function
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const file of targets) {
      try {
        unwatchFile(file, handleFileChange);
      } catch {
        // Ignore errors during cleanup
      }
    }
  };
}
