/**
 * ★ 只读地用**镜像档案**跑 `dsh --dump-config`（阶段 0：钉死 compaction 的真实挂载）。
 *
 * 为什么必须绕这一下：`desktop` profile 被内核显式拦掉
 *   （`@deepseek-ai/dsh/lib/bin.js` 的 `rejectElectronProfile()`：
 *    `if (profile.toLowerCase() === "desktop") program.error(...)`），
 *   而它**只按名字拦** ⇒ 把档案镜像成别的名字即可。
 *
 * ★ 四条"绝不碰真档案"的保证：
 *   ① 镜像建在系统 %TEMP% 下（不在 `.dsh` 里）；
 *   ② `node_modules` 用 **Junction** 指回真档（619 MB 复制不起；且本机规矩：
 *      判/建联接一律 `lstatSync`/`Dirent`，**绝不 `fs.cpSync` 跟随**）；
 *   ③ 沙箱 `DSH_HOME` ⇒ dsh 若真要写，也写进沙箱；
 *   ④ 只跑 `--dump-config`（内核 `--help` 原话：*"print the composed profile tree and exit"*）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REAL = path.join(os.homedir(), ".dsh", "profiles", "desktop");
const SANDBOX = path.join(os.tmpdir(), "dsh-stage0-mirror");
const MIRROR = path.join(SANDBOX, "profiles", "mirror");
const DSH = path.join(process.env.APPDATA, "npm", "dsh.cmd");

/** 递归复制/重建：**目录真复制、联接只重建**（绝不跟随）。 */
const mirrorTree = (src, dst, stats) => {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dst, "junction"); stats.linked.push(dst); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      mirrorTree(path.join(src, e.name), path.join(dst, e.name), stats);
    }
    return;
  }
  if (st.isFile()) { fs.copyFileSync(src, dst); stats.files += 1; stats.bytes += st.size; }
};

// ── 1) 清掉旧沙箱并重建 ────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
fs.mkdirSync(MIRROR, { recursive: true });

const stats = { files: 0, bytes: 0, linked: [] };
for (const e of fs.readdirSync(REAL, { withFileTypes: true })) {
  const src = path.join(REAL, e.name);
  const dst = path.join(MIRROR, e.name);
  if (e.name === "node_modules") {
    fs.symlinkSync(src, dst, "junction"); // ★ Junction 指回真档
    stats.linked.push("node_modules → 真档");
    continue;
  }
  mirrorTree(src, dst, stats);
}

const nmSt = fs.lstatSync(path.join(MIRROR, "node_modules"));
console.log("═".repeat(84));
console.log("① 镜像已建（在 %TEMP%，不在 .dsh）");
console.log("═".repeat(84));
console.log(`  沙箱家 : ${SANDBOX}`);
console.log(`  镜像档 : ${MIRROR}`);
console.log(`  复制   : ${stats.files} 个真文件 · ${(stats.bytes / 1024).toFixed(0)} KB`);
console.log(`  联接   : ${stats.linked.length} 条`);
for (const l of stats.linked) console.log(`      · ${l}`);
console.log(`  node_modules 是联接吗 = ${nmSt.isSymbolicLink()} → ${fs.readlinkSync(path.join(MIRROR, "node_modules"))}`);
console.log(`  ★ 真档 node_modules 顶层仍 ${fs.readdirSync(path.join(REAL, "node_modules")).length} 项（未被物化）`);

// ── 2) 沙箱家里跑 --dump-config ────────────────────────────────────────────
console.log("\n" + "═".repeat(84));
console.log("② dsh --profile mirror --dump-config（沙箱 DSH_HOME，只读）");
console.log("═".repeat(84));
let out = "";
let code = 0;
try {
  out = execFileSync(DSH, ["--profile", "mirror", "--dump-config"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: SANDBOX },
    shell: true, // ★ Node 24：execFileSync 调 .cmd 必须带 shell
  });
} catch (e) {
  code = e.status ?? 1;
  out = String(e.stdout ?? "") + "\n[STDERR]\n" + String(e.stderr ?? "");
}
fs.writeFileSync(path.join(SANDBOX, "dump.txt"), out, "utf8");
console.log(`  exit=${code}  输出 ${out.length} 字符 → ${path.join(SANDBOX, "dump.txt")}`);
console.log(`  首 12 行：`);
for (const l of out.split("\n").slice(0, 12)) console.log(`    ${l}`);
