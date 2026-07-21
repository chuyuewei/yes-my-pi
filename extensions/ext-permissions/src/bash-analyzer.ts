/**
 * yes-my-pi 权限系统 - bash 命令分类器（v2 加固版）
 *
 * v2 改进：
 *   - 引号内的管道/链式操作符不再误拆分
 *   - 检测命令替换 $() 和反引号
 *   - 检测 env 变量前缀 (FOO=bar cmd)
 *   - 检测 find -exec / xargs 嵌套命令
 *   - 检测 bash -c / sh -c 嵌套命令
 *   - 新增 Windows PowerShell / cmd.exe 命令分类
 *   - 脚本执行 (node -e, python -c) 归类为 write
 */

export type BashCommandClass = "read" | "write" | "dangerous" | "unknown";

// ── 只读命令白名单 ────────────────────────────────────────

const READ_ONLY_COMMANDS: string[] = [
  // 文件查看
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
  // 目录
  "ls ",
  "ll ",
  "dir ",
  "tree ",
  "pwd",
  // 搜索
  "grep ",
  "egrep ",
  "fgrep ",
  "rg ",
  "ag ",
  "find ",
  "fd ",
  "locate ",
  // 系统信息
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
  // 文本处理（只读用法）
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
  // 版本查询
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
  // Git 只读
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
  // 测试/构建（只读验证）
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
  // 其他
  "test ",
  "[ ",
  "true",
  "false",
  "sleep ", // 无副作用
];

// ── 危险命令黑名单 ────────────────────────────────────────

const DANGEROUS_COMMANDS: string[] = [
  // 文件系统破坏
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf .",
  "rm -rf ./",
  "rm -rf ..",
  "rm -rf ../",
  // 权限提升
  "sudo ",
  "su ",
  "doas ",
  // 远程代码执行
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
  // 权限破坏
  "chmod 777",
  "chmod -R 777",
  "chown -R",
  // 磁盘破坏
  "dd if=",
  "mkfs",
  "fdisk",
  "parted ",
  // Fork bomb
  ":(){ :|:& };:",
  // 设备覆写
  "> /dev/sda",
  "> /dev/nvme",
  "> /dev/disk",
  // 系统控制
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  // 进程破坏
  "kill -9 1",
  "killall",
  // 防火墙
  "iptables",
  "ufw ",
  "nft ",
  // 服务控制
  "systemctl stop",
  "systemctl disable",
  "service stop",
  // Windows 危险命令
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

// ── 写操作命令 ────────────────────────────────────────────

const WRITE_COMMANDS: string[] = [
  // 文件操作
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
  // Git 写操作
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
  // 包管理
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
  // 构建
  "make ",
  "cmake ",
  "gradle ",
  "mvn ",
  "tsc ",
  "webpack ",
  "vite build",
  "rollup ",
  // 容器/部署
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
  // 下载
  "wget ",
  "curl -o ",
  "curl -O ",
  "scp ",
  "rsync ",
  // 压缩
  "tar ",
  "zip ",
  "unzip ",
  "gzip ",
  "gunzip ",
  // 原地编辑
  "sed -i",
  "perl -i",
  "patch ",
  // 脚本执行（可能有副作用）
  "node ",
  "python ",
  "python3 ",
  "ruby ",
  "perl ",
  "php ",
  "bash ",
  "sh ",
  "zsh ",
  // Windows 写操作
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

// ── 引号感知的命令拆分 ────────────────────────────────────

/**
 * 将命令按管道/链式操作符拆分，但忽略引号内的操作符
 *
 * 'cat "a|b.txt" | grep foo && echo "x;y"'
 * → ['cat "a|b.txt"', 'grep foo', 'echo "x;y"']
 */
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

    // 不在引号内时，检测操作符
    if (!inSingle && !inDouble) {
      // ||
      if (ch === "|" && command[i + 1] === "|") {
        segments.push(current.trim());
        current = "";
        i++; // 跳过第二个 |
        continue;
      }
      // |（管道）
      if (ch === "|") {
        segments.push(current.trim());
        current = "";
        continue;
      }
      // &&
      if (ch === "&" && command[i + 1] === "&") {
        segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      // ;
      if (ch === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments.filter((s) => s.length > 0);
}

// ── 嵌套命令检测 ──────────────────────────────────────────

/**
 * 提取嵌套命令（命令替换、子 shell、-c 参数等）
 *
 * "echo $(rm -rf /)"       → ["rm -rf /"]
 * "bash -c 'rm -rf /'"     → ["rm -rf /"]
 * "find . -exec rm {} \;"  → ["rm {}"]
 * "xargs rm"               → ["rm"]（xargs 后的命令）
 */
export function extractNestedCommands(command: string): string[] {
  const nested: string[] = [];

  // $() 命令替换
  const cmdSubstRegex = /\$\(([^)]+)\)/g;
  let match;
  while ((match = cmdSubstRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  // 反引号命令替换
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  // bash -c / sh -c / zsh -c
  const shellCRegex =
    /(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-\w+\s+)*-c\s+["']?([^"']+)["']?/gi;
  while ((match = shellCRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  // find -exec
  const findExecRegex = /-exec\s+(.+?)(?:\s*\\;|\s*;|\s*\\+\s*)/g;
  while ((match = findExecRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  // xargs <cmd>
  const xargsRegex = /xargs\s+(?:-\w+\s+)*(\S+)/g;
  while ((match = xargsRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  return nested;
}

// ── 环境变量前缀剥离 ──────────────────────────────────────

/**
 * 剥离环境变量赋值前缀
 * "FOO=bar BAZ=qux rm file" → "rm file"
 */
export function stripEnvPrefix(segment: string): string {
  return segment.replace(/^(\s*\w+=\S+\s+)+/, "").trim();
}

// ── 重定向检测 ────────────────────────────────────────────

/**
 * 检测输出重定向（写操作）
 * 排除 2>&1（stderr 重定向到 stdout，非文件写入）
 */
export function hasRedirect(command: string): boolean {
  // 移除引号内容，避免误判 echo ">" 这种
  const stripped = command.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
  return /(?<!\d)>{1,2}(?!&)/.test(stripped);
}

// ── 单段分类 ──────────────────────────────────────────────

function classifySegment(segment: string): BashCommandClass {
  // 剥离环境变量前缀
  const trimmed = stripEnvPrefix(segment.trim());

  if (!trimmed) return "read"; // 纯环境变量赋值，无命令

  // 1. 危险命令
  for (const pattern of DANGEROUS_COMMANDS) {
    if (trimmed.startsWith(pattern) || trimmed === pattern.trim()) {
      return "dangerous";
    }
  }

  // 2. 重定向
  if (hasRedirect(trimmed)) {
    return "write";
  }

  // 3. 只读命令
  for (const pattern of READ_ONLY_COMMANDS) {
    if (trimmed.startsWith(pattern) || trimmed === pattern.trim()) {
      return "read";
    }
  }

  // 4. 写操作命令
  for (const pattern of WRITE_COMMANDS) {
    if (trimmed.startsWith(pattern)) {
      return "write";
    }
  }

  // 5. 无法判断
  return "unknown";
}

// ── 主分类函数 ────────────────────────────────────────────

/**
 * 分类整条 bash 命令（v2 加固版）
 *
 * 流程：
 * 1. 提取嵌套命令，递归分类
 * 2. 按管道/链式拆分（引号感知）
 * 3. 逐段分类
 * 4. 取最严格结果：dangerous > write/unknown > read
 */
export function classifyBashCommand(command: string): BashCommandClass {
  if (!command || !command.trim()) {
    return "unknown";
  }

  let result: BashCommandClass = "read";

  // 1. 检查嵌套命令
  const nested = extractNestedCommands(command);
  for (const nestedCmd of nested) {
    const cls = classifyBashCommand(nestedCmd); // 递归
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }

  // 2. 拆分命令段
  const segments = splitCommandSegments(command);

  if (segments.length === 0) {
    return result === "read" ? "unknown" : result;
  }

  // 3. 逐段分类
  for (const segment of segments) {
    const cls = classifySegment(segment);

    if (cls === "dangerous") {
      return "dangerous";
    }
    if (cls === "write" || cls === "unknown") {
      result = "write";
    }
  }

  return result;
}
