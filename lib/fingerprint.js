/**
 * fingerprint.js —— 文件指纹：**改名、搬家之后仍能机械地认出"这是哪个文件"**
 *
 * ★★★★ 用户原话（2026-10-28，D351/D352）：
 *   *"即使所有文件名字都被改了，也能准确区分以及被调用"*
 *   *"最好是能够被机械识别的，不能让模型自己去思考怎么识别出来"*
 *   *"如果整个项目的所有文件路径都变化了…用类似计算哈希值的公式来计算指纹，
 *     让这些指纹自己就可以确定这些文件到底是干什么用的"*
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计铁律（这几条互相制约，动一条就会破坏另一条）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ① **身份三元组 = kind + project + key，三者都不随内容变化。**
 *    为什么不含内容哈希：含了之后**改一个字就认不出是同一个文件** ——
 *    那是"校验和"，不是"身份"。内容用独立的 `seal` 位。
 *
 * ② ★ **身份自证位 `check` = sha8(`v|kind|project|key`)。**
 *    作用：扫描时**不信任字面量**，自己重算一遍再比 ⇒ 能抓出手工改坏、截断、
 *    陈旧副本、字段拼错这类"看起来对其实不对"的指纹。
 *    ★★ 但它**不是签名、不防伪造**（改了字段谁都能重算）——
 *       它防的是**事故**，不是**恶意**。这一点必须写在代码里，不能含糊过去。
 *
 * ③ ★★★ **`seal` = 正文（去掉指纹后）的 sha8，只用于判断"内容有没有被换过"。**
 *    它**不参与身份**，所以正文变了身份不变 —— 这正是"改名不丢"能成立的前提。
 *
 * ④ **指纹必须"影响不大"**：单行 HTML 注释，Markdown 不可见、现有解析器当普通文本。
 *    ★ 且 **splitBlocks 必须跳过指纹行**（见 part1.js）——
 *      否则它会自成一个块，把 15 块变成 16 块（实测抓到的 bug）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 形状（放文件头，BOM 之后）：
 *   <!-- dsh-ledger-fp: v=1 kind=decisions project=<16hex> key=D195 check=<8hex> seal=<8hex> -->
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isAbsoluteAnywhere, isUnderReal } from "./base.js";

/** 指纹行的格式版本。将来若改字段，靠它做兼容分流。 */
export const FP_VERSION = 1;

/** 前缀（用于"这行是不是指纹行"的快速判定，不解析） */
export const FP_MARK = "<!-- dsh-ledger-fp:";

/**
 * ★★★ 唯一的识别正则 —— **整个插件认指纹只有这一处**。
 * 判据纪律：同一个事实只能有一个出口；两套正则会分叉。
 * 字段顺序固定：v → kind → project → key → check → seal。
 */
const FP_RE =
  /<!--\s*dsh-ledger-fp:\s*v=(\d+)\s+kind=([a-z][a-z0-9_-]*)\s+project=([0-9a-f]{16})\s+key=(\S+?)\s+check=([0-9a-f]{8})\s+seal=([0-9a-f]{8})\s*-->/;

/** 旧格式（只有 sha8，没有 check/seal）—— 读到时**视为无 check**，仍可认出身份 */
const FP_RE_LEGACY =
  /<!--\s*dsh-ledger-fp:\s*v=(\d+)\s+kind=([a-z][a-z0-9_-]*)\s+project=([0-9a-f]{16})\s+key=(\S+?)\s+sha8=([0-9a-f]{8})\s*-->/;

/** 生成一个 16 位十六进制项目 id（2^64，单机项目量级碰撞可忽略） */
export function newProjectId() {
  return crypto.randomBytes(8).toString("hex");
}

/** 内容校验位 */
export function sha8Of(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/**
 * ★★★★ 身份自证位：`v|kind|project|key` 的哈希。
 * ★ 不含内容 ⇒ 正文随便改，这个位不变 ⇒ 身份稳定。
 * ★ 扫描时用它验证"指纹没被改坏"（防事故，不防伪造）。
 */
export function identityCheck(v, kind, project, key) {
  return sha8Of(`${v}|${kind}|${project}|${key}`);
}

const KIND_RE = /^[a-z][a-z0-9_-]*$/;
const PROJ_RE = /^[0-9a-f]{16}$/;
const SHA8_RE = /^[0-9a-f]{8}$/;
/**
 * ★★★ `key` 的合法字符集（D357 实测修正）。
 *
 * 🔴 原写法 `/^[A-Za-z0-9_./-]+$/` —— **只允许 ASCII**，
 *   而真实文件名里有中文：`_handoff/2026-10-10-1323-发布就绪审计-+-确认新构建已在真内核生效.md`
 *   ⇒ 铺指纹时**直接抛异常**（`指纹 key 非法`），全库铺不进去。
 *   ★ 这是"拿想象中的字符集去卡真实数据"的典型 —— 本机文件树大量中文。
 *
 * ★ 但 `key` 里有**空格**也不行：指纹行是"空格分隔的字段序列"，
 *   空格会让 `key=(\S+?)` 提前截断。实测本库确有 **3 个**带空格的文件名
 *   （`_ledger-archive/.../2026-10-14-迁移前快照-DECISIONS.md（203 卡之来源）.md`）。
 *   ⇒ **不改文件名**（它们是归档真源），改用 **百分号编码**：空格 → `%20`。
 *
 * ★★ 编码只动"会破坏格式"的字符，其余原样保留（保证可读、可人眼核对）：
 *   `%`→`%25`（必须第一个做，否则二次编码）· 空格→`%20` · `<`→`%3C` · `>`→`%3E`
 *   · 控制字符→`%XX`。解码是**唯一逆运算**，无歧义。
 */
export function encodeKey(raw) {
  let s = String(raw ?? "");
  s = s.replace(/%/g, "%25"); // ★ 必须先做
  s = s.replace(/ /g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E");
  s = s.replace(/[\u0000-\u001f\u007f]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  return s;
}
export function decodeKey(enc) {
  return String(enc ?? "").replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
/** 编码后必须**不含空白与尖括号**且非空 —— 这是"能被正则无歧义切分"的充要条件。 */
function keyIsSafe(key) {
  return typeof key === "string" && key !== "" && !/[\s<>]|-->|[\u0000-\u001f\u007f]/.test(key);
}

/** 拼一行指纹。★ 纯函数。非法输入抛错（生成侧也守门） */
export function renderFingerprintLine(f) {
  const v = Number.isFinite(f?.v) ? f.v : FP_VERSION;
  const kind = String(f?.kind ?? "");
  const project = String(f?.project ?? "");
  const key = String(f?.key ?? "-") || "-";
  if (!KIND_RE.test(kind)) throw new Error(`指纹 kind 非法: ${kind}`);
  if (!PROJ_RE.test(project)) throw new Error(`指纹 project 非法: ${project}`);
  if (!keyIsSafe(key)) throw new Error(`指纹 key 非法（含空白/尖括号/控制字符）: ${key}`);
  const check = identityCheck(v, kind, project, key);
  const seal = SHA8_RE.test(String(f?.seal ?? "")) ? String(f.seal) : sha8Of("");
  return `<!-- dsh-ledger-fp: v=${v} kind=${kind} project=${project} key=${key} check=${check} seal=${seal} -->`;
}

/** 这行文本是不是指纹行（不解析字段） */
export function isFingerprintLine(line) {
  return typeof line === "string" && line.includes(FP_MARK);
}

/**
 * ★★★ 这行是不是**指纹的链接引用定义**（D354 加的第二载体）。
 * ★ 为什么它比注释强：链接引用定义是**正文语法**（不是注释）⇒
 *   `strip HTML comments` 那类清洗器不碰它；而 Markdown **渲染时同样不显示**。
 * ★ 实测（`_probe-d354-positions.mjs`）：单点抗洗能力 **注释 2/6 · 链接定义 5/6**。
 */
export function isFingerprintLinkLine(line) {
  if (typeof line !== "string") return false;
  return /^\s*\[dsh-fp-link\]:\s*dsh-ledger-fp\s/.test(line);
}

/**
 * 行内信标（第三载体）：嵌在正文第一行末尾，抗"整体缩进"与 CRLF。
 *
 * ★★★ 2026-10-28（D357 实测修正）：key 的字符集必须**与 `keyIsSafe` 对齐**。
 *   🔴 原写法 `([A-Za-z0-9_.-]+)` —— 只认 ASCII ⇒ 遇到
 *     `key=extensions/gemini4-gemini3-8-gpt/cards/R1.md`（含 `/`）或中文时**匹配不到**，
 *     于是 `replace(...,"g")` **摘不掉** ⇒ 信标每写一次就多留一处 ⇒ **幂等被破坏**
 *     （实测 608/1021 个文件不幂等，`seal` 每次变）。
 *   ★ 现在改成"**排除空白与 `-->` 的非贪婪串**"——与 `keyIsSafe` 同一条判据，
 *     不再维护第二份字符集（那正是"两套规则必然分叉"的又一个实例）。
 */
const INLINE_KEY = "([^\\s<>]+?)";
const INLINE_RE = new RegExp(`<!--dsh-id:([0-9a-f]{16}):${INLINE_KEY}-->`);
const INLINE_MARK = "<!--dsh-id:";
export function isInlineBeaconIn(line) {
  return typeof line === "string" && line.includes(INLINE_MARK);
}

/**
 * ★★★ 解析指纹。**机械、确定性、零判断**。
 * 只看**前 8 行** —— 扫描整文件会把正文里偶然出现的同样字符串误认，
 * 那是"尺子把被测对象自己的文本当成标记"的经典错。
 *
 * @returns {{ok:true, fp:{v,kind,project,key,check,seal|null,legacy:boolean},
 *            checkOk:boolean, line:number, raw:string, warning?:string}
 *          |{ok:false, reason:string}}
 */
export function parseFingerprint(text, headLines = 8) {
  if (typeof text !== "string" || text === "") return { ok: false, reason: "空文本" };
  const lines = text.split("\n", headLines);

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(FP_RE);
    if (m !== null) {
      const fp = {
        v: Number(m[1]),
        kind: m[2],
        project: m[3],
        key: m[4],
        check: m[5],
        seal: m[6],
        legacy: false,
      };
      const want = identityCheck(fp.v, fp.kind, fp.project, fp.key);
      const checkOk = want === fp.check;
      return {
        ok: true,
        fp,
        checkOk,
        line: i,
        raw: m[0],
        ...(checkOk ? {} : { warning: `身份自证位不符（存 ${fp.check}，实算 ${want}）⇒ 指纹被改坏过` }),
      };
    }
    // 旧格式兼容：认得出来，但没有 check ⇒ checkOk 记 true 并标注 legacy
    const lm = lines[i].match(FP_RE_LEGACY);
    if (lm !== null) {
      const fp = {
        v: Number(lm[1]),
        kind: lm[2],
        project: lm[3],
        key: lm[4],
        check: null,
        seal: lm[5],
        legacy: true,
      };
      return {
        ok: true,
        fp,
        checkOk: true,
        line: i,
        raw: lm[0],
        warning: "旧格式指纹（无 check 位），建议重写升级",
      };
    }
  }
  return { ok: false, reason: "头部无指纹" };
}

/**
 * ★★★ 把指纹写入文本（幂等：已有指纹则替换那一行，绝不叠加）。
 *
 * ★ 幂等为什么重要：`ledger_write` 每次重写整份文件，
 *   若每次追加一行，长会话下来文件头会堆几百行指纹 —— 直接吃掉注入预算。
 * ★★ BOM 必须当成"整份文件的前缀"处理（D352 实测抓到的 bug：
 *   原实现让 BOM 跟着第一行走 ⇒ 摘指纹时连 BOM 一起摘 ⇒ 两次结果不同 = 幂等被破坏）。
 */
export function applyFingerprint(text, id, opts = {}) {
  const src = typeof text === "string" ? text : "";
  const strip = opts.strip === true;

  const hasBom = src.startsWith("\uFEFF");
  const bodyIn = hasBom ? src.slice(1) : src;

  // ① 先摘掉**所有**已存在的指纹行
  const lines = bodyIn.split("\n");
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (isFingerprintLine(line)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  const body = kept.join("\n");

  if (strip) return { text: hasBom ? `\uFEFF${body}` : body, removed, added: false };

  // ② seal 按**去掉指纹后的正文**算 —— 指纹自己不影响校验位
  const seal = sha8Of(body);
  const line = renderFingerprintLine({
    kind: id?.kind,
    project: id?.project,
    key: id?.key,
    seal,
  });

  const out = `${line}\n${body}`;
  return { text: hasBom ? `\uFEFF${out}` : out, removed, added: true };
}

/** 校验内容：正文与指纹声明的 seal 是否一致（= 内容有没有被换过；同时兼容三载体与旧版单载体） */
export function verifySeal(text, parsed) {
  const p =
    parsed !== undefined
      ? parsed
      : (() => {
          const r3 = readFingerprint3(text);
          return r3.ok === true ? r3 : parseFingerprint(text);
        })();
  if (p?.ok !== true) return { ok: false, reason: "无指纹可校验" };
  const wantSeal = p?.fp?.seal ?? p?.seal;
  if (typeof wantSeal !== "string" || wantSeal === "") {
    return { ok: false, reason: "无内容校验位（可能是旧格式或仅剩行内信标）" };
  }
  const isLegacySingle =
    (p?.fp !== undefined && !Array.isArray(p?.sources)) ||
    (Array.isArray(p?.sources) && p.sources.length === 1 && p.sources[0] === "legacy");
  if (Array.isArray(p?.seals) && p.seals.length >= 2) {
    for (const sItem of p.seals) {
      if (sItem.seal !== wantSeal) {
        return {
          ok: false,
          reason: `多载体内容校验位不一致（${p.seals.map((x) => `${x.src}:${x.seal}`).join(" vs ")}）⇒ 正文或载体被部分改过`,
        };
      }
    }
  }
  let stripped;
  if (isLegacySingle) {
    stripped = applyFingerprint(text, undefined, { strip: true }).text;
  } else {
    stripped = applyFingerprint3(text, undefined, { strip: true, forSeal: true }).text;
  }
  const body = stripped.startsWith("\uFEFF") ? stripped.slice(1) : stripped;
  const want = sha8Of(body);
  if (want !== wantSeal) {
    return { ok: false, reason: `内容校验位不符（存 ${wantSeal}，实 ${want}）⇒ 正文被改过` };
  }
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★★★ 三载体（D354/D355）—— 抗洗能力从 2/6 提到 7/8
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 三处同时写，任一处存活即可认出：
 *
 *   ① YAML frontmatter      `dsh-fp-front: <payload>`        ← 抗 strip 注释
 *   ② 行内信标（第一行末）   `<!--dsh-id:<project>:<key>-->`  ← 抗整体缩进/CRLF
 *   ③ 链接引用定义（文末）   `[dsh-fp-link]: dsh-ledger-fp <payload>` ← 抗 MD→HTML→MD
 *
 * ★ 为什么必须三处而不是一处：三种洗法各灭一处，实测没有单点能全活（D354 §二）。
 * ★★ 为什么不能更多处：每处都会进每回合注入（实测三者合计 ≈239 字符 ≈139 tok/次），
 *   再加就是拿上下文税换覆盖率，不划算。
 * ★★★ 冲突处理是必备件：三处不一致时**必须报冲突并回显全部来源**，不许取第一个 ——
 *   那会把"文件被两个来源改过"这种真事故伪装成"一切正常"。
 */

/** 三载体的 payload（不含 HTML 注释包装） */
function fpPayload(v, kind, project, key, check, seal) {
  return `v=${v} kind=${kind} project=${project} key=${key} check=${check} seal=${seal}`;
}

const PAYLOAD_RE =
  /v=(\d+)\s+kind=([a-z][a-z0-9_-]*)\s+project=([0-9a-f]{16})\s+key=(\S+?)\s+check=([0-9a-f]{8})\s+seal=([0-9a-f]{8})/;

function parsePayload(s) {
  const m = PAYLOAD_RE.exec(s ?? "");
  if (m === null) return null;
  return { v: Number(m[1]), kind: m[2], project: m[3], key: m[4], check: m[5], seal: m[6] };
}

/**
 * ★★★★ 三载体写入（**幂等**：先摘掉全部旧载体，再写三处）。
 *
 * @param {string} text 原全文
 * @param {{kind:string, project:string, key:string, v?:number}} id
 * @param {{strip?:boolean}} opts strip=true ⇒ 只摘除，不写入
 */
export function applyFingerprint3(text, id, opts = {}) {
  const src = typeof text === "string" ? text : "";
  const strip = opts.strip === true;
  const hasBom = src.startsWith("\uFEFF");
  let s = (hasBom ? src.slice(1) : src).replace(/\r\n/g, "\n");

  // ── ① 摘掉全部旧载体（含旧版单载体注释，便于平滑升级）──
  let removed = 0;
  // frontmatter：整段摘（仅当文件最开头）
  const fmM = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(s);
  let fmInner = "";
  if (fmM !== null && fmM[1].split("\n").some((l) => l.trimStart().startsWith("dsh-fp-front:"))) {
    fmInner = fmM[1];
    s = s.slice(fmM[0].length);
    removed += 1;
  }
  // 链接定义行 / 行内信标 / 旧版单载体注释（跳过代码块围栏，且仅清理摘除行内信标那一行的尾空白，保住正文双空格换行）
  {
    const rawLines = s.split("\n");
    const fencedSet = computeFencedLineSetForFp(rawLines);
    const keptLines = [];
    const inlineWithSp = new RegExp(`[ \\t]?${INLINE_RE.source}`, "g");
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const l = rawLines[idx];
      if (fencedSet.has(idx)) {
        if (/^\s*(`{3,}|~{3,})/.test(l)) {
          keptLines.push(
            l.replace(inlineWithSp, () => {
              removed += 1;
              return "";
            }),
          );
        } else {
          keptLines.push(l);
        }
        continue;
      }
      if (/^\[dsh-fp-link\]:.*$/.test(l)) {
        removed += 1;
        continue;
      }
      if (/^\s*<!--\s*dsh-ledger-fp:[\s\S]*?-->\s*$/.test(l)) {
        removed += 1;
        continue;
      }
      // ★★★★ 2026-10-29（D365 · 补丁回归修复）：**只摘「一个空格 + 信标」，不再清行尾**。
      let nextL = l.replace(inlineWithSp, () => {
        removed += 1;
        return "";
      });
      keptLines.push(nextL);
    }
    s = keptLines.join("\n");
  }
  // ★★★ 2026-10-29（D364）：这里原来写 `.replace(/\s+$/, "")` —— 它把**末尾换行也吃掉**，
  //   实测原文 `"第一行笔记\n第二行\n"` strip 后变 `"第一行笔记\n第二行"`（少一个 \n）。
  //
  //   ★★★★ 但**我第一版修法把幂等改坏了**（实测：不带尾换行的文件 `幂等? false`、
  //     `seal1.ok false`）—— 因为我在"剥离前"测 `hadTrailingNl`，而那时末尾是**指纹行**，
  //     永远有 \n ⇒ 一律补回一个 \n ⇒ 本来没尾换行的文件多出一个。
  //   ⇒ **回退到原样，这个问题记进 D364，不在这一轮顺手改** —— 它属于「写入侧收尾策略」，
  //     与「要不要支持非 md 格式」是两件事，混在一起改就是假修（D362 教训）。
  s = s.replace(/^\n+/, "").replace(/\s+$/, "");

  if (strip) {
    if (opts.forSeal === true) return { text: s, removed, added: false };
    // frontmatter 里可能还有**别人的**键（用户的 YAML）⇒ 只摘我们那一行，其余原样留回
    const keep = fmInner.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("dsh-fp-front:"));
    const head = keep.length > 0 ? `---\n${keep.join("\n")}\n---\n` : "";
    const out = `${head}${s}`;
    return { text: hasBom ? `\uFEFF${out}` : out, removed, added: false };
  }

  // ── ② 算 check / seal ──
  const v = Number.isFinite(id?.v) ? id.v : FP_VERSION;
  const kind = String(id?.kind ?? "");
  const project = String(id?.project ?? "");
  const key = String(id?.key ?? "-") || "-";
  if (!KIND_RE.test(kind)) throw new Error(`指纹 kind 非法: ${kind}`);
  if (!PROJ_RE.test(project)) throw new Error(`指纹 project 非法: ${project}`);
  if (!keyIsSafe(key)) throw new Error(`指纹 key 非法（含空白/尖括号/控制字符）: ${key}`);
  const check = identityCheck(v, kind, project, key);
  const seal = sha8Of(s);
  const payload = fpPayload(v, kind, project, key, check, seal);

  // ── ③ 行内信标：嵌在**第一个非围栏的非空行**末尾（若全文均在围栏内则退回首个非空行）──
  const lines = s.split("\n");
  const bodyFencedSet = computeFencedLineSetForFp(lines);
  let placed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "" || bodyFencedSet.has(i)) continue;
    // ★★★★ 2026-10-29（D365 · 补丁回归修复）：信标必须插在**行尾空白之前**。
    //   🔴 019 补丁把无差别的 `l.replace(/\s+$/, "")` 去掉后，这里仍然先清行尾再贴信标
    //     ⇒ **首行的双空格硬换行（`  \n`）被吃掉，而 strip 回不来**。
    //     更糟的是 seal 是在清之前算的 ⇒ 实测 `verifySeal` 直接报
    //     「内容校验位不符（存 0385777c，实 61f8655a）⇒ 正文被改过」
    //     —— **一次正常写入被当成"文件被外部改坏"**，这是最坏的一种假警报。
    //   ★ 修法：`内容 + 一个空格 + 信标 + 原来的行尾空白`。Markdown 的硬换行看的是
    //     **行末**，所以空白留在最后照样生效；而 strip 侧把「空格+信标」整段摘掉，
    //     就能**逐字**还原（不再需要"摘完信标再清一次行尾"那个不可逆动作）。
    //   ★ 判据：**凡是"为了塞进元数据而改动正文"的地方，必须能逐字还原** ——
    //     否则 seal 与 strip 两条路径必然对不上（这一轮就是这么撞出来的）。
    const mTrail = /[ \t]*$/.exec(lines[i]);
    const trail = mTrail === null ? "" : mTrail[0];
    const content = lines[i].slice(0, lines[i].length - trail.length);
    lines[i] = `${content} <!--dsh-id:${project}:${key}-->${trail}`;
    placed = true;
    break;
  }
  if (!placed) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === "") continue;
      const mTrail = /[ \t]*$/.exec(lines[i]);
      const trail = mTrail === null ? "" : mTrail[0];
      const content = lines[i].slice(0, lines[i].length - trail.length);
      lines[i] = `${content} <!--dsh-id:${project}:${key}-->${trail}`;
      placed = true;
      break;
    }
  }
  let body = lines.join("\n");
  if (!placed) body = `<!--dsh-id:${project}:${key}-->`;

  // ── ④ 拼三处（frontmatter 保留用户其它键）──
  const keep = fmInner.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("dsh-fp-front:"));
  const fmLines = [...keep, `dsh-fp-front: ${payload}`];
  const out = `---\n${fmLines.join("\n")}\n---\n${body}\n\n[dsh-fp-link]: dsh-ledger-fp ${payload}\n`;
  return { text: hasBom ? `\uFEFF${out}` : out, removed, added: true };
}

/**
 * ★★★★ 三载体读取：**返回全部来源，冲突必须报**。
 *
 * @returns {{ok:true, id, sources:string[], seal?:string}
 *          |{ok:false, reason:string, all?:Array}}
 */
function computeFencedLineSetForFp(lines) {
  let bodyEnd = lines.length;
  while (bodyEnd > 0) {
    const tail = lines[bodyEnd - 1];
    if (tail.trim() === "" || /^\[dsh-fp-link\]:\s*dsh-ledger-fp\b/.test(tail)) {
      bodyEnd -= 1;
    } else {
      break;
    }
  }
  const fenced = new Set();
  let openFence = null;
  for (let i = 0; i < bodyEnd; i += 1) {
    const l = lines[i];
    if (openFence === null) {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
      if (m !== null && (m[1][0] !== "`" || !m[2].includes("`"))) {
        openFence = { ch: m[1][0], len: m[1].length };
        fenced.add(i);
      }
    } else {
      fenced.add(i);
      const closeRe = new RegExp(`^\\s*${openFence.ch}{${openFence.len},}\\s*$`);
      if (closeRe.test(l)) {
        openFence = null;
      }
    }
  }
  return fenced;
}

function stripFencedCodeForFp(s) {
  const lines = s.split("\n");
  const fencedSet = computeFencedLineSetForFp(lines);
  const inlineOnlyRe = new RegExp(INLINE_RE.source);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (fencedSet.has(i)) {
      const mInl = /^\s*(`{3,}|~{3,})/.test(l) ? inlineOnlyRe.exec(l) : null;
      out.push(mInl !== null ? mInl[0] : "");
      continue;
    }
    const stripped = l.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
    out.push(stripped);
  }
  return out.join("\n");
}

export function readFingerprint3(text, opts = {}) {
  const t = (typeof text === "string" ? text : "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const found = [];
  const corrupt = [];

  // ① frontmatter
  const fmM = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  let afterFm = t;
  if (fmM !== null) {
    const line = fmM[1].split("\n").find((l) => l.trimStart().startsWith("dsh-fp-front:"));
    if (line !== undefined) {
      const p = parsePayload(line.slice(line.indexOf(":") + 1));
      if (p !== null) found.push({ src: "frontmatter", id: p });
      else corrupt.push("frontmatter");
      afterFm = t.slice(fmM[0].length);
    }
  }
  const unfenced = stripFencedCodeForFp(afterFm);
  // ② 链接定义
  const lm = /^\[dsh-fp-link\]:\s*dsh-ledger-fp(?:\s+(.*))?$/m.exec(unfenced);
  if (lm !== null) {
    const p = parsePayload(lm[1]);
    if (p !== null) found.push({ src: "link", id: p });
    else corrupt.push("link");
  }
  // ③ 行内（只有 project + key）
  const im = INLINE_RE.exec(unfenced);
  if (im !== null) found.push({ src: "inline", id: { project: im[1], key: im[2] } });
  else if (unfenced.split("\n", 8).some((l) => l.includes(INLINE_MARK) && l.includes("-->"))) corrupt.push("inline");
  // ④ 旧版单载体注释（平滑兼容）
  const om = FP_RE.exec(unfenced);
  if (om !== null) {
    found.push({ src: "legacy", id: { v: Number(om[1]), kind: om[2], project: om[3], key: om[4], check: om[5], seal: om[6] } });
  } else {
    const oml = FP_RE_LEGACY.exec(unfenced);
    if (oml !== null) {
      found.push({ src: "legacy", id: { v: Number(oml[1]), kind: oml[2], project: oml[3], key: oml[4], check: undefined, seal: oml[5] } });
    } else if (/<!--\s*dsh-ledger-fp:[\s\S]*?-->/.test(unfenced)) {
      corrupt.push("legacy");
    }
  }

  if (corrupt.length > 0) {
    return {
      ok: false,
      reason: `载体格式损坏或身份自证位不符（${corrupt.join(" / ")}）⇒ 指纹被外部改坏，拒绝据此认身份`,
      corrupt,
      all: found,
    };
  }

  if (found.length === 0) return { ok: false, reason: "三处载体都没有" };

  // ── 冲突判定：凡带 kind 的（完整身份）之间必须完全一致 ──
  const full = found.filter((x) => x.id.kind !== undefined);
  if (full.length >= 2) {
    const ref = full[0].id;
    for (const x of full.slice(1)) {
      if (x.id.kind !== ref.kind || x.id.project !== ref.project || x.id.key !== ref.key) {
        return {
          ok: false,
          reason: `多载体身份不一致（${full.map((y) => `${y.src}:${y.id.kind}/${y.id.key}`).join(" vs ")}）`,
          all: found,
        };
      }
    }
  }
  // 行内必须与完整身份一致
  const inl = found.find((x) => x.src === "inline");
  const ref = full[0]?.id;
  if (inl !== undefined && ref !== undefined && (inl.id.project !== ref.project || inl.id.key !== ref.key)) {
    return {
      ok: false,
      reason: `行内信标与其它载体不一致（inline:${inl.id.key} vs ${ref.kind}/${ref.key}）`,
      all: found,
    };
  }

  // ★★★★★ 2026-10-28（D356）**补上一个安全漏洞**：
  //   🔴 病：这里原来**只比"三处是否一致"，从不验证 `check` 位**。
  //     实测后果（`_probe-d356-diag2.mjs`）：把三处 project 一起改成 `0000…`（check 位不动），
  //     `readFingerprint3` 照样返回 `ok:true` ⇒ **假身份被当成真的**。
  //     ⇒ 那 `check` 位等于白写了，而它是"防指纹被改坏"的唯一判据。
  //   ★ 修法：**每一个带 check 的来源都要各自验一遍**（不能只验第一个）。
  //   ★★ 为什么三处一起改也算"被改坏"：用户的手滑/工具的事故**不会去重算 check**；
  //     能重算的只有我们自己的写入路径。所以 check 不符 = 这个文件被**外部**动过。
  if (opts?.verifyCheck !== false) for (const x of found) {
    if (typeof x.id.check !== "string") continue; // 旧格式 / 行内（无 check）
    const want = identityCheck(x.id.v, x.id.kind, x.id.project, x.id.key);
    if (want !== x.id.check) {
      return {
        ok: false,
        reason:
          `身份自证位不符（${x.src} 存 ${x.id.check}，实算 ${want}）` +
          `⇒ 指纹被外部改过，拒绝据此认身份`,
        all: found,
      };
    }
  }

  return {
    ok: true,
    id: ref ?? inl.id,
    sources: found.map((x) => x.src),
    seal: ref?.seal,
    seals: full.map((x) => ({ src: x.src, seal: x.id.seal })).filter((x) => typeof x.seal === "string"),
  };
}


/**
 * ★★★★ 扫描目录、按指纹建索引。
 * ★ 只在"按名字找不到"时才调用 —— memoryRoot 现在近千文件，
 *   每回合扫是拿 O(文件数) 换一个通常不需要的答案。
 *
 * @param {string} rootAbs
 * @param {{project?:string, maxFiles?:number, maxDepth?:number, verifyCheck?:boolean}} opts
 */
export function scanFingerprints(rootAbs, opts = {}) {
  if (typeof rootAbs !== "string" || rootAbs.trim() === "") {
    return { byKind: new Map(), byProject: new Map(), bad: [], scanned: 0, unreadable: 0, truncated: false };
  }
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 5000;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 4;
  const verifyCheck = opts.verifyCheck !== false;
  const onlyProject = typeof opts.project === "string" && opts.project !== "" ? opts.project : undefined;

  const byKind = new Map();
  const byProject = new Map();
  const bad = []; // 指纹被改坏的（报了但不采用）
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;

  const walk = (dirAbs, depth) => {
    if (truncated) return;
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      unreadable += 1;
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const abs = path.join(dirAbs, e.name);
      // ★ 用 Dirent 判类型，不用 statSync（后者跟随联接，会把联接当目录）
      if (e.isDirectory()) {
        if (e.name === "_backup") continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".md")) continue;
      if (scanned >= maxFiles) {
        truncated = true;
        return;
      }
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        unreadable += 1;
        continue;
      }
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      const p3 = readFingerprint3(text);
      if (p3.ok === true) {
        if (onlyProject !== undefined && p3.id.project !== onlyProject) continue;
        byProject.set(p3.id.project, (byProject.get(p3.id.project) ?? 0) + 1);
        const kindKey = p3.id.kind ?? "*";
        const isLeg = Array.isArray(p3.sources) && p3.sources.length === 1 && p3.sources[0] === "legacy";
        const item3 = { rel, abs, key: p3.id.key, seal: p3.seal, legacy: isLeg };
        if (!byKind.has(kindKey)) byKind.set(kindKey, []);
        byKind.get(kindKey).push(item3);
        continue;
      }
      if (
        String(p3.reason).includes("不一致") ||
        String(p3.reason).includes("损坏") ||
        (verifyCheck && String(p3.reason).includes("自证位"))
      ) {
        bad.push({ rel, reason: p3.reason });
        continue;
      }
      const p = parseFingerprint(text);
      if (p.ok !== true) continue;
      if (verifyCheck && p.checkOk !== true) {
        bad.push({ rel, reason: p.warning });
        continue;
      }
      if (onlyProject !== undefined && p.fp.project !== onlyProject) continue;
      byProject.set(p.fp.project, (byProject.get(p.fp.project) ?? 0) + 1);
      const item = { rel, abs, key: p.fp.key, seal: p.fp.seal, legacy: p.fp.legacy };
      if (!byKind.has(p.fp.kind)) byKind.set(p.fp.kind, []);
      byKind.get(p.fp.kind).push(item);
    }
  };

  walk(rootAbs, 0);
  return { byKind, byProject, bad, scanned, unreadable, truncated };
}

/**
 * ★★★★ **三步解析**（这是本机制的全部价值，D351 §五）。
 *   ① 按清单里的名字找 → 找到了，校验指纹（kind / project / check）
 *   ② 名字找不到 → 扫指纹，按 kind 找 → 找到就用，并**明确报"已改名"**
 *   ③ 都找不到 → 才报缺失（这时报错是**对的**）
 * ★ 不做 ②，指纹就只是给文件加了行无用注释。
 */
export function resolveByIdentity(rootAbs, want) {
  const name = typeof want?.name === "string" ? want.name : "";
  const kind = typeof want?.kind === "string" ? want.kind : "";
  const project = typeof want?.project === "string" ? want.project : "";
  const wantKey = typeof want?.key === "string" ? want.key : "";
  const keyMatches = (got, expected) =>
    expected === "" || got === expected || decodeKey(got) === expected || got === encodeKey(expected);

  // ── ① 按名字 ──
  if (name !== "") {
    if (isAbsoluteAnywhere(name)) {
      return { ok: false, reason: `名字必须是相对路径：${name}`, unsafePath: true };
    }
    const abs = path.resolve(rootAbs, name);
    if (!isUnderReal(rootAbs, abs).ok) {
      return { ok: false, reason: `名字逃出项目根：${name}`, unsafePath: true };
    }
    if (fs.existsSync(abs)) {
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        return { ok: false, reason: `文件存在但读不出：${name}` };
      }
      // ★★★ 2026-10-28（D356）：**先认三载体，再退回旧格式**。
      //   🔴 病：这里原来只调 `parseFingerprint`（旧版单载体注释），
      //     而写路径已经在写三载体 ⇒ **刚写的文件在这里读不到指纹** ⇒ 全部按"老文件"放行。
      //   ★ 判据：**同一件事只能有一个读取出口**；两套解析器并存必然分叉。
      const p3 = readFingerprint3(text);
      if (p3.ok === true) {
        if (p3.id.kind !== undefined && p3.id.kind !== kind) {
          return {
            ok: false,
            reason:
              `名字命中了 \`${name}\`，但指纹说自己是 kind=${p3.id.kind}，而我们要 kind=${kind} ` +
              `⇒ **拒绝按名字认它**`,
          };
        }
        if (project !== "" && p3.id.project !== project) {
          return {
            ok: false,
            reason:
              `\`${name}\` 的 project=${p3.id.project}，与清单的 ${project} 不符 ` +
              `⇒ 这不是本项目的文件（可能被别的项目的同名文件覆盖了）`,
          };
        }
        if (
          !keyMatches(p3.id.key, wantKey) ||
          (p3.id.kind === undefined && wantKey === "" && p3.id.key !== undefined && p3.id.key !== "" && p3.id.key !== "-")
        ) {
          return {
            ok: false,
            reason:
              `名字命中了 \`${name}\`，但指纹说自己是 key=${p3.id.key}，而我们要 key=${wantKey || "-"} ` +
              `⇒ **拒绝按名字认它**（可能被同项目的其它卡片覆盖了）`,
          };
        }
        return { ok: true, abs, how: "name", rel: name };
      }
      if (
        p3.ok !== true &&
        (String(p3.reason).includes("不一致") || String(p3.reason).includes("损坏") || String(p3.reason).includes("自证位"))
      ) {
        // 三处载体互相打架或身份自证位不符 ⇒ 这是事故，必须报，不能当"没指纹"按老文件放行
        return { ok: false, reason: `\`${name}\` ${p3.reason}` };
      }
      const p = parseFingerprint(text);
      // 两套都没有 ⇒ 老文件，按名字认（向后兼容）
      if (p.ok !== true) return { ok: true, abs, how: "name", rel: name, note: "无指纹（老文件，按名字认）" };
      if (p.checkOk !== true) {
        return { ok: false, reason: `\`${name}\` 的指纹自证位不符 ⇒ 指纹被改坏过，拒绝据此认它` };
      }
      if (p.fp.kind !== kind) {
        return {
          ok: false,
          reason:
            `名字命中了 \`${name}\`，但指纹说自己是 kind=${p.fp.kind}，而我们要 kind=${kind} ` +
            `⇒ **拒绝按名字认它**`,
        };
      }
      if (project !== "" && p.fp.project !== project) {
        return {
          ok: false,
          reason:
            `\`${name}\` 的 project=${p.fp.project}，与清单的 ${project} 不符 ` +
            `⇒ 这不是本项目的文件（可能被别的项目的同名文件覆盖了）`,
        };
      }
      if (!keyMatches(p.fp.key, wantKey)) {
        return {
          ok: false,
          reason:
            `名字命中了 \`${name}\`，但指纹说自己是 key=${p.fp.key}，而我们要 key=${wantKey} ` +
            `⇒ **拒绝按名字认它**（可能被同项目的其它卡片覆盖了）`,
        };
      }
      return { ok: true, abs, how: "name", rel: name };
    }
  }

  // ── ② 盲扫兜底（★ 用 `scanBlind` 而不是旧的 `scanFingerprints`：后者只认 .md 且限深度）──
  if (want?.scan === false) return { ok: false, reason: `\`${name}\` 不存在（已禁止扫描）` };
  const scan = scanBlind(rootAbs, { project });
  const hits = scan.byKind.get(kind) ?? [];
  if (hits.length === 1 && keyMatches(hits[0].key, wantKey)) {
    return {
      ok: true,
      abs: hits[0].abs,
      how: "fp",
      rel: hits[0].rel,
      note: `清单写的是 \`${name}\`，按名字找不到；**按指纹找到它在 \`${hits[0].rel}\`**（文件被改过名）`,
    };
  }
  if (hits.length >= 1) {
    if (wantKey !== "") {
      const exact = hits.filter((h) => keyMatches(h.key, wantKey));
      if (exact.length === 1) {
        return {
          ok: true,
          abs: exact[0].abs,
          how: "fp",
          rel: exact[0].rel,
          note: `按指纹 kind=${kind}+key=${wantKey} 找到 \`${exact[0].rel}\`（文件被改过名）`,
        };
      }
      if (exact.length > 1) {
        return {
          ok: false,
          reason:
            `按指纹找到 **${exact.length} 个** kind=${kind}+key=${wantKey} 的文件 ⇒ 身份不唯一，不敢替你选：` +
            exact.map((h) => `\`${h.rel}\``).join("、"),
          candidates: exact.map((h) => h.rel),
        };
      }
    } else {
      return {
        ok: false,
        reason:
          `按指纹找到 **${hits.length} 个** kind=${kind} 的文件 ⇒ 身份不唯一，不敢替你选：` +
          hits.map((h) => `\`${h.rel}\``).join("、"),
        candidates: hits.map((h) => h.rel),
      };
    }
  }
  // ── ②b 若仅行内信标存活（kind 未知，归在 "*" 桶），且调用方指定了明确 wantKey ──
  if (wantKey !== "") {
    const inlineHits = (scan.byKind.get("*") ?? []).filter((h) => keyMatches(h.key, wantKey));
    if (inlineHits.length === 1) {
      return {
        ok: true,
        abs: inlineHits[0].abs,
        how: "fp",
        rel: inlineHits[0].rel,
        note: `按行内信标 key=${wantKey} 找到 \`${inlineHits[0].rel}\`（文件被改过名且仅剩行内信标）`,
      };
    }
    if (inlineHits.length > 1) {
      return {
        ok: false,
        reason:
          `按行内信标找到 **${inlineHits.length} 个** key=${wantKey} 的文件 ⇒ 身份不唯一，不敢替你选：` +
          inlineHits.map((h) => `\`${h.rel}\``).join("、"),
        candidates: inlineHits.map((h) => h.rel),
      };
    }
  }

  // ── ③ 都找不到 ──
  const others = [...scan.byKind.keys()].filter((k) => k !== kind);
  return {
    ok: false,
    reason:
      `\`${name}\` 按名字找不到，按指纹也没有 kind=${kind} 的文件` +
      (scan.scanned === 0
        ? "；而且**一个带指纹的文件都没扫到**（可能是老项目，还没铺指纹）"
        : `（扫了 ${scan.scanned} 个文件${scan.truncated ? "，已达上限" : ""}` +
          (scan.bad.length > 0 ? `，另有 ${scan.bad.length} 个指纹被改坏` : "") + "）") +
      (others.length > 0 ? `。扫到的其它 kind：${others.join(", ")}` : ""),
  };
}

/**
 * ★★★★★ **整个项目的路径全变了怎么办**（用户 D352 的追问）。
 *
 * 判据：**项目 id 是唯一不随路径变化的东西** ⇒ 拿它去一个更大的范围里找。
 * 但"更大范围"不能是整块硬盘（太慢，且可能扫到别的项目同名文件）。
 *
 * 做法：从起点向上找，逐层扫**有限的**深度，找哪些目录里存在该 projectId 的指纹文件。
 * ⇒ 返回「候选根」，由调用方决定用哪个（**不替它选**）。
 *
 * @param {string} startAbs 起点（通常是当前 projectRoot 或它的父目录）
 * @param {string} projectId
 * @param {{upLevels?:number, maxFiles?:number, maxDepth?:number}} opts
 * @returns {{roots:Array<{abs:string, hits:number}>, scanned:number, truncated:boolean}}
 */
export function locateProjectRoots(startAbs, projectId, opts = {}) {
  if (typeof startAbs !== "string" || startAbs.trim() === "") return { roots: [], scanned: 0, truncated: false };
  const upLevels = Number.isFinite(opts.upLevels) ? opts.upLevels : 2;
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 20000;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 3;
  if (!PROJ_RE.test(String(projectId ?? ""))) return { roots: [], scanned: 0, truncated: false };

  // 收集"向上 N 层的祖先"作为搜索起点
  const starts = [];
  let cur = path.resolve(startAbs);
  for (let i = 0; i <= upLevels; i += 1) {
    starts.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 按目录聚合命中数
  const perDir = new Map();
  const visited = new Set();
  let scanned = 0;
  let truncated = false;

  const walk = (dirAbs, depth) => {
    if (visited.has(dirAbs)) return;
    visited.add(dirAbs);
    if (truncated) return;
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        // 跳过明显的噪音目录与热备份目录（_backup 含上一版指纹副本，绝不作为活体项目根信号）
        if (["node_modules", ".git", ".dsh", "dist", "build", "_backup"].includes(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      if (scanned >= maxFiles) { truncated = true; return; }
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const p3 = readFingerprint3(text);
      if (p3.ok === true) {
        if (p3.id.project === projectId) perDir.set(dirAbs, (perDir.get(dirAbs) ?? 0) + 1);
        continue;
      }
      if (String(p3.reason).includes("不一致") || String(p3.reason).includes("自证位")) continue;
      const p = parseFingerprint(text, 3);
      if (p.ok !== true || p.checkOk !== true) continue;
      if (p.fp.project !== projectId) continue;
      perDir.set(dirAbs, (perDir.get(dirAbs) ?? 0) + 1);
    }
  };

  for (const s of starts) walk(s, 0);

  const roots = [...perDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([abs, hits]) => ({ abs, hits }));
  return { roots, scanned, truncated };
}

/**
 * ★★★★★ **盲扫**：不认扩展名、不认目录结构，只认文件头里的指纹。
 *
 * ★★★ 为什么必须"盲"（用户 D352 原话）：
 *   *"如果我将项目内的所有文件随机打乱，那么工具仍然能够准确找到自己需要的文件"*
 *   ⇒ "随机打乱"完全可能把 `D195.md` 变成 `x7f2a.txt`、也可能塞进任意深度的子目录。
 *   所以下面这两条**都不能再用**：
 *     · `name.endsWith(".md")` —— 扩展名会被改掉
 *     · `depth > maxDepth` —— 位置会被打乱
 *   ⇒ 唯一还成立的判据是：**文件内容里那行指纹**。其余一概不认。
 *
 * ★ 性能怎么扛住：只读**文件头**（默认 4 KiB），不读整份；二进制/超大文件直接跳。
 *   指纹永远在第 0 行（BOM 之后），4 KiB 绰绰有余。
 *
 * @param {string} rootAbs 搜索根（通常 = 会话 cwd / 项目根）
 * @param {{project?:string, maxFiles?:number, maxDepth?:number,
 *          skipDirs?:string[], skipOverBytes?:number, verifyCheck?:boolean}} opts
 */
export function scanBlind(rootAbs, opts = {}) {
  if (typeof rootAbs !== "string" || rootAbs.trim() === "") {
    return {
      byKind: new Map(),
      byProject: new Map(),
      bad: [],
      scanned: 0,
      skippedBinary: 0,
      skippedBig: 0,
      unreadable: 0,
      truncated: false,
    };
  }
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 60000;
  // ★ 盲扫默认**不限深度**（"随机打乱"可能塞很深），但仍留一个防御性的极大上限，
  //   防止符号链接环或异常目录树把扫描拖死。
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 24;
  const verifyCheck = opts.verifyCheck !== false;
  const skipOverBytes = Number.isFinite(opts.skipOverBytes) ? opts.skipOverBytes : 8 * 1024 * 1024;
  const skipDirs = new Set(
    Array.isArray(opts.skipDirs) && opts.skipDirs.length > 0
      ? opts.skipDirs
      : ["node_modules", ".git", ".dsh", "dist", "build", ".cache", "__pycache__", ".venv", "_backup"],
  );
  const onlyProject = typeof opts.project === "string" && opts.project !== "" ? opts.project : undefined;

  const byKind = new Map();
  const byProject = new Map();
  const bad = [];
  let scanned = 0;
  let skippedBinary = 0;
  let skippedBig = 0;
  let unreadable = 0;
  let truncated = false;

  const walk = (dirAbs, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      unreadable += 1;
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const abs = path.join(dirAbs, e.name);
      // ★ 用 Dirent，不用 statSync（后者跟随联接，会把联接当目录）
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // ★ 联接/设备一律不碰
      if (scanned >= maxFiles) { truncated = true; return; }
      scanned += 1;

      // ① 太大的直接跳（不可能是我们要的小文本文件）
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        unreadable += 1;
        continue;
      }
      if (st.size > skipOverBytes) { skippedBig += 1; continue; }

      // ② 只读文件头（≤5 KiB 直接一次读完，避免 [dsh-fp-link] 跨 4096 字节边界被切碎）
      const headQuota = st.size > 4096 && st.size <= 5120 ? st.size : 4096;
      let head;
      try {
        head = readHead(abs, headQuota);
      } catch {
        unreadable += 1;
        continue;
      }
      // ③ 二进制直接跳（含 NUL 字节）
      if (head.includes(0)) { skippedBinary += 1; continue; }

      let text = head.toString("utf8");
      if (st.size > headQuota) {
        try {
          const tail = readTail(abs, st.size, 1024);
          if (!tail.includes(0)) {
            let tailStr = tail.toString("utf8");
            const nl = tailStr.indexOf("\n");
            if (nl >= 0) tailStr = tailStr.slice(nl + 1);
            text = `${text}\n${tailStr}`;
          }
        } catch {
          /* 尾块读取失败不阻断头块识别 */
        }
      }
      // ★★★ 2026-10-28（D356）：**先认三载体，认不到再退回旧格式**。
      //   🔴 病（实测抓到的第二个"两套解析器并存"事故）：这里原来只调 `parseFingerprint`，
      //     而写路径已经在写三载体 ⇒ **盲扫一个都认不出来**（scanned=1 但 byKind 空）。
      //     `resolveByIdentity` 的整个兜底路径因此**完全失效**，而单元测试全绿。
      //   ★ 判据（同 D356 上一处）：**同一件事只能有一个读取出口。**
      //     这条已经犯过两次，以后新增任何"读指纹"的地方都必须先走 `readFingerprint3`。
      const p3 = readFingerprint3(text, { verifyCheck });
      const rel0 = path.relative(rootAbs, abs).split(path.sep).join("/");
      if (p3.ok === true) {
        if (onlyProject !== undefined && p3.id.project !== onlyProject) continue;
        byProject.set(p3.id.project, (byProject.get(p3.id.project) ?? 0) + 1);
        const kindKey = p3.id.kind ?? "*";
        const isLeg = Array.isArray(p3.sources) && p3.sources.length === 1 && p3.sources[0] === "legacy";
        const item = { rel: rel0, abs, key: p3.id.key, seal: p3.seal, legacy: isLeg };
        if (!byKind.has(kindKey)) byKind.set(kindKey, []);
        byKind.get(kindKey).push(item);
        continue;
      }
      if (
        String(p3.reason).includes("不一致") ||
        String(p3.reason).includes("损坏") ||
        (verifyCheck && String(p3.reason).includes("自证位"))
      ) {
        // 三处载体互相打架、格式损坏或自证位被篡改 ⇒ 这是事故，必须记进 bad，不能当"没有指纹"
        bad.push({ rel: rel0, reason: p3.reason });
        continue;
      }
      // ── 退回旧格式（单载体注释）──
      const p = parseFingerprint(text, 8);
      if (p.ok !== true) continue;
      if (verifyCheck && p.checkOk !== true) {
        bad.push({ rel: rel0, reason: p.warning });
        continue;
      }
      if (onlyProject !== undefined && p.fp.project !== onlyProject) continue;
      byProject.set(p.fp.project, (byProject.get(p.fp.project) ?? 0) + 1);
      const itemOld = { rel: rel0, abs, key: p.fp.key, seal: p.fp.seal, legacy: true };
      if (!byKind.has(p.fp.kind)) byKind.set(p.fp.kind, []);
      byKind.get(p.fp.kind).push(itemOld);
    }
  };

  walk(rootAbs, 0);
  return { byKind, byProject, bad, scanned, skippedBinary, skippedBig, unreadable, truncated };
}

/** 只读文件头 N 字节（不读整份 —— 盲扫的性能全押在这上面） */
export function readHead(abs, bytes = 4096) {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** 只读文件尾 N 字节（配合 readHead 让 >4 KiB 文件的文末 [dsh-fp-link] 载体也能参与盲扫校验） */
function readTail(abs, totalSize, bytes = 1024) {
  const fd = fs.openSync(abs, "r");
  try {
    const len = Math.min(bytes, Math.max(0, totalSize));
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, totalSize - len);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * ★★★★★ **在完全不知道路径的情况下，发现项目并自举**（用户要的"最好的结果"）。
 *
 * 情形：**所有文件都被随机打乱** —— 名字变了（连 `.md` 都没了）、位置变了、
 *       `memoryRoot` 甚至 `.dsh-ledger.json` 本身也被改名。
 * 这时**没有文件名可用**，唯一还成立的只有：**文件内容里的指纹**。
 *
 * 步骤（全机械）：
 *   ① 从 `startAbs` 出发盲扫，收集所有出现过的 projectId 及其 kind 分布
 *   ② 若只有一个 projectId ⇒ 就是它
 *   ③ 若有多个 ⇒ **不替用户选**，列出候选让人定（这是纪律，不是偷懒）
 *
 * @returns {{ok:true, project:string, kinds:Record<string,string[]>, files:number}
 *          |{ok:false, reason:string, candidates?:Array<{project:string,files:number}>}}
 */
export function discoverProject(startAbs, opts = {}) {
  const scan = scanBlind(startAbs, opts);
  const ids = [...scan.byProject.keys()];

  if (ids.length === 0) {
    return {
      ok: false,
      reason:
        `在 \`${startAbs}\` 下盲扫了 ${scan.scanned} 个文件，` +
        `**没有找到任何带指纹的文件**（跳过二进制 ${scan.skippedBinary} · 超大 ${scan.skippedBig}` +
        `${scan.truncated ? " · 已达扫描上限" : ""}）` +
        ` ⇒ 要么还没铺指纹，要么指纹被清掉了`,
    };
  }

  if (ids.length > 1) {
    return {
      ok: false,
      reason: `盲扫发现 **${ids.length} 个不同项目**的指纹混在 \`${startAbs}\` 下 ⇒ 不敢替你选`,
      candidates: ids.map((id) => ({ project: id, files: scan.byProject.get(id) })),
    };
  }

  const project = ids[0];
  const kinds = {};
  for (const [k, arr] of scan.byKind.entries()) kinds[k] = arr.map((x) => x.rel);
  return { ok: true, project, kinds, files: scan.byProject.get(project) };
}

/**
 * ★★★★★ **随机打乱后的完整重建**：在没有清单、没有文件名的情况下，把
 * 「每个 kind 对应哪个文件」重新算出来。
 *
 * ★★ 这是对用户那句话的直接实现：*"工具仍然能够准确找到自己需要的文件"*。
 *   ⇒ 它**不读清单**，只靠指纹；所以清单被打乱/丢失也不影响。
 *
 * @returns {{ok:true, project:string, byKind:Map<string,Array<{rel,abs,key}>>,
 *            warnings:string[]}
 *          |{ok:false, reason:string, candidates?:any}}
 */
export function rebuildFromFingerprints(startAbs, opts = {}) {
  const scan = scanBlind(startAbs, opts);
  const ids = [...scan.byProject.keys()];

  if (ids.length === 0) {
    // ★ 有文件被扫到、但全部因自证位不符被拒 ⇒ 不能说"未找到"（那会让人以为根本没有指纹）
    if (scan.bad.length > 0) {
      return {
        ok: false,
        reason:
          `盲扫 \`${startAbs}\` 扫了 ${scan.scanned} 个文件，` +
          `其中 ${scan.bad.length} 个的指纹自证位不符（被外部改过），已排除；` +
          `没有剩下可用的指纹文件`,
        bad: scan.bad,
      };
    }
    return { ok: false, reason: `盲扫 \`${startAbs}\` 未找到任何指纹文件（扫了 ${scan.scanned} 个）` };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: `发现 ${ids.length} 个项目混在一起 ⇒ 不替用户选`,
      candidates: ids.map((id) => ({ project: id, files: scan.byProject.get(id) })),
    };
  }

  const warnings = [];
  // ★ 单例 kind（active/journal/principles/security）必须唯一，否则报歧义
  const SINGLETON = new Set(["active", "journal", "principles", "security"]);
  for (const k of SINGLETON) {
    const arr = scan.byKind.get(k) ?? [];
    if (arr.length > 1) {
      warnings.push(
        `kind=${k} 有 ${arr.length} 个文件（应为 1）⇒ 身份歧义：` +
          arr.map((x) => `\`${x.rel}\``).join("、"),
      );
    }
  }
  if (scan.bad.length > 0) {
    warnings.push(`${scan.bad.length} 个文件的指纹自证位不符（被改坏），已排除`);
  }
  if (scan.truncated) warnings.push("扫描达到文件数上限，可能还有未发现的文件");

  return { ok: true, project: ids[0], byKind: scan.byKind, warnings };
}

/**
 * ★★★★ **路径 → 身份**（机械映射，让写路径不必逐处传参）。
 *
 * ★ 为什么需要它：`writeFileAtomic` 是全部写入的**唯一出口**（28 处调用），
 *   但它只拿到一个绝对路径，**不知道自己在写哪个记忆面**。
 *   若要求 28 个调用点各自传 kind/key，一定会漏、而且以后新加的写入点还会漏。
 *   ⇒ **从路径机械反推**才是不会漏的做法。
 *
 * ★ 判据全部来自清单（`info`）而不是硬编码 —— 但**键名是约定**（D351 实测那 85 处字面量仍在）。
 *   这里只做"从已知清单配置推身份"，不试图猜。
 *
 * @param {{memoryBase:string, active:string, journal?:string, principles?:string,
 *          decisionsDir?:string, lessonsDir?:string, goalsDir?:string}} info
 * @param {string} absPath
 * @returns {{kind:string, key:string}|undefined} undefined ⇒ 这个路径不属于记忆面，不加指纹
 */
export function identityOfPath(info, absPath) {
  if (info === undefined || typeof info?.memoryBase !== "string" || absPath === undefined) return undefined;
  const base = path.resolve(info.memoryBase);
  const abs = path.resolve(absPath);
  const rel = path.relative(base, abs);
  // 不在 memoryRoot 之下 ⇒ 不是记忆文件（例如 .gitignore / 包内源码）
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;

  const posix = rel.split(path.sep).join("/");
  const parts = posix.split("/");
  const baseName = parts[parts.length - 1];
  if (parts[0] === "_backup") return undefined;

  // ── ① 单例文件（兼容原始清单字段 active/journal/principles 与 inspect(root) 的 *Rel 字段）──
  const singletons = [
    [info.active ?? info.activeRel, "active"],
    [info.journal ?? info.journalRel, "journal"],
    [info.principles ?? info.principlesRel, "principles"],
    [info.decisions ?? (info.decisionsDir ? undefined : info.decisionsRel), "decisions"],
    [info.lessons ?? (info.lessonsDir ? undefined : info.lessonsRel), "lessons"],
    [info.goals ?? (info.goalsDir ? undefined : info.goalsRel), "goals"],
    ["SECURITY.md", "security"],
  ];
  for (const [name, kind] of singletons) {
    if (typeof name === "string" && name !== "") {
      const normName = name.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      if (posix === normName) return { kind, key: "-" };
    }
  }
  if (baseName.startsWith(".") || /^(INDEX|README|SECURITY)\.(md|markdown|txt)$/i.test(baseName)) return undefined;

  // ── ② 卡片目录（一卡一文件，key = 去掉 .md 的文件名；排除 INDEX.md / README.md 缓存与说明）──
  const cardDirs = [
    [info.decisionsDir, "decisions"],
    [info.lessonsDir, "lessons"],
    [info.goalsDir, "goals"],
  ];
  for (const [dirRel, kind] of cardDirs) {
    if (typeof dirRel !== "string" || dirRel === "") continue;
    const d = dirRel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/^(?:\.\/)+/, "");
    if (
      d !== "" &&
      posix === `${d}/${baseName}` &&
      /\.md$/i.test(baseName) &&
      !/^(INDEX|README|SECURITY)\.md$/i.test(baseName)
    ) {
      return { kind, key: encodeKey(baseName.slice(0, -3)) };
    }
  }

  // ── ③ 其余记忆面：优先识别清单自定义目录（含嵌套子路径如 docs/交接单），再兜底默认目录名，key = 相对路径 ──
  const customDirs = [
    [info.archiveDir ?? info.archiveRel, "archive"],
    [info.logDir ?? info.logRel, "log"],
    [info.handoffDir ?? info.handoffRel, "handoff"],
  ];
  for (const [dirRel, kind] of customDirs) {
    if (typeof dirRel !== "string" || dirRel === "") continue;
    const d = dirRel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/^(?:\.\/)+/, "");
    if (d !== "" && (posix === d || posix.startsWith(`${d}/`))) {
      return { kind, key: encodeKey(posix) };
    }
  }
  const dirKinds = {
    "_stash": "stash",
    "_handoff": "handoff",
    "_ledger-archive": "archive",
    "_ledger-log": "log",
    "extensions": "extension",
  };
  for (const [d, kind] of Object.entries(dirKinds)) {
    if (parts[0] === d) {
      if (d === "extensions" && (posix === "extensions/registry.json" || /^(INDEX|README)\.(md|markdown|txt)$/i.test(baseName))) {
        return undefined;
      }
      return { kind, key: encodeKey(posix) };
    }
  }

  // ── ④ ★★★★ 2026-10-29（D364 · 用户拍板）：**记忆根里的一切都算我们的。**
  //   用户原话（逐字）：*"只要出现在项目台账文件夹里面的，就算我们插件的。其他的不动就可以了。"*
  //   ⇒ 不再要求"必须落在已知的记忆面里"；**只要在 memoryRoot 之下**就给身份。
  //
  //   ★★ 为什么这样是安全的（三条，都实测过）：
  //     ① 开头那个 `rel.startsWith("..")` 已经把 memoryRoot 之外的全挡掉了 ——
  //        用户的边界"其他的不动"**由那一个判断保证**，不靠这条新分支；
  //     ② `kind:"custom"` 是**新的一类**，不冒充 decisions/lessons/goals ⇒ 不会把用户的
  //        随手记误当成决策卡读进注入；
  //     ③ key 用**相对路径**（与 archive/log/handoff 同一套 `encodeKey`），
  //        改名后能靠指纹内容找回 —— 这正是用户要的效果。
  //
  //   ★★★ **但缓存/说明文件必须先排除**（这条是自检 130⑳ 当场抓到的）：
  //     `INDEX.md` / `README.md` 是**生成的缓存与说明**，不是记忆内容；
  //     原来靠"不在任何已知面里 ⇒ undefined"顺带挡住了，现在兜底放宽，
  //     它们就会变成 `{kind:"custom"}` ⇒ ① 被当成卡片读进注入 ② 每次重算都改它。
  //     ⇒ 判据：**兜底范围放宽时，原先"靠不匹配而排除"的东西必须显式排除一次。**
  // ★★★★ 2026-10-30（D366）：**备份目录不参与指纹。**
  //   备份必须**逐字节不变** —— 它不是记忆内容，是"上一版原样的副本"；
  //   给它打指纹等于把备份自己也改一遍 ⇒ **那就不叫备份了**，恢复回去还会带回
  //   一份"当时并未落盘的内容"（带了后来加的信标）。
  //   ★ 与 `INDEX|README` 同一条判据：**住在记忆目录里、但不属于记忆内容的东西，必须显式排除**。
  //   ★ 这里**用字面量、不 import `backup.js`**：本文件被 `backup.js` 的上层调用，
  //     反向 import 会把叶子模块拖进 `lib/` 的环（本项目栽过）。改名要同步 `lib/backup.js` 的 `BACKUP_DIR`。
  if (parts[0] === "_backup") return undefined;
  if (baseName.startsWith(".") || /^(INDEX|README|SECURITY)\.(md|markdown|txt)$/i.test(baseName)) return undefined;
  if (
    typeof info.projectRoot === "string" &&
    info.projectRoot !== "" &&
    (typeof info.memoryRoot !== "string" || info.memoryRoot.trim() === "") &&
    path.resolve(base) === path.resolve(info.projectRoot)
  ) {
    return undefined;
  }

  return { kind: "custom", key: encodeKey(posix) };
}

/**
 * 确保清单里有 `projectId`；没有就生成一个并返回。
 * ★ 纯函数（不改清单）：返回 `{projectId, isNew}`，由调用方决定何时落盘。
 */
export function ensureProjectId(manifest) {
  const cur = manifest?.projectId;
  if (typeof cur === "string" && PROJ_RE.test(cur)) return { projectId: cur, isNew: false };
  return { projectId: newProjectId(), isNew: true };
}

/**
 * ★★★★ 从清单读 `projectId`（**带缓存**，写路径每次都调，不能每次读盘）。
 *
 * ★ 为什么需要缓存：`writeFileAtomic` 的调用频率是"每次写文件"，
 *   而读清单要解析 JSON —— 不缓存会让每次写入多一次同步读盘。
 * ★★ 缓存键用 `root` 的解析后路径；清单 `mtimeMs` 变了才重读 ⇒
 *   用户手动改清单（比如换了 projectId）也能立刻生效，不会吃到旧缓存。
 * ★★★ 读不到清单 / 没有 projectId ⇒ **返回 undefined**，调用方据此**不加指纹**。
 *   绝不"生成一个临时的" —— 那会让同一个项目出现两个 id，比没有指纹糟得多。
 */
const _projectIdCache = new Map(); // root -> {mtimeMs, id}

export function projectOf(root) {
  if (typeof root !== "string" || root === "") return undefined;
  const rootAbs = path.resolve(root);
  const parentAbs = path.dirname(rootAbs);
  const candidates = [
    { mf: path.join(rootAbs, MANIFEST_REL_NAME), checkParentMem: false },
    { mf: path.join(rootAbs, `${path.basename(rootAbs)}-ledger-memory`, MANIFEST_REL_NAME), checkParentMem: false },
    { mf: path.join(rootAbs, "10.项目台账-ledger-memory", MANIFEST_REL_NAME), checkParentMem: false },
    ...(parentAbs !== rootAbs ? [{ mf: path.join(parentAbs, MANIFEST_REL_NAME), checkParentMem: true }] : []),
  ];
  for (const { mf, checkParentMem } of candidates) {
    let st;
    try {
      st = fs.statSync(mf);
    } catch {
      continue;
    }
    const cacheKey = `${rootAbs}::${mf}`;
    const hit = _projectIdCache.get(cacheKey);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs) {
      if (hit.id !== undefined) return hit.id;
      continue;
    }
    let id;
    try {
      const j = JSON.parse(fs.readFileSync(mf, "utf8"));
      if (checkParentMem) {
        const mr = typeof j?.memoryRoot === "string" ? j.memoryRoot.trim() : "";
        if (mr === "" || path.resolve(parentAbs, mr) !== rootAbs) {
          _projectIdCache.set(cacheKey, { mtimeMs: st.mtimeMs, id: undefined });
          continue;
        }
      }
      if (typeof j?.projectId === "string" && PROJ_RE.test(j.projectId)) id = j.projectId;
      if (id === undefined && !checkParentMem && typeof j?.memoryRoot === "string" && j.memoryRoot.trim() !== "") {
        const mirrorMf = path.join(rootAbs, j.memoryRoot.trim(), MANIFEST_REL_NAME);
        if (!candidates.some((c) => c.mf === mirrorMf)) {
          candidates.push({ mf: mirrorMf, checkParentMem: false });
        }
      }
    } catch {
      id = undefined;
    }
    _projectIdCache.set(cacheKey, { mtimeMs: st.mtimeMs, id });
    if (id !== undefined) return id;
  }
  return undefined;
}

/** 清掉 projectId 缓存（清单被改写后调，或测试用） */
export function clearProjectCache() {
  _projectIdCache.clear();
}

/** 清单文件名（与 `defs.js` 的 `MANIFEST_REL` 同值，但本模块是叶子，不 import 它） */
const MANIFEST_REL_NAME = ".dsh-ledger.json";

/**
 * 给一个目录下的所有文件补指纹（**只改写缺指纹的**，已有的只重算 seal）。
 * ★ 幂等：重复跑不会重复加行，也不会反复改（BOM 已按前缀处理）。
 * ★ 盲扫模式下**不按扩展名筛** —— 但补指纹时仍只处理文本类，避免把二进制写坏。
 *
 * ★★★★ 2026-10-29（D364 · 用户要求「不仅兼容 md，也兼容 txt / json 之类」）：
 *   **默认扩展名从 `[".md"]` 扩到一组"加注释不会破坏语法"的纯文本格式。**
 *
 *   ★★ `json` **故意不在默认名单里** —— 这一点必须说清，不能含糊：
 *     实测（`_probe-d364-formats.mjs` ①）：给一份合法 JSON 加完三载体后，
 *     `JSON.parse` 立刻抛 `SyntaxError: No number after minus sign ... position 1`
 *     —— 因为三载体会在文件最前面插 `---\n…\n---`（YAML frontmatter），
 *     **那已经不是 JSON 了**。任何不经过 strip 的读取（编辑器 / 别家工具 / 用户双击）都会看到坏文件。
 *     ⇒ **`json` 只读、绝不改写。** 要给它加指纹得另设计一套"不侵入语法"的载体，
 *       那是另一件事，不在这一轮（D362 教训：不能把"顺手扩个名单"当成"支持了"）。
 *   ★ `yaml`/`yml` 同理**不在**默认名单：加 frontmatter 会把用户的顶层键挤下去（实测 ②）。
 *   ★ 想给这些格式加，**必须显式传 `exts`** ⇒ 由调用方自己承担"我知道它会改语法"。
 */
const STAMP_SAFE_EXTS = [".md", ".markdown", ".txt", ".text", ".log", ".rst", ".org", ".csv", ".tsv"];

export function stampDir(rootAbs, idOfRel, opts = {}) {
  const dryRun = opts.dryRun === true;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 24;
  const exts = Array.isArray(opts.exts) && opts.exts.length > 0 ? opts.exts : STAMP_SAFE_EXTS;
  const skipDirs = new Set(Array.isArray(opts.skipDirs) && opts.skipDirs.length > 0 ? opts.skipDirs : ["node_modules", ".git", ".dsh", "_backup"]);
  const updated = [];
  const skipped = [];
  const failed = [];

  const walk = (dirAbs, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch (err) {
        failed.push({ rel, error: String(err?.message ?? err) });
        continue;
      }
      // ★★★ 2026-10-28（D357）：**必须用三载体写入 + 三载体读取**。
      //   🔴 病（实测抓到的第三处"两套解析器并存"）：这里原来读 `parseFingerprint`、
      //     写 `applyFingerprint`（**都是旧版单载体**）⇒ 铺完之后文件里只有那行 HTML 注释，
      //     **三载体一个都没有**。抽查时 `fm/lk/in` 全 false，但 `read=true`
      //     （因为 `readFingerprint3` 会退回旧格式分支）⇒ **测试看着过，实际没铺三载体**。
      //   ★ 判据（同 D356 那条，这是第三次）：**读写必须走同一代 API** ——
      //     读 `readFingerprint3`、写 `applyFingerprint3`。旧格式只作兜底。
      const cur3 = readFingerprint3(text);
      const curLegacy = cur3.ok === true ? undefined : parseFingerprint(text);
      const id = idOfRel(rel, e.name);
      if (id === undefined) {
        skipped.push(rel);
        continue;
      }
      // ★★★★ 2026-10-29（D364 实测抓到的真缺陷）：**`identityOfPath` 只给 kind/key，不给 project**
      //   ⇒ 走到这里 `id.project` 是 `undefined` ⇒ `applyFingerprint3` 抛
      //   `指纹 project 非法: `（空串）⇒ **stampDir 一个文件都盖不上，全进 failed**。
      //   🔴 这不是新引入的：`stampDir` 本来就**没在生产里被调用过**（零调用方），
      //     所以这个洞一直没被踩到 —— 直到这一轮需要真用它补铺用户手写的文件。
      //   ★ 判据：**"函数能跑" ≠ "它跑得出结果"** —— 只验 `stampDir` 不抛异常是不够的，
      //     必须验 `updated.length > 0`（我在 `_probe-d363-survey` 里就是只看 `failed` 没看 `updated`，
      //     差点漏掉）。
      //   做法：project 缺失时**从 rootAbs 反查清单**（`projectOf` 带缓存，不会每次都读盘）。
      const projFromRoot = id.project === undefined ? projectOf(rootAbs) : id.project;
      // 已有指纹：只重算 seal，身份字段不动（★ 优先取三载体，其次旧格式；若仅剩行内信标则 kind 回退到 id.kind）
      const useId = cur3.ok === true
        ? {
            kind: cur3.id.kind ?? id.kind,
            project: cur3.id.project ?? projFromRoot,
            key: cur3.id.key ?? id.key,
          }
        : curLegacy?.ok === true
          ? {
              kind: curLegacy.fp.kind ?? id.kind,
              project: curLegacy.fp.project ?? projFromRoot,
              key: curLegacy.fp.key ?? id.key,
            }
          : { kind: id.kind, key: id.key, project: projFromRoot };
      // ★ 仍然拿不到 projectId（清单没写）⇒ **跳过，绝不"生成一个临时的"**（D356 那条判据）
      if (typeof useId.project !== "string" || useId.project === "") {
        failed.push({ rel, error: "清单里没有 projectId ⇒ 不盖指纹（绝不生成临时的，否则同一项目会出现两个 id）" });
        continue;
      }
      let next;
      try {
        next = applyFingerprint3(text, useId);
      } catch (err) {
        failed.push({ rel, error: String(err?.message ?? err) });
        continue;
      }
      if (next.text === text) {
        skipped.push(rel);
        continue;
      }
      if (!dryRun) {
        try {
          if (fs.lstatSync(abs).isSymbolicLink()) {
            failed.push({ rel, error: "拒绝改写符号链接文件" });
            continue;
          }
          fs.writeFileSync(abs, next.text, "utf8");
        } catch (err) {
          failed.push({ rel, error: String(err?.message ?? err) });
          continue;
        }
      }
      updated.push(rel);
    }
  };

  walk(rootAbs, 0);
  return { updated, skipped, failed };
}
