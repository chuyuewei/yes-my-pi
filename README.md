# yes-my-pi

基于 [Pi](https://github.com/earendil-works/pi) 构建的可控 AI 编程智能体。

Pi 是引擎，yes-my-pi 是产品层。不修改 Pi 一行源码，全部通过扩展系统实现。

[![Quality gate status](https://sonarcloud.io/api/project_badges/measure?project=chuyuewei_yes-my-pi&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=chuyuewei_yes-my-pi)

```
npm install -g yes-my-pi
ymp
```

---

## 为什么需要 yes-my-pi

Pi 是一个极简的终端 AI 编程代理，设计哲学是「原语而非功能」——它**不内置权限系统**，默认以启动用户的权限全自动执行所有操作。

yes-my-pi 在 Pi 之上补上了这一层：

- **三级审批模式**（+ 一个无限制模式），控制 AI 的自主程度
- **YAML 权限规则**，按工具 + 参数精细控制 allow / deny / ask
- **bash 命令分类器**，自动识别只读 / 写操作 / 危险命令
- **会话级覆盖**，临时允许或拒绝某个工具
- **配置热更新**，修改规则文件无需重启

---

## 审批模式

| 模式            | 只读操作 | 写操作 | 危险命令     | 适用场景           |
| --------------- | -------- | ------ | ------------ | ------------------ |
| 🔒 `suggest`    | 需确认   | 需确认 | **强制拒绝** | 初次使用、代码审查 |
| 🔓 `auto-edit`  | 自动     | 需确认 | **强制拒绝** | 日常开发（默认）   |
| ⚡ `full-auto`  | 自动     | 自动   | **强制拒绝** | 信任环境、CI       |
| 🚨 `always-yes` | 自动     | 自动   | **也自动**   | 完全信任、沙箱内   |

切换模式：

```
/mode suggest
/mode auto-edit
/mode full-auto
/mode always-yes    ← 需要二次确认
```

> ⚠️ `always-yes` 会覆盖所有 deny 规则（包括 `rm -rf /`）。仅在沙箱或完全信任的环境中使用。激活时需要输入确认。

> 🔒 在 `suggest` / `auto-edit` / `full-auto` 三种模式下，危险命令（`rm -rf /`、`sudo`、`curl|bash` 等）**任何情况下都不可执行**。

---

## 安装

### 前置条件

- Node.js >= 22.19.0
- 已安装 Pi 的 API Key（Anthropic / OpenAI / 其他提供商）

### 从 npm 安装

```bash
npm install -g yes-my-pi
```

### 从源码安装

```bash
git clone https://github.com/chuyuewei/yes-my-pi.git
cd yes-my-pi
npm install --ignore-scripts
npm link
```

### 验证

```bash
ymp --version
```

---

## 快速开始

```bash
# 进入你的项目目录
cd your-project

# 启动 yes-my-pi
ymp

# 在交互界面中：
#   /mode              查看当前模式
#   /mode suggest      切换到最严格模式
#   /permissions       查看权限规则状态
#   /help              查看所有命令
```

---

## 权限配置

### 规则文件位置

| 作用域   | 路径                             | 优先级 |
| -------- | -------------------------------- | ------ |
| 项目级   | `<project>/.pi/permissions.yaml` | 最高   |
| 全局级   | `~/.pi/agent/permissions.yaml`   | 中     |
| 出厂默认 | 包内 `permissions.default.yaml`  | 最低   |

项目级规则覆盖全局级，全局级覆盖出厂默认。

### 规则格式

```yaml
version: 1
defaultAction: ask # 无规则命中时的兜底动作

rules:
  # 只读工具：始终放行
  - tool: read
    action: allow
  - tool: grep
    action: allow

  # 写工具：需要确认
  - tool: write
    action: ask
    reason: "创建/覆写文件需要确认"

  # bash：按命令模式匹配
  - tool: bash
    match:
      command: "npm test*" # 前缀通配
    action: allow

  # 危险命令：强制拒绝
  - tool: bash
    match:
      command: "rm -rf /"
    action: deny
    reason: "高危命令"

  # 按文件路径匹配
  - tool: write
    match:
      path: ".env.production"
    action: deny
    reason: "生产配置不允许修改"

  # 通配所有工具
  - tool: "*"
    match:
      args:
        target: "production*"
    action: ask
    reason: "生产环境操作需确认"
```

### 模式匹配语法

| 语法      | 含义                | 示例                                     |
| --------- | ------------------- | ---------------------------------------- |
| `*`       | 匹配所有            | `tool: "*"`                              |
| `prefix*` | 前缀通配            | `"npm test*"` 匹配 `npm test -- --watch` |
| `**`      | 路径 glob（跨目录） | `"src/**/*.ts"`                          |
| 无通配符  | 精确匹配或前缀匹配  | `"git status"`                           |

### 动作优先级

```
deny > ask > allow
```

同一作用域内，最严格的规则生效。跨作用域取最严格结果。

---

## bash 命令分类器

对于 `bash` 工具，yes-my-pi 内置了一个命令分类器，自动判断命令的安全级别：

| 分类   | 默认动作 | 示例                                          |
| ------ | -------- | --------------------------------------------- |
| 只读   | allow    | `cat`、`grep`、`git status`、`npm test`       |
| 写操作 | ask      | `rm`、`git commit`、`npm install`、`mkdir`    |
| 危险   | deny     | `rm -rf /`、`sudo`、`curl\|bash`、`format C:` |
| 未知   | ask      | 无法判断的命令，安全优先                      |

分类器支持：

- **引号感知拆分**：`echo "a | b" | grep a` 正确识别为只读
- **嵌套命令检测**：`bash -c "rm -rf /"`、`$(rm file)`、`` `rm file` ``
- **环境变量前缀剥离**：`FOO=bar cat file` 正确识别为只读
- **find -exec / xargs 检测**：`find . -exec rm {} \;` 识别为写操作
- **重定向检测**：`echo hi > file.txt` 识别为写操作
- **Windows 命令**：`dir`、`Get-ChildItem`、`Remove-Item`、`format` 等

---

## 命令

| 命令           | 说明                               |
| -------------- | ---------------------------------- |
| `/mode`        | 显示当前审批模式                   |
| `/mode <name>` | 切换审批模式                       |
| `/permissions` | 查看规则统计、会话覆盖、未分类工具 |

### 确认框选项

当工具调用需要确认时，可选择：

| 按键 | 说明                 |
| ---- | -------------------- |
| `y`  | 允许本次             |
| `n`  | 拒绝本次             |
| `a`  | 本会话始终允许此工具 |
| `d`  | 本会话始终拒绝此工具 |

---

## 项目配置模板

yes-my-pi 提供两个配置模板，复制到项目根目录即可生效（Pi 原生读取）：

```bash
# 从 yes-my-pi 包复制模板
cp node_modules/yes-my-pi/config/SYSTEM.md ./SYSTEM.md
cp node_modules/yes-my-pi/config/AGENTS.md ./AGENTS.md
```

| 文件        | 用途                                        |
| ----------- | ------------------------------------------- |
| `SYSTEM.md` | AI 行为准则：工作流程、工具优先级、安全规则 |
| `AGENTS.md` | 项目级规则：代码规范、测试要求、禁止操作    |

---

## 项目结构

```
yes-my-pi/
├── bin/
│   └── ymp.js                          # CLI 入口（包装 Pi main()）
├── extensions/
│   └── ext-permissions/                # 权限扩展
│       ├── index.ts                    # 扩展入口（tool_call 拦截器）
│       ├── package.json
│       ├── permissions.default.yaml    # 出厂默认规则
│       ├── permissions.example.yaml    # 带注释的规则示例
│       └── src/
│           ├── types.ts                # 数据模型
│           ├── matcher.ts              # 规则匹配引擎
│           ├── bash-analyzer.ts        # bash 命令分类器（v2）
│           ├── tool-registry.ts        # 工具分类注册表
│           ├── loader.ts               # YAML 加载 / 校验 / 热更新
│           └── mode.ts                 # 审批模式状态机
├── config/                             # 配置模板
│   ├── SYSTEM.md                       # AI 行为准则
│   ├── AGENTS.md                       # 项目规则模板
│   ├── settings.default.json           # 默认设置
│   └── README.md                       # 模板使用说明
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

---

## 与 Pi 的关系

```
┌─────────────────────────────────────────────┐
│  yes-my-pi（产品层）                         │
│  权限系统 / 审批模式 / 命令 / 配置模板        │
├─────────────────────────────────────────────┤
│  Pi（引擎层）                                │
│  Agent 循环 / 工具 / 会话 / TUI / 多模型      │
│  @earendil-works/pi-coding-agent v0.80.10   │
└─────────────────────────────────────────────┘
```

- Pi 是上游 npm 依赖，**不是 fork**
- yes-my-pi 不修改 Pi 源码
- Pi 更新 = `npm update`，零冲突
- 所有定制通过 Pi 的扩展系统实现
- 卸载 yes-my-pi 后，Pi 仍可独立使用

这种模式类似于 Paper 之于 Minecraft：上游是依赖，不是副本。

---

## 开发

```bash
# 安装依赖
npm install --ignore-scripts

# 启动（开发模式）
npm run dev

# 同步扩展到 Pi 配置目录
# Windows PowerShell:
Remove-Item .pi\extensions\yes-my-pi-permissions -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item extensions\ext-permissions .pi\extensions\yes-my-pi-permissions -Recurse -Force

# 启动测试
node bin/ymp.js

# 调试模式（显示完整错误堆栈）
$env:YMP_DEBUG = "1"
node bin/ymp.js
```

---

## 路线图

- [x] Phase 1：权限系统（审批模式 + 规则引擎 + bash 分类器）
- [ ] Phase 2：计划模式 / Git 工具集 / 多文件编辑
- [ ] Phase 3：子代理 / MCP 桥接 / 技能包
- [ ] Phase 4：沙箱执行 / 发布

---

## 致谢

基于 [Pi](https://github.com/earendil-works/pi)（MIT）构建。
Copyright (c) Earendil Works / Mario Zechner

Pi 是一个极简的、自我扩展的终端 AI 编程代理，支持 15+ 模型提供商。
了解更多：[pi.dev](https://pi.dev)

---

## 许可证

MIT

Copyright (c) 2026 Earendil Works (Pi)
Copyright (c) 2026 <Your Name> (yes-my-pi)
