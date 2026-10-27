// ★ 只读盘点：决策卡到底住在哪、有没有「写了但插件看不见」的卡。
//   触发：本轮要写 D331 / D333 卡，先确认落点；顺带查 lessons / goals 有没有同型问题。
//   判据：插件读哪个目录 = manifest.memoryRoot + decisionsDir（memoryRoot 相对）。
//   ★ 本探针**只读**，不写盘、不删任何东西。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, ".dsh-ledger.json"), "utf8"));
const MEM = MAN.memoryRoot ? path.join(ROOT, MAN.memoryRoot) : ROOT;

let pass = 0,
  fail = 0;
const ok = (t, c) => (c ? (pass++, console.log(`  PASS  ${t}`)) : (fail++, console.log(`  FAIL  ${t}`)));

console.log("== 0. 清单事实 ==");
console.log(`  memoryRoot   = ${JSON.stringify(MAN.memoryRoot)}`);
console.log(`  decisionsDir = ${JSON.stringify(MAN.decisionsDir)}`);
console.log(`  lessonsDir   = ${JSON.stringify(MAN.lessonsDir)}`);
console.log(`  goalsDir     = ${JSON.stringify(MAN.goalsDir)}`);
console.log(`  解析后的记忆基准 = ${MEM}`);

/** 读一个目录的 .md 卡，返回 {name, bytes, firstLine, ufffd, dupes} */
function scan(dir) {
  if (!fs.existsSync(dir)) return { exists: false, entries: [] };
  const entries = [];
  for (const n of fs.readdirSync(dir)) {
    if (!n.toLowerCase().endsWith(".md")) continue;
    const abs = path.join(dir, n);
    const st = fs.lstatSync(abs);
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(abs);
    const text = buf.toString("utf8");
    const firstLine = (text.split("\n")[0] || "").trim();
    entries.push({
      name: n,
      bytes: st.size,
      firstLine,
      ufffd: (text.match(/\uFFFD/g) || []).length,
      mtime: st.mtime.toISOString(),
      text,
    });
  }
  return { exists: true, entries };
}

function numOf(name) {
  const m = /^([DL]|E|g)(\d+)\.md$/i.exec(name);
  return m ? Number(m[2]) : NaN;
}

for (const [label, rel, prefix] of [
  ["决策卡", MAN.decisionsDir, "D"],
  ["经验教训", MAN.lessonsDir, null],
  ["目标树", MAN.goalsDir, "g"],
]) {
  if (!rel) continue;
  const canon = path.join(MEM, rel);
  const alt = path.join(ROOT, rel);
  const a = scan(canon);
  const b = scan(alt);
  const same = path.resolve(canon) === path.resolve(alt);
  console.log(`\n== ${label}：规范位置 ${canon} (${a.entries.length} 张) ==`);
  if (same) {
    console.log("  （规范位置 = 项目根，无分叉）");
    continue;
  }
  console.log(`  项目根另有一份同名目录 ${alt} → ${b.exists ? `${b.entries.length} 张` : "不存在"}`);
  if (!b.exists || b.entries.length === 0) continue;
  // U+FFFD（编码坏掉的迹象）
  const badA = a.entries.filter((e) => e.ufffd > 0).map((e) => e.name);
  const badB = b.entries.filter((e) => e.ufffd > 0).map((e) => e.name);
  ok(`规范位置无 U+FFFD（坏卡 ${badA.length} 张）`, badA.length === 0);
  ok(`项目根那份无 U+FFFD（坏卡 ${badB.length} 张）`, badB.length === 0);
  const setCanon = new Map(a.entries.map((e) => [e.name, e]));
  console.log("  --- 项目根那份逐张对账 ---");
  for (const e of b.entries.sort((x, y) => (numOf(x.name) || 0) - (numOf(y.name) || 0))) {
    const twin = setCanon.get(e.name);
    if (!twin) {
      console.log(`  ✗ ${e.name.padEnd(10)} ${String(e.bytes).padStart(6)} B  规范位置**没有这张** ← 插件读不到`);
    } else if (twin.bytes === e.bytes && twin.text === e.text) {
      console.log(`  = ${e.name.padEnd(10)} ${String(e.bytes).padStart(6)} B  两处逐字节相同`);
    } else {
      console.log(
        `  ≠ ${e.name.padEnd(10)} 根 ${String(e.bytes).padStart(6)} B / 规范 ${String(twin.bytes).padStart(6)} B  内容不同`,
      );
      console.log(`      根首行  ：${e.firstLine.slice(0, 80)}`);
      console.log(`      规范首行：${twin.firstLine.slice(0, 80)}`);
    }
  }
  const onlyCanon = a.entries.filter((e) => !b.entries.some((x) => x.name === e.name)).length;
  console.log(`  （只在规范位置有的：${onlyCanon} 张）`);
}

console.log("\n== 2. 台账里引用过的卡号是否真能取到 ==");
{
  const led = fs.readFileSync(path.join(MEM, "LEDGER.md"), "utf8");
  const refs = [...new Set((led.match(/\bD\d{2,3}\b/g) || []))].sort((p, q) => Number(p.slice(1)) - Number(q.slice(1)));
  const canon = scan(path.join(MEM, MAN.decisionsDir || "decisions"));
  const have = new Set(canon.entries.map((e) => e.name.replace(/\.md$/i, "")));
  const missing = refs.filter((r) => !have.has(r));
  console.log(`  台账引用 ${refs.length} 个卡号；规范位置缺 ${missing.length} 个`);
  if (missing.length) {
    // 缺的这些，项目根那份里有没有？
    const alt = scan(path.join(ROOT, MAN.decisionsDir || "decisions"));
    const altHave = new Set(alt.entries.map((e) => e.name.replace(/\.md$/i, "")));
    for (const m of missing) {
      console.log(`  - ${m}  规范位置:无  项目根那份:${altHave.has(m) ? "**有（即插件读不到）**" : "也没有"}`);
    }
  }
  ok("台账引用的卡号在规范位置都能取到", missing.length === 0);
}

console.log(`\nPROBE-COMPLETE  ${pass} PASS / ${fail} FAIL`);
