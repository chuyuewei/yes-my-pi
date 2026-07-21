/**
 * yes-my-pi 权限系统 - 工具分类注册表
 *
 * 将 Pi 内置工具和扩展工具按安全级别分类。
 * 分类用于：
 *   1. 无显式规则时的默认动作推断
 *   2. auto-edit 模式下判断"只读 vs 写操作"
 *   3. 状态栏 / 日志中的工具类别显示
 */

export type ToolCategory = "read" | "write" | "mixed" | "unknown";

export interface ToolInfo {
  /** 工具名 */
  name: string;
  /** 安全分类 */
  category: ToolCategory;
  /** 说明 */
  description: string;
  /** 是否为 Pi 内置工具 */
  builtin: boolean;
}

// ── Pi 内置工具分类 ───────────────────────────────────────

const BUILTIN_TOOLS: ToolInfo[] = [
  {
    name: "read",
    category: "read",
    description: "读取文件内容",
    builtin: true,
  },
  {
    name: "grep",
    category: "read",
    description: "搜索文件内容",
    builtin: true,
  },
  {
    name: "find",
    category: "read",
    description: "查找文件",
    builtin: true,
  },
  {
    name: "ls",
    category: "read",
    description: "列出目录内容",
    builtin: true,
  },
  {
    name: "write",
    category: "write",
    description: "创建或覆写文件",
    builtin: true,
  },
  {
    name: "edit",
    category: "write",
    description: "精确编辑文件（查找替换）",
    builtin: true,
  },
  {
    name: "bash",
    category: "mixed",
    description: "执行 shell 命令（需命令级分析）",
    builtin: true,
  },
];

// ── 注册表 ────────────────────────────────────────────────

const registry = new Map<string, ToolInfo>();

// 初始化内置工具
for (const tool of BUILTIN_TOOLS) {
  registry.set(tool.name, tool);
}

/**
 * 查询工具分类
 * 未注册的工具返回 "unknown"
 */
export function getToolCategory(toolName: string): ToolCategory {
  return registry.get(toolName)?.category ?? "unknown";
}

/**
 * 查询工具完整信息
 */
export function getToolInfo(toolName: string): ToolInfo {
  return (
    registry.get(toolName) ?? {
      name: toolName,
      category: "unknown",
      description: "扩展注册的工具（未分类）",
      builtin: false,
    }
  );
}

/**
 * 判断工具是否为只读
 * 用于 auto-edit 模式的快速判断
 */
export function isReadOnlyTool(toolName: string): boolean {
  return getToolCategory(toolName) === "read";
}

/**
 * 动态注册工具分类（扩展工具在 session_start 时注册）
 */
export function registerTool(info: ToolInfo): void {
  registry.set(info.name, info);
}

/**
 * 获取所有已注册工具
 */
export function getAllTools(): ToolInfo[] {
  return [...registry.values()];
}

/**
 * 获取未分类工具列表（用于 /permissions 命令提示）
 */
export function getUncategorizedTools(): string[] {
  return [...registry.values()]
    .filter((t) => t.category === "unknown" && !t.builtin)
    .map((t) => t.name);
}
