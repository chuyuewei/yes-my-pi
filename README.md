# yes-my-pi

> 基于 [Pi](https://github.com/earendil-works/pi) 构建的可控 AI 编程智能体。

Pi 是引擎，yes-my-pi 是产品层。  
yes-my-pi 不修改 Pi 一行源码，全部通过 Pi 的扩展系统实现权限管控与审批流程。

[![Quality gate](https://sonarcloud.io/api/project_badges/quality_gate?project=chuyuewei_yes-my-pi)](https://sonarcloud.io/summary/new_code?id=chuyuewei_yes-my-pi)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```bash
npm install -g yes-my-pi
ymp
```

---

## 目录

- [为什么需要 yes-my-pi](#为什么需要-yes-my-pi)
- [核心能力](#核心能力)
- [审批模式](#审批模式)
- [安装](#安装)
- [快速开始](#快速开始)
- [权限配置](#权限配置)
- [bash 命令分类器](#bash-命令分类器)
- [命令](#命令)
- [项目配置模板](#项目配置模板)
- [项目结构](#项目结构)
- [与 Pi 的关系](#与-pi-的关系)
- [开发](#开发)
- [路线图](#路线图)
- [FAQ](#faq)
- [致谢](#致谢)
- [许可证](#许可证)

---

## 为什么需要 yes-my-pi

[Pi](https://github.com/earendil-works/pi) 是一个极简的终端 AI 编程代理，设计哲学是「原语而非功能」。

这意味着 Pi 本身**不内置权限系统**，默认会以启动用户的权限自动执行工具调用和命令。

在日常开发中，这可能带来风险，例如：

- AI 自动修改关键文件
- AI 执行 `rm`、`sudo`、`curl | bash` 等高风险命令
- AI 修改 `.env.production`、部署配置等敏感文件
- AI 在未确认的情况下执行写操作、安装依赖、提交代码

yes-my-pi 在 Pi 之上补上了这一层安全网：

> **Pi 负责干活，yes-my-pi 负责把关。**

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 🎚️ 四级审批模式 | 从全程确认到完全自动，按场景控制 AI 自主程度 |
| 📐 YAML 权限规则 | 按工具、命令、路径、参数精细控制 `allow` / `deny` / `ask` |
| 🔍 bash 命令分类器 | 自动识别只读、写操作、危险命令 |
| ⏱️ 会话级覆盖 | 临时允许或拒绝某个工具，不污染配置文件 |
| 🔄 配置热更新 | 修改权限规则后无需重启 |
| 🧩 非侵入式扩展 | 不 fork、不 patch Pi，通过扩展系统实现 |

---

## 审批模式

| 模式 | 只读操作 | 写操作 | 危险命令 | 适用场景 |
| --- | --- | --- | --- | --- |
| 🔒 `suggest` | 需确认 | 需确认 | **强制拒绝** | 初次使用、代码审查 |
| 🔓 `auto-edit` | 自动 | 需确认 | **强制拒绝** | 日常开发，默认模式 |
| ⚡ `full-auto` | 自动 | 自动 | **强制拒绝** | 信任环境、CI |
| 🚨 `always-yes` | 自动 | 自动 | **也自动** | 完全信任环境、沙箱内 |

切换模式：

```text
/mode suggest
/mode auto-edit
/mode full-auto
/mode always-yes
```

> ⚠️ `always-yes` 会覆盖所有 `deny` 规则，包括类似 `rm -rf /` 的危险命令。  
> 仅建议在沙箱、临时容器或完全可信环境中使用。启用时需要二次确认。

> 🔒 在 `suggest` / `auto-edit` / `full-auto` 三种模式下，危险命令会被强制拒绝，任何权限规则都不能放行。

---

## 安装

### 前置条件

- Node.js >= 22.19.0
- 已配置 Pi 所需的 API Key，例如 Anthropic、OpenAI 或其他模型提供商

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

### 验证安装

```bash
ymp --version
```

---

## 快速开始

进入你的项目目录：

```bash
cd your-project
```

启动 yes-my-pi：

```bash
ymp
```

在交互界面中可以使用：

```text
/mode
/mode suggest
/mode auto-edit
/mode full-auto
/permissions
/help
```

常用命令说明：

| 命令 | 说明 |
| --- | --- |
| `/mode` | 查看当前审批模式 |
| `/mode suggest` | 切换到最严格模式 |
| `/mode auto-edit` | 切换到日常开发模式 |
| `/mode full-auto` | 切换到自动编辑模式 |
| `/mode always-yes` | 切换到无限制模式，需要二次确认 |
| `/permissions` | 查看权限规则、会话覆盖、未分类工具 |
| `/help` | 查看所有命令 |

---

## 权限配置

### 规则文件位置

yes-my-pi 会按以下顺序加载权限规则：

| 作用域 | 路径 | 优先级 |
| --- | --- | --- |
| 项目级 | `<project>/.pi/permissions.yaml` | 最高 |
| 全局级 | `~/.pi/agent/permissions.yaml` | 中 |
| 出厂默认 | 包内 `permissions.default.yaml` | 最低 |

项目级规则覆盖全局级，全局级规则覆盖出厂默认。

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
    reason: "创建或覆写文件需要确认"

  # bash：按命令模式匹配
  - tool: bash
    match:
      command: "npm test*"
    action: allow
    reason: "允许自动运行测试"

  # 危险命令：拒绝
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
    reason: "生产环境配置不允许修改"

  # 通配所有工具
  - tool: "*"
    match:
      args:
        target: "production*"
    action: ask
    reason: "生产环境操作需要确认"
```

### 动作说明

| 动作 | 含义 |
| --- | --- |
| `allow` | 允许执行 |
| `ask` | 执行前询问用户 |
| `deny` | 拒绝执行 |

### 模式匹配语法

| 语法 | 含义 | 示例 |
| --- | --- | --- |
| `*` | 匹配所有 | `tool: "*"` |
| `prefix*` | 前缀通配 | `"npm test*"` 匹配 `npm test -- --watch` |
| `**` | 路径 glob，支持跨目录 | `"src/**/*.ts"` |
| 无通配符 | 精确匹配或前缀匹配 | `"git status"` |

### 动作优先级

```text
deny > ask > allow
```

当多条规则同时命中时，采用更严格的动作。

例如：

- 同时命中 `allow` 和 `ask`，结果为 `ask`
- 同时命中 `ask` 和 `deny`，结果为 `deny`
- 同时命中 `allow` 和 `deny`，结果为 `deny`

---

## bash 命令分类器

对于 `bash` 工具，yes-my-pi 内置了命令分类器，可以自动判断命令安全级别。

| 分类 | 默认动作 | 示例 |
| --- | --- | --- |
| 只读 | `allow` | `cat`、`grep`、`git status`、`npm test` |
| 写操作 | `ask` | `rm`、`git commit`、`npm install`、`mkdir` |
| 危险 | `deny` | `rm -rf /`、`sudo`、`curl \| bash`、`format C:` |
| 未知 | `ask` | 无法判断的命令，安全优先 |

分类器支持：

- **引号感知拆分**  
  `echo "a | b" | grep a` 会被正确识别为只读命令。

- **嵌套命令检测**  
  `bash -c "rm -rf /"`、`$(rm file)`、`` `rm file` `` 会被识别为风险命令。

- **环境变量前缀剥离**  
  `FOO=bar cat file` 会被正确识别为只读命令。

- **find -exec / xargs 检测**  
  `find . -exec rm {} \;` 会被识别为写操作。

- **重定向检测**  
  `echo hi > file.txt` 会被识别为写操作。

- **Windows 命令检测**  
  支持 `dir`、`Get-ChildItem`、`Remove-Item`、`format` 等命令识别。

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `/mode` | 显示当前审批模式 |
| `/mode <name>` | 切换审批模式 |
| `/permissions` | 查看规则统计、会话覆盖、未分类工具 |

### 确认框选项

当工具调用需要确认时，可选择：

| 按键 | 说明 |
| --- | --- |
| `y` | 允许本次 |
| `n` | 拒绝本次 |
| `a` | 本会话始终允许此工具 |
| `d` | 本会话始终拒绝此工具 |

会话级覆盖只在当前会话中生效，不会写入配置文件。

---

## 项目配置模板

yes-my-pi 提供两个配置模板，可以复制到项目根目录中使用。

| 文件 | 用途 |
| --- | --- |
| `SYSTEM.md` | AI 行为准则：工作流程、工具优先级、安全规则 |
| `AGENTS.md` | 项目级规则：代码规范、测试要求、禁止操作 |

### macOS / Linux

```bash
PKG_DIR="$(npm root -g)/yes-my-pi"

cp "$PKG_DIR/config/SYSTEM.md" ./SYSTEM.md
cp "$PKG_DIR/config/AGENTS.md" ./AGENTS.md
```

### Windows PowerShell

```powershell
$pkg = Join-Path (npm root -g) "yes-my-pi"

Copy-Item "$pkg\config\SYSTEM.md" .\SYSTEM.md
Copy-Item "$pkg\config\AGENTS.md" .\AGENTS.md
```

复制完成后，Pi 会原生读取这些配置文件。

---

## 项目结构

```text
yes-my-pi/
├── bin/
│   └── ymp.js                          # CLI 入口，包装 Pi main()
├── extensions/
│   └── ext-permissions/                # 权限扩展
│       ├── index.ts                    # 扩展入口，tool_call 拦截器
│       ├── package.json
│       ├── permissions.default.yaml    # 出厂默认规则
│       ├── permissions.example.yaml    # 带注释的规则示例
│       └── src/
│           ├── types.ts                # 数据模型
│           ├── matcher.ts              # 规则匹配引擎
│           ├── bash-analyzer.ts        # bash 命令分类器
│           ├── tool-registry.ts        # 工具分类注册表
│           ├── loader.ts               # YAML 加载、校验、热更新
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

```text
┌─────────────────────────────────────────────┐
│  yes-my-pi（产品层）                         │
│  权限系统 / 审批模式 / 命令 / 配置模板        │
├─────────────────────────────────────────────┤
│  Pi（引擎层）                                │
│  Agent 循环 / 工具 / 会话 / TUI / 多模型      │
│  @earendil-works/pi-coding-agent             │
└─────────────────────────────────────────────┘
```

- Pi 是上游 npm 依赖，**不是 fork**
- yes-my-pi 不修改 Pi 源码
- 所有定制都通过 Pi 的扩展系统实现
- Pi 更新时不需要手动合并源码
- 卸载 yes-my-pi 后，Pi 仍可独立使用

这种模式类似于 Paper 之于 Minecraft：上游是依赖，不是副本。

---

## 开发

### 安装依赖

```bash
npm install --ignore-scripts
```

### 启动开发模式

```bash
npm run dev
```

### 同步扩展到 Pi 配置目录

#### macOS / Linux

```bash
rm -rf .pi/extensions/yes-my-pi-permissions
cp -r extensions/ext-permissions .pi/extensions/yes-my-pi-permissions
```

#### Windows PowerShell

```powershell
Remove-Item .pi\extensions\yes-my-pi-permissions -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item extensions\ext-permissions .pi\extensions\yes-my-pi-permissions -Recurse -Force
```

### 启动测试

```bash
node bin/ymp.js
```

### 调试模式

#### macOS / Linux

```bash
export YMP_DEBUG=1
node bin/ymp.js
```

#### Windows PowerShell

```powershell
$env:YMP_DEBUG = "1"
node bin/ymp.js
```

---

## 路线图

- [x] Phase 1：权限系统
  - [x] 审批模式
  - [x] YAML 规则引擎
  - [x] bash 命令分类器
  - [x] 配置热更新
- [ ] Phase 2：增强开发体验
  - [ ] 计划模式
  - [ ] Git 工具集
  - [ ] 多文件编辑
- [ ] Phase 3：扩展生态
  - [ ] 子代理
  - [ ] MCP 桥接
  - [ ] 技能包
- [ ] Phase 4：安全执行环境
  - [ ] 沙箱执行
  - [ ] 发布流程完善

欢迎通过 [Issues](https://github.com/chuyuewei/yes-my-pi/issues) 提交建议、问题或 PR。

---

## FAQ

### yes-my-pi 是 Pi 的 fork 吗？

不是。

yes-my-pi 把 Pi 当作上游 npm 依赖使用，不修改 Pi 源码，所有能力都通过 Pi 的扩展系统实现。

### yes-my-pi 会影响 Pi 的更新吗？

不会。

Pi 可以正常通过 npm 更新，yes-my-pi 不需要合并上游源码。

### yes-my-pi 会拖慢执行速度吗？

权限判断在本地完成，通常开销很小，可以忽略不计。

### 规则冲突时如何判断？

遵循：

```text
deny > ask > allow
```

也就是说，只要有更严格的规则命中，就会采用更严格的动作。

### 为什么 `always-yes` 还需要二次确认？

因为 `always-yes` 会绕过所有拒绝规则，包括危险命令。  
为了避免误触，启用该模式时需要用户二次确认。

### 我可以只使用 Pi 吗？

可以。

yes-my-pi 是 Pi 之上的产品层和安全层。卸载 yes-my-pi 后，Pi 仍然可以独立使用。

---

## 致谢

yes-my-pi 基于 [Pi](https://github.com/earendil-works/pi) 构建。

Pi 是一个极简的、自我扩展的终端 AI 编程代理，支持多个模型提供商。

了解更多：

- [Pi GitHub](https://github.com/earendil-works/pi)
- [pi.dev](https://pi.dev)

Copyright (c) Earendil Works / Mario Zechner

---

## 许可证

[MIT](./LICENSE)

Copyright (c) 2026 Earendil Works (Pi)  
Copyright (c) 2026 chuyuewei (yes-my-pi)
