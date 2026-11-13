/**
 * ★★★★ 探针（D388）：**看板"跟随最近活跃项目"的判据必须是"最近"**。
 *
 * 为什么要有它：在没有明确会话上下文时，看板提供最近活跃项目作为建议。
 * `rememberSessionRoot` 记录的是后台活动，不代表用户眼前的当前对话。
 * 当前对话应由客户端 mainView 会话标识定位；本探针只验证最近活动排序。
 *
 * 判据（全部可证伪）：
 *   ① `mostRecentRoot()` = 最后被 `rememberSessionRoot` 记过的那个 root
 *   ② `knownRoots()` 第一项 = 同一个 root（最近活跃建议，不冒充当前对话）
 *   ③ 同一会话改换项目后，最近活跃跟着换（不是缓存旧的）
 *   ④ 非法入参（空 sid / 空 root / 非字符串）**不得**污染清单
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ★★★ D389 起这个探针**必须先换家再加载模块**：
//   那之后 `rememberSessionRoot` 会**落盘**（跨重启保存），而本探针用的是假项目路径
//   ⇒ 若直接静态 import，就会把 `D:\__d388_probe__` 这种垃圾写进**用户真正的**
//   `$DSH_HOME\plugin-data\dsh-ledger-memory\board-roots.json`。
//   ⇒ 一律指向 `mkdtemp` 出来的临时家，跑完删掉。
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-d388-"));
process.env.DSH_HOME = probeHome;
const modUrl = pathToFileURL(fileURLToPath(new URL("../lib/board-http.js", import.meta.url))).href;
const { rememberSessionRoot, knownRoots, mostRecentRoot, sessionRootOf } = await import(modUrl);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : " → " + extra}`); }
};

// 使用隔离家中的真实目录：排序只针对仍存在的项目，不把失效路径当成有效夹具。
const A = path.join(probeHome, "proj-A");
const B = path.join(probeHome, "proj-B");
fs.mkdirSync(A);
fs.mkdirSync(B);

rememberSessionRoot("sid-probe-1", A);
rememberSessionRoot("sid-probe-2", B);
ok("① mostRecentRoot = 最后记的那个（B）", mostRecentRoot()?.root === B, JSON.stringify(mostRecentRoot()));
ok("② knownRoots 第一项也是 B", knownRoots()[0]?.root === B, JSON.stringify(knownRoots().slice(0, 2)));
ok("② 清单里 A 仍在（没被顶掉）", knownRoots().some((p) => p.root === A));

rememberSessionRoot("sid-probe-1", B); // 会话 1 换到 B
rememberSessionRoot("sid-probe-3", A); // 又有会话在 A 活跃 ⇒ 最近应是 A
ok("③ 最近活跃跟着新活动换（A）", mostRecentRoot()?.root === A, JSON.stringify(mostRecentRoot()));
ok("③ 会话 1 的项目根已改写为 B", sessionRootOf("sid-probe-1") === B, String(sessionRootOf("sid-probe-1")));

const before = knownRoots().length;
rememberSessionRoot("", A);
rememberSessionRoot("sid-x", "");
rememberSessionRoot(undefined, A);
rememberSessionRoot("sid-y", undefined);
ok("④ 非法入参不增加清单项", knownRoots().length === before, `${before} → ${knownRoots().length}`);
ok("④ 非法入参不改最近活跃", mostRecentRoot()?.root === A, JSON.stringify(mostRecentRoot()));

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
try {
  fs.rmSync(probeHome, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不致命 */
}
process.exit(fail === 0 ? 0 : 1);
