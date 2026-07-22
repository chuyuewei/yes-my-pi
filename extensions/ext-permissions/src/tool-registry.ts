/**
 * yes-my-pi Permission System — Tool Classification Registry
 *
 * Classifies both Pi built-in tools and extension-registered tools by
 * safety level. Used as a fallback when no explicit rule matches:
 *   - read   -> auto-allow (no side effects)
 *   - write  -> ask (modifies the filesystem or state)
 *   - mixed  -> ask (effect depends on arguments, e.g. `bash`)
 *   - unknown -> ask (ext tools default to safe behavior)
 */

export type ToolCategory = "read" | "write" | "mixed" | "unknown";

export interface ToolInfo {
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly builtin: boolean;
}

const BUILTIN_TOOLS: readonly ToolInfo[] = [
  {
    name: "read",
    category: "read",
    description: "Read file contents",
    builtin: true,
  },
  {
    name: "grep",
    category: "read",
    description: "Search file contents",
    builtin: true,
  },
  { name: "find", category: "read", description: "Find files", builtin: true },
  {
    name: "ls",
    category: "read",
    description: "List directory contents",
    builtin: true,
  },
  {
    name: "write",
    category: "write",
    description: "Create or overwrite a file",
    builtin: true,
  },
  {
    name: "edit",
    category: "write",
    description: "Precise file edit (find/replace)",
    builtin: true,
  },
  {
    name: "bash",
    category: "mixed",
    description: "Execute shell command (requires sub-analysis)",
    builtin: true,
  },
].map(Object.freeze); // Deep freeze builtin definitions to prevent runtime tampering

// Pre-allocated frozen fallback object for unknown tools (Zero-allocation O(1) lookup)
const UNKNOWN_TOOL_TEMPLATE: ToolInfo = Object.freeze({
  name: "", // Name will be dynamically assigned in a lightweight wrapper if needed,
  // but for safety we return a read-only shape.
  category: "unknown",
  description: "Extension-registered tool (uncategorized)",
  builtin: false,
});

const registry = new Map<string, ToolInfo>();
for (const tool of BUILTIN_TOOLS) {
  registry.set(tool.name, tool);
}

export function getToolCategory(toolName: string): ToolCategory {
  return registry.get(toolName)?.category ?? "unknown";
}

export function getToolInfo(toolName: string): ToolInfo {
  const existing = registry.get(toolName);
  if (existing) {
    return existing;
  }

  // Return a new lightweight object for the specific unknown tool name.
  // We don't cache this to avoid unbounded Map growth from arbitrary/malicious names.
  return Object.freeze({
    ...UNKNOWN_TOOL_TEMPLATE,
    name: toolName,
  });
}

export function isReadOnlyTool(toolName: string): boolean {
  return getToolCategory(toolName) === "read";
}

/**
 * Registers a new tool or updates an existing extension tool.
 *
 * Security: Throws an error if attempting to overwrite a built-in tool.
 * This prevents malicious extensions from reclassifying secure tools
 * (like changing `bash` to `read` to bypass the classifier).
 *
 * Reliability: The input info is frozen before storage to ensure
 * immutability across the application lifecycle.
 */
export function registerTool(info: ToolInfo): void {
  const existing = registry.get(info.name);

  if (existing?.builtin) {
    throw new Error(
      `[ymp-permissions] Security Error: Cannot overwrite built-in tool "${info.name}".`,
    );
  }

  // Enforce immutability on stored references
  const frozenInfo = Object.freeze({ ...info });
  registry.set(frozenInfo.name, frozenInfo);
}

export function getAllTools(): ToolInfo[] {
  return Array.from(registry.values());
}

export function getUncategorizedTools(): string[] {
  const result: string[] = [];
  for (const tool of registry.values()) {
    if (tool.category === "unknown" && !tool.builtin) {
      result.push(tool.name);
    }
  }
  return result;
}
