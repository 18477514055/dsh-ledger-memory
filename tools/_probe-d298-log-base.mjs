#!/usr/bin/env node
/**
 * ★★★★★ 探针：**V3 项目里，后台日志采集器写到哪里**（D298）。
 *
 * 🔴 病的由来（真跑撞出来的，不是设想）：
 *   V3 迁移完成后，项目根**又长出** `_ledger-log/…`，而且**重启也没用**。
 *   一查：`logFileRel()` 早在 D289 就改成 V3 语义（返回相对 `memoryBase` 的路径），
 *   但 `part3.js` 的采集器用 `path.resolve(b.root, fileRel)` 落盘 —— `b.root` 是**项目根**。
 *   ⇒ **每一条日志都写回项目根**。
 *
 *   ★ 最恶劣的地方是**它不报错**：`isUnder(项目根, 记忆子目录)` 天然成立，
 *     防御检查通过；文件也确实写成功了。只是**分裂成了两份**。
 *     这正是本项目反复记的那类：**地址有第二个出处 ⇒ 静默走错，不抛不报**。
 *
 * 测四件事：
 *   ① **V2**：日志写在项目根 `_ledger-log/`（旧行为不许被改坏）
 *   ② **V3**：日志写在 `<memoryRoot>/_ledger-log/`，**项目根一个字节都不许有**
 *   ③ V3 下**内容照样写对**（不是"换个地方写空文件"）
 *   ④ 反向：把修复退回 ⇒ ①②必须红
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "part3.js")).href);
const { setActiveSettings } = await import(pathToFileURL(path.join(ROOT, "lib", "defs.js")).href);

const LEVELS = { L0: true, L1: true, L2: true, L3: false, L4: true };

/** 造一个项目（V2 = 记忆就在根；V3 = 记忆在子目录）。 */
function makeProject(tag, withMemRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `d298p-${tag}-`));
  const base = withMemRoot ? path.join(root, "proj-ledger-memory") : root;
  if (withMemRoot) fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(base, "_a"), { recursive: true });
  const mf = {
    version: 1,
    active: "LEDGER.md",
    archiveDir: "_a",
    logDir: "_ledger-log",
    logLevels: LEVELS,
    maxActiveLines: 300,
    revision: 0,
  };
  if (withMemRoot) mf.memoryRoot = "proj-ledger-memory";
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify(mf), "utf8");
  return root;
}

/** 跑一次采集，返回本次产生的日志文件（相对 root）。 */
function collect(tag, withMemRoot) {
  const root = makeProject(tag, withMemRoot);
  setActiveSettings({ logLevels: LEVELS });
  const logs = [];
  const ctx = {
    logger: {
      info() {},
      warn(...a) {
        logs.push(`WARN ${a.join(" ")}`);
      },
      error(...a) {
        logs.push(`ERROR ${a.join(" ")}`);
      },
      debug() {},
    },
    on() {},
    effect() {
      return () => {};
    },
  };
  const c = mod.createLogCollector(ctx);
  c.consume(root, `s-${tag}`, {
    type: "tool/call",
    data: {
      turn: 1,
      step: 1,
      callId: "c1",
      name: "write",
      arguments: { file_path: path.join(root, "a.ts") },
    },
  });
  c.flushNow();

  const walk = (d) => {
    let out = [];
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out = out.concat(walk(p));
        else out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    } catch {
      /* 目录不存在就当空 */
    }
    return out;
  };
  const files = walk(root).filter((f) => f.includes("_ledger-log"));
  const bodies = files.map((f) => fs.readFileSync(path.join(root, f), "utf8"));
  return { root, files, bodies, logs };
}

console.log("\n=== ① V2 形态：日志写在项目根（旧行为不许被改坏）===\n");
{
  const r = collect("v2", false);
  ok("①a 项目根下有日志文件", r.files.length > 0, JSON.stringify(r.files));
  ok(
    "①b 路径形如 `_ledger-log/…/L2-*.md`",
    r.files.every((f) => /^_ledger-log\/.*L2-.*\.md$/.test(f)),
    JSON.stringify(r.files),
  );
  ok("①c 内容里确实记了一行 (M)", r.bodies.join("").includes("(M)"), JSON.stringify(r.bodies).slice(0, 200));
  ok("①d 没有写盘告警", r.logs.length === 0, r.logs.join("\n"));
}

console.log("\n=== ② V3 形态：日志必须写在 memoryRoot 里 ===\n");
{
  const r = collect("v3", true);
  ok("②a 有日志文件产生", r.files.length > 0, JSON.stringify(r.files));
  ok(
    "②b 路径在 `proj-ledger-memory/_ledger-log/…` 下",
    r.files.length > 0 && r.files.every((f) => f.startsWith("proj-ledger-memory/_ledger-log/")),
    JSON.stringify(r.files),
  );
  ok(
    "②c ★★★ 项目根下**一个日志文件都没有**（不许分裂成两份）",
    r.files.every((f) => !/^_ledger-log\//.test(f)),
    JSON.stringify(r.files),
  );
  ok("②d 没有写盘告警", r.logs.length === 0, r.logs.join("\n"));
}

console.log("\n=== ③ V3 下内容照样写对（不是换个地方写空文件）===\n");
{
  const r = collect("v3b", true);
  const body = r.bodies.join("");
  ok("③a 有一行 (M) 记录", body.includes("(M)"), body.slice(0, 300));
  ok("③b 记录了工具名 write", body.includes("[write]"), body.slice(0, 300));
  ok("③c 行首是 `- 时间` 形状（L2 解析器认这个）", /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(M\)/m.test(body), body.slice(0, 300));
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`d298-log-base 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
