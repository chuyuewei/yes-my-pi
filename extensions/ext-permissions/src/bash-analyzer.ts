/**
 * yes-my-pi Permission System — Bash Command Classifier (v7)
 *
 * v7 changes (Maintainability Refactor):
 *   - Reduced Cognitive Complexity of splitCommandSegments and
 *     extractNestedCommands by extracting shared quote/escape state
 *     machine logic (updateQuoteState) and operator/regex matching
 *     into small, single-purpose helper functions.
 *
 * v6 changes (ReDoS Security Fix):
 *   - Fixed stripEnvPrefix: replaced the nested-quantifier regex
 *     with a `while` loop driven by a single-assignment regex.
 *
 * v5 changes (ReDoS Security Fix):
 *   - Replaced the vulnerable glob regex compiler with a ReDoS-safe
 *     implementation (compileSafeGlob).
 *
 * v4 changes (Performance, Security, Reliability):
 *   - Compiles prefix lists into single optimized regexes.
 *   - Uses word-boundary assertions for command matching.
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
 *
 * Patterns ending with a word character get a boundary assertion `(?=\s|$)`
 * to prevent false positives (e.g., "cat" matching "catch"). Patterns ending
 * with non-word chars (spaces, slashes) are matched directly as prefixes.
 *
 * Sorted by length descending so the regex engine prioritizes specific matches.
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
  /** If true, `*` matches `/` (useful for commands/URLs). Default: false (path semantics). */
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
 *
 *   "*"           -> matches everything
 *   "npm test*"   -> prefix wildcard
 *   "src/**"      -> path glob (** crosses directories, * single segment)
 *   no wildcard   -> EXACT match only (no implicit startsWith for security)
 */
export function matchPattern(
  pattern: string,
  value: string,
  options: MatchOptions = {},
): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;

  // No wildcards means strict exact match.
  // This prevents accidental prefix matches on security-sensitive paths.
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

// ── Shared Quote/Escape State Machine ────────────────────
//
// Both splitCommandSegments and extractNestedCommands need to track
// whether the parser is currently inside a single/double-quoted string
// (so operators like |, &, ; or subshell markers $( inside a quoted
// string literal are NOT treated as syntax). This shared helper avoids
// duplicating that state machine in two places, and keeps each caller's
// main loop simple (lower cognitive complexity).

interface QuoteState {
  inSingle: boolean;
  inDouble: boolean;
  escaped: boolean;
}

function createQuoteState(): QuoteState {
  return { inSingle: false, inDouble: false, escaped: false };
}

/**
 * Feeds one character into the quote/escape state machine.
 *
 * Returns `true` if the character was "consumed" by quote/escape handling
 * (i.e. it's a backslash, or a quote character that toggled state) and the
 * caller should treat it as literal content rather than syntax. Returns
 * `false` for any other character, meaning the caller should apply its own
 * syntax rules (e.g. operator detection) — but only when NOT currently
 * inside a quoted string (see `isInsideQuotes`).
 */
function updateQuoteState(state: QuoteState, ch: string): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (ch === "\\") {
    state.escaped = true;
    return true;
  }
  if (ch === "'" && !state.inDouble) {
    state.inSingle = !state.inSingle;
    return true;
  }
  if (ch === '"' && !state.inSingle) {
    state.inDouble = !state.inDouble;
    return true;
  }
  return false;
}

function isInsideQuotes(state: QuoteState): boolean {
  return state.inSingle || state.inDouble;
}

// ── Command Segment Splitting ─────────────────────────────

/**
 * Length of the shell separator operator starting at position `i`, or 0
 * if there isn't one. Handles the two-character operators (`||`, `&&`)
 * before the single-character ones (`|`, `&`, `;`, newline).
 */
function matchSeparatorLength(command: string, i: number): number {
  const ch = command[i];
  const next = command[i + 1];

  if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) {
    return 2;
  }
  if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
    return 1;
  }
  return 0;
}

/**
 * Quote & escape aware splitter.
 *
 *   cat "a|b.txt" | grep foo && echo "x;y"
 *     -> ['cat "a|b.txt"', 'grep foo', 'echo "x;y"']
 *
 * Supports: |, ||, &&, ;, & (background), \n
 * Operators inside single or double quotes are NOT treated as splits.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  const state = createQuoteState();
  let current = "";

  const pushSegment = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const consumedByQuoteHandling = updateQuoteState(state, ch);

    if (consumedByQuoteHandling) {
      current += ch;
      continue;
    }

    if (!isInsideQuotes(state)) {
      const sepLen = matchSeparatorLength(command, i);
      if (sepLen > 0) {
        pushSegment();
        i += sepLen - 1; // -1 because the for-loop will also increment
        continue;
      }
    }

    current += ch;
  }

  pushSegment();
  return segments;
}

// ── Nested Command Extraction ─────────────────────────────

/**
 * Extracts the contents of $(), <(), and >() constructs, correctly
 * handling arbitrary nesting depth (e.g. `$(echo $(rm -rf /))`).
 * A regex cannot do this reliably, so we use a small state machine.
 */
function extractSubshellCommands(command: string): string[] {
  const nested: string[] = [];
  const state = createQuoteState();
  let depth = 0;
  let start = -1;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    const consumed = updateQuoteState(state, ch);
    if (consumed || isInsideQuotes(state)) continue;

    if (depth === 0) {
      if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
        depth = 1;
        start = i + 2;
        i++; // consume the '(' too
      }
      continue;
    }

    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        nested.push(command.substring(start, i));
        start = -1;
      }
    }
  }

  return nested;
}

/** Runs a global-flag regex against `command` and collects all group-1 captures. */
function extractByRegex(command: string, regex: RegExp): string[] {
  const nested: string[] = [];
  // Clone the regex so callers' shared `RegExp.lastIndex` state can't leak
  // between invocations.
  const re = new RegExp(regex.source, regex.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    nested.push(match[1]);
  }
  return nested;
}

const BACKTICK_REGEX = /`([^`]+)`/g;
const SHELL_C_REGEX =
  /(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-\w+\s+)*-c\s+["']?([^"']+)["']?/gi;
const FIND_EXEC_REGEX = /-exec\s+(.+?)(?:\s*\\;|\s*;|\s*\\+\s*)/g;
const XARGS_REGEX = /xargs\s+(?:-\w+\s+)*(\S+)/g;

/**
 * Extract nested commands (command substitution, subshells, -c args,
 * find -exec, xargs).
 *
 *   "echo $(rm -rf /)"        -> ["rm -rf /"]
 *   "bash -c 'rm -rf /'"      -> ["rm -rf /"]
 *   "find . -exec rm {} \;"   -> ["rm {}"]
 *   "xargs rm"                -> ["rm"]
 */
export function extractNestedCommands(command: string): string[] {
  return [
    ...extractSubshellCommands(command),
    ...extractByRegex(command, BACKTICK_REGEX),
    ...extractByRegex(command, SHELL_C_REGEX),
    ...extractByRegex(command, FIND_EXEC_REGEX),
    ...extractByRegex(command, XARGS_REGEX),
  ];
}

// Matches a SINGLE env-var assignment prefix (e.g. "FOO=bar ").
// Supports quoted values (e.g. FOO="a b") without introducing nested
// unbounded quantifiers.
const ENV_PREFIX_REGEX = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/**
 * Strip env-var assignment prefixes: "FOO=bar BAZ=qux rm file" -> "rm file"
 * Also handles quoted values: `FOO="a b" rm file` -> `rm file`
 *
 * Security (CWE-1333): Uses a `while` loop driven by a single-assignment
 * regex instead of a nested unbounded quantifier (the previous
 * `/^(?:\s*\w+=\S+\s+)+/` pattern), which was vulnerable to exponential
 * backtracking (ReDoS). Each iteration runs in linear time, and the loop
 * bound is naturally capped by the string length.
 */
export function stripEnvPrefix(segment: string): string {
  let s = segment.trimStart();
  while (true) {
    const match = s.match(ENV_PREFIX_REGEX);
    if (!match) break;
    s = s.slice(match[0].length);
  }
  return s.trim();
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
  if (!trimmed) return "read"; // bare env assignments, nothing to classify

  // 1. Dangerous wins outright.
  if (DANGEROUS_REGEX.test(trimmed)) return "dangerous";

  // 2. Redirection -> write.
  if (hasRedirect(trimmed)) return "write";

  // 3. Read-only short-circuits.
  if (READ_ONLY_REGEX.test(trimmed)) return "read";

  // 4. Known write commands.
  if (WRITE_REGEX.test(trimmed)) return "write";

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

  // 1. Walk nested commands recursively (subshells, $(), xargs, -exec).
  const nested = extractNestedCommands(command);
  for (const nestedCmd of nested) {
    const cls = classifyBashCommand(nestedCmd);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }

  // 2. Split on quote-aware pipes / chains.
  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return result === "read" ? "unknown" : result;
  }

  // 3. Classify each segment and promote severity.
  for (const segment of segments) {
    const cls = classifySegment(segment);
    if (cls === "dangerous") return "dangerous";
    if (cls === "write" || cls === "unknown") result = "write";
  }

  return result;
}
