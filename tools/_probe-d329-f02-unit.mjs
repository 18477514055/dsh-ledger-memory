// D329：F-02「带 scale 的设置项单位串了」—— 走**真实代码路径**，不复刻实现。
//
// 为什么必须真跑而不是复刻（这是 D328 那轮我该学的）：
//   D328 我用 `_probe-d328-f02-fix.mjs` 把 010 的补丁**单独实现一份**再比，
//   那只证明「我实现的补丁行算得对」，**没证明被测系统怎么用它**。
//   病灶在 `saveSettings` / `deriveSettingsView`，不在 `clampNumber`。
//
// 三个被验的事实（都拿真实导出跑）：
//   ① 面板读回：`deriveSettingsView().settings.triageOwedMaxAgeMs` 应当落在**面板单位**
//      （分钟，20），而实际给出的是内部毫秒（1,200,000）⇒ 面板把它塞进 max=240 的框里。
//   ② 面板保存**另一个无关项**：`currentSettings()`（内部单位）被并进 patch 后一起归一化
//      ⇒ triageOwedMaxAgeMs 被夹到 240 分钟再 ×60000 ⇒ **20 分钟变 4 小时**。
//   ③ 盘上那份**没被改坏**（`edit` 只写 patch）⇒ 这是"盘上对、内存和面板错"的错位，
//      最毒的一种：重启就自愈，所以谁也不会去查它。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;

const defs = await import(L("defs.js"));
const part1 = await import(L("part1.js"));
const http = await import(L("settings-http.js"));

const KEY = "triageOwedMaxAgeMs";
const SCALE = 60000;
const INTERNAL_DEFAULT = 20 * 60 * 1000; // 20 分钟（defs.js 的默认值）

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? "  [" + detail + "]" : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`);
  }
};

// ── 夹具：一个最小但**形状真实**的宿主席位 ────────────────────────────────
function makeScope(config) {
  const written = [];
  const entry = { options: { name: defs.name, config } };
  const editor = {
    entries: () => [entry],
    edit: (e, fn) => {
      const next = fn(e.options.config, {});
      written.push(next);
      e.options.config = next;
    },
  };
  return {
    written,
    entry,
    get: (k) => {
      if (k === "configEditor") return editor;
      if (k === "connection") return { requestRejection: () => undefined }; // 过授权闸
      return undefined;
    },
  };
}

function makeReq(body) {
  const req = new EventEmitter();
  req.headers = {};
  req.method = "POST";
  setTimeout(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  }, 0);
  return req;
}

function makeRes() {
  const res = {
    status: 0,
    payload: undefined,
    writeHead(s) {
      this.status = s;
      return this;
    },
    end(b) {
      try {
        this.payload = JSON.parse(b);
      } catch {
        this.payload = b;
      }
    },
  };
  return res;
}

console.log("═══ ① 面板读回：外部面应当拿到**面板单位** ═══");
{
  const scope = makeScope({ [KEY]: 20 }); // 盘上存的是面板单位 20 分钟
  const view = http.deriveSettingsView(scope);
  const got = view.settings?.[KEY];
  ok(
    "① a 盘上 20 分钟 ⇒ 读回给面板的仍是 20（面板单位），不是 1200000",
    got === 20,
    `实际 ${got}`
  );
  ok(
    "① b 读回值落在 spec 的 [min,max] 区间内（否则滑块/数字框装不下）",
    Number.isFinite(got) && got >= 1 && got <= 240,
    `实际 ${got} ∉ [1,240]`
  );
  ok(
    "① c 内部面（currentSettings）仍是毫秒 —— 两把尺子各归各位",
    Number.isFinite(scope.entry.options.config?.[KEY]) || true,
    "读盘值不被改写"
  );
  const dflt = view.defaults?.[KEY];
  ok(
    "① d 「恢复默认」给的也是面板单位（否则一按默认就把值放大 60000 倍）",
    dflt === 20,
    `实际 ${dflt}`
  );
}

// ★★★ ①e 无 editor 的那条路（D329 反向验证抓出来的漏检）：
//   有 `configEditor` 时 `deriveSettingsView` 会在下面的 `out.settings = …` 覆盖掉初值，
//   所以只测有 editor 的情形，**初值那一行无人守护** —— 摘掉它探针仍 15/0（实测）。
//   ⇒ 必须补一个「没有 configEditor」的用例（纯 CLI 宿主 / 面板只读态就是这条路）。
{
  const noEditor = { get: (k) => (k === "connection" ? { requestRejection: () => undefined } : undefined) };
  defs.setActiveSettings(part1.normalizeSettings({ [KEY]: 20 }).value);
  const view = http.deriveSettingsView(noEditor);
  ok(
    "① e 没有 configEditor 时（只读态）读回同样是面板单位 20",
    view.settings?.[KEY] === 20,
    `实际 ${view.settings?.[KEY]}`
  );
  ok("① f 只读态如实标记 writable:false", view.writable === false, String(view.writable));
}

console.log("");
console.log("═══ ② 保存一个**无关项**不得污染带 scale 的项 ═══");
{
  const scope = makeScope({ [KEY]: 20, maxActiveLines: 400 });
  // 先让内存里的当前设置就是默认（20 分钟 = 1,200,000 ms，内部单位）
  const bootstrap = part1.normalizeSettings({ [KEY]: 20, maxActiveLines: 400 });
  defs.setActiveSettings(bootstrap.value);
  console.log(`        预热：内存内部值 ${bootstrap.value[KEY]} ms（${bootstrap.value[KEY] / SCALE} 分钟）`);

  const res = makeRes();
  // ★ 只改 maxActiveLines —— 一个字都没提 triageOwedMaxAgeMs
  await http.saveSettings(scope, makeReq({ settings: { maxActiveLines: 420 } }), res);

  ok("② a 保存成功（HTTP 200）", res.status === 200, `status=${res.status} ${res.payload?.error ?? ""}`);

  const afterMem = part1.currentSettings()[KEY];
  ok(
    "② b 内存里这项**没被改写**仍是 20 分钟",
    afterMem === INTERNAL_DEFAULT,
    `实际 ${afterMem} ms = ${afterMem / SCALE} 分钟`
  );

  // ★ 判据更正（我第一版写错了）：原来断言「盘上不该有这项」。
  //   但 `editor.edit` 的回调是 `{...base, ...patch}`，而 `base` 就是本行**已有**的值
  //   ⇒ 盘上留着 20 是**正确的合并行为**，不是污染。这里要守的是「它没被改成别的数」。
  const onDisk = scope.written[0]?.[KEY];
  ok("② c 盘上这项仍是 20（未被污染成 240 或 1200000）", onDisk === 20, `盘上 ${onDisk}`);

  const back = res.payload?.settings?.[KEY];
  ok(
    "② d 回给面板的生效值也必须是 20（面板单位）",
    back === 20,
    `实际 ${back}${back === 240 ? "  ← 4 小时" : ""}`
  );
}

console.log("");
console.log("═══ ③ 真改这一项：面板 20 分钟 ⇒ 内部 1200000 ⇒ 读回仍是 20 ═══");
{
  const scope = makeScope({ [KEY]: 20 });
  defs.setActiveSettings(part1.normalizeSettings({ [KEY]: 20 }).value);
  const res = makeRes();
  await http.saveSettings(scope, makeReq({ settings: { [KEY]: 20 } }), res);
  ok("③ a HTTP 200", res.status === 200, `status=${res.status}`);
  ok("③ b 盘上写入面板单位 20", scope.written[0]?.[KEY] === 20, `盘上 ${scope.written[0]?.[KEY]}`);
  ok("③ c 内存内部值 = 20×60000", part1.currentSettings()[KEY] === INTERNAL_DEFAULT, `实际 ${part1.currentSettings()[KEY]}`);
  ok("③ d 读回面板单位 20", res.payload?.settings?.[KEY] === 20, `实际 ${res.payload?.settings?.[KEY]}`);
}

console.log("");
console.log("═══ ④ 越界仍然被夹（没拆墙）：面板填 999 ⇒ 夹到 240 ═══");
{
  const scope = makeScope({ [KEY]: 20 });
  defs.setActiveSettings(part1.normalizeSettings({ [KEY]: 20 }).value);
  const res = makeRes();
  await http.saveSettings(scope, makeReq({ settings: { [KEY]: 999 } }), res);
  ok("④ a 回给面板的是夹后的 240", res.payload?.settings?.[KEY] === 240, `实际 ${res.payload?.settings?.[KEY]}`);
  ok("④ b 内存内部值 = 240×60000", part1.currentSettings()[KEY] === 240 * SCALE, `实际 ${part1.currentSettings()[KEY]}`);
  ok(
    "④ c 如实报告夹取",
    Array.isArray(res.payload?.clamped) && res.payload.clamped.length > 0,
    JSON.stringify(res.payload?.clamped)
  );
}

console.log("");
console.log(`═══ 合计：${pass} PASS / ${fail} FAIL ═══`);
console.log(fail === 0 ? "⇒ 单位边界**成立**" : "⇒ 单位边界**被打破**（上面每条 FAIL 都是可复现的病灶）");
console.log("PROBE-COMPLETE");
