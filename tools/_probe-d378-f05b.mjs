// F-05 后半段的本机替代夹具（D378 · v2 修正顺序）
// ① 报告原稿用 symlinkSync 让根 `.dsh-ledger.json` 写入失败 —— 本机 EPERM（与 6 条既有 SKIP 同源）。
//    替代：把根清单位置做成**目录** ⇒ writeFileAtomic 必然失败，效果等价且不需软链。
// ② ★ v1 的顺序错了：在一次「失败的修复」之后才去断言 INDEX.md —— 那次修复根本没走到写索引，
//    于是断言必然假红。**修正：先做一次成功修复核索引标题，再另起一次失败修复核镜像。**
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const targetDir = path.resolve(process.argv[2] || process.cwd());
const imp = (rel) => import(pathToFileURL(path.join(targetDir, rel)).href);
const initToolMod = await imp("lib/init-tool.js");
const part4Mod = await imp("lib/part4.js");

const initTool = initToolMod.defineInitTool();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log("PASS  " + name + (detail ? " — " + detail : "")); }
  else { fail += 1; console.log("FAIL  " + name + (detail ? " — " + detail : "")); }
};

async function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const r = await initTool.execute(
    { active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", root },
    { cwd: root },
  );
  if (!r.ok) throw new Error("init 失败: " + r.error);
  const memRootAbs = path.join(root, r.memoryRoot);
  const decDir = path.join(memRootAbs, "decisions");
  // 清空卡片、只留一个待迁移的单文件 ⇒ repair 会重建索引
  for (const f of fs.readdirSync(decDir)) fs.unlinkSync(path.join(decDir, f));
  fs.writeFileSync(path.join(memRootAbs, "DECISIONS.md"), "# 关键决策\n\n## D1 · 测试决策\n- 内容\n", "utf8");
  return { root, memRootAbs, decDir };
}

// ── 阶段 A：成功修复 ⇒ 核索引标题（报告 F-05 ③）
{
  const { root, decDir } = await makeRoot("dsh-f05c-");
  const rep = part4Mod.repairConformance(root, { apply: true });
  ok("A1 修复成功（ok=true）", rep.ok === true, String(rep.ok));
  const idx = path.join(decDir, "INDEX.md");
  const first = fs.existsSync(idx) ? fs.readFileSync(idx, "utf8").split("\n")[0] : "(INDEX.md 不存在)";
  ok("A2 ★ 索引标题为『# 索引 · 关键决策』（不是英文键 decisions）", first.includes("# 索引 · 关键决策"), first);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// ── 阶段 B：根清单写失败 ⇒ 核镜像未被提前写（报告 F-05 ①，D303 写序）
{
  const { root, memRootAbs } = await makeRoot("dsh-f05d-");
  const mirrorMf = path.join(memRootAbs, ".dsh-ledger.json");
  const rootMf = path.join(root, ".dsh-ledger.json");
  if (fs.existsSync(mirrorMf)) fs.unlinkSync(mirrorMf);
  ok("B1 前置：镜像不存在", !fs.existsSync(mirrorMf));

  fs.renameSync(rootMf, path.join(root, "_mf-backup.json"));
  fs.mkdirSync(rootMf); // 目录占位 ⇒ 写文件必失败

  const rep = part4Mod.repairConformance(root, { apply: true });
  ok("B2 根清单确实写失败（ok=false）", rep.ok === false, String(rep.reason ?? "").slice(0, 60));
  ok("B3 ★★ 镜像一个字节都没被碰（D303 写序）", !fs.existsSync(mirrorMf), "mirror exists=" + fs.existsSync(mirrorMf));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("F05B-PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
