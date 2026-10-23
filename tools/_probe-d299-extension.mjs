#!/usr/bin/env node
/**
 * ★★★★★ 探针：**扩展记忆**（D299 · V3 阶段 4）。
 *
 * 🔴 本探针要守的核心命题（任务书 §6.5，最容易被做错的一条）：
 *   **扩展只是"借用"基础记忆的管理语义，绝不改变基础协议。**
 *   这句话必须用断言钉住 —— 否则"建了一个决策型扩展"很容易顺手变成
 *   "插件以后把 decisions 也当扩展处理"，而那种错**不会报错，只会慢慢走偏**。
 *
 * 五组：
 *   ① 创建：注册表 + 文件都真的建出来了（**不许"界面说成功但文件不存在"**）
 *   ② **建满 7 种模式之后，核心记忆一个字节都不许变**（§6.5 的铁律）
 *   ③ 七种模式的读写语义各自正确（卡片型 / 单文件型 / 只追加 / 原则型拒写）
 *   ④ 安全边界：越界 id / 重名 / 保留名 / 路径穿越 全部拦住
 *   ⑤ 删除：有内容必须 confirm；删完核心记忆仍然一个字没变
 */

import crypto from "node:crypto";
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

const P8 = await import(pathToFileURL(path.join(ROOT, "lib", "part8.js")).href);
const { inspect } = await import(pathToFileURL(path.join(ROOT, "lib", "part2.js")).href);

/** 造一个 V3 形态的项目（memoryRoot 子目录 + 核心记忆在里面）。 */
function makeV3Project(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `d299-${tag}-`));
  const memDir = "proj-ledger-memory";
  const mem = path.join(root, memDir);
  fs.mkdirSync(path.join(mem, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(mem, "_a"), { recursive: true });
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 核心台账\n\n不许被扩展改到。\n", "utf8");
  fs.writeFileSync(path.join(mem, "PRINCIPLES.md"), "# 核心原则\n\n不许被扩展改到。\n", "utf8");
  fs.writeFileSync(path.join(mem, "decisions", "D1.md"), "## D1 · 核心决策\n\n不许被扩展改到。\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify(
      {
        version: 1,
        active: "LEDGER.md",
        archiveDir: "_a",
        principles: "PRINCIPLES.md",
        decisionsDir: "decisions",
        logDir: "_ledger-log",
        maxActiveLines: 300,
        revision: 0,
        memoryRoot: memDir,
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

const hashTree = (dir) => {
  const out = new Map();
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
};

/** 只盯核心记忆（排除 extensions 树本身）。 */
const coreOf = (info) => {
  const mem = info.memoryBase;
  if (typeof mem !== "string" || mem === ""){
    throw new Error(`coreOf: info.memoryBase 取不到（拿到 ${JSON.stringify(mem)}）—— 夹具错了，不是被测对象的问题`);
  }
  const all = hashTree(mem);
  return new Map([...all].filter(([rel]) => !rel.startsWith("extensions/")));
};
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ① 创建：注册表与文件都真的落地 ===\n");
{
  const root = makeV3Project("create");
  const info = inspect(root);
  const r = P8.createExtension(info, root, {
    name: "Boss机制记录",
    description: "记录 Boss 的攻击模式与阶段逻辑",
    mode: "decisions",
    inject: false,
  });
  ok("①a 创建返回 ok", r.ok === true, JSON.stringify(r));
  ok("①b 有 id", typeof r.created?.id === "string" && r.created.id !== "", String(r.created?.id));
  ok("①c 注册表文件真的存在", fs.existsSync(P8.extRegistryAbs(info, root)));

  const reg = JSON.parse(fs.readFileSync(P8.extRegistryAbs(info, root), "utf8"));
  ok("①d 注册表里有一条", reg.extensions.length === 1);
  ok("①e 注册表里的 id 与返回一致", reg.extensions[0].id === r.created.id);
  ok("①f ★ 模式存对了", reg.extensions[0].mode === "decisions");

  const dir = P8.extDirAbs(info, root, r.created.id);
  ok("①g ★★ 扩展目录**真的存在**（不许「说成功但没建」）", fs.existsSync(dir), String(dir));
  ok(
    "①h ★★ 卡片目录也真的在（不是空壳）",
    fs.existsSync(path.join(dir, "cards")) && fs.readdirSync(path.join(dir, "cards")).length > 0,
  );
  ok(
    "①i 扩展住在 memoryRoot 里，不在项目根",
    dir.startsWith(path.join(root, "proj-ledger-memory")),
    String(dir),
  );
  ok("①j ★ 项目根下**没有** extensions 目录", !fs.existsSync(path.join(root, "extensions")));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ② 建满全部模式 ⇒ 核心记忆一个字节都不许变（§6.5 铁律）===\n");
{
  const root = makeV3Project("all7");
  const info = inspect(root);
  const before = coreOf(info);
  // ★ 夹具实际建了 3 个：`LEDGER.md`、`PRINCIPLES.md`、`decisions/D1.md`（已 dump 确认，不是拍的）。
  //   这条断言只是"基线非空"，**不是**在验数量 —— 所以写成 >= 3 而不是某个精确值。
  ok("②a 基线：核心记忆里有文件", before.size >= 3, `${before.size} 个`);

  const results = [];
  for (const mode of P8.EXT_MODE_KEYS) {
    const r = P8.createExtension(info, root, {
      name: `测试-${mode}`,
      description: `${mode} 模式的测试扩展`,
      mode,
      inject: true,
    });
    results.push({ mode, ok: r.ok === true, reason: r.reason, id: r.created?.id });
  }
  const bad = results.filter((r) => !r.ok);
  // ★ 2026-10-23（D311）：7 → **6**（用户拍板去掉「原则型」）。
  //   这里刻意**用 EXT_MODE_KEYS.length 而不是写死 6** ——
  //   将来再加/再删模式，这条断言自动跟着走，不必回来改数字（数字写死就会过期）。
  const want = P8.EXT_MODE_KEYS.length;
  ok(`②b 全部 ${want} 种模式全部创建成功`, bad.length === 0, JSON.stringify(bad));
  ok(`②c 注册表里恰好 ${want} 条`, P8.readRegistry(info, root).registry.extensions.length === want, String(P8.readRegistry(info, root).registry.extensions.length));

  const after = coreOf(info);
  ok("②d ★★★ 核心记忆文件数没变", before.size === after.size, `${before.size} → ${after.size}`);
  ok(
    "②e ★★★ **核心记忆每个字节都没变**（扩展绝不改写基础协议）",
    sameMap(before, after),
    [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k).join(", "),
  );
  // 再单独点名几个最容易被误改的
  const mem = info.memoryBase;
  ok(
    "②f 核心 LEDGER.md 内容原样",
    fs.readFileSync(path.join(mem, "LEDGER.md"), "utf8").includes("不许被扩展改到"),
  );
  ok(
    "②g 核心 decisions/D1.md 原样",
    fs.readFileSync(path.join(mem, "decisions", "D1.md"), "utf8").includes("不许被扩展改到"),
  );
  ok(
    "②h 核心 PRINCIPLES.md 原样",
    fs.readFileSync(path.join(mem, "PRINCIPLES.md"), "utf8").includes("不许被扩展改到"),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ③ 七种模式的读写语义 ===\n");
{
  const root = makeV3Project("sem");
  const info = inspect(root);
  const mk = (mode) => {
    // ★ 每次给唯一名字 —— 探针自己不能撞重名（重名是被正确拒绝的，那不是缺陷）
    const uniq = `${mode}-${Math.random().toString(36).slice(2, 7)}`;
    const r = P8.createExtension(info, root, { name: `模-${uniq}`, description: `${mode} 测试`, mode, inject: false });
    if (r.ok !== true) throw new Error(`夹具没建出扩展（${mode}）：${r.reason}`);
    return r.created.id;
  };

  // ③1 卡片型（decisions / goals / lessons）：一卡一文件
  for (const mode of ["decisions", "goals", "lessons"]) {
    const id = mk(mode);
    const w = P8.writeExtension(info, root, id, { key: "D1", content: `## D1 · ${mode} 测试卡\n` });
    ok(`③1 ${mode}：写卡成功`, w.ok === true, JSON.stringify(w));
    const rd = P8.readExtension(info, root, id, { key: "D1" });
    ok(`③2 ${mode}：读回内容一致`, rd.ok === true && rd.text.includes(`${mode} 测试卡`));
    const lst = P8.readExtension(info, root, id, {});
    ok(`③3 ${mode}：不给 key ⇒ 列卡片`, Array.isArray(lst.cards) && lst.cards.some((c) => c.key === "D1"));
  }

  // ③4 单文件型（active / plain）：整份替换
  for (const mode of ["active", "plain"]) {
    const id = mk(mode);
    const w1 = P8.writeExtension(info, root, id, { content: "第一版\n" });
    ok(`③4 ${mode}：首次写成功`, w1.ok === true, JSON.stringify(w1));
    const w2 = P8.writeExtension(info, root, id, { content: "第二版（替换）\n" });
    ok(`③5 ${mode}：第二次是**替换**不是追加`, w2.ok === true && w2.appended === false);
    const rd = P8.readExtension(info, root, id, {});
    ok(`③6 ${mode}：读回是第二版（旧内容被替换）`, rd.text.includes("第二版") && !rd.text.includes("第一版"));
  }

  // ③7 流水型（journal）：**只许追加**
  {
    const id = mk("journal");
    const bad = P8.writeExtension(info, root, id, { content: "想整份覆盖\n" });
    ok("③7 journal：不带 append 被拒（只追加语义）", bad.ok === false && bad.appendOnly === true, JSON.stringify(bad));
    const a1 = P8.writeExtension(info, root, id, { content: "第一条\n", append: true });
    ok("③8 journal：带 append 成功", a1.ok === true, JSON.stringify(a1));
    const a2 = P8.writeExtension(info, root, id, { content: "第二条\n", append: true });
    ok("③9 journal：第二次追加成功", a2.ok === true);
    const rd = P8.readExtension(info, root, id, {});
    ok("③10 journal：两条都在（旧条目没被覆盖）", rd.text.includes("第一条") && rd.text.includes("第二条"));
  }

  // ③11 ★★★ 2026-10-23（D311）：**「原则型」这个模式已经不存在了** —— 要正面证明它没了。
  //
  //   🔴 原来这里验的是"原则型存在、且模型写被硬拒"。用户拍板去掉这个模式之后，
  //     那条断言就成了**在证明一件已经不存在的事**（它只会因为 create 失败而红）。
  //   ⇒ 现在该证明的是**三件事**，一件都不能少：
  //     ① 枚举里没有 `principles`；
  //     ② 传 `mode:"principles"` 新建 ⇒ **明确被拒**（且理由里说清"必须是这些之一"）；
  //     ③ 全系统**再没有任何 `protect:true` 的模式** —— 否则"删掉保护"就成了新隐患。
  {
    ok(
      "③11 ★★★★★ 模式枚举里**没有** principles（D311 用户拍板去掉）",
      !P8.EXT_MODE_KEYS.includes("principles"),
      JSON.stringify(P8.EXT_MODE_KEYS)
    );
    const r = P8.createExtension(info, root, {
      name: "想建原则型",
      description: "这一条应该被拒",
      mode: "principles",
      inject: false,
    });
    ok(
      "③12 传 mode:\"principles\" 新建 ⇒ **明确被拒**，且理由列出现在合法的模式",
      r.ok === false && /必须是这些之一/.test(String(r.reason)),
      `${r.ok} / ${String(r.reason).slice(0, 90)}`
    );
    const protectedModes = Object.entries(P8.EXT_MODES).filter(([, v]) => v.protect === true).map(([k]) => k);
    ok(
      "③13 ★★★★ **全系统已无 `protect:true` 的模式**（否则删掉那条写保护分支就是新隐患）",
      protectedModes.length === 0,
      `仍是 protect 的模式：${protectedModes.join(",") || "（无）"}`
    );
    // ★ 反向自证：这条断言**真的在读模式表**，不是空判据。
    ok(
      "③13b 且这条断言不是空的：模式表里确实有 ≥5 个模式（否则 protectedModes 恒空）",
      P8.EXT_MODE_KEYS.length >= 5,
      `模式数=${P8.EXT_MODE_KEYS.length}`
    );
  }

  // ③14 非流水型传 append ⇒ 拒绝（防止把台账/决策当流水用）
  {
    const id = mk("plain");
    const w = P8.writeExtension(info, root, id, { content: "x\n", append: true });
    ok("③14 非流水型传 append ⇒ 被拒", w.ok === false, JSON.stringify(w));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ④ 安全边界 ===\n");
{
  const root = makeV3Project("sec");
  const info = inspect(root);

  // ④1 保留名
  for (const bad of ["decisions", "LEDGER", "principles", "extensions"]) {
    const r = P8.createExtension(info, root, { name: bad, description: "x", mode: "plain" });
    ok(`④1 保留名「${bad}」被拒`, r.ok === false, JSON.stringify(r));
  }

  // ④2 重名
  P8.createExtension(info, root, { name: "Boss机制", description: "第一份", mode: "plain" });
  const dup = P8.createExtension(info, root, { name: "boss机制", description: "第二份", mode: "plain" });
  ok("④2 重名被拒（大小写不敏感）", dup.ok === false, JSON.stringify(dup));

  // ④3 空名称 / 空说明 / 非法模式
  ok("④3a 空名称被拒", P8.createExtension(info, root, { name: "  ", description: "x", mode: "plain" }).ok === false);
  ok("④3b 空说明被拒", P8.createExtension(info, root, { name: "新东西", description: "", mode: "plain" }).ok === false);
  ok("④4 非法模式被拒", P8.createExtension(info, root, { name: "新东西", description: "x", mode: "hack" }).ok === false);

  // ④5 名称里的路径符号
  ok(
    "④5 名称含 `../` 被拒",
    P8.createExtension(info, root, { name: "../escape", description: "x", mode: "plain" }).ok === false,
  );

  // ④6 id 白名单
  for (const badId of ["../x", "a/b", "..", "", "A B", "x".repeat(80)]) {
    ok(`④6 非法 id ${JSON.stringify(badId)} 被 isSafeExtId 拒`, P8.isSafeExtId(badId) === false);
  }
  ok("④7 合法 id 通过", P8.isSafeExtId("boss-mechanics") === true);

  // ④8 不存在的 id ⇒ 明确拒绝，不静默
  ok("④8 不存在的 id 读 ⇒ ok:false", P8.readExtension(info, root, "nope-xyz", {})?.ok === false);
  ok("④9 不存在的 id 写 ⇒ ok:false", P8.writeExtension(info, root, "nope-xyz", { content: "x" })?.ok === false);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑤ 删除：有内容必须确认，删完核心记忆不变 ===\n");
{
  const root = makeV3Project("del");
  const info = inspect(root);
  const before = coreOf(info);

  const r = P8.createExtension(info, root, { name: "待删扩展", description: "测试删除", mode: "plain" });
  const id = r.created.id;

  // ⑤1 空扩展（只有模板）⇒ 直接删
  const d1 = P8.deleteExtension(info, root, id, {});
  ok("⑤1 空扩展无需确认即可删", d1.ok === true, JSON.stringify(d1));
  ok("⑤2 删完注册表里没了", P8.readRegistry(info, root).registry.extensions.length === 0);
  ok("⑤3 删完目录也没了", !fs.existsSync(P8.extDirAbs(info, root, id)));

  // ⑤4 有内容 ⇒ 必须 confirm
  const r2 = P8.createExtension(info, root, { name: "有内容的", description: "测试", mode: "plain" });
  const id2 = r2.created.id;
  P8.writeExtension(info, root, id2, { content: "这里有一段真内容，不能被顺手删掉。\n" });
  const d2 = P8.deleteExtension(info, root, id2, {});
  ok("⑤4 ★★ 有内容不确认 ⇒ **拒绝**", d2.ok === false && d2.needConfirm === true, JSON.stringify(d2));
  ok("⑤5 被拒之后内容**还在**", fs.existsSync(P8.extDirAbs(info, root, id2)));
  ok(
    "⑤6 被拒之后内容原样",
    fs.readFileSync(path.join(P8.extDirAbs(info, root, id2), "content.md"), "utf8").includes("真内容"),
  );

  const d3 = P8.deleteExtension(info, root, id2, { confirm: true });
  ok("⑤7 确认后删成功", d3.ok === true, JSON.stringify(d3));
  ok("⑤8 确认删之后目录没了", !fs.existsSync(P8.extDirAbs(info, root, id2)));

  const after = coreOf(info);
  ok("⑤9 ★★★ 删完核心记忆仍然**逐字节不变**", sameMap(before, after));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`d299-extension 探针：${pass} PASS / ${fail} FAIL`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
