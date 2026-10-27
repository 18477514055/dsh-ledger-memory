/**
 * _reverse-verify-d330.mjs —— 反向验证 D330 那条新守卫（125⑨）**真的会红**
 *
 * ★ 为什么必须做（纪律第 10 条）：**反向验证必须摘到"能看见红"为止**。
 *   125⑨ 是我为"空卡片目录不许被放宽"新加的守卫。
 *   如果摘掉 `cards === 0` 它仍然全绿 ⇒ 说明这条断言太弱（或者在测别的东西），
 *   那就等于白加 —— 而本项目已经有前科（`122⑤` 曾被 D327 查出是假阳性）。
 *
 * ★ 做法（一次性副本上，绝不碰生产工作区 —— 纪律：验回滚/验破坏都在副本上）：
 *   ① 把当前 lib/ 整套复制到 %TEMP%
 *   ② 在副本上摘掉 `cards === 0`（模拟"被放宽"的那个世界）
 *   ③ 让 selftest 指向这个副本跑，看它是否变红
 *   ④ 恢复 ⇒ 必须重新变绿（证明红的成因就是那一处）
 *
 * ★ 哨兵：输出 `PROBE-COMPLETE`，且**每条破坏都要报 prepared/got**，
 *   不许出现"没跑完就报检出"（D324 那条坑）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const results = [];
let pass = 0;
let fail = 0;

function log(s) {
  console.log(s);
}

function record(name, prepared, gotRed, sentinel) {
  const hit = prepared === true && gotRed === true && sentinel === true;
  if (hit) pass += 1;
  else fail += 1;
  results.push({ name, prepared, gotRed, sentinel, hit });
  console.log(`  ${hit ? "✓ 检出" : "✗ 未检出"}  ${name}  —— prepared=${prepared} got=${gotRed ? "red" : "green"} 哨兵=${sentinel}`);
}

// ── 一次性副本：整套 lib/ 复制（含 package.json 的 type:module 语义由根 package.json 提供） ──
function stageCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rev-d330-"));
  const lib = path.join(d, "lib");
  fs.mkdirSync(lib, { recursive: true });
  for (const n of fs.readdirSync(path.join(REPO, "lib")).filter((x) => x.endsWith(".js"))) {
    fs.copyFileSync(path.join(REPO, "lib", n), path.join(lib, n));
  }
  // ★ selftest 通过相对路径 `lib/` 找模块 ⇒ 复制 tools 过去时也要让它看到同一棵树
  fs.cpSync(path.join(REPO, "tools"), path.join(d, "tools"), {
    recursive: true,
    filter: (src) => !/_probe-|_reverse-|_condense-|_diag-|_arch-|_prep-|_msg-|_run-|_cut-|_measure-|_audit-/.test(path.basename(src)),
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  // ★★ 夹具补全（第一次就是漏了这个 ⇒ ENOENT README.md，白跑一轮）：
  //    selftest 会读**包面文件**（README / LICENSE / cordis.patch.yml / .gitignore 模板等）。
  //    **凡是 `tools/` 与 `lib/` 以外、被 selftest 读到的根文件，都必须一起复制**。
  for (const n of fs.readdirSync(REPO)) {
    const src = path.join(REPO, n);
    const st = fs.statSync(src);
    if (!st.isFile()) continue;
    if (n === "package.json") continue; // 已写
    fs.copyFileSync(src, path.join(d, n));
  }
  return { dir: d, lib };
}

// ── 跑 selftest 副本，返回 { ran, green, failCount, out } ──
function runSelftest(copyDir) {
  const r = spawnSync(process.execPath, [path.join(copyDir, "tools", "selftest.mjs")], {
    cwd: copyDir,
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: "github.com" },
  });
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  // ★ 哨兵：必须看到"合计：PASS … · FAIL …"那一行，否则视为没跑完（不许当检出）
  const m = /合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/.exec(out);
  const ran = m !== null;
  const failCount = m === null ? -1 : Number(m[3]);
  // 更精确：直接看那 5 条新断言有没有 FAIL
  const guardFailed = /FAIL\s+125⑨/.test(out);
  return { ran, failCount, guardFailed, out, totals: m === null ? null : { pass: Number(m[1]), skip: Number(m[2]), fail: Number(m[3]) } };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 未改副本：必须全绿（建立"绿"的基线）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ① 基线：未改动的副本必须全绿 ═══");
const base = stageCopy();
const baseRun = runSelftest(base.dir);
console.log(`      哨兵=${baseRun.ran} 合计=${JSON.stringify(baseRun.totals)}`);
if (!baseRun.ran) {
  console.log("      🔴 夹具没跑通 ⇒ 报 PROBE-FAILED，**不把夹具故障当被测对象的问题**（纪律第 6 条）");
  console.log(String(baseRun.out).slice(-2000));
  fs.rmSync(base.dir, { recursive: true, force: true });
  console.log("PROBE-FAILED");
  process.exit(1);
}
const baseGreen = baseRun.totals !== null && baseRun.totals.fail === 0;
console.log(`      基线绿=${baseGreen}（125⑨ 全过=${!baseRun.guardFailed}）`);

// ══════════════════════════════════════════════════════════════════════════
// ② 破坏一：摘掉 `cards === 0`（模拟 011 补丁把硬约束放宽的那个世界）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ② 破坏一：摘掉 conformanceOf 里的 `cards === 0` ═══");
{
  const copy = stageCopy();
  const p2 = path.join(copy.lib, "part2.js");
  const src = fs.readFileSync(p2, "utf8");
  const NEEDLE = "if (!dirOk || cards === 0 || hasUnmigratedSingleFile) {";
  const prepared = src.includes(NEEDLE);
  if (prepared) {
    fs.writeFileSync(p2, src.replace(NEEDLE, "if (!dirOk || hasUnmigratedSingleFile) {"), "utf8");
  }
  console.log(`      破坏已植入=${prepared}`);
  const run = runSelftest(copy.dir);
  console.log(`      哨兵=${run.ran} 合计=${JSON.stringify(run.totals)} 125⑨见红=${run.guardFailed}`);
  record("破坏 ①：摘掉 `cards === 0` ⇒ 125⑨ 必须见红", prepared, run.guardFailed, run.ran);
  if (run.guardFailed) {
    const lines = String(run.out).split(/\r?\n/).filter((l) => /FAIL\s+125⑨/.test(l));
    for (const l of lines) console.log(`         ${l.trim()}`);
  }
  fs.rmSync(copy.dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 破坏二：摘掉 `fixable.push`（让它变成"永远修不好的红"）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ③ 破坏二：让那条红不可修（fixable 不填）═══");
{
  const copy = stageCopy();
  const p2 = path.join(copy.lib, "part2.js");
  const src = fs.readFileSync(p2, "utf8");
  // 只摘卡片模式里那句 fixable.push（保留别的分支，避免误伤）
  const NEEDLE = `        fixable.push(
          dirOk
            ? hasUnmigratedSingleFile
              ? "把旧单文件里的决策切卡搬进卡片目录（\`repairConformance\` 能直接做）"
              : "往卡片目录里补决策卡"
            : \`创建卡片目录 \\\`\${cmode.dirRel}\\\`\`
        );`;
  const prepared = src.includes(NEEDLE);
  if (prepared) {
    fs.writeFileSync(p2, src.replace(NEEDLE, "        /* 破坏：fixable 不填 */"), "utf8");
  }
  console.log(`      破坏已植入=${prepared}`);
  const run = runSelftest(copy.dir);
  console.log(`      哨兵=${run.ran} 合计=${JSON.stringify(run.totals)} 125⑨见红=${run.guardFailed}`);
  record("破坏 ②：fixable 不填 ⇒ 125⑨b 必须见红（红必须可修）", prepared, run.guardFailed, run.ran);
  if (run.guardFailed) {
    const lines = String(run.out).split(/\r?\n/).filter((l) => /FAIL\s+125⑨/.test(l));
    for (const l of lines) console.log(`         ${l.trim()}`);
  }
  fs.rmSync(copy.dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 破坏三：让 `repairConformance` 不再真补卡（能力端退化成只报 action）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ④ 破坏三：repairConformance 只报 action、不真写卡 ═══");
{
  const copy = stageCopy();
  const p4 = path.join(copy.lib, "part4.js");
  const src = fs.readFileSync(p4, "utf8");
  const NEEDLE = "            for (const p of legacyParts) writeCard(mBase, decMode.dirRel, p.key, p.text);";
  const prepared = src.includes(NEEDLE);
  if (prepared) {
    fs.writeFileSync(p4, src.replace(NEEDLE, "            /* 破坏：不真写卡 */"), "utf8");
  }
  console.log(`      破坏已植入=${prepared}`);
  const run = runSelftest(copy.dir);
  console.log(`      哨兵=${run.ran} 合计=${JSON.stringify(run.totals)} 125⑨见红=${run.guardFailed}`);
  record("破坏 ③：repair 不真写卡 ⇒ 125⑨d 必须见红", prepared, run.guardFailed, run.ran);
  if (run.guardFailed) {
    const lines = String(run.out).split(/\r?\n/).filter((l) => /FAIL\s+125⑨/.test(l));
    for (const l of lines) console.log(`         ${l.trim()}`);
  }
  fs.rmSync(copy.dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 破坏四：判据一律判红（"判定过严"那种假修）⇒ 125⑨c 反向那条必须见红
// ══════════════════════════════════════════════════════════════════════════
console.log("\n═══ ⑤ 破坏四：判据一律判红（模拟「干脆永远判不合格」的假修）═══");
{
  const copy = stageCopy();
  const p2 = path.join(copy.lib, "part2.js");
  const src = fs.readFileSync(p2, "utf8");
  const NEEDLE = "if (!dirOk || cards === 0 || hasUnmigratedSingleFile) {";
  const prepared = src.includes(NEEDLE);
  if (prepared) {
    fs.writeFileSync(p2, src.replace(NEEDLE, "if (true) {"), "utf8");
  }
  console.log(`      破坏已植入=${prepared}`);
  const run = runSelftest(copy.dir);
  console.log(`      哨兵=${run.ran} 合计=${JSON.stringify(run.totals)} 125⑨见红=${run.guardFailed}`);
  record("破坏 ④：一律判红 ⇒ 125⑨c（放一张卡回去应转 ok）必须见红", prepared, run.guardFailed, run.ran);
  if (run.guardFailed) {
    const lines = String(run.out).split(/\r?\n/).filter((l) => /FAIL\s+125⑨/.test(l));
    for (const l of lines) console.log(`         ${l.trim()}`);
  }
  fs.rmSync(copy.dir, { recursive: true, force: true });
}

fs.rmSync(base.dir, { recursive: true, force: true });

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  合计：检出 ${pass} / 未检出 ${fail}（共 ${results.length} 个破坏点）`);
for (const r of results) {
  console.log(`    ${r.hit ? "✓" : "✗"} ${r.name}`);
}
if (fail === 0) console.log("  ⇒ 125⑨ 的每一条子断言都是**唯一守卫**（摘掉对应那处就红）");
else console.log("  ⇒ 🔴 有破坏点没见红 ⇒ 对应子断言太弱，必须加强");
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
