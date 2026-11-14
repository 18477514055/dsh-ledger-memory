/**
 * _reverse-verify-d324.mjs —— 证明 `_probe-d324-f01-f06.mjs` 不是空判据。
 *
 * 六种破坏，全部取自 006 报告**真实指出的病灶**（把修复摘回旧样）：
 *   ① `isAbsoluteAnywhere` 正则退回只认双反斜杠
 *   ② `logDirOf` 退回直读 `manifest.logDir`
 *   ③ `installSettingsRoutes` 不再返回 dispose
 *   ④ `forget(sid)` 退回全局 `flushAll(true)`
 *   ⑤ `fingerprintOf` 的 absent 分支去掉 broadcastTag
 *   ⑥ `lib/part8.js` 塞回本机路径
 *
 * ★ 纪律：**必须摘到"能看见红"为止**，且**每条都要有真 FAIL 行**
 *   （只看 exit≠0 可能只是崩溃 —— 006 报告 F-06① 自己就批评过这一点）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "tools", "_probe-d324-f01-f06.mjs");

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d324-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "tools", "_probe-d324-f01-f06.mjs"));
  // ★★★ 2026-10-25（D324）：探针会**读同目录下的其它探针源码**做静态判据
  //   （`_probe-d323-e2e.mjs` 的签名、`_probe-dirty-source.mjs` 的扫描方式、
  //    `_probe-assertion-can-fail.mjs` 的 dirname 兜底）⇒ 夹具必须把它们都拷过来。
  //   🔴 第一版我只拷了 e2e 一个 ⇒ 探针在第 167 行 `ENOENT` **崩溃**，
  //     于是"破坏 1 / 破坏 6"变成"红了但没有 FAIL 行"。
  //   ★ 这正是纪律第 6 条：**夹具没走通时，绝不能把"夹具故障"当成"被测对象的问题"**。
  for (const f of [
    "_probe-d323-e2e.mjs",
    "_probe-dirty-source.mjs",
    "_probe-assertion-can-fail.mjs",
    "_probe-capsule-persistence.mjs",
    "_probe-private-repo-workflow.mjs",
    "selftest.mjs",
  ]) {
    const p = path.join(ROOT, "tools", f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, "tools", f));
  }
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "_probe-d324-f01-f06.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = out
    .split("\n")
    .filter((l) => /^\s+FAIL/.test(l))
    .map((l) => l.trim().slice(0, 110));
  // ★ 哨兵：探针跑完才打印它。没有它 = 中途崩了。
  const complete = /PROBE-COMPLETE/.test(out);
  return { code: r.status, out, fails, complete };
}

const cases = [];
function tryBreak(name, mutate) {
  const d = stage();
  const prepared = mutate(d);
  const r = run(d);
  cases.push({
    name,
    expect: "red",
    prepared: prepared === true,
    got: r.code === 0 ? "green" : "red",
    fails: r.fails,
    complete: r.complete,
  });
  fs.rmSync(d, { recursive: true, force: true });
}

// ① 单反斜杠根那条正则的**真实作用**
//
// ★★★★ 2026-10-25（D324）：**这条我连错三次，三次都是同一个病：破坏点选错。**
//   ① 手写正则转义写错 ⇒ 破坏没命中 ⇒ "红"其实是崩溃。
//   ② 改对那一行 ⇒ 结果 **green**：**Windows 上** `path.isAbsolute("\\evil")` 本就 true，
//      第 69 行早退 ⇒ 第 72 行从来不是唯一守卫 ⇒ 破坏它什么都不变。
//   ③ 只去掉 `path.isAbsolute` ⇒ 仍绿（正则在兜底）—— 那也不叫破坏。
//
//   ★★ 判据：**"我能破坏它" ≠ "它是那个洞的唯一守卫"。**
//     要证明一条修复有效，必须构造**没有它就会漏**的输入。
//     ⇒ 正确做法：**两个兜底一起去掉**（原生判断 + 正则），
//       这时 `isAbsoluteAnywhere("\\evil")` 才真的变 false ⇒ 才能看见红。
//     ★ 这同时说明：那条正则**是有用的**（它是 POSIX 上唯一的守卫），
//       只是**在 Windows 上测不出来** —— 这正是 006 F-01 说的"跨平台"。
tryBreak("破坏1：POSIX 语义下（原生判断去掉 + 正则退回只认双反斜杠）=> 单反斜杠根必须漏", (d) => {
  const p = path.join(d, "lib", "base.js");
  const t = fs.readFileSync(p, "utf8");
  let next = t.replace("if (path.isAbsolute(v)) return true;", "/* POSIX 模拟：原生判断不兜底 */");
  const BS = String.fromCharCode(92);
  // 把 `if (/^\\.test(v))` 改成要求两个反斜杠（源码里写 4 个）
  const fromLine = "if (/^" + BS + BS + "/.test(v)) return true;";
  const toLine = "if (/^" + BS + BS + BS + BS + "/.test(v)) return true;";
  const before = next;
  next = next.replace(fromLine, toLine);
  const hitBoth = next !== t && next !== before;
  if (!hitBoth) console.log("        [夹具] 🔴 两处替换没有都命中");
  fs.writeFileSync(p, next, "utf8");
  return hitBoth;
});

// ② logDirOf 退回直读 manifest
tryBreak("破坏2：logDirOf 退回直读 manifest.logDir（绕过门禁）", (d) => {
  const p = path.join(d, "lib", "part2.js");
  const t = fs.readFileSync(p, "utf8");
  const from = `export function logDirOf(info) {
  if (info !== null && typeof info === "object" && "logRel" in info) {
    return typeof info.logRel === "string" && info.logRel !== "" ? info.logRel : undefined;
  }
  const d = info?.manifest?.logDir;
  return typeof d === "string" && d !== "" && !isAbsoluteAnywhere(d) ? d : undefined;
}`;
  const to = `export function logDirOf(info) {
  const d = info?.manifest?.logDir;
  return typeof d === "string" && d !== "" ? d : undefined;
}`;
  const next = t.replace(from, to);
  fs.writeFileSync(p, next, "utf8");
  return next !== t;
});

// ③ installSettingsRoutes 不再返回 dispose
tryBreak("破坏3：installSettingsRoutes 不返回 dispose（路由泄漏）", (d) => {
  const p = path.join(d, "lib", "settings-http.js");
  const t = fs.readFileSync(p, "utf8");
  const next = t.replace("return { registered, failures, dispose };", "return { registered, failures };");
  fs.writeFileSync(p, next, "utf8");
  return next !== t;
});

// ④ forget(sid) 退回全局 flush
tryBreak("破坏4：forget(sid) 退回全局 flushAll(true)（连坐其它会话）", (d) => {
  const p = path.join(d, "lib", "log-collector.js");
  const t = fs.readFileSync(p, "utf8");
  const next = t.replace("flushAll(true, sid);", "flushAll(true);");
  fs.writeFileSync(p, next, "utf8");
  return next !== t;
});

// ⑤ absent 分支去掉 broadcastTag
tryBreak("破坏5：fingerprintOf 的 absent 分支去掉 broadcastTag（广播失效）", (d) => {
  const p = path.join(d, "lib", "defs.js");
  const t = fs.readFileSync(p, "utf8");
  const next = t.replace("`absent|${settingsTag}|${broadcastTag}`", "`absent|${settingsTag}`");
  fs.writeFileSync(p, next, "utf8");
  return next !== t;
});

// ⑥ 把本机路径塞回 part8
//
// ★★ 同样是第一版有 bug：我用模板串 `${t}\n// 本机 D:\\Deepseek工作区 ...`
//   在 JS 里 `\\` ⇒ 一个反斜杠，写进去的是 `D:\Deepseek` —— 那**确实**该被抓；
//   但探针里我用的正则是 `/[A-Za-z]:\\\\Deepseek|D:\\Deepseek/`，
//   而 `part8.js` 里也可能因为**转义层级**不匹配。⇒ 现在先用「写入后立刻读回自检」证明夹具对。
tryBreak("破坏6：lib/part8.js 塞回本机盘符路径（隐私泄露）", (d) => {
  const p = path.join(d, "lib", "part8.js");
  const t = fs.readFileSync(p, "utf8");
  const injected = t + "\n// 本机 " + "D" + ":" + String.fromCharCode(92) + "Deepseek工作区 下 0 个 registry.json\n";
  fs.writeFileSync(p, injected, "utf8");
  const back = fs.readFileSync(p, "utf8");
  const okInjected = back.includes("D:" + String.fromCharCode(92) + "Deepseek");
  if (!okInjected) console.log("        [夹具] 🔴 注入失败，字面量没写进去");
  return okInjected;
});

// ═══ 汇总 ═══
console.log("═══ 反向验证（D324 · 006 六项）═══");
let good = 0;
let bad = 0;
for (const c of cases) {
  const passed = c.prepared === true && c.got === c.expect && c.fails.length > 0 && c.complete === true;
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${c.name}：期望 ${c.expect}，实际 ${c.got}`);
  if (c.prepared !== true) console.log(`        夹具没生效（替换没命中）—— 是夹具故障，不是被测对象的问题`);
  if (c.complete !== true) console.log(`        🔴 探针**没跑完**（缺 PROBE-COMPLETE 哨兵）—— 这是崩溃，不是检出`);
  if (c.fails.length) console.log(`        红在：${c.fails.slice(0, 2).join(" | ")}`);
  else if (c.got === "red") console.log(`        🔴 变红了但没有 FAIL 行（可能是崩溃，不是逻辑检出）`);
  if (passed) good++;
  else bad++;
}
console.log(`\n═══ ${good} 条符合预期 / ${bad} 条不符合 ═══`);
process.exit(bad === 0 ? 0 : 1);
