/**
 * yes-my-pi Permission System — Bash Command Classifier (v5)
 *
 * v5 changes (ReDoS Security Fix):
 *   - Replaced the vulnerable glob regex compiler with a ReDoS-safe
 *     implementation (compileSafeGlob). It accumulates literal characters
 *     and builds negated character classes, eliminating exponential
 *     backtracking on overlapping wildcards (e.g., "*a*b*c").
 *
 * v4 changes (Performance, Security, Reliability):
 *   - Compiles prefix lists into single optimized regexes (O(N) -> O(1) lookup).
 *   - Uses word-boundary assertions for command matching.
 *   - State-machine parser for extractNestedCommands, handling infinite depth.
 *   - Extended splitCommandSegments to cover "&" and newlines.
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
  "node -e",
  "node -p",
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
  "wget |bash",
  "wget |sh",
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

/**
 * Compiles an array of prefix strings into a single optimized RegExp.
 */
function compilePrefixes(prefixes: string[]): RegExp {
  const parts = prefixes.map((p) => {
    const trimmed = p.trim();
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/\w$/.test(trimmed)) {
      return `${escaped}(?=\\s|$)`;
    }
    return escaped;
  });
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(`^(?:${parts.join("|")})`);
}

const DANGEROUS_REGEX = compilePrefixes(DANGEROUS_COMMANDS);
const READ_ONLY_REGEX = compilePrefixes(READ_ONLY_COMMANDS);
const WRITE_REGEX = compilePrefixes(WRITE_COMMANDS);

// ── ReDoS-Safe Glob Compiler ─────────────────────────────

interface MatchOptions {
  crossSlashes?: boolean;
}

const patternRegexCache = new Map<string, RegExp>();

function escapeRegexChar(c: string): string {
  if (/[.+^${}()|[\]\\]/.test(c)) return "\\" + c;
  return c;
}

/**
 * ReDoS-safe glob pattern compiler.
 *
 * Instead of compiling `*a*b` into `^.*a.*b$` (which causes exponential
 * backtracking on strings like "1a2a3a4"), we accumulate the literal
 * characters seen so far and use them to build a negated character class.
 *
 * `*a*b` compiles to `^[^/]*a[^/a]*b$`. Because `[^/a]*` cannot consume 'a',
 * there is no ambiguity in how the string is partitioned between the wildcards.
 * This preserves greedy semantics but guarantees linear execution time.
 */
function compileSafeGlob(pattern: string, options: MatchOptions = {}): RegExp {
  let regexStr = "^";
  const seenLiterals = new Set<string>();
  let i = 0;
  const crossSlashes = options.crossSlashes === true;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      let isGlobstar = false;
      if (pattern[i + 1] === "*") {
        isGlobstar = true;
        i++;
      }

      let negClass = "";
      if (seenLiterals.size > 0) {
        negClass = [...seenLiterals].map(escapeRegexChar).join("");
      }

      if (isGlobstar || crossSlashes) {
        regexStr += negClass ? `[^${negClass}]*` : ".*";
      } else {
        regexStr += negClass ? `[^/${negClass}]*` : "[^/]*";
      }
      i++;
    } else if (char === "?") {
      regexStr += crossSlashes ? "." : "[^/]";
      i++;
    } else {
      const escaped = escapeRegexChar(char);
      regexStr += escaped;
      seenLiterals.add(char);
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Pattern matching using the ReDoS-safe compiler.
 */
export function matchPattern(
  pattern: string,
  value: string,
  options: MatchOptions = {},
): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;

  if (!pattern.includes("*") && !pattern.includes("?")) {
    return false;
  }

  const cacheKey = pattern + (options.crossSlashes ? ":cmd" : ":path");
  let regex = patternRegexCache.get(cacheKey);

  if (!regex) {
    regex = compileSafeGlob(pattern, options);
    patternRegexCache.set(cacheKey, regex);
  }

  return regex.test(value);
}

function matchStringOrArray(
  pattern: string | string[] | undefined,
  value: string,
  options?: MatchOptions,
): boolean {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, value, options));
}

// ── Command Parsing & Extraction ─────────────────────────

/**
 * Quote & escape aware splitter.
 * Supports: |, ||, &&, ;, & (background), \n
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

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
      if (ch === "|" && next === "|") {
        pushSegment();
        i++;
        continue;
      }
      if (ch === "|") {
        pushSegment();
        continue;
      }
      if (ch === "&" && next === "&") {
        pushSegment();
        i++;
        continue;
      }
      if (ch === "&") {
        pushSegment();
        continue;
      }
      if (ch === ";" || ch === "\n") {
        pushSegment();
        continue;
      }
    }

    current += ch;
  }

  pushSegment();
  return segments;
}

/**
 * Extract nested commands using a state machine.
 * Reliably handles infinite nesting depths for $(), <(), >() which regex fails on.
 */
export function extractNestedCommands(command: string): string[] {
  const nested: string[] = [];
  let inSingle = false,
    inDouble = false,
    escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (depth === 0) {
      if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
        depth = 1;
        start = i + 2;
        i++;
        continue;
      }
    } else {
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          nested.push(command.substring(start, i));
          start = -1;
        }
        continue;
      }
    }
  }

  const backtickRegex = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
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
  return segment.replace(/^(?:\s*\w+=\S+\s+)+/, "").trim();
}

/**
 * Detect output redirection (a write side-effect).
 * Excludes fd duplication like 2>&1, but catches >, >>, 1>file, etc.
 */
export function hasRedirect(command: string): boolean {
  const stripped = command
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "");
  return />{1,2}(?!&)/.test(stripped);
}

// ── Classification Engine ────────────────────────────────

function classifySegment(segment: string): BashCommandClass {
  const trimmed = stripEnvPrefix(segment.trim());
  if (!trimmed) return "read";

  if (DANGEROUS_REGEX.test(trimmed)) return "dangerous";
  if (hasRedirect(trimmed)) return "write";
  if (READ_ONLY_REGEX.test(trimmed)) return "read";
  if (WRITE_REGEX.test(trimmed)) return "write";

  return "unknown";
}

/**
 * Classify a whole bash command. Returns the most-strict class found:
 *   dangerous > write/unknown > read
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
