/**
 * yes-my-pi Permission System — Bash Command Classifier (v3)
 *
 * v3 changes:
 *   - Removed "node ", "python ", "ruby ", etc. from WRITE_COMMANDS so
 *     effects-free one-liners like `node -v` and `node -e "..."` fall
 *     through to the rule engine (where `node --version*` is explicitly
 *     allow-listed and otherwise defaults to ask, not write). The
 *     previous version over-classified arbitrary scripts as writes.
 */

export type BashCommandClass = "read" | "write" | "dangerous" | "unknown";

/**
 * Commands with no side effects (safe to run without confirmation).
 * Order matters: longer/more-specific prefixes prevent a short
 * prefix from shadowing a longer one.
 */
const READ_ONLY_COMMANDS: string[] = [
  "cat ", "head ", "tail ", "less ", "more ", "wc ", "file ", "stat ",
  "du ", "df ",
  "ls ", "ll ", "dir ", "tree ", "pwd",
  "grep ", "egrep ", "fgrep ", "rg ", "ag ",
  "find ", "fd ", "locate ",
  "which ", "where ", "whereis ", "type ", "command -v ",
  "echo ", "printf ",
  "env", "printenv", "date", "uname ", "hostname", "whoami", "id ",
  "sort ", "uniq ", "cut ", "tr ", "jq ", "yq ", "diff ", "comm ",
  "realpath ", "readlink ", "basename ", "dirname ",
  "node -v", "node --version", "node -e", "node -p",
  "npm -v", "npm --version", "npm list", "npm ls", "npm outdated",
  "npm view", "npm search", "npx --version",
  "python --version", "python3 --version",
  "pip list", "pip show", "pip3 list", "pip3 show",
  "cargo --version", "rustc --version",
  "go version", "go env",
  "java -version", "javac -version",
  "tsc --version", "eslint --version",
  "git status", "git log", "git diff", "git show",
  "git branch", "git remote", "git tag", "git rev-parse",
  "git ls-files", "git blame",
  "git stash list", "git shortlog", "git describe",
  "git config --get", "git config --list",
  "npm test", "npm run test", "npm run lint", "npm run check",
  "npm run typecheck",
  "npx vitest", "npx jest", "npx tsc --noEmit",
  "npx eslint", "npx prettier --check",
  "pytest", "cargo test", "cargo clippy",
  "go test", "go vet",
  "make test", "make lint", "make check",
  "test ", "[ ",
  "true", "false", "sleep ",
];

/** Hard-deny commands; bypass every allow rule regardless of mode. */
const DANGEROUS_COMMANDS: string[] = [
  "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/",
  "rm -rf .", "rm -rf ./", "rm -rf ..", "rm -rf ../",
  "sudo ", "su ", "doas ",
  "curl | bash", "curl | sh", "wget | bash", "wget | sh",
  "curl|bash", "curl|sh", "wget|bash", "wget|sh",
  "curl |bash", "curl |sh", "wget |bash", "wget |sh",
  "chmod 777", "chmod -R 777", "chown -R",
  "dd if=", "mkfs", "fdisk", "parted ",
  ":(){ :|:& };:",
  "> /dev/sda", "> /dev/nvme", "> /dev/disk",
  "shutdown", "reboot", "halt", "poweroff",
  "init 0", "init 6",
  "kill -9 1", "killall",
  "iptables", "ufw ", "nft ",
  "systemctl stop", "systemctl disable", "service stop",
  "format ", "del /s /q ", "rd /s /q ",
  "Remove-Item -Recurse -Force C:",
  "diskpart", "reg delete ", "net stop ", "sc delete ",
  "Stop-Computer", "Restart-Computer",
];

/**
 * Write-side commands (mutate state outside the agent's subprocess).
 * NOTE: "node ", "python ", "ruby ", "perl ", "php ", "bash ", "sh ",
 * "zsh " have been removed in v3 — they are now routed through the
 * rule engine, which lets users grant blanket-allow via the rule
 * file rather than baking it into the classifier.
 */
const WRITE_COMMANDS: string[] = [
  "rm ", "rmdir ", "mv ", "cp ", "mkdir ", "touch ", "ln ",
  "chmod ", "chown ", "tee ",
  "git add", "git commit", "git push", "git pull",
  "git checkout", "git switch", "git merge", "git rebase",
  "git reset", "git cherry-pick",
  "git stash push", "git stash pop", "git stash drop", "git stash clear",
  "git tag ", "git branch -d", "git branch -D",
  "git remote add", "git remote remove", "git remote set-url",
  "git config --set", "git config --add", "git clean",
  "npm install", "npm i ", "npm ci",
  "npm uninstall", "npm remove", "npm publish", "npm link",
  "npm run build", "npm run compile", "npm cache clean",
  "npx create-",
  "yarn add", "yarn remove", "yarn install",
  "pnpm add", "pnpm remove", "pnpm install",
  "pip install", "pip3 install", "pip uninstall",
  "cargo build", "cargo install", "cargo publish",
  "go build", "go install", "go get",
  "make ", "cmake ", "gradle ", "mvn ", "tsc ",
  "webpack ", "vite build", "rollup ",
  "docker build", "docker run", "docker push",
  "docker compose up", "docker-compose up",
  "docker rm", "docker rmi",
  "kubectl apply", "kubectl delete",
  "terraform apply", "terraform destroy",
  "wget ", "curl -o ", "curl -O ", "scp ", "rsync ",
  "tar ", "zip ", "unzip ", "gzip ", "gunzip ",
  "sed -i", "perl -i", "patch ",
  "del ", "erase ", "move ", "copy ", "mkdir ", "md ",
  "rmdir ", "rd ", "ren ", "rename ", "attrib ",
  "New-Item", "Remove-Item", "Move-Item", "Copy-Item",
  "Set-Content", "Add-Content", "Clear-Content", "Rename-Item",
  "Set-ItemProperty",
  "Install-Module", "Uninstall-Module",
  "git.exe ",
];

/**
 * Quote-aware splitter.
 *
 *   cat "a|b.txt" | grep foo && echo "x;y"
 *     -> ['cat "a|b.txt"', 'grep foo', 'echo "x;y"']
 *
 * Operators inside single or double quotes are NOT treated as splits.
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

/**
 * Extract nested commands (command substitution, subshells, -c args).
 *
 *   "echo $(rm -rf /)"        -> ["rm -rf /"]
 *   "bash -c 'rm -rf /'"      -> ["rm -rf /"]
 *   "find . -exec rm {} \;"   -> ["rm {}"]
 *   "xargs rm"                -> ["rm"]
 */
export function extractNestedCommands(command: string): string[] {
  const nested: string[] = [];
  let match: RegExpExecArray | null;

  const cmdSubstRegex = /\$\(([^)]+)\)/g;
  while ((match = cmdSubstRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  const shellCRegex =
    /(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-\w+\s+)*-c\s+["']?([^"']+)["']?/gi;
  while ((match = shellCRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  const findExecRegex = /-exec\s+(.+?)(?:\s*\\;|\s*;|\s*\\+\s*)/g;
  while ((match = findExecRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  const xargsRegex = /xargs\s+(?:-\w+\s+)*(\S+)/g;
  while ((match = xargsRegex.exec(command)) !== null) {
    nested.push(match[1]);
  }

  return nested;
}

/** Strip env-var assignment prefixes: "FOO=bar BAZ=qux rm file" -> "rm file" */
export function stripEnvPrefix(segment: string): string {
  return segment.replace(/^(\s*\w+=\S+\s+)+/, "").trim();
}

/**
 * Detect output redirection (a write side-effect).
 * Excludes `2>&1` (stderr → stdout dup).
 */
export function hasRedirect(command: string): boolean {
  const stripped = command.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
  return /(?<!\d)>{1,2}(?!&)/.test(stripped);
}

function classifySegment(segment: string): BashCommandClass {
  const trimmed = stripEnvPrefix(segment.trim());
  if (!trimmed) return "read"; // bare env assignments, nothing to classify

  // 1. Dangerous wins outright.
  for (const pattern of DANGEROUS_COMMANDS) {
    if (trimmed.startsWith(pattern) || trimmed === pattern.trim()) {
      return "dangerous";
    }
  }

  // 2. Redirection -> write.
  if (hasRedirect(trimmed)) return "write";

  // 3. Read-only short-circuits.
  for (const pattern of READ_ONLY_COMMANDS) {
    if (trimmed.startsWith(pattern) || trimmed === pattern.trim()) {
      return "read";
    }
  }

  // 4. Known write commands.
  for (const pattern of WRITE_COMMANDS) {
    if (trimmed.startsWith(pattern)) return "write";
  }

  // 5. Fallback: unknown (caller decides what to do).
  return "unknown";
}

/**
 * Classify a whole bash command. Returns the most-strict class found:
 *   dangerous > write/unknown > read
 *
 *   1. Walk nested commands recursively (subshells, $(), xargs, -exec).
 *   2. Split on quote-aware pipes / chains.
 *   3. Classify each segment.
 *   4. Promote to the strictest class seen.
 */
export function classifyBashCommand(command: string): BashCommandClass {
  if (!command || !command.trim()) return "unknown";

  let result: BashCommandClass = "read";

  const nested = extractNestedCommands(command);
  for (const nestedCmd of nested) {
    const cls = classifyBashCommand(nestedCmd);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }

  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return result === "read" ? "unknown" : result;
  }

  for (const segment of segments) {
    const cls = classifySegment(segment);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }

  return result;
}
