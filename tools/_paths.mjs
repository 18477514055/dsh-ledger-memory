/**
 * 探针共用的**路径推导**（原来每个探针都硬编码本机绝对路径）。
 *
 * ★ 为什么要有这个文件：20 多个探针里散着 30 处 `C:\Users\<我>\…` 与
 *   `D:\<我的工作区>\…`。那样别人 clone 下来**一个都跑不了**，
 *   而且会把本机目录结构带进公开仓库。
 *
 * ★ 推导优先级：**环境变量 > 从文件位置推 > 本机默认**。
 *   推不出来的（如别人的 Junction 链）就是 `undefined`，
 *   调用方**必须自己判断并跳过**，而不是拿个错路径去撞。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 本插件根目录（`tools/` 的上一级）—— 这条对所有 clone 都成立。 */
export const PLUGIN_DIR = path.dirname(HERE);

/** 宿主半边 / 客户端半边入口。 */
export const LIB = path.join(PLUGIN_DIR, "lib", "index.js");
export const CLIENT = path.join(PLUGIN_DIR, "lib", "client.js");

/** DSH 的家。默认按官方桌面端，可用 `DSH_HOME` 覆盖。 */
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");

/** 当前 profile 目录。 */
export const PROFILE_DIR = path.join(DSH_HOME, "profiles", process.env.DSH_PROFILE ?? "desktop");

/** 会话日志目录。 */
export const SESSIONS = path.join(DSH_HOME, "sessions");

/** 本机是否装了 DSH（有些探针没有它就没意义）。 */
export const HAS_DSH = fs.existsSync(DSH_HOME);

/**
 * 内核的 `app.asar`。装在哪儿**因机器而异**：
 * 官方桌面端在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`，
 * 但也可能是集成端 / 免安装版 ⇒ 猜不到就回 `undefined`，让调用方跳过。
 */
export const ASAR = (() => {
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
  const cands = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DSH Integrated", "resources", "app.asar"),
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
  ];
  for (const c of cands) {
    try {
      if (c !== "" && fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return undefined;
})();

/**
 * 内核包目录（集成端那种 `plugin\<名>` 结构）。
 * ★ 这是**别人的布局**，不是本插件的约定 ⇒ 多数 clone 上会是 `undefined`。
 */
export const KERNEL_PLUGIN_DIR = (() => {
  const cand = path.join(PLUGIN_DIR, "..", "..", "..", "30-DSH客户端", "01-集成桌面端", "plugin");
  try {
    return fs.existsSync(cand) ? cand : undefined;
  } catch {
    return undefined;
  }
})();

/**
 * 跳过工具：探针在"本机没有这个前提"时应当**明确跳过**，
 * 而不是报 FAIL —— 否则别人 clone 下来满屏假失败。
 */
export function skip(label, why) {
  console.log(`  SKIP  ${label}（${why}）`);
}
