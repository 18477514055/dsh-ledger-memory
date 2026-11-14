/**
 * ★★★★ 探针（D389）：**"看板见过哪些项目"必须跨重启活着**。
 *
 * ── 为什么要有它 ───────────────────────────────────────────────────────────
 *   用户 2026-11-13 重启 DSH 后**直接点开看板**、还没跑任何回合 ⇒ 旧实现里那张
 *   `sessionRoots` 是**进程内 Map** ⇒ 空的 ⇒ 红字「本进程还没见过任何项目」。
 *   修法是把它落成 `$DSH_HOME\plugin-data\dsh-ledger-memory\board-roots.json`，
 *   启动时读回。这个探针守的就是这件事，而且要守到**这几件容易写错的地方**：
 *     ① 真的落盘了（不是"我加了代码"）
 *     ② **节流**真的在（pre-step 每步都调 ⇒ 不节流就是每步写一次盘）
 *     ③ 恢复后**"最近活跃"仍然是那个最近的**（不是恢复顺序决定）
 *     ④ 恢复后新登记的序号**接着旧的最大值往下发**（否则重启后"最近"会永远停在旧的那个）
 *     ⑤ 已经不存在 / 末尾被删掉的**不恢复**（点一下就一次读盘失败）
 *     ⑥ 存档坏了**不致命**（吞错，不影响本次运行）
 *
 * ── 尺子（怎么保证不是假绿）───────────────────────────────────────────────
 *   `DSH_HOME` 指向 `mkdtemp` 出来的临时目录 —— **绝不碰用户真正的家**；
 *   每个"跨重启"用例都**重新 import 一次模块**（带 `?v=N` 绕过模块缓存），
 *   模拟真进程重启；项目根都是临时目录里**真实存在**的文件夹
 *   （因为恢复时会按 `existsSync` 剔掉死项目 —— 用假路径会测不到真行为）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : " → " + extra}`);
  }
};

// ★ 先换家：模块加载时会 `loadBoardRootsStore()`，读的是 `dshHome()`（每次现取环境变量）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-d389-"));
process.env.DSH_HOME = home;
const storeFile = path.join(home, "plugin-data", "dsh-ledger-memory", "board-roots.json");

const proj = (name) => {
  const dir = path.join(home, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const A = proj("proj-A");
const B = proj("proj-B");
const C = proj("proj-C");

const modUrl = pathToFileURL(fileURLToPath(new URL("../lib/board-http.js", import.meta.url))).href;
let gen = 0;
/** 模拟一次"真进程重启"：丢掉模块缓存，重新走一遍模块级 `loadBoardRootsStore()`。 */
const boot = async () => {
  gen += 1;
  return import(`${modUrl}?boot=${gen}`);
};

console.log("── ① 落盘 ───────────────────────────────────────────────");
const m1 = await boot();
m1.rememberSessionRoot("sid-1", A);
m1.rememberSessionRoot("sid-2", B);
const w1 = m1.flushBoardRootsStore();
ok("① 写盘返回 ok", w1.ok === true, JSON.stringify(w1));
ok("① 文件真的在（临时家里）", fs.existsSync(storeFile), storeFile);
let raw = "";
try {
  raw = fs.readFileSync(storeFile, "utf8");
} catch (e) {
  raw = "";
}
let doc = null;
try {
  doc = JSON.parse(raw);
} catch {
  doc = null;
}
ok("① 存档是合法 JSON", doc !== null && typeof doc === "object", raw.slice(0, 120));
ok("① 存档里有版本号", doc?.version === 1, String(doc?.version));
ok(
  "① 两个项目都在存档里",
  Array.isArray(doc?.roots) && doc.roots.length === 2 && doc.roots.every((r) => typeof r.root === "string"),
  JSON.stringify(doc?.roots)
);
ok("① 会话行是 [sid, root] 对（不是对象，避免键序歧义）", Array.isArray(doc?.sessions) && doc.sessions.every((p) => Array.isArray(p) && p.length === 2), JSON.stringify(doc?.sessions));
ok("① 存档里 seq 记到了（用于重启后接着发号）", Number.isFinite(doc?.seq) && doc.seq >= 2, String(doc?.seq));

console.log("── ② 节流（3 秒窗口内不得每一步都写盘）────────────────────");
const savedAt1 = doc?.savedAt ?? 0;
// ★ 尺子说明：这里**故意继续登记 B**（最后登记的那个）而不是 A ——
//   否则这 5 次调用会把 A 的序号顶到最新，"最近活跃"变成 A 是对的（pre-step 每步都刷新），
//   那会把下面第 ③ 组用例测成假红。**这一组只测"写盘频率"，不测排序。**
for (let i = 0; i < 5; i += 1) m1.rememberSessionRoot("sid-2", B);
let doc2 = null;
try {
  doc2 = JSON.parse(fs.readFileSync(storeFile, "utf8"));
} catch {
  doc2 = null;
}
ok("② 3 秒窗口内连调 5 次 ⇒ 没有立刻再写盘（savedAt 未变）", (doc2?.savedAt ?? 0) === savedAt1, `${savedAt1} → ${doc2?.savedAt ?? "读取失败"}`);
ok("② 但内存里已经是最新的（脏标记不等于丢了）", m1.sessionRootOf("sid-2") === B, String(m1.sessionRootOf("sid-2")));
const w2 = m1.flushBoardRootsStore();
ok("② 显式 flush 能把欠下的那次补写出去", w2.ok === true, JSON.stringify(w2));
let doc3 = null;
try {
  doc3 = JSON.parse(fs.readFileSync(storeFile, "utf8"));
} catch {
  doc3 = null;
}
ok("② 补写之后 savedAt 前进了", (doc3?.savedAt ?? 0) >= savedAt1, `${savedAt1} → ${doc3?.savedAt ?? "读取失败"}`);

console.log("── ③ 跨重启恢复（模拟新进程）──────────────────────────────");
const m2 = await boot();
ok("③ 恢复后 knownRoots 有 2 项", m2.knownRoots().length === 2, JSON.stringify(m2.knownRoots()));
ok("③ 最近活跃仍是最后登记的 B（不是恢复顺序决定的）", m2.mostRecentRoot()?.root === B, JSON.stringify(m2.mostRecentRoot()));
ok("③ 下拉框第一项 = B", m2.knownRoots()[0]?.root === B, JSON.stringify(m2.knownRoots().slice(0, 2)));
ok("③ 会话映射也恢复了（看板带 sid 时能直接命中）", m2.sessionRootOf("sid-2") === B, String(m2.sessionRootOf("sid-2")));
ok(
  "③ 恢复的项带 seq（排序依据没丢）",
  m2.knownRoots().every((p) => Number.isFinite(p.seq) && p.seq > 0),
  JSON.stringify(m2.knownRoots())
);

console.log("── ④ 重启后新登记的序号必须接续（否则「最近」会卡在旧项目）──────");
m2.rememberSessionRoot("sid-3", C);
ok("④ 新项目 C 成为最近活跃", m2.mostRecentRoot()?.root === C, JSON.stringify(m2.mostRecentRoot()));
const seqC = m2.knownRoots().find((p) => p.root === C)?.seq ?? 0;
const seqB = m2.knownRoots().find((p) => p.root === B)?.seq ?? 0;
ok("④ C 的序号严格大于重启前最大的那个", seqC > seqB, `C=${seqC} B=${seqB}`);
m2.flushBoardRootsStore();
const m3 = await boot();
ok("④ 再重启一次，最近活跃仍是 C", m3.mostRecentRoot()?.root === C, JSON.stringify(m3.mostRecentRoot()));

console.log("── ⑤ 已经不存在的项目不得恢复 ──────────────────────────────");
fs.rmSync(B, { recursive: true, force: true }); // 模拟用户把项目删了/改名了
const m4 = await boot();
ok("⑤ 死项目被剔掉（不回下拉框）", !m4.knownRoots().some((p) => p.root === B), JSON.stringify(m4.knownRoots()));
ok("⑤ 活着的项目照旧在", m4.knownRoots().some((p) => p.root === A) && m4.knownRoots().some((p) => p.root === C), JSON.stringify(m4.knownRoots()));
ok("⑤ 指向死项目的会话行也一并丢掉", m4.sessionRootOf("sid-2") === undefined, String(m4.sessionRootOf("sid-2")));
ok("⑤ 最近活跃回落到活着的那个（不是死项目）", m4.mostRecentRoot()?.root === C, JSON.stringify(m4.mostRecentRoot()));

console.log("── ⑥ 存档坏了不致命 ───────────────────────────────────────");
fs.writeFileSync(storeFile, "{ 这不是 JSON", "utf8");
const m5 = await boot();
ok("⑥ 坏存档不抛异常，进程照常起来", typeof m5.knownRoots === "function");
ok("⑥ 坏存档 ⇒ 当作没有（清单为空）", m5.knownRoots().length === 0, JSON.stringify(m5.knownRoots()));
m5.rememberSessionRoot("sid-9", A);
const w5 = m5.flushBoardRootsStore();
const m6 = await boot();
ok("⑥ 坏存档能被一份新的好存档覆盖掉", w5.ok === true && m6.knownRoots().length === 1, JSON.stringify(m6.knownRoots()));

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
fs.rmSync(home, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
