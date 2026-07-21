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
