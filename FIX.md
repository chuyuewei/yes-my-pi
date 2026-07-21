# yes-my-pi Phase 1 优化指南

## 你的角色

你是一个代码优化工程师。你的任务是阅读以下完整项目，修复已知问题，并执行优化清单。
所有修改必须保持 Paper 模式原则：**不修改 Pi 上游源码**，仅修改 yes-my-pi 自己的文件。

---

## 项目背景

yes-my-pi 是一个基于 Pi（开源终端 AI 编程代理）的权限控制层。
Pi 作为 npm 依赖引入（`@earendil-works/pi-coding-agent` v0.80.10），yes-my-pi 通过 Pi 的扩展系统实现三级审批模式（suggest / auto-edit / full-auto）。

### 架构

```
用户输入 ymp 命令
  → bin/ymp.js（注入 --append-system-prompt，调用 Pi main(args)）
    → Pi 引擎启动，加载 .pi/extensions/ 下的扩展
      → ext-permissions/index.ts 注册 tool_call 拦截器
        → 每次工具调用经过：规则引擎求值 → 模式映射 → allow/ask/deny
```

### Pi 扩展 API（已确认）

```typescript
// 扩展入口：导出默认函数，接收 ExtensionAPI
export default function myExtension(pi: ExtensionAPI): void {
  // 事件监听
  pi.on("tool_call", async (event, ctx) => {
    // event.toolName: string
    // event.args: Record<string, unknown>
    // 返回 { blocked: true, reason: "..." } 可阻止工具执行
    // 返回 undefined 放行
  });
  pi.on("session_start", (event, ctx) => {});
  pi.on("session_shutdown", () => {});

  // 注册斜杠命令
  pi.registerCommand("name", {
    description: "...",
    handler: async (args: string, ctx: any) => {
      return "输出文本"; // ⚠️ 返回值是否被渲染未确认
    },
  });

  // 注册工具
  pi.registerTool({ name, description, parameters, execute });
}
```

### Pi 导出的关键 API（从 dist/index.js 确认）

```
createAgentSession, createAgentSessionFromServices,
createAgentSessionRuntime, createAgentSessionServices,
AgentSession, AgentSessionRuntime,
main, parseArgs,
CONFIG_DIR_NAME, getAgentDir, VERSION,
createBashTool, createEditTool, createReadTool, createWriteTool,
createGrepTool, createFindTool, createLsTool, createCodingTools, createReadOnlyTools,
createExtensionRuntime, defineTool, discoverAndLoadExtensions, ExtensionRunner,
SessionManager, SettingsManager,
InteractiveMode, runPrintMode, runRpcMode,
initTheme, Theme,
（大量 UI 组件导出）
```

### 配置目录

- `CONFIG_DIR_NAME` 来自 Pi 包的 `package.json` 中 `piConfig.configDir`，值为 `".pi"`，**外部无法覆盖**
- 全局配置：`~/.pi/agent/`（可通过 `PI_CODING_AGENT_DIR` 环境变量覆盖）
- 项目配置：`<project>/.pi/`
- 扩展目录：`.pi/extensions/`

---

## 已知问题（必须修复）

### BUG-001：/mode 命令无视觉反馈（P0）

**现象**：执行 `/mode suggest` 后模式确实切换了（功能正常），但 TUI 中无任何提示文字。
**原因**：Pi 的 `registerCommand` handler 返回值可能不会被渲染。`emitOutput` 尝试了 4 个通道（ctx.ui.print、pi.appendSystemMessage、ctx.print、console.error）均无效。Pi 的 TUI 使用差分渲染，可能吞掉了 stderr。
**修复方向**：

1. 在 `/mode` handler 开头写一个诊断文件，dump `ctx` 和 `pi` 的所有可用方法：

```typescript
import { writeFileSync } from "node:fs";
writeFileSync(
  "ymp-ctx-dump.json",
  JSON.stringify(
    {
      ctx_keys: Object.getOwnPropertyNames(Object.getPrototypeOf(ctx)).concat(
        Object.keys(ctx),
      ),
      ctx_ui_keys: ctx?.ui
        ? Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.ui)).concat(
            Object.keys(ctx.ui),
          )
        : [],
      pi_keys: Object.keys(pi),
    },
    null,
    2,
  ),
);
```

2. 运行 `/mode`，检查 dump 文件，找到正确的输出 API
3. 可能的候选：`ctx.ui.addMessage()`、`ctx.ui.showToast()`、`ctx.ui.write()`、`pi.emit()`、通过 event bus 发送消息
4. 如果找不到 TUI 内输出方式，考虑用 Pi 导出的 UI 组件（如 `CustomMessageComponent`）手动渲染

### BUG-002：ctx.ui.confirm() API 未验证（P0）

**现象**：确认框可能不弹出（ask 模式下应弹出确认框让用户选择 y/n/a/d）。
**原因**：`ctx.ui.confirm(message, { choices })` 的签名是猜测的，Pi 可能不支持此 API。
**修复方向**：

1. 同样通过 dump 文件检查 `ctx.ui` 上有哪些方法
2. Pi 导出了 `ExtensionSelectorComponent`、`ExtensionInputComponent` 等 UI 组件，可能需要用这些
3. 降级方案：如果无确认 UI，在 tool_call 中直接 block 并提示用户用 `/mode full-auto` 或添加 allow 规则

### BUG-003：状态栏更新未验证（P2）

**现象**：`ctx.ui.setStatus()` 可能不存在。
**修复方向**：同 BUG-001 诊断，检查 ctx.ui 可用方法。

---

## 完整项目文件

### 文件结构

```
yes-my-pi/
├── bin/
│   └── ymp.js
├── extensions/
│   └── ext-permissions/
│       ├── package.json
│       ├── index.ts
│       ├── permissions.default.yaml
│       ├── permissions.example.yaml
│       └── src/
│           ├── types.ts
│           ├── bash-analyzer.ts
│           ├── matcher.ts
│           ├── tool-registry.ts
│           ├── loader.ts
│           └── mode.ts
├── config/
│   ├── SYSTEM.md
│   ├── AGENTS.md
│   ├── settings.default.json
│   └── README.md
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

---

### bin/ymp.js

```javascript
#!/usr/bin/env node
import process from "node:process";

/**
 * yes-my-pi (ymp) CLI 入口
 *
 * Paper 模式：Pi 是上游引擎，yes-my-pi 是产品层。
 * 本文件职责：
 *   1. 透传用户传入的 CLI 参数
 *   2. 若用户未显式指定 system prompt，注入 ymp 默认身份
 *   3. 启动上游 Pi 引擎，并处理启动期错误
 */

const YMP_SYSTEM_PROMPT = [
  "You are yes-my-pi (ymp), a controllable AI coding agent built on Pi.",
  "You respect the permission system: some tool calls may require user approval.",
  "When a tool call is blocked, acknowledge the denial and adjust your approach.",
].join(" ");

const SYSTEM_PROMPT_FLAGS = new Set([
  "--system-prompt",
  "--append-system-prompt",
]);

/**
 * 若用户未显式传入 system prompt 相关参数，则追加 ymp 默认身份。
 * @param {string[]} userArgs
 * @returns {string[]}
 */
export function buildArgs(userArgs) {
  const hasSystemPrompt = userArgs.some((arg) => SYSTEM_PROMPT_FLAGS.has(arg));

  if (hasSystemPrompt) {
    return userArgs;
  }

  return [...userArgs, "--append-system-prompt", YMP_SYSTEM_PROMPT];
}

async function run() {
  const args = buildArgs(process.argv.slice(2));

  let pi;
  try {
    pi = await import("@earendil-works/pi-coding-agent");
  } catch (err) {
    throw new Error(
      `Failed to load "@earendil-works/pi-coding-agent". ` +
        `Please check the installation.\n${err instanceof Error ? err.message : err}`,
    );
  }

  await pi.main(args);
}

run().catch((err) => {
  console.error(`[ymp] ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.YMP_DEBUG) {
    console.error(err);
  }
  process.exitCode = 1;
});
```

---

### extensions/ext-permissions/package.json

```json
{
  "name": "yes-my-pi-permissions",
  "version": "0.1.0",
  "description": "Permission & approval system for yes-my-pi",
  "type": "module",
  "main": "index.ts",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.80.0"
  },
  "dependencies": {
    "yaml": "^2.9.0"
  }
}
```

---

### extensions/ext-permissions/src/types.ts

```typescript
/**
 * yes-my-pi 权限系统 - 数据模型
 */

export type PermissionAction = "allow" | "deny" | "ask";

export interface RuleMatch {
  command?: string | string[];
  path?: string | string[];
  args?: Record<string, string | string[]>;
}

export interface PermissionRule {
  tool: string;
  match?: RuleMatch;
  action: PermissionAction;
  reason?: string;
}

export interface PermissionConfig {
  version: number;
  defaultAction: PermissionAction;
  rules: PermissionRule[];
}

export interface MatchResult {
  action: PermissionAction;
  rule?: PermissionRule;
  scope: "project" | "global" | "default";
  reason?: string;
}

export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
}
```

---

### extensions/ext-permissions/src/mode.ts

```typescript
/**
 * yes-my-pi 权限系统 - 审批模式状态机
 */

import type { PermissionAction } from "./types.js";

export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export const ALL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

export const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  suggest: "所有工具调用需用户确认",
  "auto-edit": "只读操作自动放行，写操作需确认",
  "full-auto": "全部自动放行（deny 规则仍生效）",
};

export const MODE_ICONS: Record<ApprovalMode, string> = {
  suggest: "🔒",
  "auto-edit": "🔓",
  "full-auto": "⚡",
};

export function applyMode(
  mode: ApprovalMode,
  ruleAction: PermissionAction,
): PermissionAction {
  if (ruleAction === "deny") return "deny";
  switch (mode) {
    case "suggest":
      return ruleAction === "allow" ? "ask" : ruleAction;
    case "auto-edit":
      return ruleAction;
    case "full-auto":
      return ruleAction === "ask" ? "allow" : ruleAction;
  }
}

export class ModeManager {
  private _mode: ApprovalMode;
  private _listeners: Array<(mode: ApprovalMode) => void> = [];

  constructor(initialMode: ApprovalMode = "auto-edit") {
    this._mode = initialMode;
  }

  get mode(): ApprovalMode {
    return this._mode;
  }

  setMode(mode: ApprovalMode): void {
    if (!ALL_MODES.includes(mode)) {
      throw new Error(
        `无效的审批模式: "${mode}"。可选: ${ALL_MODES.join(" | ")}`,
      );
    }
    this._mode = mode;
    for (const listener of this._listeners) {
      listener(mode);
    }
  }

  cycleMode(): ApprovalMode {
    const idx = ALL_MODES.indexOf(this._mode);
    const next = ALL_MODES[(idx + 1) % ALL_MODES.length];
    this.setMode(next);
    return next;
  }

  onChange(listener: (mode: ApprovalMode) => void): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  get statusText(): string {
    return `${MODE_ICONS[this._mode]} ${this._mode}`;
  }
}
```

---

### extensions/ext-permissions/src/tool-registry.ts

```typescript
/**
 * yes-my-pi 权限系统 - 工具分类注册表
 */

export type ToolCategory = "read" | "write" | "mixed" | "unknown";

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  description: string;
  builtin: boolean;
}

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
  { name: "find", category: "read", description: "查找文件", builtin: true },
  { name: "ls", category: "read", description: "列出目录内容", builtin: true },
  {
    name: "write",
    category: "write",
    description: "创建或覆写文件",
    builtin: true,
  },
  {
    name: "edit",
    category: "write",
    description: "精确编辑文件",
    builtin: true,
  },
  {
    name: "bash",
    category: "mixed",
    description: "执行 shell 命令",
    builtin: true,
  },
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
      description: "扩展注册的工具（未分类）",
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
```

---

### extensions/ext-permissions/src/bash-analyzer.ts

```typescript
/**
 * yes-my-pi 权限系统 - bash 命令分类器（v2）
 */

export type BashCommandClass = "read" | "write" | "dangerous" | "unknown";

const READ_ONLY_COMMANDS: string[] = [
  "cat ",
  "head ",
  "tail ",
  "less ",
  "more ",
  "wc ",
  "file ",
  "stat ",
  "du ",
  "df ",
  "ls ",
  "ll ",
  "dir ",
  "tree ",
  "pwd",
  "grep ",
  "egrep ",
  "fgrep ",
  "rg ",
  "ag ",
  "find ",
  "fd ",
  "locate ",
  "which ",
  "where ",
  "whereis ",
  "type ",
  "command -v ",
  "echo ",
  "printf ",
  "env",
  "printenv",
  "date",
  "uname ",
  "hostname",
  "whoami",
  "id ",
  "sort ",
  "uniq ",
  "cut ",
  "tr ",
  "jq ",
  "yq ",
  "diff ",
  "comm ",
  "realpath ",
  "readlink ",
  "basename ",
  "dirname ",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "npm list",
  "npm ls",
  "npm outdated",
  "npm view",
  "npm search",
  "npx --version",
  "python --version",
  "python3 --version",
  "pip list",
  "pip show",
  "pip3 list",
  "pip3 show",
  "cargo --version",
  "rustc --version",
  "go version",
  "go env",
  "java -version",
  "javac -version",
  "tsc --version",
  "eslint --version",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "git ls-files",
  "git blame",
  "git stash list",
  "git shortlog",
  "git describe",
  "git config --get",
  "git config --list",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run check",
  "npm run typecheck",
  "npx vitest",
  "npx jest",
  "npx tsc --noEmit",
  "npx eslint",
  "npx prettier --check",
  "pytest",
  "cargo test",
  "cargo clippy",
  "go test",
  "go vet",
  "make test",
  "make lint",
  "make check",
  "test ",
  "[ ",
  "true",
  "false",
  "sleep ",
];

const DANGEROUS_COMMANDS: string[] = [
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf .",
  "rm -rf ./",
  "rm -rf ..",
  "rm -rf ../",
  "sudo ",
  "su ",
  "doas ",
  "curl | bash",
  "curl | sh",
  "wget | bash",
  "wget | sh",
  "curl|bash",
  "curl|sh",
  "wget|bash",
  "wget|sh",
  "curl |bash",
  "curl |sh",
  "chmod 777",
  "chmod -R 777",
  "chown -R",
  "dd if=",
  "mkfs",
  "fdisk",
  "parted ",
  ":(){ :|:& };:",
  "> /dev/sda",
  "> /dev/nvme",
  "> /dev/disk",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  "kill -9 1",
  "killall",
  "iptables",
  "ufw ",
  "nft ",
  "systemctl stop",
  "systemctl disable",
  "service stop",
  "format ",
  "del /s /q ",
  "rd /s /q ",
  "Remove-Item -Recurse -Force C:",
  "diskpart",
  "reg delete ",
  "net stop ",
  "sc delete ",
  "Stop-Computer",
  "Restart-Computer",
];

const WRITE_COMMANDS: string[] = [
  "rm ",
  "rmdir ",
  "mv ",
  "cp ",
  "mkdir ",
  "touch ",
  "ln ",
  "chmod ",
  "chown ",
  "tee ",
  "git add",
  "git commit",
  "git push",
  "git pull",
  "git checkout",
  "git switch",
  "git merge",
  "git rebase",
  "git reset",
  "git cherry-pick",
  "git stash push",
  "git stash pop",
  "git stash drop",
  "git stash clear",
  "git tag ",
  "git branch -d",
  "git branch -D",
  "git remote add",
  "git remote remove",
  "git remote set-url",
  "git config --set",
  "git config --add",
  "git clean",
  "npm install",
  "npm i ",
  "npm ci",
  "npm uninstall",
  "npm remove",
  "npm publish",
  "npm link",
  "npm run build",
  "npm run compile",
  "npm cache clean",
  "npx create-",
  "yarn add",
  "yarn remove",
  "yarn install",
  "pnpm add",
  "pnpm remove",
  "pnpm install",
  "pip install",
  "pip3 install",
  "pip uninstall",
  "cargo build",
  "cargo install",
  "cargo publish",
  "go build",
  "go install",
  "go get",
  "make ",
  "cmake ",
  "gradle ",
  "mvn ",
  "tsc ",
  "webpack ",
  "vite build",
  "rollup ",
  "docker build",
  "docker run",
  "docker push",
  "docker compose up",
  "docker-compose up",
  "docker rm",
  "docker rmi",
  "kubectl apply",
  "kubectl delete",
  "terraform apply",
  "terraform destroy",
  "wget ",
  "curl -o ",
  "curl -O ",
  "scp ",
  "rsync ",
  "tar ",
  "zip ",
  "unzip ",
  "gzip ",
  "gunzip ",
  "sed -i",
  "perl -i",
  "patch ",
  "node ",
  "python ",
  "python3 ",
  "ruby ",
  "perl ",
  "php ",
  "bash ",
  "sh ",
  "zsh ",
  "del ",
  "erase ",
  "move ",
  "copy ",
  "mkdir ",
  "md ",
  "rmdir ",
  "rd ",
  "ren ",
  "rename ",
  "attrib ",
  "New-Item",
  "Remove-Item",
  "Move-Item",
  "Copy-Item",
  "Set-Content",
  "Add-Content",
  "Clear-Content",
  "Rename-Item",
  "Set-ItemProperty",
  "Install-Module",
  "Uninstall-Module",
  "git.exe ",
];

export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "|" && command[i + 1] === "|") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === "|") {
        segments.push(current.trim());
        current = "";
        continue;
      }
      if (ch === "&" && command[i + 1] === "&") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter((s) => s.length > 0);
}

export function extractNestedCommands(command: string): string[] {
  const nested: string[] = [];
  let match;
  const cmdSubstRegex = /\$\(([^)]+)\)/g;
  while ((match = cmdSubstRegex.exec(command)) !== null) nested.push(match[1]);
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(command)) !== null) nested.push(match[1]);
  const shellCRegex =
    /(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-\w+\s+)*-c\s+["']?([^"']+)["']?/gi;
  while ((match = shellCRegex.exec(command)) !== null) nested.push(match[1]);
  const findExecRegex = /-exec\s+(.+?)(?:\s*\\;|\s*;|\s*\\+\s*)/g;
  while ((match = findExecRegex.exec(command)) !== null) nested.push(match[1]);
  const xargsRegex = /xargs\s+(?:-\w+\s+)*(\S+)/g;
  while ((match = xargsRegex.exec(command)) !== null) nested.push(match[1]);
  return nested;
}

export function stripEnvPrefix(segment: string): string {
  return segment.replace(/^(\s*\w+=\S+\s+)+/, "").trim();
}

export function hasRedirect(command: string): boolean {
  const stripped = command.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
  return /(?<!\d)>{1,2}(?!&)/.test(stripped);
}

function classifySegment(segment: string): BashCommandClass {
  const trimmed = stripEnvPrefix(segment.trim());
  if (!trimmed) return "read";
  for (const p of DANGEROUS_COMMANDS) {
    if (trimmed.startsWith(p) || trimmed === p.trim()) return "dangerous";
  }
  if (hasRedirect(trimmed)) return "write";
  for (const p of READ_ONLY_COMMANDS) {
    if (trimmed.startsWith(p) || trimmed === p.trim()) return "read";
  }
  for (const p of WRITE_COMMANDS) {
    if (trimmed.startsWith(p)) return "write";
  }
  return "unknown";
}

export function classifyBashCommand(command: string): BashCommandClass {
  if (!command || !command.trim()) return "unknown";
  let result: BashCommandClass = "read";
  const nested = extractNestedCommands(command);
  for (const nc of nested) {
    const cls = classifyBashCommand(nc);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return result === "read" ? "unknown" : result;
  for (const seg of segments) {
    const cls = classifySegment(seg);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }
  return result;
}
```

---

### extensions/ext-permissions/src/matcher.ts

```typescript
/**
 * yes-my-pi 权限系统 - 规则匹配引擎
 */

import type {
  MatchResult,
  PermissionAction,
  PermissionConfig,
  PermissionRule,
  ToolCallInfo,
} from "./types.js";
import { classifyBashCommand } from "./bash-analyzer.js";
import { getToolCategory } from "./tool-registry.js";

export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*") && !pattern.includes("**")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  if (pattern.includes("**") || pattern.includes("*")) {
    const regexStr =
      "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§GLOBSTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/§GLOBSTAR§/g, ".*") +
      "$";
    try {
      return new RegExp(regexStr).test(value);
    } catch {
      return value.startsWith(pattern);
    }
  }
  return value === pattern || value.startsWith(pattern);
}

function matchStringOrArray(
  pattern: string | string[] | undefined,
  value: string,
): boolean {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, value));
}

export function matchRule(rule: PermissionRule, call: ToolCallInfo): boolean {
  if (rule.tool !== "*" && rule.tool !== call.toolName) return false;
  if (!rule.match) return true;
  const { command, path, args } = rule.match;
  if (command !== undefined && call.toolName === "bash") {
    if (!matchStringOrArray(command, String(call.args.command ?? "")))
      return false;
  }
  if (path !== undefined) {
    const filePath = String(
      call.args.path ?? call.args.file ?? call.args.filePath ?? "",
    );
    if (!matchStringOrArray(path, filePath)) return false;
  }
  if (args !== undefined) {
    for (const [key, pattern] of Object.entries(args)) {
      if (!matchStringOrArray(pattern, String(call.args[key] ?? "")))
        return false;
    }
  }
  return true;
}

const ACTION_PRIORITY: Record<PermissionAction, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

function evaluateConfig(
  config: PermissionConfig,
  call: ToolCallInfo,
  scope: MatchResult["scope"],
): MatchResult | undefined {
  let bestMatch: { rule: PermissionRule; action: PermissionAction } | undefined;
  for (const rule of config.rules) {
    if (!matchRule(rule, call)) continue;
    if (
      !bestMatch ||
      ACTION_PRIORITY[rule.action] > ACTION_PRIORITY[bestMatch.action]
    ) {
      bestMatch = { rule, action: rule.action };
    }
    if (rule.action === "deny") break;
  }
  if (bestMatch) {
    return {
      action: bestMatch.action,
      rule: bestMatch.rule,
      scope,
      reason: bestMatch.rule.reason,
    };
  }
  return undefined;
}

function evaluateBashClassifier(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName !== "bash") return undefined;
  const cmd = String(call.args.command ?? "");
  const cls = classifyBashCommand(cmd);
  const preview = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
  switch (cls) {
    case "dangerous":
      return {
        action: "deny",
        scope: "default",
        reason: `命令被分类为危险操作: "${preview}"`,
      };
    case "write":
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason: `命令包含写操作或无法判断: "${preview}"`,
      };
    case "read":
      return { action: "allow", scope: "default" };
  }
}

function evaluateToolRegistry(call: ToolCallInfo): MatchResult | undefined {
  if (call.toolName === "bash") return undefined;
  const category = getToolCategory(call.toolName);
  switch (category) {
    case "read":
      return { action: "allow", scope: "default" };
    case "write":
      return {
        action: "ask",
        scope: "default",
        reason: `写操作工具 "${call.toolName}" 需要确认`,
      };
    case "mixed":
      return {
        action: "ask",
        scope: "default",
        reason: `混合工具 "${call.toolName}" 需要确认`,
      };
    case "unknown":
      return {
        action: "ask",
        scope: "default",
        reason: `未分类工具 "${call.toolName}"，默认需要确认。可在 permissions.yaml 中添加规则。`,
      };
  }
}

export function evaluateToolCall(
  call: ToolCallInfo,
  configs: {
    project?: PermissionConfig;
    global?: PermissionConfig;
    default?: PermissionConfig;
  },
): MatchResult {
  const results: MatchResult[] = [];
  if (configs.project) {
    const r = evaluateConfig(configs.project, call, "project");
    if (r) results.push(r);
  }
  if (configs.global) {
    const r = evaluateConfig(configs.global, call, "global");
    if (r) results.push(r);
  }
  if (configs.default) {
    const r = evaluateConfig(configs.default, call, "default");
    if (r) results.push(r);
  }
  const bashResult = evaluateBashClassifier(call);
  if (bashResult) results.push(bashResult);
  const registryResult = evaluateToolRegistry(call);
  if (registryResult) results.push(registryResult);
  if (results.length === 0) {
    return {
      action: configs.default?.defaultAction ?? "ask",
      scope: "default",
    };
  }
  results.sort((a, b) => ACTION_PRIORITY[b.action] - ACTION_PRIORITY[a.action]);
  return results[0];
}
```

---

### extensions/ext-permissions/src/loader.ts

```typescript
/**
 * yes-my-pi 权限系统 - 配置加载 / 校验 / 合并
 */

import { existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { parse } from "yaml";
import type {
  PermissionAction,
  PermissionConfig,
  PermissionRule,
} from "./types.js";

const VALID_ACTIONS: PermissionAction[] = ["allow", "deny", "ask"];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof config !== "object" || config === null) {
    return { valid: false, errors: ["配置必须是一个对象"], warnings };
  }
  const cfg = config as Record<string, unknown>;
  if (cfg.version !== undefined && cfg.version !== 1) {
    warnings.push(`不支持的配置版本: ${cfg.version}，按 v1 处理`);
  }
  if (
    cfg.defaultAction !== undefined &&
    !VALID_ACTIONS.includes(cfg.defaultAction as PermissionAction)
  ) {
    errors.push(
      `defaultAction 必须是 ${VALID_ACTIONS.join(" | ")}，收到: "${cfg.defaultAction}"`,
    );
  }
  if (!Array.isArray(cfg.rules)) {
    errors.push("rules 必须是一个数组");
    return { valid: false, errors, warnings };
  }
  for (let i = 0; i < cfg.rules.length; i++) {
    const rule = cfg.rules[i] as Record<string, unknown>;
    const prefix = `rules[${i}]`;
    if (typeof rule !== "object" || rule === null) {
      errors.push(`${prefix}: 必须是一个对象`);
      continue;
    }
    if (typeof rule.tool !== "string" || rule.tool.length === 0)
      errors.push(`${prefix}: tool 是必填的字符串字段`);
    if (!VALID_ACTIONS.includes(rule.action as PermissionAction))
      errors.push(
        `${prefix}: action 必须是 ${VALID_ACTIONS.join(" | ")}，收到: "${rule.action}"`,
      );
    if (
      rule.match !== undefined &&
      (typeof rule.match !== "object" || rule.match === null)
    )
      errors.push(`${prefix}: match 必须是一个对象`);
    if (rule.reason !== undefined && typeof rule.reason !== "string")
      warnings.push(`${prefix}: reason 应该是字符串`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function loadConfigFromFile(
  filePath: string,
): PermissionConfig | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parse(raw);
    const validation = validateConfig(parsed);
    if (!validation.valid) {
      console.error(`[ymp-permissions] 配置文件无效: ${filePath}`);
      for (const err of validation.errors) console.error(`  ✗ ${err}`);
      return undefined;
    }
    for (const warn of validation.warnings)
      console.warn(`[ymp-permissions] ${filePath}: ${warn}`);
    const cfg = parsed as Record<string, unknown>;
    return {
      version: 1,
      defaultAction: (cfg.defaultAction as PermissionAction) ?? "ask",
      rules: (cfg.rules as PermissionRule[]) ?? [],
    };
  } catch (err) {
    console.error(
      `[ymp-permissions] 无法解析 ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

export interface ConfigSet {
  project?: PermissionConfig;
  global?: PermissionConfig;
  default?: PermissionConfig;
}

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

export function watchConfigs(
  paths: { global: string; project: string },
  onChange: (configs: ConfigSet) => void,
): () => void {
  const filesToWatch = [paths.global, paths.project].filter((p) =>
    existsSync(p),
  );
  let debounceTimer: ReturnType<typeof setTimeout>;
  const handler = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const configs = loadAllConfigs({ ...paths, default: "" });
      onChange(configs);
    }, 100);
  };
  for (const file of filesToWatch) watchFile(file, { interval: 500 }, handler);
  return () => {
    clearTimeout(debounceTimer);
    for (const file of filesToWatch) unwatchFile(file, handler);
  };
}
```

---

### extensions/ext-permissions/index.ts

```typescript
/**
 * yes-my-pi 权限系统 - Pi 扩展入口
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
const MAX_ARGS_DISPLAY = 200;

function getConfigPaths() {
  return {
    default: join(__dirname, "permissions.default.yaml"),
    global: join(homedir(), ".pi", "agent", "permissions.yaml"),
    project: join(process.cwd(), ".pi", "permissions.yaml"),
  };
}

interface SessionOverrides {
  alwaysAllow: Set<string>;
  alwaysDeny: Set<string>;
}

let confirmQueue: Promise<unknown> = Promise.resolve();
function enqueueConfirm<T>(fn: () => Promise<T>): Promise<T> {
  const result = confirmQueue.then(fn, fn);
  confirmQueue = result.catch(() => {});
  return result;
}

export default function extPermissions(pi: ExtensionAPI): void {
  const paths = getConfigPaths();
  let configs: ConfigSet = loadAllConfigs(paths);
  const modeManager = new ModeManager("auto-edit");
  const overrides: SessionOverrides = {
    alwaysAllow: new Set(),
    alwaysDeny: new Set(),
  };
  const loggedUnknownTools = new Set<string>();

  // ── 生命周期 ──

  pi.on("session_start", (_event: unknown, ctx: any) => {
    updateStatus(ctx);
  });

  const stopWatching = watchConfigs(
    { global: paths.global, project: paths.project },
    (newConfigs) => {
      configs = { ...newConfigs, default: configs.default };
      emitOutput("[ymp] 权限配置已重新加载。");
    },
  );

  pi.on("session_shutdown", () => {
    stopWatching();
  });

  // ── tool_call 拦截器 ──

  pi.on("tool_call", async (event: any, ctx: any) => {
    const call: ToolCallInfo = {
      toolName: event.toolName,
      args: (event.args ?? {}) as Record<string, unknown>,
    };

    if (overrides.alwaysDeny.has(call.toolName)) {
      return {
        blocked: true,
        reason: `[ymp] 工具 "${call.toolName}" 在本会话中已被标记为始终拒绝。请调整方案。`,
      };
    }
    if (overrides.alwaysAllow.has(call.toolName)) return;

    const matchResult: MatchResult = evaluateToolCall(call, configs);

    const toolInfo = getToolInfo(call.toolName);
    if (
      toolInfo.category === "unknown" &&
      !toolInfo.builtin &&
      !loggedUnknownTools.has(call.toolName)
    ) {
      loggedUnknownTools.add(call.toolName);
      emitOutput(
        `[ymp] 检测到未分类工具 "${call.toolName}"（来自扩展）。默认需要确认。`,
      );
    }

    const finalAction = applyMode(modeManager.mode, matchResult.action);
    updateStatus(ctx);

    switch (finalAction) {
      case "allow":
        return;
      case "deny":
        return { blocked: true, reason: formatDenyReason(call, matchResult) };
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
              blocked: true,
              reason: `[ymp] 工具 "${call.toolName}" 已被标记为始终拒绝。`,
            };
          case "deny":
          default:
            return {
              blocked: true,
              reason: `[ymp] 用户拒绝了 ${call.toolName} 操作。请调整方案，不要重试。`,
            };
        }
      }
    }
  });

  // ── 用户确认 ──

  type UserDecision = "allow" | "deny" | "always-allow" | "always-deny";

  async function askUser(
    call: ToolCallInfo,
    match: MatchResult,
    ctx: any,
  ): Promise<UserDecision> {
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
          if (["allow", "deny", "always-allow", "always-deny"].includes(result))
            return result;
        }
      } catch {
        /* 降级 */
      }
      return "deny";
    });
  }

  // ── /mode 命令 ──

  pi.registerCommand("mode", {
    description: `切换审批模式 (${ALL_MODES.join(" | ")})`,
    handler: async (args: string, ctx: any) => {
      const target = args?.trim().toLowerCase();
      let output: string;

      if (!target) {
        const lines = ALL_MODES.map((m) => {
          const active = m === modeManager.mode;
          return `  ${active ? "●" : "○"} ${MODE_ICONS[m]} ${m}: ${MODE_DESCRIPTIONS[m]}${active ? " ← 当前" : ""}`;
        });
        output = [
          "审批模式:",
          ...lines,
          "",
          `用法: /mode <${ALL_MODES.join(" | ")}>`,
        ].join("\n");
      } else if (!ALL_MODES.includes(target as ApprovalMode)) {
        output = `❌ 无效模式 "${target}"。可选: ${ALL_MODES.join(" | ")}`;
      } else {
        modeManager.setMode(target as ApprovalMode);
        updateStatus(ctx);
        output = `✅ 审批模式已切换为: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}\n   ${MODE_DESCRIPTIONS[modeManager.mode]}`;
      }

      emitOutput(output, ctx);
      return output;
    },
  });

  // ── /permissions 命令 ──

  pi.registerCommand("permissions", {
    description: "查看当前权限规则与会话状态",
    handler: async (_args: string, ctx: any) => {
      const lines: string[] = [
        `模式: ${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`,
        `  ${MODE_DESCRIPTIONS[modeManager.mode]}`,
        "",
        "配置来源:",
        `  默认规则: ${configs.default ? `${configs.default.rules.length} 条` : "未加载"}`,
        `  全局规则: ${configs.global ? `${configs.global.rules.length} 条` : "无"} (${paths.global})`,
        `  项目规则: ${configs.project ? `${configs.project.rules.length} 条` : "无"} (${paths.project})`,
        "",
        "会话覆盖:",
      ];
      if (overrides.alwaysAllow.size > 0)
        lines.push(`  始终允许: ${[...overrides.alwaysAllow].join(", ")}`);
      if (overrides.alwaysDeny.size > 0)
        lines.push(`  始终拒绝: ${[...overrides.alwaysDeny].join(", ")}`);
      if (overrides.alwaysAllow.size === 0 && overrides.alwaysDeny.size === 0)
        lines.push("  无临时覆盖");
      if (loggedUnknownTools.size > 0) {
        lines.push("", `未分类工具: ${[...loggedUnknownTools].join(", ")}`);
      }
      const output = lines.join("\n");
      emitOutput(output, ctx);
      return output;
    },
  });

  // ── 输出通道 ──

  function emitOutput(text: string, ctx?: any): void {
    let emitted = false;
    try {
      if (ctx?.ui?.print) {
        ctx.ui.print(text);
        emitted = true;
      }
    } catch {}
    if (!emitted)
      try {
        if (typeof (pi as any).appendSystemMessage === "function") {
          (pi as any).appendSystemMessage(text);
          emitted = true;
        }
      } catch {}
    if (!emitted)
      try {
        if (typeof ctx?.print === "function") {
          ctx.print(text);
          emitted = true;
        }
      } catch {}
    if (!emitted) console.error(`\n${text}\n`);
  }

  // ── 状态栏 ──

  function updateStatus(ctx?: any): void {
    try {
      ctx?.ui?.setStatus?.(
        `${MODE_ICONS[modeManager.mode]} ${modeManager.mode}`,
      );
    } catch {}
  }

  // ── 辅助 ──

  function formatDenyReason(call: ToolCallInfo, match: MatchResult): string {
    return `[ymp] ${match.reason ?? `工具 "${call.toolName}" 被权限规则拒绝`}。请调整方案，不要重试。`;
  }

  function formatArgsSummary(call: ToolCallInfo): string {
    const args = call.args;
    let summary: string;
    if (call.toolName === "bash" && typeof args.command === "string") {
      summary = args.command;
    } else {
      const pathKey = ["path", "file", "filePath"].find(
        (k) => typeof args[k] === "string",
      );
      summary = pathKey
        ? String(args[pathKey])
        : (() => {
            try {
              return JSON.stringify(args);
            } catch {
              return String(args);
            }
          })();
    }
    return summary.length > MAX_ARGS_DISPLAY
      ? `${summary.slice(0, MAX_ARGS_DISPLAY)}… (${summary.length} chars)`
      : summary;
  }
}
```

---

### extensions/ext-permissions/permissions.default.yaml

```yaml
version: 1
defaultAction: ask

rules:
  - tool: read
    action: allow
  - tool: grep
    action: allow
  - tool: find
    action: allow
  - tool: ls
    action: allow

  - tool: write
    action: ask
    reason: "创建/覆写文件需要确认"
  - tool: edit
    action: ask
    reason: "编辑文件需要确认"

  - tool: bash
    match:
      command:
        - "npm test*"
        - "npm run test*"
        - "npm run lint*"
        - "npm run build*"
        - "npm run check*"
        - "npx vitest*"
        - "npx jest*"
        - "npx tsc*"
        - "npx eslint*"
        - "npx prettier*"
        - "pytest*"
        - "cargo test*"
        - "cargo build*"
        - "cargo clippy*"
        - "go test*"
        - "go build*"
        - "go vet*"
        - "make *"
        - "git status*"
        - "git log*"
        - "git diff*"
        - "git show*"
        - "git branch*"
        - "git stash list*"
    action: allow

  - tool: bash
    match:
      command:
        - "rm -rf /"
        - "rm -rf /*"
        - "rm -rf ~"
        - "sudo *"
        - "su *"
        - "curl * | bash*"
        - "curl * | sh*"
        - "wget * | bash*"
        - "chmod 777*"
        - "chmod -R 777*"
        - "dd if=*"
        - "mkfs*"
        - ":(){ :|:& };:*"
        - "> /dev/sda*"
        - "shutdown*"
        - "reboot*"
    action: deny
    reason: "高危命令，已被权限系统拦截"

  - tool: bash
    match:
      command:
        - "git commit*"
        - "git push*"
        - "git checkout*"
        - "git switch*"
        - "git merge*"
        - "git rebase*"
        - "git reset*"
    action: ask
    reason: "Git 写操作需要确认"

  - tool: bash
    match:
      command:
        - "npm install*"
        - "npm i *"
        - "npm ci*"
        - "npm uninstall*"
        - "yarn add*"
        - "yarn remove*"
        - "pnpm add*"
        - "pnpm remove*"
        - "pip install*"
        - "cargo install*"
    action: ask
    reason: "安装/卸载依赖需要确认"

  - tool: bash
    match:
      command:
        - "dir *"
        - "type *"
        - "Get-Content *"
        - "Get-ChildItem *"
        - "Get-Item *"
        - "Get-Location"
        - "Get-Command *"
        - "Write-Output *"
        - "Select-String *"
    action: allow

  - tool: bash
    match:
      command:
        - "format *"
        - "del /s /q *"
        - "rd /s /q *"
        - "Remove-Item -Recurse -Force C:*"
        - "diskpart*"
        - "reg delete *"
        - "Stop-Computer*"
        - "Restart-Computer*"
    action: deny
    reason: "Windows 高危命令，已被权限系统拦截"

  - tool: bash
    match:
      command:
        - "del *"
        - "erase *"
        - "move *"
        - "copy *"
        - "mkdir *"
        - "ren *"
        - "New-Item *"
        - "Remove-Item *"
        - "Move-Item *"
        - "Copy-Item *"
        - "Set-Content *"
        - "Add-Content *"
        - "Install-Module *"
    action: ask
    reason: "Windows 写操作需要确认"
```

---

### config/SYSTEM.md

```markdown
# yes-my-pi 行为准则

## 权限系统

你运行在 yes-my-pi 的权限控制下。部分工具调用会被拦截并等待用户审批。

- 当工具调用被拒绝时，**不要重试相同操作**，而是调整方案或向用户解释替代路径。
- 当工具调用需要审批时，耐心等待，不要催促或绕过。
- 优先使用只读工具（read、grep、find、ls）收集信息，减少需要审批的写操作次数。

## 工作流程

遵循「理解 → 规划 → 执行 → 验证」四步：

1. **理解**：用 grep / find / read 定位相关代码，理解上下文后再动手。
2. **规划**：涉及多文件修改时，先列出修改计划，等用户确认。
3. **执行**：用 edit（精确替换）而非 write（全量覆写）修改代码。
4. **验证**：修改后运行相关测试或构建命令，确认无回归。

## 工具使用优先级

| 优先级 | 工具        | 场景                     |
| ------ | ----------- | ------------------------ |
| 1      | grep / find | 定位文件和代码位置       |
| 2      | read        | 理解文件内容             |
| 3      | edit        | 精确修改已有代码         |
| 4      | write       | 仅在创建新文件时使用     |
| 5      | bash        | 运行测试、构建、git 操作 |

## 安全规则

- **永远不要**执行 rm -rf、sudo、curl | bash 等高危命令，除非用户明确要求。
- 修改配置文件（.env、package.json、tsconfig 等）前，先展示 diff 让用户确认。
- 不要修改 .git/ 目录下的任何内容。
- 不要在代码中硬编码密钥、密码、token。

## 输出风格

- 回复简洁，避免重复用户已知信息。
- 代码修改附带一句话说明改了什么、为什么。
- 遇到不确定的决策，主动询问而非猜测。
- 使用用户的语言回复。
```

---

### config/AGENTS.md

```markdown
# 项目规则

> 复制此模板到项目根目录，按实际情况修改。

## 项目概述

- 项目名称：
- 技术栈：
- 包管理器：
- 构建命令：
- 测试命令：
- Lint 命令：

## 代码规范

- 缩进：
- 命名风格：
- 文件组织：

## 测试要求

- 修改逻辑代码后必须运行测试
- 新增功能必须附带测试

## Git 规范

- 提交信息格式：type(scope): description
- 允许的 type：feat / fix / refactor / test / docs / chore

## 禁止操作

- 不要修改 package-lock.json
- 不要删除测试文件
- 不要修改 CI/CD 配置
- 不要引入新的外部依赖（除非明确要求）
```

---

### config/settings.default.json

```json
{
  "version": 1,
  "approval": {
    "defaultMode": "auto-edit"
  },
  "permissions": {
    "rulesFile": "permissions.default.yaml",
    "sessionOverrides": true
  },
  "identity": {
    "name": "yes-my-pi",
    "alias": "ymp"
  }
}
```

---

### package.json（根目录）

```json
{
  "name": "yes-my-pi",
  "version": "0.1.0",
  "description": "基于 Pi 构建的可控 AI 编程智能体",
  "type": "module",
  "bin": {
    "ymp": "./bin/ymp.js",
    "yes-my-pi": "./bin/ymp.js"
  },
  "scripts": {
    "start": "node bin/ymp.js",
    "dev": "node --watch bin/ymp.js"
  },
  "dependencies": {
    "@earendil-works/pi-ai": "^0.80.10",
    "@earendil-works/pi-agent-core": "^0.80.10",
    "@earendil-works/pi-coding-agent": "^0.80.10",
    "@earendil-works/pi-tui": "^0.80.10"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "license": "MIT"
}
```

---

## 优化清单（按优先级）

### P0：必须修复

#### 1. 修复命令输出（BUG-001）

`/mode` 和 `/permissions` 命令执行后无视觉反馈。

**诊断方法**：在 handler 开头写文件 dump ctx 和 pi 的 API：

```typescript
import { writeFileSync } from "node:fs";
writeFileSync(
  "ymp-ctx-dump.json",
  JSON.stringify(
    {
      ctx_proto: Object.getOwnPropertyNames(Object.getPrototypeOf(ctx || {})),
      ctx_own: Object.keys(ctx || {}),
      ctx_ui_proto: ctx?.ui
        ? Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.ui))
        : [],
      ctx_ui_own: ctx?.ui ? Object.keys(ctx.ui) : [],
      pi_keys: Object.keys(pi),
    },
    null,
    2,
  ),
);
```

运行 `/mode`，读取 dump 文件，找到正确的输出方法，替换 `emitOutput` 中的通道。

Pi 导出了以下 UI 组件（可能需要用这些来渲染输出）：
`CustomMessageComponent, ExtensionInputComponent, ExtensionSelectorComponent, ExtensionEditorComponent`

#### 2. 修复确认框（BUG-002）

`ctx.ui.confirm()` 的签名是猜测的。同样通过 dump 诊断。

如果 Pi 不提供 confirm API，降级方案：

- 直接 block 工具调用，reason 中提示用户：
  `"需要确认。输入 /mode full-auto 跳过确认，或在 .pi/permissions.yaml 中添加 allow 规则。"`
- 或注册 `/allow <tool>` 和 `/deny <tool>` 命令作为替代

### P1：应该修复

#### 3. loader.ts watchConfigs 的 default 路径问题

`watchConfigs` 回调中 `loadAllConfigs({ ...paths, default: "" })` 传了空字符串作为 default 路径，会导致 default 配置丢失。应改为只重新加载 global 和 project，保留原有 default。

#### 4. bash-analyzer 的 node/python 误判

`node ` 和 `python ` 在 WRITE_COMMANDS 中，但 `node -v`、`node --version` 在 READ_ONLY_COMMANDS 中。由于 READ_ONLY 先匹配，`node -v` 正确。但 `node script.js` 被归为 write，这可能过于严格。考虑：

- `node -e "console.log(1)"` → 无副作用，但被归为 write
- 建议：将 `node ` 和 `python ` 从 WRITE_COMMANDS 移到 unknown，让规则引擎的 defaultAction 处理

#### 5. 规则匹配性能

当前每次 tool_call 都遍历所有规则。规则数量少时无问题，但建议：

- 按 tool name 建立索引（Map<string, PermissionRule[]>）
- 缓存相同 tool+args 的匹配结果（会话内）

### P2：体验优化

#### 6. /mode 支持无参数循环切换

当前 `/mode` 无参数显示列表。考虑增加 `/mode next` 循环切换。

#### 7. 确认框超时

当前确认框无超时。如果用户离开，agent 会一直等待。考虑 60 秒超时自动拒绝。

#### 8. 错误信息国际化

当前错误信息混合中英文。统一为中文或根据用户语言切换。

#### 9. permissions.example.yaml 增加更多示例

补充常见场景：Docker 命令、数据库命令、部署命令等。

### P3：代码质量

#### 10. 类型安全

- `ctx: any` 应定义接口（待诊断后确认实际 API）
- `event: any` 应使用 Pi 导出的类型（如果有）

#### 11. 单元测试

为以下纯函数编写测试：

- `matchPattern()`
- `classifyBashCommand()`
- `splitCommandSegments()`
- `extractNestedCommands()`
- `applyMode()`
- `evaluateToolCall()`
- `validateConfig()`

#### 12. 日志系统

当前用 `console.error` 输出日志。应改为：

- 写入 `~/.pi/agent/ymp-permissions.log`
- 受 `YMP_DEBUG` 环境变量控制
- 不污染 TUI 输出

---

## 测试清单

修复完成后，逐项验证：

| #   | 场景                                 | 预期                   |
| --- | ------------------------------------ | ---------------------- |
| 1   | `/mode`                              | 显示三种模式列表       |
| 2   | `/mode suggest`                      | 切换成功 + 视觉提示    |
| 3   | `/permissions`                       | 显示规则统计           |
| 4   | suggest 下 read                      | 弹出确认（或降级提示） |
| 5   | auto-edit 下 read                    | 自动放行               |
| 6   | auto-edit 下 write                   | 弹出确认（或降级提示） |
| 7   | full-auto 下 write                   | 自动放行               |
| 8   | 任何模式下 `rm -rf /`                | 强制拒绝               |
| 9   | 任何模式下 `sudo *`                  | 强制拒绝               |
| 10  | `echo "a \| b"`                      | 识别为 read            |
| 11  | `bash -c "rm -rf /"`                 | 识别为 dangerous       |
| 12  | `FOO=bar cat file`                   | 识别为 read            |
| 13  | `find . -exec rm {} \;`              | 识别为 write           |
| 14  | `dir`（Windows）                     | 放行                   |
| 15  | `Remove-Item file`（Windows）        | 需确认                 |
| 16  | `format C:`（Windows）               | 强制拒绝               |
| 17  | 扩展注册的未知工具                   | 需确认 + 日志          |
| 18  | `ymp -ne`（无扩展启动）              | 正常，无拦截           |
| 19  | `ymp --version`                      | 显示版本               |
| 20  | 修改 `.pi/permissions.yaml` 后不重启 | 热更新生效             |

---

## 约束

- **不修改** `node_modules/@earendil-works/` 下的任何文件
- **不修改** Pi 的 `package.json` 中的 `piConfig`
- 所有修改仅在 yes-my-pi 自己的文件中进行
- 保持 `"type": "module"`（ESM）
- TypeScript 文件由 Pi 的 jiti 运行时加载，无需编译步骤
- 运行环境：Windows PowerShell，Node.js v24.16.0
