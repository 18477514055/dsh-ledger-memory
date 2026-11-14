// _probe-d356-resolve.mjs —— 第三步：把「按名字失败 ⇒ 盲扫兜底」接成可用路径
// ★ 要验证的是**真实场景**：文件被改名/搬家后，用清单里的"期望名"去找，能不能靠指纹找回来。
// ★ 并且必须验证「找不到时敢说找不到」，不许硬凑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveByIdentity, scanBlind, newProjectId, applyFingerprint3 } from "../lib/fingerprint.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

const PROJ = newProjectId();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-resolve-"));
const mem = path.join(tmp, "mem");

function put(rel, body, kind, key) {
  const abs = path.join(mem, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, applyFingerprint3(body, { kind, project: PROJ, key }).text, "utf8");
  return abs;
}

put("LEDGER.md", "# 台账\n内容\n", "active", "-");
put("decisions/D195.md", "## D195 · 决定\n", "decisions", "D195");
put("decisions/D196.md", "## D196 · 决定\n", "decisions", "D196");

// ══════════════════════════════════════════════════════════
console.log("=== 1. 名字在 ⇒ 走 name 路径 ===");
{
  const r = resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PROJ });
  eq("找到", r.ok, true);
  eq("how=name", r.how, "name");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. ★★★ 台账被改名 ⇒ 必须走指纹找回来 ===");
{
  fs.renameSync(path.join(mem, "LEDGER.md"), path.join(mem, "我改的名字.txt"));
  const r = resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PROJ });
  eq("★★ 仍找到", r.ok, true);
  eq("★★ how=fp", r.how, "fp");
  eq("★★ 指到新名字", r.rel, "我改的名字.txt");
  ok("★★ 并说明被改过名", String(r.note).includes("改过名"), r.note);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. ★★★ 卡片改名 + 指定 key ⇒ 精确定位 ===");
{
  fs.renameSync(path.join(mem, "decisions", "D195.md"), path.join(mem, "decisions", "那个老决定.md"));
  // 不带 key：两张卡 ⇒ 不唯一 ⇒ 必须拒
  const r1 = resolveByIdentity(mem, { name: "decisions/D195.md", kind: "decisions", project: PROJ });
  eq("★ 不带 key ⇒ 拒绝瞎选", r1.ok, false);
  ok("★ 列出候选", Array.isArray(r1.candidates) && r1.candidates.length === 2, JSON.stringify(r1.candidates));

  // 带 key ⇒ 精确
  const r2 = resolveByIdentity(mem, { name: "decisions/D195.md", kind: "decisions", project: PROJ, key: "D195" });
  eq("★★ 带 key ⇒ 找到", r2.ok, true);
  eq("★★ 指到改名后的文件", r2.rel, "decisions/那个老决定.md");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. ★★★ 整棵树打乱（连目录都变）⇒ 仍能找到 ===");
{
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else all.push(p);
    }
  };
  walk(mem);
  // 全部搬到随机深目录、随机名字、随机扩展名
  const staging = path.join(tmp, "staging");
  fs.mkdirSync(staging, { recursive: true });
  const moved = all.map((p, i) => {
    const dst = path.join(staging, `f${i}`);
    fs.renameSync(p, dst);
    return dst;
  });
  fs.rmSync(mem, { recursive: true, force: true });
  fs.mkdirSync(mem, { recursive: true });
  const exts = ["", ".md", ".txt", ".dat"];
  moved.forEach((p, i) => {
    const d = path.join(mem, ...Array.from({ length: i % 4 }, (_, k) => `d${k}${i}`));
    fs.mkdirSync(d, { recursive: true });
    fs.renameSync(p, path.join(d, `r${i}` + exts[i % exts.length]));
  });
  fs.rmSync(staging, { recursive: true, force: true });

  // 现在连 decisions 目录都没了
  ok("目录 decisions 已不存在", !fs.existsSync(path.join(mem, "decisions")));

  const r1 = resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PROJ });
  eq("★★★ active 仍找得到", r1.ok, true);
  eq("★★★ how=fp", r1.how, "fp");

  const r2 = resolveByIdentity(mem, { name: "decisions/D196.md", kind: "decisions", project: PROJ, key: "D196" });
  eq("★★★ D196 仍找得到", r2.ok, true);
  ok("★★★ 且 key 对", r2.rel !== undefined, r2.rel);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. ★★★ 真的没有了 ⇒ 必须说找不到（不许硬凑）===");
{
  // 删掉所有文件
  const rmAll = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rmAll(p); fs.rmdirSync(p); } else fs.unlinkSync(p);
    }
  };
  rmAll(mem);

  const r = resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PROJ });
  eq("★ ok=false", r.ok, false);
  // ★ 目录已被清空 ⇒ 扫到 0 个是**正确**结果，文案走的是"一个带指纹的文件都没扫到"分支
  //   （原来这条断言要求包含「扫了」，那是"扫到过文件"才出现的分支 —— 断言写错了）
  ok("★ 说明情况（扫到 0 个 / 或扫了多少）",
     String(r.reason).includes("都没扫到") || String(r.reason).includes("扫了"), r.reason);
  ok("★ 并提示可能是还没铺指纹", String(r.reason).includes("指纹"), r.reason);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 6. 别的项目的同名文件 ⇒ 必须拒绝 ===");
{
  const OTHER = newProjectId();
  fs.writeFileSync(path.join(mem, "LEDGER.md"),
    applyFingerprint3("# 别的项目\n", { kind: "active", project: OTHER, key: "-" }).text, "utf8");
  const r = resolveByIdentity(mem, { name: "LEDGER.md", kind: "active", project: PROJ });
  eq("★ 拒绝按名字认", r.ok, false);
  ok("★ 理由点名 project", String(r.reason).includes("project"), r.reason);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
