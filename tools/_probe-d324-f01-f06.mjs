/**
 * _probe-d324-f01-f06.mjs —— D324：Gemini 006 报告的 6 项（含 10 个子项）逐条**行为**验证。
 *
 * ★ 本项目纪律：**"代码改成那个样子"与"那个洞真的堵上了"是两件事。**
 *   006 报告自称给了补丁并"全量自检 2262 PASS"，但**报告里的模块体积表 20 项错 17 项**
 *   ⇒ 它的数字整体不可信，必须自己跑。
 *
 * 每一条都要能**看见红**：先证明旧行为是坏的（用当前修复后的代码 + 参数翻转复现不了就说明判据没抓到）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = pathToFileURL(path.join(ROOT, "lib")).href;

let pass = 0;
let fail = 0;
const ok = (c, name, detail) => {
  if (typeof c !== "boolean") throw new TypeError(`ok() 第一个参数必须是布尔，收到 ${typeof c}`);
  if (c) {
    pass++;
    console.log(`  PASS  ${name}  —— ${detail ?? ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  —— ${detail ?? ""}`);
  }
};

const base = await import(`${LIB}/base.js`);
const part2 = await import(`${LIB}/part2.js`);

// ═══ F-01：跨平台绝对路径拦截 ═══
{
  // isAbsoluteAnywhere 单反斜杠根（Windows 盘符根相对路径 `\evil`）
  ok(base.isAbsoluteAnywhere("\\evil") === true, "F-01① `\\\\evil`（单反斜杠根）被判为绝对路径", String(base.isAbsoluteAnywhere("\\evil")));
  ok(base.isAbsoluteAnywhere("E:\\evil") === true, "F-01① b `E:\\evil`（Win 盘符）被判为绝对路径", "true");
  ok(base.isAbsoluteAnywhere("\\\\server\\share") === true, "F-01① c UNC `\\\\server\\share`", "true");
  ok(base.isAbsoluteAnywhere("sub/dir") === false, "F-01① d 普通相对路径**不误伤**", "false");
  ok(base.isAbsoluteAnywhere("问题记录") === false, "F-01① e 中文相对目录**不误伤**", "false");

  // inspect 真的把 Windows 绝对路径记进 unsafePaths（在 POSIX 语义下也拦）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f01-"));
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({ active: "LEDGER.md", logDir: "E:\\evil-log", notesDir: "\\\\server\\share\\notes" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# L\n", "utf8");
  const info = part2.inspect(dir);
  const fields = (info.unsafePaths ?? []).map((u) => u.field);
  ok(fields.includes("logDir"), "F-01② `logDir: E:\\\\evil-log` 被记进 unsafePaths（跨平台拦）", fields.join(",") || "(空)");
  ok(
    (info.unsafePaths ?? []).some((u) => u.field === "logDir" && /absolute-path-forbidden/.test(String(u.why))),
    "F-01② b 且理由是 `absolute-path-forbidden`（不是含糊的越界）",
    JSON.stringify((info.unsafePaths ?? []).find((u) => u.field === "logDir")?.why)
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ F-02：logDirOf 必须走 gateRel 的结果 ═══
{
  // ① 有 logRel 字段时以它为准（inspect 的产物）
  ok(part2.logDirOf({ logRel: "logs" }) === "logs", "F-02① logDirOf 有 logRel 时用它", String(part2.logDirOf({ logRel: "logs" })));
  ok(part2.logDirOf({ logRel: undefined, manifest: { logDir: "escape" } }) === undefined, "F-02① b logRel 被 gate 掉（undefined）时**绝不回读 manifest**", String(part2.logDirOf({ logRel: undefined, manifest: { logDir: "escape" } })));
  // ② 没有 logRel 字段时（老调用方）仍要拦绝对路径
  ok(part2.logDirOf({ manifest: { logDir: "E:\\x" } }) === undefined, "F-02① c 回读 manifest 时也拦绝对路径", String(part2.logDirOf({ manifest: { logDir: "E:\\x" } })));
  ok(part2.logDirOf({ manifest: { logDir: "logs" } }) === "logs", "F-02① d 合法相对路径照常放行", "logs");

  // ③ 端到端：logDir 越界 ⇒ 真的不落日志
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f02-"));
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify({ active: "LEDGER.md", logDir: "../escape-log" }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# L\n", "utf8");
  const info = part2.inspect(dir);
  ok(info.logRel === undefined, "F-02② 越界 logDir ⇒ info.logRel 被置空", String(info.logRel));
  ok(part2.logDirOf(info) === undefined, "F-02② b ⇒ logDirOf 也拿不到（不再绕过门禁）", String(part2.logDirOf(info)));
  const outside = path.join(path.dirname(dir), "escape-log");
  ok(!fs.existsSync(outside), "F-02② c ⇒ 项目外**没有**出现 escape-log 目录", fs.existsSync(outside) ? "🔴 出现了" : "未出现");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ F-03：路由注销函数必须能拿回来 ═══
{
  const shSrc = fs.readFileSync(path.join(ROOT, "lib", "settings-http.js"), "utf8");
  ok(/routeDisposers/.test(shSrc), "F-03① installSettingsRoutes 收集了 routeDisposers", "有");
  ok(/return \{ registered, failures, dispose \}/.test(shSrc), "F-03① b 返回对象里带 dispose", "有");

  const settingsHttp = await import(`${LIB}/settings-http.js`);
  const disposed = [];
  const fakeScope = {
    webServer: { register: () => () => disposed.push(1) },
    get: () => undefined,
  };
  const r = settingsHttp.installSettingsRoutes(fakeScope, () => ({ settings: {} }), { get: () => undefined });
  ok(typeof r.dispose === "function", "F-03② 真调一次：拿到 dispose 函数", typeof r.dispose);
  ok(r.registered.length === 3, "F-03② b 注册了 3 条路由", String(r.registered.length));
  // ★ 2026-10-25（D324）：`dispose` 可能不存在（这正是被守护的性质）⇒ 必须**判空后再调**，
  //   否则「dispose 丢了」这个被测缺陷会变成**探针自己崩溃**，反向验证就分不清两者。
  if (typeof r.dispose === "function") r.dispose();
  ok(
    typeof r.dispose === "function" && disposed.length === 3,
    "F-03② c 🔴 调 dispose ⇒ **3 条路由的注销函数全被调用**（真的注销了）",
    `dispose=${typeof r.dispose} disposed=${disposed.length}`
  );
}

// ═══ F-04：forget(sid) 不许连坐其它会话 ═══
{
  const lcSrc = fs.readFileSync(path.join(ROOT, "lib", "log-collector.js"), "utf8");
  ok(/function flushAll\(stage, onlySid\)/.test(lcSrc), "F-04① flushAll 接受 onlySid 过滤参数", "有");
  ok(/flushAll\(true,\s*sid\)/.test(lcSrc), "F-04① b forget(sid) 传了 sid（不再全局 flush）", "有");
  ok(/onlySid !== undefined && b\.sid !== onlySid/.test(lcSrc), "F-04① c 循环里真的跳过别的会话", "有");
}

// ═══ F-05：absent 分支也要带广播序号 ═══
{
  const dSrc = fs.readFileSync(path.join(ROOT, "lib", "defs.js"), "utf8");
  ok(
    /return `absent\|\\?\$\{settingsTag\}\|\\?\$\{broadcastTag\}`|return `absent\|\$\{settingsTag\}\|\$\{broadcastTag\}`/.test(dSrc),
    "F-05① absent 分支的返回值里带上了 broadcastTag",
    /absent\|\$\{settingsTag\}\|\$\{broadcastTag\}/.test(dSrc) ? "有" : "🔴 没有"
  );
}

// ═══ F-06①：我那条 e2e 探针必须真的喂进事件（这是本轮最该记的一条）═══
{
  const probeSrc = fs.readFileSync(path.join(ROOT, "tools", "_probe-d323-e2e.mjs"), "utf8");
  ok(
    /consume\(\s*dir\s*,/.test(probeSrc) || /consume\(\s*[a-zA-Z_$][\w$]*\s*,\s*["']/.test(probeSrc),
    "F-06① e2e 探针改成 `consume(root, sid, event)` 正确签名",
    /consume\(\s*dir\s*,/.test(probeSrc) ? "consume(dir, ...)" : "未识别签名"
  );
  ok(
    /memoryRoot/.test(probeSrc),
    "F-06① b 夹具里补了 memoryRoot（否则 logDirOf 仍拿不到日志目录）",
    /memoryRoot/.test(probeSrc) ? "有" : "🔴 没有"
  );
  ok(
    /L0-milestones/.test(probeSrc),
    "F-06① c 断言**真的落盘了 L0 文件**（真跑，不是「不抛错」）",
    /L0-milestones/.test(probeSrc) ? "有" : "🔴 没有"
  );
  // ★★★ 2026-10-25（D324）：**这条断言我第一版写错过，就地记下**。
  //   我原来匹配的是字面量 `L0-milestones.md`（带 `.md`），而探针里实际写的是
  //   `f.includes("L0-milestones")`（**不带扩展名**，因为 `readdirSync(recursive)` 返回的
  //   是目录项名，判断前缀更稳）。⇒ 我的判据**假红**。
  //   ★ 判据：**核"探针有没有在做这件事"，不要核"它的字符串长什么样"** ——
  //     后者把"实现细节"当成了"行为"，实现一换写法就误报。
  {
    const e2eOut = (() => {
      try {
        const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "_probe-d323-e2e.mjs")], {
          cwd: ROOT,
          encoding: "utf8",
        });
        return `${r.stdout ?? ""}${r.stderr ?? ""}`;
      } catch (e) {
        return `spawn 失败：${e.message}`;
      }
    })();
    ok(
      /② c 真喂一条事件[^\n]*logWritten=true/.test(e2eOut),
      "F-06① c-2 🔴 **真跑它一次**：② c 那一行必须报 `logWritten=true`（不是靠读源码猜）",
      /logWritten=true/.test(e2eOut) ? "logWritten=true" : "🔴 没看到 logWritten=true"
    );
  }
}

// ═══ F-06②：dirty-source 必须扫全部 lib，不是单文件 ═══
{
  const dsSrc = fs.readFileSync(path.join(ROOT, "tools", "_probe-dirty-source.mjs"), "utf8");
  ok(/readdirSync/.test(dsSrc), "F-06② dirty-source 用 readdirSync 扫目录（不是单文件）", "有");
  ok(/endsWith\(["']\.js["']\)/.test(dsSrc), "F-06② b 且按 .js 过滤拼全部模块", "有");
}

// ═══ F-06⑤：发布包里不许有本机路径 ═══
{
  const p8 = fs.readFileSync(path.join(ROOT, "lib", "part8.js"), "utf8");
  ok(!p8.includes("D:\\Deepseek工作区"), "F-06⑤ lib/part8.js 里没有本机盘符路径", p8.includes("D:\\Deepseek工作区") ? "🔴 还有" : "已脱敏");
  // 全 lib 都不许有
  const leaked = [];
  for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => x.endsWith(".js"))) {
    const t = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    if (/[A-Za-z]:\\\\Deepseek|D:\\Deepseek/.test(t)) leaked.push(f);
  }
  ok(leaked.length === 0, "F-06⑤ b 全部 lib 里都没有本机工作区路径", leaked.join(", ") || "0 处");
}

// ═══ F-06③④：跨平台 sh 与 import.meta.dirname 兜底 ═══
{
  const st = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");
  ok(/["']\/bin\/sh["']/.test(st), "F-06③ selftest 补了 POSIX `/bin/sh`", "有");
  const acf = fs.readFileSync(path.join(ROOT, "tools", "_probe-assertion-can-fail.mjs"), "utf8");
  ok(/import\.meta\.dirname \?\?/.test(acf), "F-06④ 探针里对 import.meta.dirname 做了兜底", "有");
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
// ★★★ 2026-10-25（D324）：**崩溃必须被明确认出来，不能混进 FAIL**。
//
//   🔴 我在反向验证里撞到过：夹具少拷一个文件 ⇒ 探针在中途 `ENOENT` 崩掉，
//     而它**前面已经打印了几十条 PASS** ⇒ 外层只看 `exit !== 0` 就判"检测出来了"。
//     那正是 006 报告 F-06① 批评的「只看 exit≠0 不算真检出」的同一个病。
//   ⇒ 现在：先打印**汇总行**，最后一行再写一个 `PROBE-COMPLETE` 哨兵。
//     反向验证必须**同时**看到 `FAIL n>0` 与哨兵 —— 缺哨兵就是崩溃，报「无法判定」。
console.log(`PROBE-COMPLETE pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
