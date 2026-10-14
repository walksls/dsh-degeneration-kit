/**
 * detect-v2 —— 「极短句轮换」判据（2026-10-14 新增，实验版）
 *
 * 【为什么要加】
 * 在役 `detect()`（escape-valve.mjs）只看「单个重复单元占窗口句数的比例」（minShare 0.20）。
 * 但英文劣化常是**多个短句轮换**：
 *
 *     Let me write it. → Go. → Now. → OK. → Writing. → Let me write the tool call. → Here. → …
 *
 * 这种形态把尾部窗口切成 300+ 段，每个短词只占 ~15%，**没有一个够 20%** ⇒ 整块放行。
 * 三个真样本（2026-09-16/09-20/09-23，见 `_英文劣化样本-证据.md`）在役判据 **0/3 召回**。
 *
 * 【判据】
 * 同一尾部窗口（默认 4000 字符，与在役同口径）内两条同时成立：
 *   · shortShare   —— 极短段（归一化 ≤3 词）占比 ≥ 0.35
 *   · topUnitShare —— 最高频 5 段合计占比 ≥ 0.50
 *
 * 【实测分界（12,203 个英文块）】
 *   真样本 topUnitShare = 0.53 / 0.63 / 0.71；假阳性最高 0.41 ⇒ 阈值 0.50 落在中间空隙。
 *
 * ⚠️ 本判据**只给 thinking-guard 用**（折叠）。不要塞进 escape-valve 的 `detect()`：
 * 那份是急停阀共用的，急停阀的动作是 `agent.cancel`（更猛），不该被新阈值连坐。
 */

const SPLIT = /[。！？!?\n]+|\.\s+/
const MEANINGFUL = /[A-Za-z0-9\u4e00-\u9fff]/
const CODE_FENCE = /```[\s\S]*?```/g

/** 归一化后的词数（与 Python 侧 norm_words 同口径：小写、数字→#、只留 a-z 与空白）。 */
function wordCount(s) {
  return s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length
}

/**
 * 纯函数：判断一个 reasoning 块是不是「极短句轮换」型退化。
 * @param {string} text
 * @param {object} cfg - { tailChars, shortWordsMax, shortShareMin, topUnitShareMin, minParts }
 * @returns {null | {unit:string, count:number, share:number, shortShare:number, parts:number, top:Array}}
 */
export function rotationHit(text, cfg = {}) {
  if (typeof text !== 'string' || text.length === 0) return null
  const tailChars = Number.isFinite(cfg.tailChars) ? cfg.tailChars : 4000
  const shortWordsMax = Number.isFinite(cfg.shortWordsMax) ? cfg.shortWordsMax : 3
  const shortShareMin = Number.isFinite(cfg.shortShareMin) ? cfg.shortShareMin : 0.35
  const topUnitShareMin = Number.isFinite(cfg.topUnitShareMin) ? cfg.topUnitShareMin : 0.5
  const minParts = Number.isFinite(cfg.minParts) ? cfg.minParts : 25

  const tail = (text.length > tailChars ? text.slice(-tailChars) : text).replace(CODE_FENCE, ' ')
  const parts = tail.split(SPLIT).map((s) => s.trim()).filter(Boolean)
  if (parts.length < minParts) return null

  let short = 0
  const counts = new Map()
  for (const p of parts) {
    if (wordCount(p) <= shortWordsMax) short += 1
    if (MEANINGFUL.test(p)) counts.set(p, (counts.get(p) || 0) + 1)
  }
  if (counts.size === 0) return null

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const shortShare = short / parts.length
  const topUnitShare = top.reduce((sum, [, n]) => sum + n, 0) / parts.length
  if (shortShare < shortShareMin || topUnitShare < topUnitShareMin) return null

  return {
    via: 'rotation',
    unit: top[0][0],
    count: top[0][1],
    share: topUnitShare,
    shortShare,
    parts: parts.length,
    top,
  }
}

export default rotationHit
