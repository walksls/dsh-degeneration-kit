/**
 * loop-valve —— 复读急停阀（v2：**软干预** + 反射句前兆）
 *
 * 【为什么是"外部急停"而不是"再写一条提示词"】
 * 本项目两次真实事故（session-8cf9f021、「好。」×10,849；session-56a87b9f、「好。」×5,233）
 * 之后加过反循环条款，**结果条款本身变成了循环的填充物**：
 *   `agent.cordis.yml` 第 143 行原话：「反空转条款本身变成了循环的填充物（上一棒的"已修好"不成立）」
 * ⇒ 任何写进上下文的"别复读"指令都会被循环吃掉。只有**外部机制**能打断它。
 *
 * 【为什么能中途停】
 * `@deepseek-ai/dsh-agent` 的 `Agent.cancel(cause, options)` 文档：
 *   "Clear queued and steering work … and **abort the active turn**"；
 * 且 `AssistantStreamAttempt.interruptedBlocks()` 明确支持
 *   "Safe visible prefix when cancellation interrupts the attempt"。
 * ⇒ 边流边判边取消，是被正式支持的路径。
 *
 * 【v2 为什么要加"软干预"（2026-10-08，学界依据 + 用户拍板）】
 * 现象在学界叫 **Circular Reasoning**，我们遇到的这一型叫 **statement loop**
 * （Duan et al., arXiv 2601.05693, 2026-01-09）。它的机制是"**V 型注意力**"：
 * 模型主要盯 attention sink + **最近的 token**，一旦近处开始重复就自我强化。
 * ⭐ 该论文**明确不用硬截断**（原话：abrupt truncation "indiscriminately cuts off
 * reasoning and compromises integrity"），而是在检测到 onset 时注入一句**结论诱导**
 * （例：`Conclude now and provide the answer.`）——即软干预。
 * 我们有对应的接口：`Agent.steer(message)` —— 文档：
 *   "Submit steering for the nearest step. An idle driver starts a turn;
 *    a running driver consumes it at its next step boundary.
 *    … cancellation or disposal may discard pending steering."
 * ⇒ **单靠 steer 刹不住正在喷的那一次生成**（它要等这一步结束），所以 v2 的做法是
 *   **先投引导、再 cancel 中止**。
 *   ⚠️ **实测坑（2026-10-08，真宿主验证）**：`steer()` 投的 `next-step` 引导**会被 cancel 作废**——
 *   会话日志里看得很清楚：
 *     `agent/inbox/spliced {target:"next-step", inserted:[⟪loop-valve⟫ …]}`   ← 投进去了
 *     `agent/inbox/spliced {removedCount:1, inserted:[], outcome:"canceled"}` ← 随即被丢弃
 *   （API 文档原话："A rejected step leaves steering parked in the inbox until the next wake;
 *    cancellation or disposal **may discard pending steering**."）
 *   ⇒ 换成 **`followup()`**："Queue an ordinary follow-up turn and wake the driver. The item
 *    becomes the sole ordinary message of its own turn." —— 它属于**排队的工作**，
 *   而 cancel 的 `keepInbox: true` 保的正是排队的工作。
 *   效果 = 论文的软干预：掐掉这一次生成，但**不让模型一脸懵地停在那里**，而是给它一句
 *   "停止复读、直接给结论/继续执行"再放它跑一轮。
 *   🛑 自动续跑要有**上限**（`maxAutoContinues`，默认 1）：否则"复读→掐→自动续跑→再复读"
 *   会变成花钱的循环。
 *
 * 【v2 还加了什么：反射句前兆（**实测否掉，默认 off**）】
 * 论文的另一条发现：statement loop **之前**通常有一段 **reflection sentence 激增**
 * （"等等 / 但是 / 我需要重新考虑"这类），他们用 CUSUM 监控**隐藏状态**提前预警。
 * 我们拿不到隐藏状态，只能做**文本层代理**：`reflectionSurge()` = 尾部窗口里反射句
 * 占句数的比例。**判据做了、也测了，结论是不成立**（我们测过，
 * 2026-10-08，只读、零成本）：
 *   · 误报：635 个真实**正常**思考块上，密度阈值 0.35 → 触发 **7.2%**；放宽到 0.50 仍有 2.8%
 *     ⇒ 当"动作触发器"太吵，会把正常的长段推理打断。
 *   · 预报：`segs-cache` 里 22 个真退化段，**只有 2 个**的**前一段**能命中前兆
 *     （前兆要真的有用，必须在循环开始**之前**就能报警）。
 *   · 块内提前量：24 个真块里只有 5 个是"前兆先于复读判据"命中，而且那 5 个的块本身
 *     已经是几万字符的巨型复读块 ⇒ 提前量没有实战意义。
 * ⚠️ 可能的失败原因（留给下一个人别再踩）：论文的"高熵少数 token"是**英文**语料里的
 *   Wait/But；中文推理里「但是/不过」是**正常连接词**，不是反思信号；而且他们做的是
 *   **相对基线**的突增检测（CUSUM），我们做的是**绝对密度**阈值。
 * ⇒ 默认 `precursor: 'off'`；函数与实验脚本都留着，想再试就自己开 `'log'` 观察。
 *   **不要**在没有新证据的情况下把它打开当触发器。
 *
 * 【判据】（纯函数 `detect`，可离线自证）
 *   只看**尾部窗口**（模拟实时），按句切开，统计**短单元**（≤maxUnit 字符）的最高重复次数，
 *   达到 minRepeats **且占窗口句数的比例 ≥ minShare** 才判复读。
 *   命中即 `steer(引导)` + `cancel({kind:'hook', reason})`。
 *
 * 【为什么后来加了 minShare（2026-10-07，235 会话离线复跑）】
 *   只有次数门槛时，阀会误伤"长段里恰好多次出现的过渡词"——实测 18 次触发里有 11 次是
 *   `OK`(×25) / `Go`(×28) / `Writing`(×35) / `Hmm`(×25)，**它们只占窗口句数的 2.5%~14.2%**，
 *   是正常长段，不是循环。而 7 个**真循环**（同一句占该段句子 ≥20%）全都 ≥20%：
 *     3867d102「我们做」52.0%｜56a87b9f「好」48.8%｜98e0ff60「写」46.2%｜a7bed659「我们」41.7%
 *     8cf9f021「好」33.1%｜142fea10「Emit」24.6%｜d1ec9561「Let me write」20.0%
 *   ⇒ 加 `minShare=0.20` 后：**召回 7/7 不变，额外触发 11 → 0**（扫 0.15~0.20，≥0.18 归零；取 0.20 这个整数）。
 *   ⚠️ 代价：**"慢速铺开"的复读检出得晚**（d1ec9561 从 4,800 字符推迟到 25,800／全段 27,719）。
 *   2026-10-08 全机复扫（571 会话）：24 个真退化块里 17 个是**带工具调用**的步
 *   —— 阀不受这一步影响（它在流上判，不管有没有工具调用）。
 *
 * 配置（代码里都有默认值）：
 *   enabled      默认 true
 *   minRepeats   短单元重复次数阈值，默认 25
 *   minShare     重复次数占窗口句数的比例下限，默认 0.20（0 = 关掉这道门，退回旧行为）
 *   maxUnit      参与统计的单元最大长度，默认 30
 *   tailChars    只看最近多少字符，默认 4000
 *   checkEvery   每累计多少字符检查一次，默认 600（避免每 token 都扫）
 *   softSteer    默认 true；命中时先投引导（见 delivery）再 cancel（带 `keepInbox: true`）。
 *   delivery     'followup'（默认，排队的工作，扛得住 cancel）| 'steer'（实测会被作废，留作对照）| 'off'
 *   maxAutoContinues  同一会话最多自动续跑几次，默认 3（0 = 不自动续跑）
 *   autoContinueCooldownMs  两次自动续跑之间的最小间隔，默认 60000（1 分钟）——
 *                     防"掐→自动续→又复读→再掐"的紧循环（紧循环里只 cancel，不续跑）
 *   steerNote    自定义引导文案（留空用内置）
 *   precursor    'off'（默认，理由见上）| 'log' | 'steer' —— 反射句前兆怎么处置
 *   precursorMinDensity / precursorMinSentences   前兆阈值（默认 0.35 / 20）
 *   includeSubagents 默认 false
 *   debug        默认 false（打 ctx.logger）
 *   debugFile    诊断落盘路径（默认关；headless 下 ctx.logger 看不到）
 */
export const name = 'loop-valve'

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

/** 只由 config.debugFile 开启的诊断落盘（生产默认关）。 */
let DEBUG_FILE
function dbg(message) {
  if (DEBUG_FILE === undefined) return
  try { fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`) } catch { /* 诊断失败不能影响正事 */ }
}

/** 按句切分（与全机扫描器同口径，保证离线自证与线上判定一致）。 */
const SPLIT = /[。！？!?\n]+|\.\s+/   // 英文句点只在「点+空白」处切，避免把 store.py 切碎
/**
 * 重复单元必须含至少一个"实义字符"（字母/数字/汉字）。
 * 依据：2026-10-07 强制触发实验里，阀把 markdown 代码围栏「```」×3 判成了复读
 * —— 那是合法的高频短标记。纯标记（```、**、---、|）一律不参与统计。
 */
const MEANINGFUL = /[A-Za-z0-9\u4e00-\u9fff]/
/**
 * 反射句标记（v2 前兆用）：论文说 statement loop 之前有一段"反思/犹豫句"激增。
 * 中文用词形（不要求边界），英文用词边界（避免 But 命中 Button、Let 命中 Letter）。
 */
const REFLECT_CN = /等等|但是|不过|然而|其实|让我|我们需要重新|重新想|换个思路|换个角度|我需要重新|我得重新|再想想|仔细想想/
const REFLECT_EN = /\b(?:Wait|But|Actually|Hmm+|Let me|Let's|Alternatively|On second thought|Reconsider)\b/i

/**
 * 纯判据：这段文本看起来是不是在复读？
 * @returns {{unit: string, count: number, share: number} | null}
 */
export function detect(text, cfg = {}) {
  const minRepeats = Number.isSafeInteger(cfg.minRepeats) ? cfg.minRepeats : 25
  const maxUnit = Number.isSafeInteger(cfg.maxUnit) ? cfg.maxUnit : 30
  const tailChars = Number.isSafeInteger(cfg.tailChars) ? cfg.tailChars : 4000
  const minShare = typeof cfg.minShare === 'number' && cfg.minShare >= 0 ? cfg.minShare : 0.20
  const tail = text.length > tailChars ? text.slice(-tailChars) : text
  const parts = tail.split(SPLIT).map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length < minRepeats) return null
  const counts = new Map()
  let best = ''
  let bestN = 0
  for (const p of parts) {
    if (p.length > maxUnit) continue
    if (!MEANINGFUL.test(p)) continue
    const n = (counts.get(p) ?? 0) + 1
    counts.set(p, n)
    if (n > bestN) { bestN = n; best = p }
  }
  if (bestN < minRepeats) return null
  // 分母 = 窗口内全部句子数（含长句与纯标记）：分母越大越保守 —— 见文件头「为什么加了 minShare」
  const share = bestN / parts.length
  if (share < minShare) return null
  return { unit: best, count: bestN, share }
}

/**
 * v2 纯判据（前兆）：尾部窗口里"反射句"占句数的比例。
 * ⚠️ 论文用的是**隐藏状态**上的 CUSUM；这里只是文本层代理，阈值需校准（见文件头）。
 * @returns {{hits:number, sentences:number, density:number, samples:string[]} | null}
 */
export function reflectionSurge(text, cfg = {}) {
  const tailChars = Number.isSafeInteger(cfg.tailChars) ? cfg.tailChars : 4000
  const minSentences = Number.isSafeInteger(cfg.precursorMinSentences) ? cfg.precursorMinSentences : 20
  const minDensity = typeof cfg.precursorMinDensity === 'number' ? cfg.precursorMinDensity : 0.35
  const tail = text.length > tailChars ? text.slice(-tailChars) : text
  const parts = tail.split(SPLIT).map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length < minSentences) return null
  let hits = 0
  const samples = []
  for (const p of parts) {
    if (!REFLECT_CN.test(p) && !REFLECT_EN.test(p)) continue
    hits += 1
    if (samples.length < 5) samples.push(p.slice(0, 24))
  }
  const density = hits / parts.length
  if (density < minDensity) return null
  return { hits, sentences: parts.length, density, samples }
}

/** 子代理判定：走 session header，不要读 agent.delegationDepth（不存在）。 */
function isSubagent(agent) {
  try {
    const h = agent?.session?.header
    return typeof h?.delegationDepth === 'number' ? h.delegationDepth > 0 : false
  } catch { return false }
}

/** 会话身份（自动续跑预算按会话记）。 */
function sessionKey(agent) {
  try { return agent?.session?.header?.id ?? agent?.session?.id ?? 'unknown' } catch { return 'unknown' }
}

/** 内置软干预文案（可用 config.steerNote 覆盖）。 */
export const DEFAULT_STEER_NOTE =
  '⟪loop-valve⟫ 你的思考正在原地复读，本回合已被中止。'
  + '不要再重复上面的内容：直接用一两句话给出结论，或立刻继续执行当前任务（调用工具）。'

/**
 * v2：把一条引导消息投给"最近的一步"。
 * 手搓 `UserMessage` 形状（插件里 import 不到 @deepseek-ai/dsh-llm 的 createUserMessage：
 * 那份包只装在 DSH 自己的 node_modules 树里，preset 目录解析不到）。
 * @returns {boolean} 是否成功投递
 */
export function followupAgent(agent, text) {
  try {
    if (typeof agent?.followup !== 'function') return false
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: `plugin:${name}` }
    })
    return true
  } catch { return false }
}

export function steerAgent(agent, text) {
  try {
    if (typeof agent?.steer !== 'function') return false
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: `plugin:${name}` }
    })
    return true
  } catch { return false }
}

export function apply(ctx, config = {}) {
  if (typeof config.debugFile === 'string' && config.debugFile.length > 0) DEBUG_FILE = config.debugFile
  dbg(`apply 被调用：enabled=${config.enabled} precursor=${config.precursor}`)
  if (config.enabled === false) return
  const minRepeats = Number.isSafeInteger(config.minRepeats) ? config.minRepeats : 25
  const maxUnit = Number.isSafeInteger(config.maxUnit) ? config.maxUnit : 30
  const tailChars = Number.isSafeInteger(config.tailChars) ? config.tailChars : 4000
  const minShare = typeof config.minShare === 'number' && config.minShare >= 0 ? config.minShare : 0.20
  const checkEvery = Number.isSafeInteger(config.checkEvery) ? config.checkEvery : 600
  const includeSubagents = config.includeSubagents === true
  const debug = config.debug === true
  const softSteer = config.softSteer !== false
  const delivery = config.delivery === 'steer' || config.delivery === 'off' ? config.delivery : 'followup'
  const maxAutoContinues = Number.isSafeInteger(config.maxAutoContinues) ? config.maxAutoContinues : 3
  const autoContinueCooldownMs = Number.isSafeInteger(config.autoContinueCooldownMs) ? config.autoContinueCooldownMs : 60000
  const steerNote = typeof config.steerNote === 'string' && config.steerNote.length > 0 ? config.steerNote : DEFAULT_STEER_NOTE
  const precursor = config.precursor === 'steer' || config.precursor === 'log' || config.precursor === 'off'
    ? config.precursor
    : 'off'   // 默认关：文本层前兆判据在本机语料上**不成立**（见文件头与 precursor-study.mjs）
  const cfg = {
    minRepeats, maxUnit, tailChars, minShare,
    precursorMinDensity: typeof config.precursorMinDensity === 'number' ? config.precursorMinDensity : 0.35,
    precursorMinSentences: Number.isSafeInteger(config.precursorMinSentences) ? config.precursorMinSentences : 20
  }

  /** agent -> { attemptId, len, checked, text, fired, precursorFired } */
  const state = new WeakMap()
  /** sessionId -> { count, lastAt }：自动续跑的预算 + 冷却（防"掐→续→再掐"变成花钱的循环） */
  const continues = new Map()

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent === undefined || agent === null) return
    if (frame?.type === 'start') {
      state.set(agent, { attemptId: frame.attemptId, len: 0, checked: 0, text: '', fired: false, precursorFired: false })
      return
    }
    if (frame?.type !== 'chunk') return
    const s = state.get(agent)
    if (s === undefined || s.fired) return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.type !== 'reasoning-delta' && chunk.type !== 'text-delta') return
    const delta = typeof chunk.text === 'string' ? chunk.text : (typeof chunk.delta === 'string' ? chunk.delta : '')
    if (delta === '') return
    s.text += delta
    s.len += delta.length
    if (s.len - s.checked < checkEvery) return
    s.checked = s.len

    if (!includeSubagents && isSubagent(agent)) return

    // ── v2-a：反射句前兆（默认 off；实测不成立，见文件头）──────────────────
    if (precursor !== 'off' && !s.precursorFired) {
      const surge = reflectionSurge(s.text, cfg)
      if (surge !== null) {
        s.precursorFired = true
        const pct = Math.round(surge.density * 100)
        const text = `⟪loop-valve⟫ 你最近反复在"犹豫/自我打断"（${surge.hits}/${surge.sentences} 句，占 ${pct}%）。`
          + '停止反复权衡：挑一个方案，直接执行下一步；需要结论就直接给结论。'
        if (precursor === 'steer') {
          const ok = steerAgent(agent, text)   // 前兆只做轻量 steer（不掐回合），作废也无所谓
          dbg(`前兆命中（${surge.hits}/${surge.sentences}=${pct}%）→ steer ${ok ? '成功' : '失败'}；样本 ${surge.samples.join(' | ')}`)
          if (debug) ctx.logger?.info?.(`[${name}] 前兆命中 → steer ${ok ? 'ok' : 'fail'}`)
        } else {
          dbg(`前兆命中（log 模式，不动作）：${surge.hits}/${surge.sentences}=${pct}%；样本 ${surge.samples.join(' | ')}`)
        }
      }
    }

    // ── v2-b：复读判据命中 → 先软干预、再硬中止 ──────────────────────────
    const hit = detect(s.text, cfg)
    if (hit === null) return
    s.fired = true
    const pct = Math.round((hit.share ?? 0) * 100)
    const reason = `loop-valve: 检测到复读（「${hit.unit.slice(0, 20)}」×${hit.count}，占窗口 ${pct}%），已中止本回合`
    if (debug) ctx.logger?.info?.(`[${name}] ${reason}`)
    let steered = false
    if (softSteer && delivery !== 'off') {
      const key = sessionKey(agent)
      const used = continues.get(key) ?? { count: 0, lastAt: 0 }
      const cooled = Date.now() - used.lastAt >= autoContinueCooldownMs
      if (used.count >= maxAutoContinues || !cooled) {
        dbg(`命中复读（「${hit.unit.slice(0, 20)}」×${hit.count}/${pct}%）→ 不自动续跑`
          + `（已用 ${used.count}/${maxAutoContinues}${cooled ? '' : '，冷却中'}），只 cancel`)
      } else {
        steered = delivery === 'followup' ? followupAgent(agent, steerNote) : steerAgent(agent, steerNote)
        if (steered) continues.set(key, { count: used.count + 1, lastAt: Date.now() })
        dbg(`命中复读（「${hit.unit.slice(0, 20)}」×${hit.count}/${pct}%）→ ${delivery} ${steered ? '成功' : '失败'}（${used.count + (steered ? 1 : 0)}/${maxAutoContinues}），随后 cancel`)
      }
    }
    try {
      // keepInbox: true —— 否则 cancel 会把刚投的 steering 一起清掉（API 文档原话：
      // "Clear queued and steering work — unless keepInbox"）。
      agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] cancel 失败: ${String(error)}`)
    }
  })
}
