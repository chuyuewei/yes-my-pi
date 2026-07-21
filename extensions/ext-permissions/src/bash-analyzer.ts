/**
 * yes-my-pi Permission System - Bash Command Classifier
 *
 * Classifies bash commands into read / write / dangerous / unknown.
 * Does not perform full shell parsing; uses prefix matching + structural
 * analysis to cover 80% of scenarios. When uncertain, defaults to write
 * (safety-first, triggers user approval).
 */

export type BashCommandClass = "read" | "write" | "dangerous" | "unknown";

/** Read-only command prefixes */
const READ_ONLY_COMMANDS: string[] = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "ls",
  "ll",
  "dir",
  "pwd",
  "which",
  "where",
  "whereis",
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "find",
  "fd",
  "locate",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "date",
  "uname",
  "hostname",
  "whoami",
  "id",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "npm list",
  "npm ls",
  "npm outdated",
  "npm view",
  "npx --version",
  "python --version",
  "python3 --version",
  "pip list",
  "pip show",
  "pip3 list",
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
  "cargo --version",
  "rustc --version",
  "go version",
  "go env",
  "java -version",
  "javac -version",
  "tsc --version",
  "eslint --version",
  "tree",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed -n",
  "jq",
  "yq",
  "curl -s",
  "wget -q -O -",
  "type",
  "command -v",
  "test",
  "[",
  "true",
  "false",
];

/** Dangerous command prefixes (deny in all modes) */
const DANGEROUS_COMMAND_PREFIXES: string[] = [
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf .",
  "rm -rf ./",
  "sudo",
  "su",
  "chmod 777",
  "chmod -R 777",
  "chown -R",
  "dd if=",
  "mkfs",
  "fdisk",
  "> /dev/sda",
  "> /dev/nvme",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill -9 1",
  "killall",
  "iptables",
  "ufw",
  "systemctl stop",
  "systemctl disable",
  "service stop",
];

/** Dangerous command regex patterns (for complex syntax like pipes) */
const DANGEROUS_COMMAND_REGEXES: RegExp[] = [
  /(?:curl|wget)\s+.*\|\s*(?:bash|sh)/, // curl | bash variations
  /:\s*\(\)\s*\{\s*:\|:\&\s*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
];

/** Write command prefixes (triggers ask in auto-edit mode) */
const WRITE_COMMANDS: string[] = [
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tee",
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
  "git tag",
  "git branch -d",
  "git branch -D",
  "git remote add",
  "git remote remove",
  "npm install",
  "npm i",
  "npm ci",
  "npm uninstall",
  "npm remove",
  "npm publish",
  "npm link",
  "npm run build",
  "npm run compile",
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
  "go build",
  "go install",
  "go get",
  "make",
  "cmake",
  "docker build",
  "docker run",
  "docker push",
  "docker compose up",
  "docker-compose up",
  "kubectl apply",
  "kubectl delete",
  "terraform apply",
  "terraform destroy",
  "apt",
  "apt-get",
  "yum",
  "brew",
  "wget",
  "curl -o",
  "curl -O",
  "scp",
  "rsync",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "sed -i",
  "perl -i",
  "patch",
  "node",
  "python",
  "python3",
];

/**
 * Compile prefix lists into regex patterns for strict word-boundary matching.
 * E.g., "cat" becomes /^cat(?:\s|$)/, matching "cat file" but not "catch".
 */
const compilePrefixes = (prefixes: string[]): RegExp[] =>
  prefixes.map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:\\s|$)`);
  });

const READ_ONLY_PATTERNS = compilePrefixes(READ_ONLY_COMMANDS);
const WRITE_PATTERNS = compilePrefixes(WRITE_COMMANDS);

/** Regex to match quoted strings (handles escaped quotes inside) */
const QUOTE_REGEX = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * Splits a command string by pipes/chains while respecting quoted strings.
 * "cat a.txt | grep 'A && B'" → ["cat a.txt", "grep 'A && B'"]
 */
export function splitCommandSegments(command: string): string[] {
  // Temporarily replace operators inside quotes to prevent false splitting
  const sanitized = command.replace(QUOTE_REGEX, (match) =>
    match.replace(/[|;&]/g, " "),
  );

  return sanitized
    .split(/\s*(?:\|\||&&|[|;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Detects output redirection (write operation), ignoring redirects in quotes.
 * "echo hi > file.txt" → true
 * "echo 'a > b'" → false
 */
export function hasRedirect(command: string): boolean {
  const noQuotes = command.replace(QUOTE_REGEX, "");
  // Matches > or >> but excludes 2>&1
  return /(?<!\d)>{1,2}(?!&)/.test(noQuotes);
}

/**
 * Strips leading environment variable assignments.
 * "NODE_ENV=prod npm run build" → "npm run build"
 */
function stripEnvVars(cmd: string): string {
  return cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
}

/**
 * Classifies a single command segment.
 */
function classifySegment(segment: string): BashCommandClass {
  const stripped = stripEnvVars(segment.trim());

  // 1. Dangerous prefix checks (highest priority)
  if (DANGEROUS_COMMAND_PREFIXES.some((p) => stripped.startsWith(p))) {
    return "dangerous";
  }

  // 2. Redirect checks (treat as write)
  if (hasRedirect(stripped)) {
    return "write";
  }

  // 3. Read-only checks
  if (READ_ONLY_PATTERNS.some((re) => re.test(stripped))) {
    return "read";
  }

  // 4. Write checks
  if (WRITE_PATTERNS.some((re) => re.test(stripped))) {
    return "write";
  }

  // 5. Cannot classify
  return "unknown";
}

/**
 * Classifies a full bash command string.
 *
 * Rules:
 * - Any segment is dangerous → dangerous (checked globally and per-segment)
 * - Any segment is write or unknown → write (safety-first)
 * - All segments are read → read
 */
export function classifyBashCommand(command: string): BashCommandClass {
  const trimmedCmd = command.trim();
  if (trimmedCmd.length === 0) return "unknown";

  // Global dangerous regex check (e.g., pipe bombs that span segments)
  if (DANGEROUS_COMMAND_REGEXES.some((re) => re.test(trimmedCmd))) {
    return "dangerous";
  }

  const segments = splitCommandSegments(trimmedCmd);
  if (segments.length === 0) return "unknown";

  let result: BashCommandClass = "read";

  for (const segment of segments) {
    const cls = classifySegment(segment);

    if (cls === "dangerous") {
      return "dangerous"; // Immediate return, highest priority
    }
    if (cls === "write" || cls === "unknown") {
      result = "write"; // Upgrade severity, but continue checking other segments
    }
  }

  return result;
}
