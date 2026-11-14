// _probe-d352-shuffle.mjs —— 终极验证：把项目文件**真随机打乱**，看还能不能找回来
// ★ 用户原话（D352）："如果我将项目内的所有文件随机打乱，那么工具仍然能够准确找到自己需要的文件"
// ★ 判据：打乱必须**同时破坏**这三样，否则测不出真本事：
//   ① 文件名（连 .md 都改掉，改成 .txt / 无扩展名 / 随机串）
//   ② 目录结构（塞进任意深度的新目录）
//   ③ 清单文件本身（.dsh-ledger.json 也改名 —— 那才是最狠的情况）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  newProjectId, applyFingerprint, parseFingerprint, scanBlind,
  discoverProject, rebuildFromFingerprints,
} from "../lib/fingerprint.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);
const rnd = () => crypto.randomBytes(4).toString("hex");

// ══════════════════════════════════════════════════════════
// 造一个"真实形状"的项目
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-shuffle-"));
const PROJ = newProjectId();
const root = path.join(tmp, "proj");
const mem = path.join(root, "memory-root");

console.log(`临时项目: ${root}`);
console.log(`projectId: ${PROJ}`);

function write(rel, content, id) {
  const abs = path.join(mem, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = id === undefined ? content : applyFingerprint(content, { ...id, project: PROJ }).text;
  fs.writeFileSync(abs, text, "utf8");
  return abs;
}

// 单例文件
write("LEDGER.md", "# 台账\n\n## 第一节\n内容A\n\n## 第二节\n内容B\n", { kind: "active", key: "-" });
write("JOURNAL.md", "# 流水\n记录\n", { kind: "journal", key: "-" });
write("PRINCIPLES.md", "# 原则\n不许乱来\n", { kind: "principles", key: "-" });
write("SECURITY.md", "# 安全\n记住\n", { kind: "security", key: "-" });
// 卡片
write("decisions/D195.md", "## D195 · 决定一\n理由一\n", { kind: "decisions", key: "D195" });
write("decisions/D196.md", "## D196 · 决定二\n理由二\n", { kind: "decisions", key: "D196" });
write("decisions/D197.md", "## D197 · 决定三\n理由三\n", { kind: "decisions", key: "D197" });
write("lessons/L1.md", "## 教训 L1\n根因一\n", { kind: "lessons", key: "L1" });
write("lessons/E2.md", "## 经验 E2\n出处一\n", { kind: "lessons", key: "E2" });
write("goals/g1.md", "## 目标 g1\n根目标\n", { kind: "goals", key: "g1" });
// 清单（说它是 JSON，也给它加个"体"但指纹加不进去 —— JSON 不能有注释行，所以它故意没有指纹）
fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), JSON.stringify({ memoryRoot: "memory-root", projectId: PROJ }, null, 2), "utf8");

const before = {
  active: path.join(mem, "LEDGER.md"),
  journal: path.join(mem, "JOURNAL.md"),
  d195: path.join(mem, "decisions", "D195.md"),
};
console.log(`原始：${fs.readdirSync(mem).join(", ")}\n`);

// ══════════════════════════════════════════════════════════
console.log("=== 1. 先确认：打乱前能正常认出来 ===");
{
  const scan = scanBlind(root, { project: PROJ });
  eq("扫到带指纹的文件数", scan.scanned >= 10, true);
  eq("active 唯一", (scan.byKind.get("active") ?? []).length, 1);
  eq("decisions 有 3 张", (scan.byKind.get("decisions") ?? []).length, 3);
  eq("byProject 记到本项目", scan.byProject.get(PROJ), 10);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. ★★★ 真·随机打乱（改名 + 改扩展名 + 换目录 + 塞深）===");
{
  // 收集所有文件
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all.push(p);
    }
  };
  walk(mem);
  console.log(`  打乱 ${all.length} 个文件`);

  // 先全部搬到暂存区（避免自己踩自己）
  const staging = path.join(tmp, "staging");
  fs.mkdirSync(staging, { recursive: true });
  const moved = [];
  for (const p of all) {
    const name = rnd() + rnd();
    const dst = path.join(staging, name);
    fs.renameSync(p, dst);
    moved.push({ src: p, dst, origName: path.basename(p) });
  }
  // 清掉空目录树
  fs.rmSync(mem, { recursive: true, force: true });
  fs.mkdirSync(mem, { recursive: true });

  // 随机塞进任意深度的新目录，并随机决定要不要保留 .md
  const depths = [0, 1, 2, 3, 4, 5];
  const exts = ["", ".md", ".txt", ".dat", ".json2", ".weird"];
  let i = 0;
  for (const m of moved) {
    const d = depths[i % depths.length];
    let dir = mem;
    for (let k = 0; k < d; k += 1) dir = path.join(dir, "d" + rnd());
    fs.mkdirSync(dir, { recursive: true });
    const ext = exts[i % exts.length];
    const base = path.basename(m.dst);
    const dst = path.join(dir, base + ext);
    fs.renameSync(m.dst, dst);
    i += 1;
  }
  fs.rmSync(staging, { recursive: true, force: true });

  // 统计：确实一个原名都没剩下
  const allAfter = [];
  const walk2 = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk2(p);
      else allAfter.push(p);
    }
  };
  walk2(mem);
  console.log(`  打乱后 ${allAfter.length} 个文件`);
  const anyOriginal = allAfter.filter((p) => /^(LEDGER|JOURNAL|PRINCIPLES|SECURITY|D19[5-7]|L1|E2|g1)\.md$/.test(path.basename(p)));
  eq("★ 原名一个都没剩", anyOriginal.length, 0);

  // 旧路径全失效
  eq("旧路径 LEDGER.md 已不存在", fs.existsSync(before.active), false);
  eq("旧路径 decisions/D195.md 已不存在", fs.existsSync(before.d195), false);
  eq("清单也改了名（.dsh-ledger.json 不在了）", fs.existsSync(path.join(mem, ".dsh-ledger.json")), false);

  // ══════════════════════════════════════════════════════════
  console.log("\n=== 3. ★★★★★ 盲扫：连扩展名都不认，还能认出全部 10 个吗 ===");
  const scan = scanBlind(root, { project: PROJ });
  console.log(`  扫了 ${scan.scanned} 个文件（二进制 ${scan.skippedBinary} · 超大 ${scan.skippedBig} · 不可读 ${scan.unreadable}）`);
  eq("★★ active 找到了", (scan.byKind.get("active") ?? []).length, 1);
  eq("★★ journal 找到了", (scan.byKind.get("journal") ?? []).length, 1);
  eq("★★ principles 找到了", (scan.byKind.get("principles") ?? []).length, 1);
  eq("★★ security 找到了", (scan.byKind.get("security") ?? []).length, 1);
  eq("★★ decisions 3 张全找到", (scan.byKind.get("decisions") ?? []).length, 3);
  eq("★★ lessons 2 张全找到", (scan.byKind.get("lessons") ?? []).length, 2);
  eq("★★ goals 1 张找到", (scan.byKind.get("goals") ?? []).length, 1);

  // key 也恢复了
  const dKeys = (scan.byKind.get("decisions") ?? []).map((x) => x.key).sort();
  eq("★★ key 全部恢复", JSON.stringify(dKeys), JSON.stringify(["D195", "D196", "D197"]));

  // 内容也还能读出来（证明找对了文件，不是随便凑）
  const act = scan.byKind.get("active")[0];
  const actText = fs.readFileSync(act.abs, "utf8");
  ok("★★ 找到的 active 内容正确（含「内容A」）", actText.includes("内容A"), actText.slice(0, 80));

  // ══════════════════════════════════════════════════════════
  console.log("\n=== 4. ★★★★★ 没有清单、没有文件名 ⇒ 自举重建 ===");
  const disc = discoverProject(root, { project: PROJ });
  eq("★★★ 发现项目成功", disc.ok, true);
  if (disc.ok) {
    eq("★★★ 认出本项目", disc.project, PROJ);
    eq("★★★ 认出 7 类", Object.keys(disc.kinds).length >= 7, true);
    console.log("     各类文件数:", Object.fromEntries(Object.entries(disc.kinds).map(([k, v]) => [k, v.length])));
  }

  const rebuilt = rebuildFromFingerprints(root, { project: PROJ });
  eq("★★★ 重建成功", rebuilt.ok, true);
  if (rebuilt.ok) {
    eq("★★★ 重建后 active 唯一", (rebuilt.byKind.get("active") ?? []).length, 1);
    eq("★★★ 重建后 decisions 3 张", (rebuilt.byKind.get("decisions") ?? []).length, 3);
    console.log("     warnings:", rebuilt.warnings.length === 0 ? "（无）" : rebuilt.warnings);
  }

  // ══════════════════════════════════════════════════════════
  console.log("\n=== 5. 但必须敢说「认不出」（不许硬凑）===");
  // 造一个没有指纹的假文件，它不该被认成任何东西
  const noise = path.join(mem, "noise-" + rnd());
  fs.writeFileSync(noise, "# 一个普通 Markdown\n没有指纹\n", "utf8");
  const scan2 = scanBlind(root, { project: PROJ });
  eq("★ 无指纹文件不被计入", scan2.byProject.get(PROJ), 10);

  // 造一个别的项目的 active ⇒ 应报"不唯一/不替选"
  const OTHER = newProjectId();
  const otherDir = path.join(mem, "other-" + rnd());
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "x"), applyFingerprint("# 别的项目\n", { kind: "active", project: OTHER, key: "-" }).text, "utf8");
  const disc2 = discoverProject(root, {});
  eq("★ 两个项目混在一起 ⇒ 拒绝替你选", disc2.ok, false);
  ok("★ 并列出候选", Array.isArray(disc2.candidates) && disc2.candidates.length === 2, JSON.stringify(disc2.candidates));
  fs.rmSync(otherDir, { recursive: true, force: true });

  // ══════════════════════════════════════════════════════════
  console.log("\n=== 6. 指纹被改坏 ⇒ 必须排除（防「看起来对其实不对」）===");
  {
    const scan3 = scanBlind(root, { project: PROJ });
    const target = scan3.byKind.get("journal")[0].abs;
    const t = fs.readFileSync(target, "utf8");
    // 把 project 改掉但不改 check
    const broken = t.replace(/project=([0-9a-f]{16})/, "project=" + "0".repeat(16));
    fs.writeFileSync(target, broken, "utf8");
    const scan4 = scanBlind(root, { project: PROJ });
    eq("★ 改坏 project 后，journal 不再被认（本项目视角）", (scan4.byKind.get("journal") ?? []).length, 0);

    // ★★★ 2026-10-28（D356）**行为已变，断言随之修正**：
    //   旧断言要求"记进 bad"。但改成**三载体**之后，三处载体里**只有一处**被改坏时，
    //   `readFingerprint3` 会判定「多载体身份不一致」⇒ ok:false ⇒ 走 bad 分支（能记）。
    //   而这里只改了 **frontmatter 那一处的 project**，另外两处（link/inline）仍是原值 ⇒
    //   readFingerprint3 返回「不一致」⇒ 应当记进 bad。
    //   ★ 若 bad 为空，说明**三载体没有被一致地改写**（例如 replace 只命中了一处），
    //     那反而是更值得警惕的情况 —— 所以下面把两种情况都报出来。
    const badHit = scan4.bad.length >= 1;
    if (!badHit) {
      console.log(`     ⚠ bad 为空。检查：文件里还有几处旧 project？`);
      const cnt = (fs.readFileSync(target, "utf8").match(new RegExp(PROJ, "g")) ?? []).length;
      console.log(`     原 project 仍出现 ${cnt} 次（若 >0 说明只改了一处，另两处仍有效 ⇒ 身份仍可认）`);
    }
    ok("★ 并且被记进 bad 列表（三处不一致必须报）", badHit, JSON.stringify(scan4.bad.slice(0, 2)));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
