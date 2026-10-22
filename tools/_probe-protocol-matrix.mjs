// ★★★ 重做验证（上一版是**尺子错**）：
//   上一版我改完判据后，直接跑 tools/_probe-protocol-real.mjs 看到 outdated=false，
//   就以为是我的改动生效了。**其实不是** —— 那份清单里的 protocolVersion 已被外部
//   （用户或别的会话）在 13:58:44 补成 2 了。**拿已经修好的夹具验证修复，等于什么都没验。**
// ⇒ 本版一律用**合成清单**，不读磁盘上的真实清单。
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.resolve(import.meta.dirname, "..");
const defs = await import(pathToFileURL(path.join(here, "lib", "defs.js")).href);

const FULL = {
  decisionsDir: "decisions",
  lessonsDir: "lessons",
  goalsDir: "goals",
  logDir: "_ledger-log",
};

const cases = [
  ["A 结构齐全 + 没写 protocolVersion", { ...FULL }, "★ 用户报的那个"],
  ["B 结构齐全 + protocolVersion: 2", { ...FULL, protocolVersion: 2 }, "已经补过的"],
  ["C 结构齐全 + protocolVersion: 1（写错了）", { ...FULL, protocolVersion: 1 }, "数字说谎"],
  ["D 真·单文件（三键全缺）", {}, "真的没升级"],
  ["E 半升级：只有卡片化，没 logDir", { decisionsDir: "d", lessonsDir: "l", goalsDir: "g" }, "缺一条"],
  ["F 半升级：只有 logDir", { logDir: "_ledger-log" }, "缺卡片化"],
];

console.log("清单情形".padEnd(42) + "projectVersion  effective  outdated   missing");
console.log("─".repeat(95));
let bad = 0;
for (const [name, m, note] of cases) {
  const g = defs.protocolGapOf(m);
  const pv = g.projectVersion;
  const ev = g.effectiveVersion;
  const line =
    name.padEnd(42) + String(pv).padEnd(16) + String(ev).padEnd(11) +
    String(g.outdated).padEnd(11) + g.missing.length;
  console.log(line + (note ? `  ← ${note}` : ""));
}

console.log("\n── 期望值 ──");
const expect = [
  ["A", false],
  ["B", false],
  ["C", false], // 结构齐全 ⇒ 数字写错也不该报"落后"
  ["D", true],
  ["E", true],
  ["F", true],
];
for (const [key, want] of expect) {
  const m = cases.find((c) => c[0].startsWith(key))[1];
  const got = defs.protocolGapOf(m).outdated;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${key}：outdated 期望 ${want}，实际 ${got}`);
}

console.log(`\n${bad === 0 ? "✅ 六种情形全部符合新判据" : `❌ ${bad} 条不符`}`);

// ★ 反向自检：把判据换回**旧写法**，A 与 C 必须变红（否则说明改动没真正起作用）
console.log("\n── 反向自检：旧判据（projectVersion < current || missing>0）在 A/C 上的表现 ──");
for (const key of ["A", "C"]) {
  const m = cases.find((c) => c[0].startsWith(key))[1];
  const g = defs.protocolGapOf(m);
  const oldOutdated = g.projectVersion < g.currentVersion || g.missing.length > 0;
  console.log(
    `  ${key}：旧判据 outdated = ${oldOutdated} ${oldOutdated ? "← 就是它把已升级的项目判成「落后」" : ""}`
  );
}
