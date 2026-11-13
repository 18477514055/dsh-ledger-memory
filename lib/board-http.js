/**
 * dsh-ledger-memory —— **项目工作台（看板）** 的宿主半边
 * ============================================================================
 *
 * ★ 这个文件治的是一件具体的事：用户要求「在开始页注册一个座位，点进去是台账看板，
 *   能查阅 / 修改 / 追加」。
 *
 * ── 为什么需要宿主侧这一层（客户端拿不到项目）─────────────────────────────
 *   看板要展示的是**某个项目**的台账。而浏览器里的面板**不知道项目根在哪**：
 *   `session.header.cwd` 只在宿主侧，且**不能直接用它**（队列/容器工作区下要用
 *   `projectRootOfSession` 归一，见 `lib/index.js` 同名注释）。
 *   ⇒ 客户端只传 `sid`（会话 id），**根目录一律由宿主侧解析**，客户端不许自己拼路径。
 *
 * ── 三个安全边界（本插件一贯口径）─────────────────────────────────────────
 *   ① **只认登记过的会话**：`sid` 必须在本进程见过（`rememberSessionRoot` 写下的），
 *      查不到就 404 —— 绝不允许客户端指定任意目录来读盘。
 *   ② **读写路径只能落在记忆目录内**：一律经 `inspect(root)` 的 `memoryBase`
 *      与 `cardFileAbs` 之类的既有解析器，不手拼字符串。
 *   ③ **原则文件在看板里是只读的**：`PRINCIPLES.md` 的写入口只有
 *      `ledger_principles_access`（用户点卡）+ `ledger_write({target:"principles"})`。
 *      看板**不提供**该通道 —— 少一个绕过授权闸门的入口（D180/D266 的不变式）。
 *
 * ── 写入口用谁的 ──────────────────────────────────────────────────────────
 *   board-model 共用读取、内容CAS和格式转换边界；单文件台账/决策/流水复用
 *   writeLedger，卡片复用 writeKindCard 并补备份、版本和审计。原则只读、流水仅追加。
 */

import fs from "node:fs";
import path from "node:path";
import { boardInventory, boardRead, boardWrite, boardPreview, boardSearch, BOARD_KINDS } from "./board-model.js";
import { readTextSafe, ensureDir, writeFileAtomic } from "./base.js";
import { dshHome } from "./part1-store.js";
import { LOCK_STORE_DIRNAME, LOCK_STORE_PKG } from "./defs.js";
import { sendJson, readBody, handleFor, authorizeRequest } from "./settings-http.js";

const BOARD_PREFIX = "/dsh-ledger-memory-board";

/** 允许从看板写入的目标（**白名单**，不是黑名单 —— 新增必须显式加）。 */
const WRITABLE = new Set(["active", "decisions", "journal", "goals", "lessons"]);

/**
 * ★ 会话 id → 项目根。**键在宿主侧、由 pre-step 每回合刷新**。
 *
 * ★★★★★ 2026-11-13（D389）**就地更正**：这里原来写的是「用进程内 Map、不落盘，
 *   重启后第一回合就会重新填」—— 那个说法**只在"用户会先跑一个回合"时成立**。
 *   实测打脸：用户 2026-11-13 重启 DSH 后**直接点开看板**，一个回合都还没跑 ⇒
 *   表是空的 ⇒ 看板显示「本进程还没见过任何项目」这句红字（截图即那次）。
 *   ⇒ **判据：凡是"重启后要不要靠运气"的状态，都不该只活在内存里。**
 *   现在这张表**会跨重启保存**（见下面 `board-roots.json` 那一节），
 *   进程内 Map 仍是一等公民（读路径不走磁盘），磁盘只是**上次退场时的快照**。
 */
const sessionRoots = new Map();

/**
 * ★★★★★ 2026-11-12（D388）：**看板要"跟着当前对话走"，不能锁死在某个碰巧见过的项目上**。
 *
 * 用户原话（逐字）：*"我认为应该先检测当前对话属于哪个项目，如果属于某个项目的话，
 *   就自动导向那个项目的项目台账文件，而不是像现在这样子锁死在某个甚至不属于我们的项目。"*
 *
 * 2026-11-13 审计更正：最近活动不是当前主视图。后台会话/子代理同样刷新 pre-step。
 * 序号仅作项目清单排序与 suggestedRoot；任何读写均要求可靠 sid 或用户显式选 root。
 * 未知 sid、sid/root 冲突一律拒绝，不回退另一个项目。
 */
const rootSeenAt = new Map(); // root → 最后一次见到的毫秒时间（只用于展示）
/**
 * ★ 单调递增序号，专治"同一毫秒内两个项目都登记"的排序歧义。
 *   实测（D388 探针）：只用 `Date.now()` 时，两个 root 的 `at` **完全相同**，
 *   于是"最近活跃"退化成"按目录名字典序" —— 那正是选错项目的一种成因。
 *   ⇒ 判据：**"最后一个登记的"必须赢**，这件事不能交给时钟分辨率。
 */
let rootSeq = 0;
const rootSeqOf = new Map(); // root → 登记序号

// ════════════════════════════════════════════════════════════════════════════
// 跨重启保存（D389）—— 把上面那三张表落成一份小 JSON
// ════════════════════════════════════════════════════════════════════════════
/**
 * ★★★★ 存在哪、为什么存在那儿
 *   `$DSH_HOME\plugin-data\dsh-ledger-memory\board-roots.json`
 *   —— 与本插件其它几份小状态同一个目录（`locks.json` / `anchors.json` / `owed.json`，
 *   见 `lib/part1-store.js` 顶部那段说明），**绝不写进用户的工作区**。
 *
 * ★★ 为什么必须节流
 *   `rememberSessionRoot` 由 pre-step **每一步**调用（`lib/index.js`），
 *   不节流就变成"每一步都写一次盘" —— 那是拿磁盘当草稿纸。
 *   ⇒ **每 ≥3 s 最多写一次**；期间有新变化就**记脏**，且**补一次尾随写**
 *   （否则"最后一个变化"可能永远等不到下一次写）。
 *
 * ★★ 为什么读盘只在启动时
 *   读路径（看板每次刷新）**一律走内存** —— 磁盘只是"上次退场时的快照"，
 *   绝不参与每次请求的判断（那会引入"看到的是磁盘上的旧项目"）。
 */
const ROOTS_STORE_FILE = "board-roots.json";
const ROOTS_STORE_VERSION = 1;
const ROOTS_WRITE_THROTTLE_MS = 3000;
const ROOTS_MAX_PROJECTS = 60;
const ROOTS_MAX_SESSIONS = 200;

/** 落盘位置（`DSH_HOME` 每次现取 —— 测试里可以把它指到临时目录）。 */
export function boardRootsStorePath() {
  return path.join(dshHome(), LOCK_STORE_DIRNAME, LOCK_STORE_PKG, ROOTS_STORE_FILE);
}

let rootsDirty = false;
let rootsTimer = null;
let rootsLastWriteAt = 0;
let rootsSaveError = null;

function rootAlive(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
}
export function boardRootsPersistenceStatus() { return { dirty: rootsDirty, error: rootsSaveError }; }
function retryRootsSave(reason) {
  rootsDirty = true;
  rootsSaveError = reason;
  if (rootsTimer === null) {
    rootsTimer = setTimeout(() => { rootsTimer = null; flushBoardRootsStore(); }, ROOTS_WRITE_THROTTLE_MS);
    rootsTimer.unref?.();
  }
}

/** 把那三张表序列化成磁盘形状（**先排序再截断**，丢的永远是最旧的那几个）。 */
function rootsSnapshot() {
  const roots = [];
  for (const [root, seq] of rootSeqOf) {
    if (typeof root !== "string" || root === "") continue;
    roots.push({ root, seq, at: rootSeenAt.get(root) ?? 0 });
  }
  roots.sort((a, b) => b.seq - a.seq); // 新 → 旧
  const kept = roots.slice(0, ROOTS_MAX_PROJECTS);
  const alive = new Set(kept.map((r) => r.root));
  // ★ 只留"项目还活着"的会话：某个项目被截断/删掉时，指向它的会话也一并丢 ——
  //   否则重启后 `sessionRootOf()` 会把一个已经不存在的根交出去。
  const sessions = [];
  for (const [sid, root] of sessionRoots) {
    if (typeof sid !== "string" || sid === "") continue;
    if (!alive.has(root)) continue;
    sessions.push([sid, root]);
  }
  return {
    version: ROOTS_STORE_VERSION,
    savedAt: Date.now(),
    seq: rootSeq,
    sessions: sessions.slice(-ROOTS_MAX_SESSIONS),
    roots: kept,
  };
}

/**
 * 真写一次盘（原子写 + **吞错**）。
 * ★ 写不进去只影响"下次重启记不住"，**绝不影响本次运行** —— 与 `writeLockStore` 同一条纪律。
 */
export function flushBoardRootsStore({ retry = true } = {}) {
  if (rootsTimer !== null) {
    clearTimeout(rootsTimer);
    rootsTimer = null;
  }
  if (!rootsDirty) return { ok: true, skipped: true };
  rootsLastWriteAt = Date.now();
  const file = boardRootsStorePath();
  try {
    ensureDir(path.dirname(file));
    const w = writeFileAtomic(file, JSON.stringify(rootsSnapshot(), null, 2) + "\n");
    if (w?.ok !== true) {
      const reason = String(w?.reason ?? "原子写失败");
      if (retry) retryRootsSave(reason);
      else { rootsDirty = true; rootsSaveError = reason; }
      return { ok: false, path: file, reason };
    }
    rootsDirty = false;
    rootsSaveError = null;
    return { ok: true, path: file };
  } catch (e) {
    const reason = String((e && e.message) || e);
    if (retry) retryRootsSave(reason);
    else { rootsDirty = true; rootsSaveError = reason; }
    return { ok: false, path: file, reason };
  }
}

/** 记账 + 按节流决定"现在写"还是"稍后补写"。 */
function scheduleRootsSave() {
  rootsDirty = true;
  const wait = ROOTS_WRITE_THROTTLE_MS - (Date.now() - rootsLastWriteAt);
  if (wait <= 0) {
    flushBoardRootsStore();
    return;
  }
  if (rootsTimer !== null) return; // 已排好一次尾随写，等它
  rootsTimer = setTimeout(() => {
    rootsTimer = null;
    flushBoardRootsStore();
  }, wait);
  // ★ 不让一个"待写"的定时器把 Node 事件循环钩住（插件卸载/进程退出不该被它拖住）。
  if (typeof rootsTimer?.unref === "function") rootsTimer.unref();
}

/**
 * 启动时读回上一次的快照。**只在模块加载时调用一次**。
 * ★ 坏条目**丢掉而不是整份作废**（与 `readLockStore` 同一条纪律）；
 * ★ **已经不存在的项目根直接丢** —— 项目被删了还留在下拉框里，
 *   点一下就是一次读盘失败，而且自动跟随会落到那个空壳上。
 */
export function loadBoardRootsStore() {
  const raw = readTextSafe(boardRootsStorePath());
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, loaded: 0, reason: "没有存档" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, loaded: 0, reason: "存档不是合法 JSON（已忽略，不影响本次运行）" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== ROOTS_STORE_VERSION) return { ok: false, loaded: 0, reason: "存档版本或形状不受支持" };
  let loaded = 0;
  const keptRoots = new Set();
  const list = (Array.isArray(parsed.roots) ? parsed.roots : []).slice(0, ROOTS_MAX_PROJECTS);
  for (const rec of list) {
    if (rec === null || typeof rec !== "object") continue;
    const root = rec.root;
    if (typeof root !== "string" || root === "") continue;
    if (keptRoots.has(root)) continue;
    if (!rootAlive(root)) continue;
    const seq = Number.isSafeInteger(rec.seq) && rec.seq >= 0 && rec.seq < Number.MAX_SAFE_INTEGER - ROOTS_MAX_SESSIONS ? rec.seq : 0;
    const at = Number.isFinite(rec.at) ? rec.at : 0;
    keptRoots.add(root);
    rootSeenAt.set(root, at);
    rootSeqOf.set(root, seq);
    // ★ 序号**接着上次的数往下发**：否则重启后新登记的 seq 会小于旧条目，
    //   "最近活跃"会退化成"上次运行里那个" —— 正是 D388 要防的错。
    if (seq > rootSeq) rootSeq = seq;
    loaded += 1;
  }
  if (Number.isSafeInteger(parsed.seq) && parsed.seq > rootSeq && parsed.seq < Number.MAX_SAFE_INTEGER - ROOTS_MAX_SESSIONS) rootSeq = parsed.seq;
  const sess = parsed.sessions;
  if (Array.isArray(sess)) {
    for (const pair of sess.slice(-ROOTS_MAX_SESSIONS)) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [sid, root] = pair;
      if (typeof sid !== "string" || sid === "") continue;
      if (typeof root !== "string" || root === "" || !keptRoots.has(root)) continue;
      sessionRoots.set(sid, root);
    }
  }
  return { ok: true, loaded, sessions: sessionRoots.size, seq: rootSeq, path: boardRootsStorePath() };
}

// ★ 模块加载时就把上次快照读回来（**早于任何请求、也早于 pre-step**）。
loadBoardRootsStore();

/** 由 `lib/index.js` 的 pre-step 采集点调用（那里已经算好了 `root` 与 `sid`）。 */
export function rememberSessionRoot(sid, root) {
  if (typeof sid !== "string" || sid === "") return;
  if (!rootAlive(root)) return;
  // Bound runtime state as well as disk snapshots; retain recently touched sessions.
  sessionRoots.delete(sid);
  sessionRoots.set(sid, root);
  rootSeenAt.set(root, Date.now());
  if (rootSeq >= Number.MAX_SAFE_INTEGER - 1) {
    const sorted = [...rootSeqOf.entries()].sort((a, b) => a[1] - b[1]);
    rootSeq = 0;
    for (const [r] of sorted) rootSeqOf.set(r, ++rootSeq);
  }
  rootSeqOf.set(root, ++rootSeq);
  while (sessionRoots.size > ROOTS_MAX_SESSIONS) sessionRoots.delete(sessionRoots.keys().next().value);
  if (rootSeqOf.size > ROOTS_MAX_PROJECTS) {
    const stale = [...rootSeqOf.entries()].sort((a, b) => a[1] - b[1]).slice(0, rootSeqOf.size - ROOTS_MAX_PROJECTS);
    for (const [r] of stale) { rootSeqOf.delete(r); rootSeenAt.delete(r); for (const [s, v] of sessionRoots) if (v === r) sessionRoots.delete(s); }
  }
  // ★ D389：记完就排一次落盘（**节流**：pre-step 每一步都会调到这里）。
  scheduleRootsSave();
}

/** 取某会话的项目根；没有就 `undefined`（调用方负责 404）。 */
export function sessionRootOf(sid) {
  return typeof sid === "string" ? sessionRoots.get(sid) : undefined;
}

/**
 * 最近活跃项目建议；绝不代表当前对话，不能作为隐式读写目的地。
 * @returns {{root:string, at:number} | undefined}
 */
export function mostRecentRoot() {
  let best;
  for (const [root, seq] of rootSeqOf) {
    if (rootAlive(root) && (best === undefined || seq > best.seq)) best = { root, seq };
  }
  if (best !== undefined) return { root: best.root, at: rootSeenAt.get(best.root) ?? 0 };
  // ★ 兜底：若 `rootSeqOf` 因某种原因没写（老版本升上来的进程），退回会话表里最后一个。
  for (const root of sessionRoots.values()) if (rootAlive(root)) return { root, at: 0 };
  return undefined;
}

/**
 * 本进程见过的**全部**项目根（去重）。
 *
 * ★ 为什么需要它：看板挂在**左栏座位**（`sidebar.panellist`）上，那是 `scope:"root"`
 *   —— **没有会话**，也就没有 `sid`。所以看板得让用户**自己选项目**，
 *   而可选范围只能是"本进程真见过的"，绝不能是客户端随便给的路径。
 *
 * ★ D389：**两个来源都要扫**。原来只扫 `sessionRoots`（会话 → 根），
 *   于是"根还在、但它的会话行被截断/没恢复"的项目会**看不见** ——
 *   而它其实仍在 `rootSeqOf` 里（落盘快照以那份为准）。只扫一处就是漏。
 */
export function knownRoots() {
  const seen = new Set();
  const out = [];
  const push = (root) => {
    if (!rootAlive(root) || seen.has(root)) return;
    seen.add(root);
    // ★ D388：带上"最后活跃时间"，调用方据此排序（最近活跃的排最前 = 默认跟随它）
    out.push({ root, name: path.basename(root) || root, at: rootSeenAt.get(root) ?? 0, seq: rootSeqOf.get(root) ?? 0 });
  };
  // ① 主来源：登记序号表（`rememberSessionRoot` 必写它，落盘快照也按它做）
  for (const root of rootSeqOf.keys()) push(root);
  // ② 兜底：只在会话表里出现过的根（`seq` 记 0 ⇒ 排最后，不抢"最近活跃"）
  for (const root of sessionRoots.values()) push(root);
  // ★ 最近登记的排最前（按**单调序号**，不按时钟 —— 同一毫秒也不会歧义）。
  out.sort((a, b) => b.seq - a.seq || a.name.localeCompare(b.name));
  return out;
}

export function installBoardRoutes(scope, state) {
  const registered = [];
  const failures = [];
  const disposers = [];
  const reg = (p, handler) => {
    try {
      const dispose = scope.webServer.register({
        kind: "exact",
        path: BOARD_PREFIX + p,
        handler: handleFor(gate(scope, handler)),
      });
      registered.push(BOARD_PREFIX + p);
      if (typeof dispose === "function") disposers.push(dispose);
      return typeof dispose === "function" ? dispose : () => {};
    } catch (e) {
      failures.push(`注册看板路由 ${p} 失败：${String((e && e.message) || e)}`);
      return () => {};
    }
  };

  /**
   * ★ 授权闸门的两层：`authorizeRequest` 与设置面板同一套（同源 + seat + 令牌）。
   *   看板读的是**项目文件**，所以它不放松、只能更严。
   */
  const gate = (sc, handler) => (req, res) => {
    const verdict = authorizeRequest(sc, req);
    if (verdict.allowed !== true) {
      sendJson(res, verdict.status ?? 403, { ok: false, error: verdict.error ?? "未授权" });
      return undefined;
    }
    return handler(req, res);
  };

  /**
   * 解析"这次要读哪个项目"。
   *   · 给了 `sid` 且登记过 ⇒ 用它；
   *   · 否则看 `root`，但**必须在 `knownRoots()` 里**（客户端只能"从我知道的里挑"，
   *     不能"你随便给我读一个目录"）；
   *   · 两者都没给 ⇒ 返回 `null`，调用方回一份项目清单让用户先选。
   */
  const rootOf = (q, res, opts) => {
    const sid = q?.sid;
    const want = q?.root;
    if (typeof sid === "string" && sid !== "") {
      const root = sessionRootOf(sid);
      if (!root || !rootAlive(root)) {
        sendJson(res, 404, { ok: false, error: "会话项目尚未登记或已不存在，请明确选择项目。" });
        return undefined;
      }
      if (want && want !== root) {
        sendJson(res, 409, { ok: false, error: "会话与指定项目不一致，拒绝猜测。" });
        return undefined;
      }
      return root;
    }
    if (typeof want === "string" && want !== "") {
      const hit = knownRoots().find((p) => p.root === want);
      if (hit) return hit.root;
      sendJson(res, 403, { ok: false, error: "该项目未登记或已不存在。" });
      return undefined;
    }
    // No current-session inference from globally latest background work.
    return null;
  };
  const getQuery = (req) => Object.fromEntries(new URL(req?.url ?? "/", "http://localhost").searchParams);
  const sendFailure = (res, e) => sendJson(res, e.status ?? 500, { ok: false, error: e.message, reason: e.message });
  const parseBody = async (req) => {
    let args;
    try { args = JSON.parse(await readBody(req)); } catch { const e = new Error("请求体不是合法 JSON。"); e.status = 400; throw e; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { const e = new Error("请求体必须是对象。"); e.status = 400; throw e; }
    return args;
  };
  const requiredRoot = (args, res) => {
    const root = rootOf(args, res);
    if (root === null) sendJson(res, 400, { ok: false, error: "请明确指定项目（root 或 sid）。" });
    return root;
  };
  reg("/board.json", async (req, res) => {
    try {
      if (req.method === "POST") {
        const args = await parseBody(req); const root = requiredRoot(args, res);
        if (!root) return;
        sendJson(res, 200, boardWrite(root, args, state)); return;
      }
      if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "仅支持 GET/POST。" }); return; }
      const q = getQuery(req); const root = rootOf(q, res);
      if (root === undefined) return;
      if (root === null) {
        sendJson(res, 200, { ok: true, needPick: true, followed: false, suggestedRoot: mostRecentRoot()?.root ?? null,
          projects: knownRoots(), persistence: boardRootsPersistenceStatus(), writable: [...WRITABLE], rows: [], selected: { ok: true, kind: "active", entry: null, text: "", writable: false, etag: null, editor: { type: "markdown", fields: {} } } }); return;
      }
      const kind = q.kind ?? "active";
      if (!BOARD_KINDS.includes(kind)) { sendJson(res, 400, { ok: false, error: "未知记忆类别。" }); return; }
      sendJson(res, 200, { ok: true, followed: false, projects: knownRoots(), persistence: boardRootsPersistenceStatus(), writable: [...WRITABLE], ...boardInventory(root), selected: boardRead(root, kind, q.entry ?? "") });
    } catch (e) { sendFailure(res, e); }
  });
  reg("/board-file.json", (req, res) => {
    if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "仅支持 GET。" }); return; }
    const q = getQuery(req); const root = requiredRoot(q, res); if (!root) return;
    const r = boardRead(root, q.kind ?? "active", q.entry ?? "");
    sendJson(res, r.ok ? 200 : r.status ?? 500, r);
  });
  reg("/search.json", (req, res) => {
    if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "仅支持 GET。" }); return; }
    const q = getQuery(req); const root = requiredRoot(q, res); if (!root) return;
    try { sendJson(res, 200, boardSearch(root, q.q, q.offset ?? 0, q.limit ?? 30)); } catch (e) { sendFailure(res, e); }
  });
  reg("/preview.json", async (req, res) => {
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST。" }); return; }
    try {
      const args = await parseBody(req); const root = requiredRoot(args, res); if (!root) return;
      sendJson(res, 200, boardPreview(root, args));
    } catch (e) { sendFailure(res, e); }
  });

  return { ok: failures.length === 0, registered, failures, dispose: () => disposers.forEach((d) => { try { d(); } catch { /* 卸载失败不致命 */ } }) };
}

export { BOARD_PREFIX };
