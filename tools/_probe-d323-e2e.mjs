/**
 * _probe-d323-e2e.mjs —— D323 搬家后的**真行为**验证（不是"文件存在/能 import"）。
 *
 * 本项目纪律：**"文件存在 / 模块可解析 / 配置里有 / 版本号对"一律不构成"能用"的证据。**
 * ⇒ 两件事必须真跑：
 *   ① `createLogCollector`（已搬到 log-collector.js）真能建起来、真能收事件、真能落盘；
 *   ② `deriveSettingsView` / `saveSettings`（已搬到 settings-http.js）通过 part2 的转发
 *      拿到的**与搬家前是同一个函数引用**（证明它不只是"同名同形"，而是真同一份实现）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

const part2 = await import(`${LIB}/part2.js`);
const part3 = await import(`${LIB}/part3.js`);
const settingsHttp = await import(`${LIB}/settings-http.js`);
const logCollector = await import(`${LIB}/log-collector.js`);

// ═══ ① 转发导出 = **同一个函数引用**（不是同名副本）═══
{
  const same = [];
  for (const n of ["deriveSettingsView", "installSettingsRoutes", "saveSettings", "authorizeRequest", "assertAuthorized"]) {
    same.push([n, part2[n] !== undefined && part2[n] === settingsHttp[n]]);
  }
  ok(
    same.every(([, v]) => v),
    "① settings-http 的 5 个入口经 part2 转发后是**同一引用**（REPL 身份相等，不是同名副本）",
    same.map(([n, v]) => `${n}=${v}`).join(" ")
  );
  ok(
    part3.createLogCollector !== undefined && part3.createLogCollector === logCollector.createLogCollector,
    "① b createLogCollector 经 part3 转发后是**同一引用**",
    "同一引用"
  );
}

// ═══ ② createLogCollector 真能建起来并真收到事件 ═══
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-lc-"));
  const mem = path.join(dir, "mem");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify({ memoryRoot: "mem", active: "LEDGER.md", logDir: "_ledger-log" }, null, 2), "utf8");
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# L\n", "utf8");

  const ctx = {
    on: () => () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
  };
  let built;
  try {
    built = logCollector.createLogCollector(ctx);
  } catch (e) {
    built = undefined;
    console.log(`        建 collector 抛错：${e.message}`);
  }
  ok(built !== undefined, "② createLogCollector 真能建成（不抛错）", built === undefined ? "抛错" : "ok");

  // ★★ 我第一版这里断言"它向 ctx 注册了事件钩子" ⇒ **假红**。
  //   真相：它是**推模式**（`consume` / `flushNow` / `forget`），事件由 `index.js` 喂进来。
  //   判据错在**我按印象假设了它的形状**，没先看它暴露什么（尺子错第 16 条）。
  const api = built === undefined ? [] : Object.keys(built).filter((k) => typeof built[k] === "function");
  ok(
    api.includes("consume") && api.includes("flushNow"),
    "② b 它暴露的是**推模式**接口（consume / flushNow）—— 事件由外层喂，不是自己注册钩子",
    api.join(", ") || "(无)"
  );

  // ★ 真喂一条事件并 flushNow，验证 L0 日志真落盘到 mem/_ledger-log（这才是"能用"的证据）
  let logWritten = false;
  try {
    built.consume(dir, "session-e2e", { type: "deliverables/presented", data: { files: ["a.md"] } }, {});
    built.flushNow();
    const logDirAbs = path.join(mem, "_ledger-log");
    const files = fs.existsSync(logDirAbs) ? fs.readdirSync(logDirAbs, { recursive: true }).map(String) : [];
    logWritten = files.some((f) => f.includes("L0-milestones") && fs.readFileSync(path.join(logDirAbs, f), "utf8").includes("deliverables/presented"));
  } catch (e) {
    logWritten = false;
  }
  ok(
    logWritten,
    "② c 真喂一条事件并 flushNow 后 L0 日志真落盘到 mem/_ledger-log（不是空转）",
    `logWritten=${logWritten}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ③ 设置视图真能算出来（走 settings-http 的实现）═══
{
  const view = settingsHttp.deriveSettingsView({ get: () => undefined });
  ok(view !== undefined && typeof view === "object", "③ deriveSettingsView 真返回对象", typeof view);
  ok(view.settings !== undefined && typeof view.settings === "object", "③ b 带 settings（不是空壳）", `keys=${Object.keys(view.settings ?? {}).length}`);
  ok(Array.isArray(view.specs) && view.specs.length > 0, "③ c specs 是**已展开的数组**（不是函数/对象）", `${view.specs?.length} 条`);
  ok(
    view.specs.every((s) => typeof s.options !== "function"),
    "③ d ★ specs 里的 options 已展开成值（留函数的话 JSON.stringify 会静默丢掉它）",
    "全部非函数"
  );
  ok(view.writable === false && typeof view.why === "string", "③ e 没有 configEditor ⇒ writable:false 且**说清原因**（不静默）", `why=${String(view.why).slice(0, 40)}`);
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
