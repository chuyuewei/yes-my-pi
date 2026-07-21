#!/usr/bin/env node
import process from "node:process";

/**
 * yes-my-pi (ymp) CLI entry.
 *
 * Paper model: Pi is the upstream engine, yes-my-pi is the product layer.
 * Responsibilities of this file:
 *   1. Forward all CLI args as-is to Pi.
 *   2. Inject the ymp default identity into the system prompt when the
 *      user hasn't supplied their own (or an --append-system-prompt).
 *   3. Boot the upstream Pi engine and report startup errors.
 */

const YMP_SYSTEM_PROMPT = [
  "You are yes-my-pi (ymp), a controllable AI coding agent built on Pi.",
  "You respect the permission system: some tool calls require user approval.",
  "When a tool call is blocked, acknowledge the denial and adjust your approach.",
].join(" ");

const SYSTEM_PROMPT_FLAGS = new Set([
  "--system-prompt",
  "--append-system-prompt",
]);

/**
 * Append the ymp default identity to the system prompt unless the user
 * has already supplied either flag. Otherwise return args unchanged.
 */
export function buildArgs(userArgs) {
  const hasSystemPrompt = userArgs.some((arg) =>
    SYSTEM_PROMPT_FLAGS.has(arg),
  );
  if (hasSystemPrompt) return userArgs;

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
        `Please check the installation.\n` +
        `${err instanceof Error ? err.message : err}`,
    );
  }

  await pi.main(args);
}

run().catch((err) => {
  console.error(`[ymp] ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.YMP_DEBUG) console.error(err);
  process.exitCode = 1;
});
