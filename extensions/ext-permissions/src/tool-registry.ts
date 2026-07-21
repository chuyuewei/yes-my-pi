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
  name: string;
  category: ToolCategory;
  description: string;
  builtin: boolean;
}

const BUILTIN_TOOLS: ToolInfo[] = [
  { name: "read", category: "read", description: "Read file contents", builtin: true },
  { name: "grep", category: "read", description: "Search file contents", builtin: true },
  { name: "find", category: "read", description: "Find files", builtin: true },
  { name: "ls",   category: "read", description: "List directory contents", builtin: true },
  { name: "write", category: "write", description: "Create or overwrite a file", builtin: true },
  { name: "edit",  category: "write", description: "Precise file edit (find/replace)", builtin: true },
  { name: "bash",  category: "mixed", description: "Execute shell command (requires sub-analysis)", builtin: true },
];

const registry = new Map<string, ToolInfo>();
for (const tool of BUILTIN_TOOLS) {
  registry.set(tool.name, tool);
}

export function getToolCategory(toolName: string): ToolCategory {
  return registry.get(toolName)?.category ?? "unknown";
}

export function getToolInfo(toolName: string): ToolInfo {
  return (
    registry.get(toolName) ?? {
      name: toolName,
      category: "unknown",
      description: "Extension-registered tool (uncategorized)",
      builtin: false,
    }
  );
}

export function isReadOnlyTool(toolName: string): boolean {
  return getToolCategory(toolName) === "read";
}

export function registerTool(info: ToolInfo): void {
  registry.set(info.name, info);
}

export function getAllTools(): ToolInfo[] {
  return [...registry.values()];
}

export function getUncategorizedTools(): string[] {
  return [...registry.values()]
    .filter((t) => t.category === "unknown" && !t.builtin)
    .map((t) => t.name);
}
