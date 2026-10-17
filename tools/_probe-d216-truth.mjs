// D216 · 取**代码真值**：工具表 / 子命令 / 设置项默认值（给人读的文案必须照它改）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const t = mod.__test ?? {};

// ── ① 工具表（从注册表读，不数文档）──────────────────────────────────────────
const src = fs
  .readdirSync(path.join(ROOT, "lib"))
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))
  .join("\n");
{
  const block = src.match(/for \(const \[label, factory\] of \[([\s\S]*?)\n  \]\) \{/);
  if (block !== null) {
    const names = [...block[1].matchAll(/\[\s*(?:"([a-z_]+)"|([A-Z_]+)),/g)].map((m) => m[1] ?? `{{${m[2]}}}`);
    console.log(`★ 工具数 = ${names.length}`);
    console.log(names.join("\n"));
  } else {
    console.log("工具注册块未匹配到");
  }
}

// ── ② 子命令 ────────────────────────────────────────────────────────────────
{
  const m = src.match(/LEDGER_SUBCOMMANDS\s*=\s*\[([\s\S]*?)\]/);
  if (m !== null) {
    const names = [...m[1].matchAll(/name:\s*"([a-z]+)"/g)].map((x) => x[1]);
    console.log(`\n★ 子命令数 = ${names.length}`);
    console.log(names.join("  "));
  } else {
    // 退路：从描述里抓
    const m2 = src.match(/LEDGER_SUBCOMMANDS[\s\S]{0,900}/);
    console.log("\n子命令块：\n" + (m2 ? m2[0].slice(0, 800) : "(未找到)"));
  }
}

// ── ③ 设置项默认值（走真实函数）─────────────────────────────────────────────
console.log("\n★ 设置项默认值（测真实函数）");
if (typeof t.settingDefaults === "function") {
  const d = t.settingDefaults();
  for (const [k, v] of Object.entries(d)) {
    console.log(`  ${k.padEnd(28)} = ${JSON.stringify(v)}`);
  }
  console.log(`  （共 ${Object.keys(d).length} 项）`);
} else {
  console.log("  __test.settingDefaults 不可用；现有键：" + Object.keys(t).join(", ").slice(0, 300));
}

// ── ④ 设置项总数 ────────────────────────────────────────────────────────────
if (typeof t.settingsValuesOf === "function") {
  const v = t.settingsValuesOf({ manifest: {} });
  console.log(`\n★ 设置项总数（settingsValuesOf）= ${Object.keys(v).length}`);
  console.log("  全部键：" + Object.keys(v).join(", "));
}

// ── ⑤ 关键默认值（从 defs.js 的 SETTING_SPECS 里抽，含 `default:` 行）────────
console.log("\n★ 关键设置项的默认值（真源：SETTING_SPECS）");
{
  const defsSrc = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
  const lines = defsSrc.split("\n");
  const KEYS = [
    "mode", "incrementalCompact", "turnEndOffer", "hardMaintenanceGate", "autoCompact",
    "blockInjection", "highFidelityCompactRatio", "deltaTriggerPoints", "deltaRemovePoints",
    "pressureTiers", "maxActiveLines", "changeRegisterMax", "capsuleUserMsgMax", "recallMaxChars",
    "triageKeepMax", "triageKeepTotalMax", "maxReadChars", "capsuleMaxChars",
  ];
  for (const k of KEYS) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*key:\\s*"${k}"`).test(l));
    if (i < 0) {
      console.log(`  ${k.padEnd(26)} (spec 未找到)`);
      continue;
    }
    let dflt = "(无 default ⇒ 走代码里的常量)";
    for (let j = i; j < Math.min(i + 20, lines.length); j += 1) {
      const m = lines[j].match(/^\s*default:\s*(.+?),?\s*$/);
      if (m !== null) {
        dflt = m[1].trim();
        break;
      }
    }
    console.log(`  ${k.padEnd(26)} = ${dflt}`);
  }
}

// ── ⑥ 模式常量与 MODES ──────────────────────────────────────────────────────
{
  const defsSrc = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
  for (const m of defsSrc.matchAll(/(MODE_STEADY|MODE_SURGICAL|MODES)\s*=\s*([^;\n]+)/g)) {
    console.log(`  ${m[1]} = ${m[2].trim()}`);
  }
}

// ── ⑦ 子命令的 sub 列表 ─────────────────────────────────────────────────────
{
  const defsSrc = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
  const subs = [...defsSrc.matchAll(/sub:\s*"([a-z]+)"/g)].map((m) => m[1]);
  console.log(`\n★ 子命令数 = ${subs.length} → ${subs.join(" / ")}`);
}

