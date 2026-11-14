/**
 * D375 取证器 —— 逐条验证 Gemini4 静态审查 023 的 6 项发现。
 *
 * ★ 极性：**PASS = 行为正确**（缺陷已修 / 不存在）；**FAIL = 缺陷仍在**。
 * ★ 铁律：不改被测代码；夹具必须真把执行推到被测那一支；不可达 / 报告说错 ⇒ KNOWN；
 *         必须有跑完哨兵 `PROBE-COMPLETE`。
 *
 * 用法：node tools/_probe-d375-verify.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// ★ 本项目路径含中文 ⇒ 必须 fileURLToPath（D374 栽过）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
let known = 0;
const rows = [];

function ok(title, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(`  PASS  ${title}`);
  } else {
    fail += 1;
    rows.push(`  FAIL  ${title}${detail !== undefined ? `  ⟵ ${detail}` : ""}`);
  }
}
function knownRow(title, detail) {
  known += 1;
  rows.push(`  KNOWN ${title}${detail !== undefined ? `  ⟵ ${detail}` : ""}`);
}

const fp = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "fingerprint.js")).href);
const bk = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "backup.js")).href);

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `d375-${tag}-`));
}
function mkProj(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// ═══════════════════════════════════════════════════════════════════════════
// F-05（先做，最独立）：backupBeforeWrite / readBackup 未归一化前导 "./"
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = tmp("f05");
  try {
    fs.writeFileSync(path.join(t, "LEDGER.md"), "# 台账 v2\n", "utf8");
    const w = bk.backupBeforeWrite({ memBase: t, rel: "./LEDGER.md", prevText: "# 台账 v1\n", forceHot: true });
    ok(
      'F-05 a：backupBeforeWrite({rel:"./LEDGER.md"}) 能正常落备份（不被 backupPathOf 拒掉）',
      w.ok === true,
      JSON.stringify(w),
    );
    const r = bk.readBackup(t, "./LEDGER.md");
    ok(
      'F-05 b：readBackup({rel:"./LEDGER.md"}) 能读回那份备份',
      r.exists === true && r.text === "# 台账 v1\n",
      JSON.stringify({ exists: r.exists, text: r.text, reason: r.reason }),
    );
    // ★ 反向：底层纯函数必须仍然拒绝 "." 段（130㉓ 的既有契约，不许放宽）
    ok(
      'F-05 c 反向：backupPathOf 仍严格拒绝含「.」段的路径（底层契约没被放宽）',
      bk.backupPathOf(t, "./LEDGER.md") === undefined,
      JSON.stringify(bk.backupPathOf(t, "./LEDGER.md")),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-01：migrateToV3 先 existsSync 过滤再做边界校验
// ═══════════════════════════════════════════════════════════════════════════
{
  const part7 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part7.js")).href);

  // a) 不存在的越界路径逃逸进 V3 清单
  {
    const t = tmp("f01a");
    try {
      const proj = path.join(t, "proj");
      mkProj(proj, {
        projectId: fp.newProjectId(),
        active: "LEDGER.md",
        protocolVersion: 2,
        decisions: "../outside.md",
      });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
      const mig = part7.migrateToV3(proj, { apply: true });
      let leaked = false;
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(proj, ".dsh-ledger.json"), "utf8"));
        leaked = typeof mf.decisions === "string" && mf.decisions.includes("..");
      } catch {
        /* 读不到就当没泄露 */
      }
      ok(
        'F-01 a：不存在的越界路径（decisions:"../outside.md"）不会逃逸进 V3 清单',
        mig.ok !== true || leaked === false,
        JSON.stringify({ migOk: mig.ok, leaked }),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // b) 自根路径 "." 触发无限递归（★ 用子进程 + 超时，绝不让主进程被拖死）
  {
    const t = tmp("f01b");
    try {
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: fp.newProjectId(), active: ".", protocolVersion: 2 });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");

      const script = path.join(t, "run.mjs");
      fs.writeFileSync(
        script,
        `import path from "node:path";\n` +
          `import { pathToFileURL } from "node:url";\n` +
          `const m = await import(pathToFileURL(${JSON.stringify(path.join(PROJECT_ROOT, "lib", "part7.js"))}).href);\n` +
          `let r;\n` +
          `try { r = m.migrateToV3(${JSON.stringify(proj)}, { apply: true }); }\n` +
          `catch (e) { console.log(JSON.stringify({ threw: String(e && e.message) })); process.exit(0); }\n` +
          `console.log(JSON.stringify({ ok: r?.ok, reason: r?.reason }));\n`,
        "utf8",
      );
      let out = "";
      let crashed = false;
      try {
        const { execFileSync } = await import("node:child_process");
        out = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 20000, stdio: "pipe" });
      } catch (e) {
        crashed = true;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        if (e.code === "ETIMEDOUT" || /ENAMETOOLONG/.test(out)) crashed = true;
      }
      const rejected =
        !crashed &&
        (() => {
          try {
            const j = JSON.parse(out.trim().split("\n").pop());
            return j.ok === false || j.threw !== undefined;
          } catch {
            return false;
          }
        })();
      ok(
        'F-01 b：清单写 active:"." 时 migrateToV3 结构化拒绝（不无限递归、不 ENAMETOOLONG 崩溃）',
        rejected,
        crashed ? "崩溃/超时" : out.slice(0, 200),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // c) 悬空符号链接漏检
  {
    const t = tmp("f01c");
    try {
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: fp.newProjectId(), active: "LEDGER.md", protocolVersion: 2, decisions: "DECISIONS.md" });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
      let madeLink = false;
      try {
        fs.symlinkSync(path.join(t, "nonexistent-target.md"), path.join(proj, "DECISIONS.md"));
        madeLink = true;
      } catch {
        madeLink = false;
      }
      if (!madeLink) {
        knownRow("F-01 c：悬空符号链接漏检 —— 本机建不了符号链接（EPERM），本条无法验证");
      } else {
        const mig = part7.migrateToV3(proj, { apply: true });
        ok(
          "F-01 c：悬空符号链接被检出并拒绝（fs.existsSync 会跟随链接 ⇒ 必须用 lstat 兜底）",
          mig.ok !== true,
          JSON.stringify({ migOk: mig.ok, reason: mig.reason }),
        );
      }
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-02：memoryRoot 越界但 activeRel 有效 ⇒ 守卫被错放在 activeRel===undefined 分支内
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const part1 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part1.js")).href);
  const part3 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part3.js")).href);

  const t = tmp("f02");
  try {
    const proj = path.join(t, "proj");
    mkProj(proj, { projectId: fp.newProjectId(), active: "LEDGER.md", memoryRoot: "../outside" });
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 根目录旧台账\n", "utf8");
    const info = part2.inspect(proj);
    ok(
      "F-02 前置：memoryRoot 越界被 inspect 记下，且 activeRel 仍然有效（这正是守卫被旁路的前提）",
      info.memoryRootUnsafe !== undefined && info.activeRel !== undefined,
      JSON.stringify({ unsafe: info.memoryRootUnsafe, activeRel: info.activeRel }),
    );

    // writeManifestMode 必须拒绝
    const before = fs.readFileSync(path.join(proj, ".dsh-ledger.json"), "utf8");
    const wm = part1.writeManifestMode(proj, info, "surgical");
    const after = fs.readFileSync(path.join(proj, ".dsh-ledger.json"), "utf8");
    ok(
      "F-02 a：writeManifestMode 在 memoryRoot 越界时拒绝写盘（清单一个字节都不动）",
      wm.ok !== true && before === after,
      JSON.stringify({ wm, changed: before !== after }),
    );

    // 注入层必须优先告警，而不是把根目录旧台账当正常内容注入
    const inj = part3.renderInjectionBody(info, undefined);
    const body = typeof inj === "string" ? inj : JSON.stringify(inj);
    // ★★★ 断言必须能区分「注入没内容」（夹具没走通）与「注入给了正确内容」。
    //   第一版写成 `!含旧台账 || 含越界` —— 注入只要是空的就恒真，那是**空守**。
    //   实测就是如此：pending 传错 ⇒ 注入是 472 字的命令模板 ⇒ 两半都真 ⇒ 假绿。
    ok(
      "F-02 b：注入层在 memoryRoot 越界时给出越界告警（且不把根目录旧台账当正常台账注入）",
      body.length > 0 && body.includes("越界") && !body.includes("根目录旧台账"),
      body.slice(0, 300),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }

  // c) 清单 JSON 损坏时，注入层必须告警而不是静默注入根目录旧台账
  {
    const t2 = tmp("f02c");
    try {
      const proj = path.join(t2, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, ".dsh-ledger.json"), "{ 这不是合法 JSON ", "utf8");
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 根目录旧台账\n", "utf8");
      const info2 = part2.inspect(proj);
      const inj2 = part3.renderInjectionBody(info2, undefined);
      const body2 = typeof inj2 === "string" ? inj2 : JSON.stringify(inj2);
      ok(
        "F-02 c：清单 JSON 损坏时注入层给出损坏告警（不静默把根目录旧台账当正常台账注入）",
        body2.length > 0 && body2.includes("损坏") && !body2.includes("根目录旧台账"),
        body2.slice(0, 300),
      );
    } finally {
      fs.rmSync(t2, { recursive: true, force: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-03：写入时直接采用入参 content 携带的指纹 kind/key/project ⇒ 身份串卡
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const part4 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part4.js")).href);

  const t = tmp("f03");
  try {
    const pid = fp.newProjectId();
    const proj = path.join(t, "proj");
    mkProj(proj, { projectId: pid, active: "LEDGER.md", decisionsDir: "decisions" });
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
    const info = part2.inspect(proj);

    // 传入一段带「别的身份」指纹的内容（模拟从 decisions/D99 复制过来）
    const poisoned = fp.applyFingerprint3("# 这是外来内容\n", {
      kind: "decisions",
      project: pid,
      key: "D99",
    }).text;

    const w = part4.writeLedger(
      proj,
      { target: "active", content: poisoned, mode: "replace" },
      { agent: { session: { header: { id: "sess-d375" } } } },
      {},
    );
    const onDisk = fs.readFileSync(path.join(proj, "LEDGER.md"), "utf8");
    const r3 = fp.readFingerprint3(onDisk);
    ok(
      "F-03 a：writeLedger 写 LEDGER.md 时，指纹 kind/key 由**目标槽位**决定（不采用入参 content 里的 decisions/D99）",
      r3.ok === true && r3.id.kind !== "decisions" && String(r3.id.key) !== "D99",
      JSON.stringify({ writeOk: w?.ok, id: r3.ok ? r3.id : r3.reason }),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }

  // b) 扩展卡片：把 B1 的内容写进 B2，不许盖上 B1 的 key
  {
    const part8 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part8.js")).href);
    const t2 = tmp("f03b");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t2, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md" });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
      const info = part2.inspect(proj);
      const cr = part8.createExtension(info, proj, { name: "cards", description: "卡片", mode: "decisions" });
      const id = cr.created.id;
      part8.writeExtension(info, proj, id, { key: "B1", content: "# Boss 1\n- HP 1000\n" });
      const b1raw = part8.readExtension(info, proj, id, { key: "B1" });

      // 把 B1 的原始（带指纹）内容复制成 B2
      let b1Disk = "";
      const walk = (d) => {
        let ents = [];
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === "B1.md") b1Disk = fs.readFileSync(p, "utf8");
        }
      };
      walk(path.join(proj, "extensions"));
      part8.writeExtension(info, proj, id, { key: "B2", content: b1Disk });
      const b2 = part8.readExtension(info, proj, id, { key: "B2" });
      let b2Disk = "";
      const walk2 = (d) => {
        let ents = [];
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk2(p);
          else if (e.name === "B2.md") b2Disk = fs.readFileSync(p, "utf8");
        }
      };
      walk2(path.join(proj, "extensions"));
      const r3b2 = b2Disk !== "" ? fp.readFingerprint3(b2Disk) : { ok: false, reason: "没找到 B2.md" };
      const keyIsB1 = r3b2.ok === true && /B1/.test(String(r3b2.id.key));
      ok(
        "F-03 b：扩展卡片 B2 被写入 B1 的内容时，指纹 key 仍是 B2（不被串成 B1）",
        b1Disk !== "" && r3b2.ok === true && !keyIsB1,
        JSON.stringify({ b1Len: b1Disk.length, b2Ok: r3b2.ok, b2Id: r3b2.ok ? r3b2.id : r3b2.reason }),
      );
    } finally {
      fs.rmSync(t2, { recursive: true, force: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-04：spliceSingleFileEntry 未收敛单例 key:"-"；lessons/goals 的 rm 漏盖章/漏回显 backup
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);

  // a) spliceSingleFileEntry 的 key 必须固定 "-"
  {
    const t = tmp("f04a");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md", lessons: "LESSONS.md" });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
      // ★★★ 复现前提（我第一版弄错了，所以是假绿）：缺陷是 **frontmatter 里 key 已被污染成 L99**，
      //   而 splice 直接采用 `r3.id.key`。只放一个行内信标不够 —— frontmatter 的 key 仍是 "-"，
      //   那样无论修没修都输出 "-"，等于什么都没测。
      const seeded = fp.applyFingerprint3("## L99 · 尺子错\n- 标题: x\n", {
        kind: "lessons",
        project: pid,
        key: "L99",
      }).text;
      fs.writeFileSync(path.join(proj, "LESSONS.md"), seeded, "utf8");
      // 前置：磁盘上那份确实带着被污染的 key
      const pre = fp.readFingerprint3(seeded);
      ok(
        "F-04 a 前置：夹具里 LESSONS.md 的指纹 key 确实被污染成 L99（前提不成立就是假绿）",
        pre.ok === true && String(pre.id.key) === "L99",
        JSON.stringify(pre.ok ? pre.id : pre.reason),
      );

      const sp = part2.spliceSingleFileEntry(
        seeded,
        /^##\s+L99\b/,
        /^##\s+/,
        "",
        "lessons",
      );
      const r3 = fp.readFingerprint3(String(sp?.text ?? ""));
      ok(
        'F-04 a：spliceSingleFileEntry 产出的单例 key 固定为 "-"（不被行内信标 L99 污染）',
        sp?.text !== undefined && r3.ok === true && String(r3.id.key) === "-",
        JSON.stringify({ spOk: sp?.text !== undefined, id: r3.ok ? r3.id : r3.reason }),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-06：读取/展示/注入出口未剥离指纹 + inspect().activeLines 被指纹膨胀
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const part3 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part3.js")).href);
  const part4 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part4.js")).href);
  const cardOps = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "card-ops.js")).href);

  const leak = (s) =>
    String(s).includes("dsh-fp-front") || String(s).includes("<!--dsh-id:") || String(s).includes("[dsh-fp-link]");

  // a) inspect().activeLines 不许把 5 行指纹算进正文行数
  {
    const t = tmp("f06a");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md" });
      const body = "# 台账\n\n- 一行\n- 两行\n- 三行\n- 四行\n";
      const stamped = fp.applyFingerprint3(body, { kind: "active", project: pid, key: "-" }).text;
      fs.writeFileSync(path.join(proj, "LEDGER.md"), stamped, "utf8");
      const info = part2.inspect(proj);
      const bodyLines = body.replace(/\s+$/, "").split("\n").length;
      const stampedLines = stamped.replace(/\s+$/, "").split("\n").length;
      ok(
        `F-06 a：inspect().activeLines 按**真实正文**统计（正文 ${bodyLines} 行，含载体 ${stampedLines} 行）`,
        info.activeLines === bodyLines,
        JSON.stringify({ activeLines: info.activeLines, bodyLines, stampedLines }),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // b) ledger_read 单文件全文不许吐指纹
  {
    const t = tmp("f06b");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md" });
      const stamped = fp.applyFingerprint3("# 台账正文\n\n- 内容\n", { kind: "active", project: pid, key: "-" }).text;
      fs.writeFileSync(path.join(proj, "LEDGER.md"), stamped, "utf8");
      const info = part2.inspect(proj);
      // ★ ledger_read 没有独立导出函数，它是 defineReadTool().execute(args, exec)（D375 夹具踩过一次）
      // ★★ root 不是 execute 的参数：`rootFromExec` 只认 `agent.session.header.cwd`（第二次踩）
      const rd = await part4
        .defineReadTool()
        .execute({ target: "active" }, { agent: { session: { header: { id: "s", cwd: proj } } } });
      const txt = rd !== undefined ? JSON.stringify(rd) : "";
      ok(
        "F-06 b：ledger_read 单文件全文剥离三载体指纹",
        rd?.ok === true && String(rd?.text ?? "") !== "" && !leak(txt),
        leak(txt) ? txt.slice(0, 240) : JSON.stringify({ ok: rd?.ok, len: String(rd?.text ?? "").length }),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // c) 注入层不许把指纹吐给模型
  {
    const t = tmp("f06c");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md" });
      const stamped = fp.applyFingerprint3("# 台账正文\n\n- 内容\n", { kind: "active", project: pid, key: "-" }).text;
      fs.writeFileSync(path.join(proj, "LEDGER.md"), stamped, "utf8");
      const info = part2.inspect(proj);
      const inj = part3.renderInjectionBody(info, undefined);
      const body = typeof inj === "string" ? inj : JSON.stringify(inj);
      ok(
        "F-06 c：注入层（renderInjectionBody 情形 C）剥离三载体指纹",
        !leak(body),
        leak(body) ? body.slice(0, 240) : undefined,
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // d) 卡片模式 readEntryUnified 不许吐指纹
  {
    const t = tmp("f06d");
    try {
      const pid = fp.newProjectId();
      const proj = path.join(t, "proj");
      mkProj(proj, { projectId: pid, active: "LEDGER.md", decisionsDir: "decisions" });
      fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
      fs.mkdirSync(path.join(proj, "decisions"), { recursive: true });
      const stamped = fp.applyFingerprint3("# D1 — 测试卡\n- 状态: 有效\n", {
        kind: "decisions",
        project: pid,
        key: "D1",
      }).text;
      fs.writeFileSync(path.join(proj, "decisions", "D1.md"), stamped, "utf8");
      const info = part2.inspect(proj);
      const r = cardOps.readEntryUnified(proj, info, "decisions", "D1");
      const txt = JSON.stringify(r);
      ok(
        "F-06 d：readEntryUnified（卡片模式）剥离三载体指纹",
        r?.ok === true && !leak(txt),
        leak(txt) ? txt.slice(0, 240) : JSON.stringify({ ok: r?.ok }),
      );
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(rows.join("\n"));
console.log("═".repeat(66));
console.log(`  合计：PASS ${pass} · FAIL ${fail} · KNOWN ${known}`);
console.log("PROBE-COMPLETE");
