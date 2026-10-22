# V3 地基勘查：lib/ 入口清单

> 生成：node tools/_probe-v3-entrypoints.mjs · 扫描 10 个文件 · 命中 459 处
> ★ 判据已剥注释、已抹文档属性；行号指向**原始文件**行号。

## ① 写文件（会改变磁盘状态）（110 处）

### `lib/part4.js`（31 处）

- **L66** `ensureDir` — ensureDir(path.dirname(abs));
- **L67** `writeFileSync` — fs.writeFileSync(abs, `# 关键决策记录\n\n> 长期决策记在这里，**不参与归档、永久保留**。\n`, "utf8");
- **L92** `ensureDir` — ensureDir(abs);
- **L138** `ensureDir` — ensureDir(abs);
- **L157** `ensureDir` — ensureDir(path.dirname(manifestPath));
- **L158** `writeFileSync` — fs.writeFileSync(manifestPath, text, "utf8");
- **L1079** `ensureDir` — //
- **L1080** `writeFileSync` — //   用户原话（逐字）：*"最好就是插件本体在被指定项目之后就会**自动生成所需要的各项文件**，
- **L1095** `ensureDir` — const ensureFile = (abs, rel, given, skelKey) => {
- **L1097** `ensureDir` — if (typeof given === "string" && given !== "") notes.push(`${rel} 已存在，未覆盖。`);
- **L1105** `ensureDir` — if (!(typeof given === "string" && given !== "")) skel.push(rel);
- **L1106** `ensureDir` — };
- **L1107** `ensureDir` — ensureFile(activeAbs, active, args?.initialActive, "active");
- **L1283** `writeFileAtomic` — if (logDir !== "") {
- **L1946** `writeFileAtomic` — return out.sort((a, b) => {
- **L1958** `unlinkSync` — if (abs === undefined) return undefined;
- **L2078** `ensureDir` — .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
- **L2080** `writeFileSync` — const shown = rows.slice(0, limit);
- **L2081** `renameSync` — const md = [
- **L2453** `ensureDir` — // ★ 记下**行号**（1-based，给人读）—— 重复编号时要把证据摆出来（见下面 dups）。
- **L2454** `writeFileSync` — starts.push({ key, line: i, lineNo: i + 1 });
- **L3101** `writeFileAtomic` — delta: bodyLines - beforeLines,
- **L3499** `ensureDir` — //
- **L3510** `writeFileAtomic` — nothingWritten: true,
- **L3517** `writeFileAtomic` — }
- **L3676** `ensureDir` — export function appendAudit(root, info, rec) {
- **L3677** `appendFileSync` — const now = new Date();
- **L4137** `ensureDir` — output: { schema: OK_SCHEMA, render: renderResult },
- **L4139** `writeFileSync` — const root = rootFromExec(exec, args);
- **L4267** `ensureDir` — }
- **L4268** `writeFileSync` — const title = typeof args?.title === "string" ? args.title.trim() : "";

### `lib/part2.js`（30 处）

- **L69** `ensureDir` — ensureDir(path.dirname(abs));
- **L70** `writeFileSync` — fs.writeFileSync(tmp, next, "utf8");
- **L71** `renameSync` — fs.renameSync(tmp, abs);
- **L807** `writeFileSync` — const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
- **L808** `renameSync` — // ★ 类型词也要认两种（`经验`/`教训`）—— 否则删经验条目会定位不到。
- **L891** `ensureDir` — kind: entry.kind,
- **L892** `writeFileSync` — mode: "card",
- **L893** `renameSync` — relPath: written.dirRel,
- **L1255** `ensureDir` — next = existing.trim() === "" ? `# 目标树\n\n${block}` : `${existing.replace(/\s+$/, "")}\n\n${block}`;
- **L1256** `writeFileSync` — } else {
- **L1257** `renameSync` — // ★ 原地替换那一张卡（**逐字**保住别人的卡不被碰）。
- **L1430** `writeFileSync` — const dropped = dropCard();
- **L1431** `renameSync` — if (dropped !== null) {
- **L1537** `writeFileSync` — } catch {
- **L1553** `writeFileSync` — /**
- **L2152** `writeFileAtomic` — *    ① **要么旧版本完整可读，要么新版本完整写入** —— 绝不留半截；
- **L2156** `ensureDir` — * ★ 为什么用 `rename` 而不是 `copy`：同目录下 `rename` 是**原子替换**（POSIX 保证；
- **L2162** `writeFileSync` — *
- **L2165** `unlinkSync` — 
- **L2173** `renameSync` — }
- **L2176** `unlinkSync` — fs.writeFileSync(tmp, data, { encoding: "utf8", flag: "wx" });
- **L2249** `ensureDir` — if (Array.isArray(value)) return value.map((x) => lossless(x));
- **L2250** `mkdirSync` — if (t === "object") {
- **L2974** `ensureDir` — try {
- **L2987** `appendFileSync` — const file = path.join(root, ...relFile.split("/"));
- **L4527** `ensureDir` — );
- **L4528** `writeFileSync` — const missing = lines.filter((l) => l !== "" && !present.has(l));
- **L4780** `unlinkSync` — // ★★★ 只删**自己装的那一个**。别人的钩子**绝对不碰** —— 那是用户的文件。
- **L4828** `ensureDir` — "\n" +
- **L4829** `writeFileSync` — 'if [ -n "$bad" ]; then\n' +

### `lib/part1.js`（29 处）

- **L481** `ensureDir` — ensureDir(path.dirname(file));
- **L483** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
- **L484** `renameSync` — fs.renameSync(tmp, file);
- **L690** `ensureDir` — ensureDir(path.dirname(p));
- **L692** `writeFileSync` — fs.writeFileSync(tmp, nextText, "utf8");
- **L693** `renameSync` — fs.renameSync(tmp, p);
- **L1022** `ensureDir` — ensureDir(path.dirname(file));
- **L1024** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
- **L1025** `renameSync` — fs.renameSync(tmp, file);
- **L1100** `ensureDir` — ensureDir(path.dirname(file));
- **L1102** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
- **L1103** `renameSync` — fs.renameSync(tmp, file);
- **L1223** `ensureDir` — ensureDir(path.dirname(file));
- **L1225** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store) + "\n", "utf8");
- **L1226** `renameSync` — fs.renameSync(tmp, file);
- **L1694** `ensureDir` — ensureDir(path.dirname(file));
- **L1696** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
- **L1697** `renameSync` — fs.renameSync(tmp, file);
- **L2316** `ensureDir` — ensureDir(path.dirname(file));
- **L2318** `writeFileSync` — fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
- **L2319** `renameSync` — fs.renameSync(tmp, file);
- **L3535** `writeFileAtomic` — //   ★ 它是"恢复所需记录"（review 的原话），写失败必须在返回值里体现（`undefined`）。
- **L3562** `writeFileSync` — if (!isUnder(root, abs)) return { ok: false, reason: "清单路径逃出项目根" };
- **L4198** `ensureDir` — try {
- **L4202** `writeFileSync` — try {
- **L4207** `writeFileSync` — const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;
- **L4300** `ensureDir` — try {
- **L4303** `writeFileSync` — try {
- **L4308** `writeFileSync` — const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;

### `lib/part7.js`（12 处）

- **L133** `ensureDir` — ensureDir(to);
- **L138** `ensureDir` — ensureDir(path.dirname(to));
- **L139** `copyFileSync` — fs.copyFileSync(from, to);
- **L145** `rmSync` — fs.rmSync(partialAbs, { recursive: true, force: true });
- **L147** `ensureDir` — ensureDir(partialAbs);
- **L171** `writeFileSync` — fs.writeFileSync(path.join(partialAbs, victim.rel), "★ 被故意写坏的内容（探针注入）\n", "utf8");
- **L206** `renameSync` — fs.renameSync(partialAbs, memAbs);
- **L209** `rmSync` — fs.rmSync(partialAbs, { recursive: true, force: true });
- **L225** `writeFileAtomic` — const w = writeFileAtomic(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
- **L240** `ensureDir` — ensureDir(retiredTo);
- **L245** `ensureDir` — ensureDir(path.dirname(to));
- **L246** `renameSync` — fs.renameSync(from, to);

### `lib/part3.js`（5 处）

- **L1477** `ensureDir` — ensureDir(path.dirname(abs));
- **L1479** `appendFileSync` — fs.appendFileSync(abs, lines.join("\n") + "\n", "utf8");
- **L2499** `writeFileSync` — const cur = readManifest(info.projectRoot) ?? {};
- **L3096** `ensureDir` — const outFile = path.join(rootDir, MIDTURN_DIAG_FILE);
- **L3097** `appendFileSync` — const ts = new Date().toISOString();

### `lib/part5.js`（3 处）

- **L525** `ensureDir` — ]
- **L526** `appendFileSync` — .filter(([, v]) => v !== "")
- **L528** `appendFileSync` — 

## ② 读文件（路径错了就读不到，迁移后必须核对）（122 处）

### `lib/part2.js`（40 处）

- **L61** `readTextSafe` — const existing = readTextSafe(abs) ?? "";
- **L281** `readTextSafe` — readTextSafe(rel === undefined ? "" : path.resolve(memoryBaseOf(info, root), rel)) ?? "";
- **L1240** `readTextSafe` — 
- **L1424** `readTextSafe` — `「${id}」还有 ${kids.length} 个子目标（${kids.map((k) => k.id).join("、")}）—— ` +
- **L1585** `readdirSync` — 
- **L1660** `existsSync` — *   的那一层，才能保证同一个工作区里的会话都写进同一处 ——
- **L1798** `existsSync` — //     照做就等于**把卡片化往回推**（重建单文件），而真正的问题只是**清单里留了个过时键**。
- **L1802** `readdirSync` — //     ⇒ 卡片模式（`<kind>Dir` 已登记）下：合规 = **该目录在且里面有卡**，
- **L1820** `existsSync` — if (!dirOk || cards === 0) {
- **L1844** `existsSync` — ? "创建一个空的决策记录文件（不覆盖任何已有内容）"
- **L1972** `readdirSync` — 
- **L1984** `readTextSafe` — try {
- **L2110** `lstatSync` — try {
- **L2202** `readTextSafe` — }
- **L2204** `readFileSync` — }
- **L2862** `statSync` — //     所以 `L2-files-002.md` 天然会被收进来。
- **L2976** `existsSync` — const rel = info?.archiveRel;
- **L3796** `readManifest` — *
- **L3802** `readManifest` — * @returns {string|undefined} 绝对路径；拿不到 cwd 且没锁 ⇒ undefined
- **L3804** `readTextSafe` — 
- **L3821** `readdirSync` — const parsed = JSON.parse(raw);
- **L3837** `readdirSync` — return undefined;
- **L3854** `statSync` — }
- **L3873** `statSync` — return undefined;
- **L3887** `readManifest` — if (fs.statSync(path.join(projectRoot, n)).isDirectory()) return n;
- **L3932** `existsSync` — if (memoryRootRaw !== "") {
- **L3939** `existsSync` — // ★ 越界 ⇒ 降级回项目根，并如实记下（不许静默忽略，否则"配了却不生效"最难查）
- **L3970** `existsSync` — let archiveSource = "manifest";
- **L3986** `existsSync` — principlesSource = "guess";
- **L4002** `existsSync` — goalsSource = "guess";
- **L4018** `existsSync` — journalSource = "guess";
- **L4135** `readManifest` — // 真项目里没有"问题记录"这回事（它该用台账），给了反而会诱导 AI 把项目内容
- **L4151** `statSync` — typeof baseManifest?.notesDir === "string" && baseManifest.notesDir !== ""
- **L4176** `readTextSafe` — if (notesRel === undefined) {
- **L4214** `statSync` — if (!isContainer) {
- **L4325** `readdirSync` — *   这里**恰恰最不该**初始化：它是个装着许多仓库的容器，不是仓库。
- **L4337** `existsSync` — let entries;
- **L4358** `statSync` — next.push(child);
- **L4506** `readTextSafe` — */
- **L4759** `readTextSafe` — if (inside.ok !== true || inside.stdout !== "true") {

### `lib/part4.js`（40 处）

- **L34** `readManifest` — const prev = readManifest(root) ?? {};
- **L58** `existsSync` — } else if (fs.existsSync(abs)) {
- **L85** `existsSync` — } else if (fs.existsSync(abs)) {
- **L129** `existsSync` — if (fs.existsSync(abs)) {
- **L130** `statSync` — if (fs.statSync(abs).isDirectory()) {
- **L275** `readTextSafe` — const text = readTextSafe(abs);
- **L322** `readTextSafe` — const gText = readTextSafe(gAbs);
- **L848** `readManifest` — //     对一个**已经登记** `principles: 'PRINCIPLES.md'` 的项目重新调 `ledger_init`，
- **L916** `readManifest` — // 三者互不重叠：归档目录不能是某个文件的路径，文件也不能塞进归档目录里。
- **L1021** `existsSync` — 
- **L1027** `existsSync` — //     ★ 这与用户早已拍板的决策**正好相反**（七个拍板决策之一就是「`git init` 必须显式」）。
- **L1073** `existsSync` — ignoreResult = mergeGitignore(root, [...DEFAULT_IGNORE_LINES, ...v3Lines, ...extra]);
- **L1110** `readManifest` — //      git init / .gitignore / LEDGER.md / DECISIONS.md **都先发生**，
- **L1138** `existsSync` — //   `notesDir` 以及**任何未知扩展字段**都被静默丢弃。
- **L1295** `existsSync` — manifest.logLevels = parseLevels(args?.logLevels ?? prev.logLevels, defaultLogLevels());
- **L1490** `readTextSafe` — "Which part of the ledger to read. ★ \"journal\" is the append-only turn journal " +
- **L1510** `readTextSafe` — additionalProperties: false,
- **L1528** `readdirSync` — const dir = path.resolve(mBase, info.archiveRel);
- **L1539** `statSync` — const raw = readTextSafe(file);
- **L1588** `readTextSafe` — const cMode = readKind === undefined ? { card: false } : cardModeOf(info, readKind);
- **L1893** `readdirSync` — * @returns {{ok:boolean, why?:string}}
- **L1908** `readFileSync` — /** 一张卡的绝对路径（**先过白名单**，非法返回 undefined）。 */
- **L1928** `readTextSafe` — const out = [];
- **L1955** `existsSync` — 
- **L2146** `readTextSafe` — */
- **L2211** `readTextSafe` — * ★ 形态：卡片模式 ⇒ 按**文件名序**把每张卡拼起来（`listCards` 已按数字后缀排序，
- **L2293** `readTextSafe` — }
- **L2305** `existsSync` — *   ④ **不是幂等就拒** —— 目标目录已存在且非空 ⇒ **拒绝**（不覆盖、不合并）。
- **L2307** `readdirSync` — * @returns {{ok:boolean, dryRun:boolean, cards?:number, written?:number, dir?:string, reason?:string, verify?:
- **L2449** `readManifest` — lines.forEach((l, i) => {
- **L2930** `readTextSafe` — "**根本原则条例只能由用户授权后写入** —— 这次调用没有携带**由用户动作产生**的授权，所以一个字节都没写。\n" +
- **L3167** `existsSync` — }
- **L3354** `readTextSafe` — const archiveAbs = path.resolve(memBase, info.archiveRel);
- **L3496** `readTextSafe` — // ★ 为什么这样反而**更安全**：真实风险不是"我改了几行"，而是"归档里进了假东西"。
- **L3569** `existsSync` — 
- **L3700** `readdirSync` — //     判据原来只白名单了 principle/goals ⇒ 一次 `target:"journal"` 的写入
- **L3714** `statSync` — `${rec.lines} 行` +
- **L3857** `readTextSafe` — // ★ audit 视图要固定读 L0（审计行就写在 L0 那个文件里）。若调用者同时给了
- **L4122** `existsSync` — cause: {
- **L4230** `existsSync` — type: "object",

### `lib/part1.js`（15 处）

- **L445** `readTextSafe` — const raw = readTextSafe(lockStorePath());
- **L636** `readTextSafe` — const raw = readTextSafe(pkgPath);
- **L685** `readTextSafe` — const prev = readTextSafe(p);
- **L998** `readTextSafe` — const raw = readTextSafe(anchorStorePath());
- **L1068** `readTextSafe` — const raw = readTextSafe(owedStorePath());
- **L1205** `readTextSafe` — const raw = readTextSafe(blockHistoryPath());
- **L1615** `existsSync` — if (fs.existsSync(file)) return file;
- **L1661** `readTextSafe` — const raw = readTextSafe(shadowedStorePath());
- **L2270** `readTextSafe` — const raw = readTextSafe(capsuleStorePath());
- **L2587** `statSync` — if (!fs.statSync(rec.root).isDirectory()) return undefined;
- **L2616** `statSync` — if (!fs.statSync(candidate).isDirectory()) return undefined;
- **L2662** `statSync` — isDir = fs.statSync(abs).isDirectory();
- **L3527** `readManifest` — try {
- **L3557** `readManifest` — if (!MODES.includes(mode)) return { ok: false, reason: `不认识的模式：${String(mode)}` };
- **L4103** `readdirSync` — try {

### `lib/part7.js`（13 处）

- **L42** `readManifest` — const manifest = readManifest(projectRoot) ?? {};
- **L81** `existsSync` — const existing = rels.filter((r) => fs.existsSync(path.join(projectRoot, r)));
- **L108** `readFileSync` — const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
- **L113** `statSync` — const st = fs.statSync(abs);
- **L117** `readdirSync` — for (const e of fs.readdirSync(d, { withFileTypes: true })) {
- **L131** `statSync` — const st = fs.statSync(from);
- **L134** `readdirSync` — for (const e of fs.readdirSync(from, { withFileTypes: true })) {
- **L144** `existsSync` — if (fs.existsSync(partialAbs)) {
- **L152** `statSync` — expected.push({ rel: f, size: fs.statSync(path.join(projectRoot, f)).size, hash: hashOf(path.join(projectRoot,
- **L180** `existsSync` — if (!fs.existsSync(p)) {
- **L184** `statSync` — const st = fs.statSync(p);
- **L205** `existsSync` — if (!fs.existsSync(memAbs)) {
- **L243** `existsSync` — if (!fs.existsSync(from)) continue;

### `lib/part3.js`（7 处）

- **L762** `readTextSafe` — const raw = readTextSafe(info.activeAbs) ?? "";
- **L1108** `readTextSafe` — blockSnapshots.set(info.projectRoot, splitBlocks(readTextSafe(info.activeAbs) ?? ""));
- **L1267** `readTextSafe` — raw = readTextSafe(info.activeAbs);
- **L1489** `existsSync` — if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(b.root, ".git"))) {
- **L1671** `statSync` — isDir = fs.statSync(abs).isDirectory();
- **L2143** `readTextSafe` — const files = logFileList(info).filter((f) => logicalLogName(path.basename(f.rel)) === "L0-ledger-changes.md")
- **L2496** `readManifest` — if (choice === "skip") {

### `lib/part5.js`（4 处）

- **L524** `existsSync` — ["下一步", cut(args?.next)],
- **L538** `existsSync` — 
- **L1147** `readTextSafe` — authorizedBy: "user-command",
- **L1399** `readTextSafe` — ? "\n**最近改动**：还没有记录（没启用日志，或还没人写过台账）。\n"

### `lib/part6.js`（2 处）

- **L284** `readdirSync` — //     在这里统一换成某个基准，必然把其中一类扫错地方，而且**扫不到不报错**。
- **L356** `statSync` — // ★ 与上面同一条判据：基准跟着**面**走，不跟着函数走。

### `lib/defs.js`（1 处）

- **L3747** `readFileSync` — * ★ "落在节点附近"由**落盘闸门**免费实现（零 token）：

## ③ Git 交互（V3 全部要改成「永不自动暂存」）（17 处）

### `lib/part2.js`（10 处）

- **L4424** `git` — 
- **L4448** `gitAvailable` — return {
- **L4449** `git` — ok: code === 0,
- **L4646** `git` — *   ★ 为什么这条边界必须守住（不是保守，是那三个动作真的都不可逆）：
- **L4656** `git` — */
- **L4744** `git` — *     与 D293 同一条调子：**只报警 + 给方案，不假装能阻止。**
- **L4751** `git` — * @param {string} projectRoot 项目根
- **L4850** `gitAdd` — chmodOk = false;
- **L4860** `git` — } catch (e) {
- **L4880** `git` — .filter((l) => l !== "");

### `lib/part4.js`（4 处）

- **L1030** `git` — //       替他把 `.git` 建好，等于**替他做了一个不可轻率撤销的决定** ——
- **L1306** `gitAdd` — const mw = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");
- **L3168** `gitAdd` — }
- **L3574** `gitAdd` — try {

### `lib/part3.js`（2 处）

- **L1490** `gitAdd` — gitAdd(b.root, written);
- **L3764** `git` — if (typeof m === "string" && MODES.includes(m)) return "manifest";

### `lib/part5.js`（1 处）

- **L539** `gitAdd` — let created = false;

## ④ 网络 / 对外发送（1 处）

### `lib/client.js`（1 处）

- **L228** `fetch` — const res = await fetch(url, opts);

## ⑤ 路径拼接（V3 要把它们统一收进 memoryRoot）（209 处）

### `lib/part4.js`（72 处）

- **L33** `path.join` — const manifestPath = path.join(root, MANIFEST_REL);
- **L55** `path.resolve` — const abs = path.resolve(mBase, info.decisionsRel);
- **L66** `ensureDir` — ensureDir(path.dirname(abs));
- **L82** `path.resolve` — const abs = path.resolve(mBase, info.archiveRel);
- **L124** `path.resolve` — const abs = path.resolve(mBaseRc, dirRel);
- **L157** `ensureDir` — ensureDir(path.dirname(manifestPath));
- **L273** `path.resolve` — const abs = path.resolve(root, c.rel);
- **L320** `path.resolve` — const gAbs = path.resolve(mBase, info.goalsRel);
- **L710** `path.resolve` — async execute(args, exec) {
- **L740** `path.resolve` — }
- **L755** `path.resolve` — //     「落在 memRootAbs 内」⇒ 必然也落在项目内。校验两层只是多余的重复。
- **L778** `path.resolve` — const abs = path.resolve(memRootAbs, value);
- **L847** `path.resolve` — //   🔴 review 的实测（这是它给出的"删掉参数也不够"那个变体）：
- **L883** `path.resolve` — ["goals", typeof args?.goals === "string" ? args.goals.trim() : prevManifest.goals],
- **L887** `path.resolve` — .filter(([, rel]) => norm(rel) !== undefined && norm(rel) === nextPrinciplesAbs)
- **L895** `path.resolve` — `  此后**每一次普通 ledger_write 都会合法地改到原则文件** —— 保护就形同虚设。\n` +
- **L896** `path.resolve` — `★ 「改变原则路径 / 解除原则保护」本身**是需要用户明确同意**的操作，\n` +
- **L897** `path.resolve` — `  不能用一次 ledger_init 悄悄完成。\n` +
- **L933** `path.resolve` — //       （正是"记录存在 ≠ 记录准确"，注释说"不受影响"、代码偏要覆盖）。
- **L956** `path.resolve` — const jAbs = path.resolve(memRootAbs, journal);
- **L1021** `existsSync` — 
- **L1027** `existsSync` — //     ★ 这与用户早已拍板的决策**正好相反**（七个拍板决策之一就是「`git init` 必须显式」）。
- **L1079** `ensureDir` — //
- **L1091** `path.resolve` — //   已有的 `initial*` 仍然优先（那段行为一个字没改，向后兼容）。
- **L1092** `path.resolve` — const written = [];
- **L1093** `path.resolve` — const skel = [];
- **L1097** `ensureDir` — if (typeof given === "string" && given !== "") notes.push(`${rel} 已存在，未覆盖。`);
- **L1105** `ensureDir` — if (!(typeof given === "string" && given !== "")) skel.push(rel);
- **L1106** `ensureDir` — };
- **L1107** `ensureDir` — ensureFile(activeAbs, active, args?.initialActive, "active");
- **L1136** `path.resolve` — //   **先铺开旧清单**，再覆盖这次明确要写的字段。
- **L1283** `writeFileAtomic` — if (logDir !== "") {
- **L1295** `existsSync` — manifest.logLevels = parseLevels(args?.logLevels ?? prev.logLevels, defaultLogLevels());
- **L1356** `path.join` — builtGeneration: honestProtoVersion,
- **L1499** `path.resolve` — "`D<n>` (decision, e.g. \"D195\"), `L<n>`/`E<n>` (lesson/experience), `g<n>` (goal card), " +
- **L1508** `path.resolve` — },
- **L1534** `path.join` — 
- **L1584** `path.resolve` — //   ★ 形态：卡片模式 ⇒ 拼出一个"虚拟整份"（顺序由 `listCards` 保证：`D2` 在 `D10` 前），
- **L1857** `path.resolve` — const k = key.trim();
- **L1881** `path.resolve` — *
- **L1908** `readFileSync` — /** 一张卡的绝对路径（**先过白名单**，非法返回 undefined）。 */
- **L2076** `path.resolve` — why: (w.weight?.why ?? []).join("；"),
- **L2078** `ensureDir` — .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
- **L2144** `path.resolve` — *
- **L2209** `path.resolve` — *   ⇒ 判据：**凡是"整份读"的地方，都必须问一句"这一类现在住在哪"**。
- **L2291** `path.resolve` — const rel = mode.fileRel;
- **L2448** `path.resolve` — const starts = [];
- **L2453** `ensureDir` — // ★ 记下**行号**（1-based，给人读）—— 重复编号时要把证据摆出来（见下面 dups）。
- **L2927** `path.resolve` — return {
- **L3167** `existsSync` — }
- **L3313** `path.resolve` — ifRevision: {
- **L3314** `path.resolve` — type: "number",
- **L3320** `path.join` — force: {
- **L3322** `path.basename` — description:
- **L3323** `path.join` — "Only to override the maxActiveLines gate after confirming the result is intended.",
- **L3569** `existsSync` — 
- **L3642** `path.basename` — goneNote:
- **L3647** `path.resolve` — ...(tag === undefined ? {} : { sessionTag: tag }),
- **L3676** `ensureDir` — export function appendAudit(root, info, rec) {
- **L3705** `path.join` — rec.kind === AUDIT_KIND_PRINCIPLE ||
- **L3732** `path.basename` — */
- **L3736** `path.basename` — const out = [];
- **L3741** `path.dirname` — entries = fs.readdirSync(dir, { withFileTypes: true });
- **L3742** `path.dirname` — } catch {
- **L4118** `path.join` — enum: NOTE_KINDS,
- **L4225** `path.join` — "a session (or when changing direction) — the document goes to the project's agreed handoff " +
- **L4232** `path.join` — title: {
- **L4256** `path.join` — output: { schema: OK_SCHEMA, render: renderResult },
- **L4259** `path.join` — const info = inspect(root);
- **L4262** `path.join` — ok: false,
- **L4265** `path.join` — "若当前目录是容器工作区，请用 `root` 点名某个具体项目。",
- **L4363** `path.resolve` — */

### `lib/part2.js`（71 处）

- **L58** `path.resolve` — const abs = path.resolve(memBase, relPath);
- **L69** `ensureDir` — ensureDir(path.dirname(abs));
- **L281** `readTextSafe` — readTextSafe(rel === undefined ? "" : path.resolve(memoryBaseOf(info, root), rel)) ?? "";
- **L783** `path.resolve` — reason:
- **L891** `ensureDir` — kind: entry.kind,
- **L1238** `path.resolve` — 
- **L1255** `ensureDir` — next = existing.trim() === "" ? `# 目标树\n\n${block}` : `${existing.replace(/\s+$/, "")}\n\n${block}`;
- **L1423** `path.resolve` — reason:
- **L1532** `path.resolve` — mode: rec.op,
- **L1548** `path.resolve` — if (typeof cur.goals === "string" && cur.goals !== "") return;
- **L1594** `path.join` — 
- **L1655** `path.resolve` — /**
- **L1660** `existsSync` — *   的那一层，才能保证同一个工作区里的会话都写进同一处 ——
- **L1667** `path.dirname` — const limit = Number.isFinite(maxUp) && maxUp > 0 ? Math.floor(maxUp) : 3;
- **L1797** `path.resolve` — //   ⇒ ★ 更糟的是它给出的"可修"建议是**「创建一个空的决策记录 `DECISIONS.md`」** ——
- **L1819** `path.resolve` — }
- **L1843** `path.resolve` — info.decisionsRel === undefined
- **L1984** `readTextSafe` — try {
- **L2023** `path.resolve` — export function fail(message) {
- **L2024** `path.resolve` — return new Error(String(message));
- **L2076** `path.resolve` — if (rootReal === undefined) {
- **L2077** `path.join` — // 连项目根本身都解析不出来（不存在 / 权限）⇒ 不猜，报不可判定（调用方按拒绝处理）
- **L2094** `path.resolve` — why:
- **L2097** `path.resolve` — lexical: "in",
- **L2107** `path.resolve` — try {
- **L2115** `path.dirname` — }
- **L2153** `path.resolve` — *    ② 写失败时**临时文件必须被清掉**（否则下一轮的"最近已存在祖先"会被它带偏）；
- **L2156** `ensureDir` — * ★ 为什么用 `rename` 而不是 `copy`：同目录下 `rename` 是**原子替换**（POSIX 保证；
- **L2862** `statSync` — //     所以 `L2-files-002.md` 天然会被收进来。
- **L2973** `path.join` — export function archiveEvictedUserMessage(root, info, msg, sid) {
- **L2974** `ensureDir` — try {
- **L3519** `path.join` — "\n### 器物索引（本会话碰过的文件；**按路径去重**，不是摘要）\n\n" +
- **L3522** `path.join` — changed.map(([p, v]) => `- \`${p}\`（${v.op}，最后 \`${v.at}\`，${v.tool}）`).join("\n") +
- **L3525** `path.join` — (rows.length > changed.length
- **L3529** `path.join` — 
- **L3551** `path.join` — //   （见 `persistCapsule`：`${dir}/${period}/${CAPSULE_DIR_NAME}`）。
- **L3552** `path.join` — //   ⇒ 那个指针**指错一层**，照着它 ls 会**一个胶囊都找不到** ——
- **L3565** `path.join` — `- 历次逐字胶囊（**原件**）：\`${path.join(memBase, capDirRel)}\`` +
- **L3568** `path.join` — }
- **L3572** `path.join` — //   ★ 原来这里读的是 `opts?.handoffRel` —— 一个**没有任何地方传**的参数 ⇒
- **L3792** `path.resolve` — *   锁是给"cwd 没有台账（典型：建在总工作区）"这种情况用的**接管**手段；
- **L3803** `path.join` — */
- **L3854** `statSync` — }
- **L3873** `statSync` — return undefined;
- **L3919** `path.resolve` — //     decisionsDir / lessonsDir / goalsDir / handoff / capsule / stash / notes(若跟随项目)
- **L3932** `existsSync` — if (memoryRootRaw !== "") {
- **L3938** `path.join` — } else {
- **L3969** `path.resolve` — let archiveRel = manifest?.archiveDir;
- **L3985** `path.resolve` — principlesRel = DEFAULT_PRINCIPLES_NAME;
- **L4001** `path.resolve` — goalsRel = DEFAULT_GOALS_NAME;
- **L4017** `path.resolve` — journalRel = DEFAULT_JOURNAL_NAME;
- **L4057** `path.resolve` — //
- **L4087** `path.resolve` — //   "绝不把 `logs/` 这类通用目录认成台账日志"，而它的候选里就有 `_log`，
- **L4141** `path.resolve` — //   所以先往上找工作区根（`findWorkspaceRoot`），找到就用它当基准。
- **L4151** `statSync` — typeof baseManifest?.notesDir === "string" && baseManifest.notesDir !== ""
- **L4153** `path.join` — : undefined;
- **L4165** `path.resolve` — if (fs.statSync(path.join(notesBase, c)).isDirectory()) {
- **L4172** `path.resolve` — /* 不存在就下一个 */
- **L4205** `path.resolve` — //   ⚠️ 我第一版写成 `if (isGitRepo)`，结果自检里那些"建了台账但没 git init"
- **L4214** `statSync` — if (!isContainer) {
- **L4216** `path.resolve` — typeof manifest?.handoffDir === "string" && manifest.handoffDir !== "" ? manifest.handoffDir : undefined;
- **L4226** `path.resolve` — for (const c of HANDOFF_DIR_CANDIDATES) {
- **L4247** `path.join` — }
- **L4335** `path.join` — const next = [];
- **L4337** `existsSync` — let entries;
- **L4358** `statSync` — next.push(child);
- **L4372** `path.resolve` — if (fs.statSync(path.join(projectRoot, m)).isFile()) return m;
- **L4505** `path.join` — * @returns {string[]} 要追加的规则行（V2 项目返回空数组 —— **行为逐字不变**）
- **L4527** `ensureDir` — );
- **L4755** `path.resolve` — const enabled = opts?.enabled === true;
- **L4756** `path.join` — 

### `lib/part1.js`（29 处）

- **L425** `path.join` — return typeof home === "string" && home !== "" ? home : path.join(os.homedir(), ".dsh");
- **L438** `path.join` — return path.join(dshHome(), LOCK_STORE_DIRNAME, LOCK_STORE_PKG, LOCK_STORE_FILE);
- **L481** `ensureDir` — ensureDir(path.dirname(file));
- **L518** `path.join` — return path.join(path.dirname(lockStorePath()), ANCHOR_STORE_FILE);
- **L634** `path.dirname` — const here = path.dirname(fileURLToPath(import.meta.url)); // lib/
- **L635** `path.join` — const pkgPath = path.join(here, "..", "package.json");
- **L651** `path.join` — return path.join(path.dirname(lockStorePath()), CAPABILITY_STORE_FILE);
- **L690** `ensureDir` — ensureDir(path.dirname(p));
- **L1022** `ensureDir` — ensureDir(path.dirname(file));
- **L1057** `path.join` — return path.join(path.dirname(lockStorePath()), OWED_STORE_FILE);
- **L1100** `ensureDir` — ensureDir(path.dirname(file));
- **L1198** `path.join` — return path.join(path.dirname(lockStorePath()), BLOCK_HISTORY_FILE);
- **L1223** `ensureDir` — ensureDir(path.dirname(file));
- **L1330** `path.join` — return path.join(path.dirname(lockStorePath()), CAPSULE_STORE_FILE);
- **L1538** `path.join` — return path.join(path.dirname(lockStorePath()), SHADOWED_INDEX_FILE);
- **L1612** `path.join` — const dir = path.join(dshHome(), "sessions", encodeSessionDirName(path.resolve(cwd)));
- **L1614** `path.join` — const file = path.join(dir, name, "session.v4.jsonl.zstd");
- **L1694** `ensureDir` — ensureDir(path.dirname(file));
- **L2316** `ensureDir` — ensureDir(path.dirname(file));
- **L2659** `path.resolve` — const abs = path.resolve(String(root));
- **L2679** `path.resolve` — cwd: typeof cwd === "string" ? path.resolve(cwd) : undefined,
- **L3535** `writeFileAtomic` — //   ★ 它是"恢复所需记录"（review 的原话），写失败必须在返回值里体现（`undefined`）。
- **L3560** `path.join` — const next = { ...prev, mode, updatedAt: stamp(new Date()) };
- **L4166** `path.resolve` — const memBase = memoryBaseOf(info, root);
- **L4186** `path.resolve` — const rel = `${relDir}/${capsuleFileStamp(now)}-${tag}.md`;
- **L4207** `writeFileSync` — const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;
- **L4256** `path.resolve` — const memBaseS = memoryBaseOf(info, root);
- **L4261** `path.resolve` — const rel = `${relDir}/${capsuleFileStamp(now)}-${tag}.md`;
- **L4308** `writeFileSync` — const rel2 = `${relDir}/${capsuleFileStamp(now)}-${tag}-2.md`;

### `lib/part7.js`（18 处）

- **L41** `path.join` — const manifestPath = path.join(projectRoot, MANIFEST_REL);
- **L56** `path.basename` — const baseName = path.basename(projectRoot);
- **L58** `path.join` — const memAbs = path.join(projectRoot, memDirName);
- **L81** `existsSync` — const existing = rels.filter((r) => fs.existsSync(path.join(projectRoot, r)));
- **L112** `path.join` — const abs = path.join(root, rel);
- **L118** `path.join` — const p = path.join(d, e.name);
- **L129** `path.join` — const from = path.join(projectRoot, rel);
- **L130** `path.join` — const to = path.join(destRoot, rel);
- **L138** `ensureDir` — ensureDir(path.dirname(to));
- **L152** `statSync` — expected.push({ rel: f, size: fs.statSync(path.join(projectRoot, f)).size, hash: hashOf(path.join(projectRoot,
- **L171** `writeFileSync` — fs.writeFileSync(path.join(partialAbs, victim.rel), "★ 被故意写坏的内容（探针注入）\n", "utf8");
- **L179** `path.join` — const p = path.join(partialAbs, e.rel);
- **L237** `path.join` — const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
- **L238** `path.join` — const retiredRoot = path.join(home, "plugin-data", "dsh-ledger-memory", "_retired", baseName);
- **L239** `path.join` — retiredTo = path.join(retiredRoot, stampSec(new Date()).replace(/[: ]/g, "-"));
- **L242** `path.join` — const from = path.join(projectRoot, rel);
- **L244** `path.join` — const to = path.join(retiredTo, rel);
- **L245** `ensureDir` — ensureDir(path.dirname(to));

### `lib/part3.js`（9 处）

- **L865** `path.join` — `\`${path.join(info.projectRoot, info.handoffLatestRel)}\`\n` +
- **L1475** `path.resolve` — const abs = path.resolve(b.root, fileRel);
- **L1477** `ensureDir` — ensureDir(path.dirname(abs));
- **L1489** `existsSync` — if (info.manifest?.autoGitAdd !== false && fs.existsSync(path.join(b.root, ".git"))) {
- **L1668** `path.resolve` — const abs = path.resolve(base ?? process.cwd(), raw);
- **L2140** `path.basename` — // ★★★★★ 2026-10-18（D255）：拆片后文件名会变成 `L0-ledger-changes-002.md`，
- **L2495** `path.join` — //     用户说过一次不用改，不该因为重启就又被催一遍（他会被问烦的）。
- **L3093** `path.join` — //     `projectRootOf(agent)` 正是全项目取根的唯一出口（part2 导出，已在本文件 line 6 导入）。
- **L3096** `ensureDir` — const outFile = path.join(rootDir, MIDTURN_DIAG_FILE);

### `lib/part5.js`（6 处）

- **L519** `path.resolve` — const parts = [
- **L525** `ensureDir` — ]
- **L538** `existsSync` — 
- **L1146** `path.resolve` — mode: "append",
- **L1234** `path.join` — }
- **L1280** `path.resolve` — "· `/ledger lock off` —— 解锁，回到按会话工作目录解析\n\n" +

### `lib/part6.js`（4 处）

- **L281** `path.resolve` — //   项目面传 `projectRoot`）—— 所以这里**只做一件事：别再自己挑基准**。
- **L353** `path.resolve` — for (const item of files) {
- **L397** `path.basename` — *   （实测：D90:147 写的是 `_调研-billion-context.md`，不带目录）。
- **L664** `path.basename` — const staleNotes = listed
