#!/usr/bin/env node
/**
 * 共享的**假 state**（审计器与各探针共用一份 —— 不许各写一份，本项目最忌"两处各写一份"）。
 *
 * ★★★ 这样做的理由（D309 的真实教训）：
 *   `state` 是插件自己的内存态容器（`Map` / `Set`）。工具里到处 `state.<name>.get(...)`。
 *   夹具少给一个字段 ⇒ 工具在**取字段**时崩 ⇒ 三态判据把它读成"**真缺陷**"。
 *   而实际原因是"你没给它该有的东西"。
 *   ⇒ **"假对象"也必须遵守真契约。** 所以这份清单必须是**全的**，且只能有一份。
 *
 * ★ 怎么定这一批字段（不是猜）：把 `lib/part{1..8,8tool}.js` 里所有
 *   `state.<name>.{get,set,has,delete}(` 扫一遍，与已有的做**差集**。
 *   实测代码用到 **32 个**、最初只写了 13 个 ⇒ 缺 19 个。
 *   ★ 改完源码后请重跑 `node tools/_probe-fakestate-coverage.mjs` 复核（它自己数差集）。
 */

/** @returns {Record<string, Map|Set>} 每个工具真正会碰到的 state 槽位 */
export function fakeState() {
  return {
    // ── 压缩 / 水位 ────────────────────────────────────────────────
    compactFailures: new Map(),
    capsuleSnapshot: new Map(),
    hfSource: new Map(),
    compactCounts: new Map(),
    hfCompacted: new Map(),
    hfCompactAfterTurn: new Map(),
    flushedAt: new Map(),
    lastCompactCycleAt: new Map(),
    flushBlocked: new Map(),
    triageBlocked: new Map(),
    anchors: new Map(),
    reinject: new Map(),
    settingsBaselines: new Map(),
    // ── D309 补齐的那 19 个 ───────────────────────────────────────
    autoOfferPending: new Map(),
    blockWeights: new Map(),
    capsuleHydrated: new Set(),
    compactAfterTurn: new Map(),
    conformAsked: new Set(),
    deltaForce: new Map(),
    deltaNudged: new Map(),
    deltaYieldSince: new Map(),
    ledgerTouched: new Map(),
    midTurnDbg: new Map(),
    pending: new Map(),
    principleGrants: new Map(),
    principleProposals: new Map(),
    projectAsked: new Set(),
    shadowedIndex: new Map(),
    skipAutoOffer: new Set(),
    triageAt: new Map(),
    triageKeep: new Map(),
    triageOwedAt: new Map(),
    turnCompact: new Map(),
    turnEndPullSpent: new Map(),
    turnObligation: new Map(),
  };
}
