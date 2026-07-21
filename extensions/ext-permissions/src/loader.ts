/**
 * yes-my-pi Permission System — Config Loader / Validator / Watcher
 *
 * Manages the lifecycle of permission configuration files:
 *   1. Validate raw config objects against the schema.
 *   2. Load and parse YAML files from disk.
 *   3. Resolve layered configurations (Default < Global < Project).
 *   4. Hot-reload with debounced file watching.
 */

import { watchFile, unwatchFile, readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import {
  isPermissionAction,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
} from "./types.js";

const LOG_PREFIX = "[ymp-permissions]";
const WATCH_DEBOUNCE_MS = 150;
const WATCH_POLL_INTERVAL_MS = 1000;

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

export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof config !== "object" || config === null) {
    return {
      valid: false,
      errors: [`Configuration must be a JSON/YAML object.`],
      warnings,
    };
  }

  const cfg = config as Record<string, unknown>;

  // 1. Version: warn-and-continue if a newer schema is encountered.
  if (cfg.version !== undefined && cfg.version !== 1) {
    warnings.push(
      `Unsupported config version: ${cfg.version}. Treating as v1.`,
    );
  }

  // 2. defaultAction.
  if (cfg.defaultAction !== undefined && !isPermissionAction(cfg.defaultAction)) {
    errors.push(
      `Invalid defaultAction "${cfg.defaultAction}". Must be allow, ask, or deny.`,
    );
  }

  if (!Array.isArray(cfg.rules)) {
    errors.push(`"rules" must be an array (received ${typeof cfg.rules}).`);
    return { valid: false, errors, warnings };
  }

  // 3. Per-rule checks.
  cfg.rules.forEach((ruleRaw, index) => {
    const prefix = `rules[${index}]`;

    if (typeof ruleRaw !== "object" || ruleRaw === null) {
      errors.push(`${prefix}: Rule must be an object.`);
      return;
    }

    const rule = ruleRaw as Record<string, unknown>;

    if (typeof rule.tool !== "string" || rule.tool.trim().length === 0) {
      errors.push(
        `${prefix}: "tool" is required and must be a non-empty string.`,
      );
    }

    if (!isPermissionAction(rule.action)) {
      errors.push(
        `${prefix}: Invalid action "${String(rule.action)}". Allowed: allow, ask, deny.`,
      );
    }

    if (
      rule.match !== undefined &&
      (typeof rule.match !== "object" || rule.match === null)
    ) {
      errors.push(`${prefix}: "match" must be an object if provided.`);
    }

    if (rule.reason !== undefined && typeof rule.reason !== "string") {
      warnings.push(
        `${prefix}: "reason" should be a string, got ${typeof rule.reason}.`,
      );
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Read+parse a file safely. Returns undefined if missing or unreadable.
 * Uses statSync to atomically check existence, avoiding the
 * TOCTOU race between existsSync and readFileSync.
 */
function readYamlFile(filePath: string): unknown | undefined {
  try {
    statSync(filePath);
    return parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `${LOG_PREFIX} Failed to read/parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return undefined;
  }
}

export function loadConfigFromFile(
  filePath: string,
): PermissionConfig | undefined {
  const parsed = readYamlFile(filePath);
  if (parsed === undefined) return undefined;

  const result = validateConfig(parsed);

  result.errors.forEach((msg) =>
    console.error(`${LOG_PREFIX} Config Error [${filePath}]: ${msg}`),
  );
  result.warnings.forEach((msg) =>
    console.warn(`${LOG_PREFIX} Warning [${filePath}]: ${msg}`),
  );

  if (!result.valid) return undefined;

  const data = parsed as Record<string, unknown>;
  return {
    version: 1,
    defaultAction: isPermissionAction(data.defaultAction)
      ? data.defaultAction
      : "ask",
    rules: Array.isArray(data.rules) ? (data.rules as PermissionRule[]) : [],
  };
}

/**
 * Load all three config layers: default (factory), global, project.
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

/**
 * Watch global and project config files for changes; debounced reload.
 *
 * Returns an unsubscribe function. The default config is read-only and
 * lives alongside the extension package, so it is NOT watched.
 */
export function watchConfigs(
  paths: { global: string; project: string },
  onChange: (configs: ConfigSet) => void,
): UnsubscribeFn {
  const targets = [paths.global, paths.project];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleFileChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`${LOG_PREFIX} Configuration change detected, reloading...`);
      onChange({
        project: loadConfigFromFile(paths.project),
        global: loadConfigFromFile(paths.global),
      });
    }, WATCH_DEBOUNCE_MS);
  };

  for (const file of targets) {
    try {
      watchFile(
        file,
        { persistent: false, interval: WATCH_POLL_INTERVAL_MS },
        handleFileChange,
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to watch ${file}:`, err);
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const file of targets) {
      try {
        unwatchFile(file, handleFileChange);
      } catch {
        // Ignore cleanup-time errors
      }
    }
  };
}
