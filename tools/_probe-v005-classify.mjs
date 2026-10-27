/**
 * ★ 005 补丁复核专用：**验证 `_probe-d322` 的豁免判据是否真的能防"退化成裸写"**。
 *
 * 为什么要单独测这一条：
 *   报告给的改法是把「整文件正则豁免」换成「`allowed.length <= 2`（只数条数）」。
 *   ★ 只数条数**只防新增第 3 处**，防不住**已有那处退化成裸写** —— 数量没变、质量变了。
 *   ⇒ 这正是本项目那条纪律：「**记录存在 ≠ 记录准确**」，同型复发。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}  —— ${detail ?? ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  —— ${detail ?? ""}`);
  }
};

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v005cls-"));
  fs.cpSync(path.join(ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "tools", "_probe-d322-f08-f09-f10.mjs"),
    path.join(dir, "tools", "_probe-d322-f08-f09-f10.mjs"),
  );
  return dir;
}

function runProbe(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "tools", "_probe-d322-f08-f09-f10.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ═══ ① 基线：未破坏时必须全绿 ═══
{
  const d = stage();
  const r = runProbe(d);
  ok(r.code === 0, "① 基线（未破坏）探针全绿", `exit=${r.code}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ═══ ② 关键：把 syncManifestMirror 那处**退化成裸写**（数量不变，质量变了）═══
{
  const d = stage();
  const p = path.join(d, "lib", "manifest-mirror.js");
  const src = fs.readFileSync(p, "utf8");
  const hardened = [
    "    try {",
    '      fs.writeFileSync(tmp, body, { encoding: "utf8", flag: "wx" });',
    "      fs.renameSync(tmp, target);",
    "    } catch (err) {",
    "      try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖真因 */ }",
    "      throw err;",
    "    }",
  ].join("\n");
  const degraded = ["    fs.writeFileSync(tmp, body, \"utf8\");", "    fs.renameSync(tmp, target);"].join("\n");
  const next = src.replace(hardened, degraded);
  fs.writeFileSync(p, next, "utf8");
  ok(next !== src, "② 夹具前提：退化替换真的改到了文件", next === src ? "替换没命中（夹具故障，不是被测对象的问题）" : "命中");
  const r = runProbe(d);
  ok(r.code !== 0, "② 🔴 退化成裸写后探针**必须变红**（现状若绿 = 判据不足）", `exit=${r.code}`);
  const line = (r.out.split("\n").find((l) => /F-08/.test(l)) ?? "").trim();
  if (line) console.log(`         探针原话：${line.slice(0, 160)}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// ═══ ③ 新增第 3 处裸写时必须变红（报告那条改法确实管这个）═══
{
  const d = stage();
  const p = path.join(d, "lib", "pure-ops.js");
  const src = fs.readFileSync(p, "utf8");
  const next = `${src}\nexport function _probeDummyBare() {\n  const tmp = "x.tmp";\n  fs.writeFileSync(tmp, "a", "utf8");\n  fs.renameSync(tmp, "x");\n}\n`;
  fs.writeFileSync(p, next, "utf8");
  const r = runProbe(d);
  ok(r.code !== 0, "③ 新增第 3 处裸写 ⇒ 探针变红", `exit=${r.code}`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
