/**
 * thinking-guard —— 退化思考**不回传**（毒化上下文的止血带）
 *
 * 【要解决的问题】
 * DSH 会把历史里的 `reasoning` 块发回上游（`@deepseek-ai/dsh-llm-pi-ai`
 * 把 `reasoning` 映射成 `thinking`）。于是一次复读退化不只是"这一步废了"——
 * 那条 15,955 字符的复读块会**留在上下文里**，之后每一步、每一轮都带着它重放。
 * 实测（抓到的真实请求体）：这条 reasoning 以 **assistant 消息正文**的
 * 形态出现在下一次请求里（`content` 长度 = 15,986）。压缩救不了：默认 `retainRatio = .16`
 * 的"逐字保留尾"正好包含它，而且压缩只在 `agent/pre-step` 触发，管不到一次生成内部。
 * 学界对这种退化的定名与机制见 topic「Circular Reasoning」：
 * 维持机制是 **V 型注意力**（模型主要看 attention sink + 最近 token）⇒ 把近处的复读
 * 从模型可见历史里拿走，正好打在维持机制上。
 *
 * 【本插件做什么】
 * 每一步请求之前扫一遍"还没检查过"的 surface 节点；凡是 assistant 消息里含
 * **退化复读**的 reasoning 块，就把那个节点（**v2：连同它调起的工具结果**）用一条
 * `user/message` 等价替换掉（`surfaceOp: {op:'replace'}` + `sourceEventSeqs`），
 * 正文变成一段折叠说明。⇒ 日志仍是只追加；模型可见历史里那一步只剩说明，
 * 复读原文一个字都不再回传；**人看的记录不受影响**（`isAppendSurfaceEvent` 的注释明确：
 * 替换副本是 model-only，人类 transcript 用的是 append 原点事件）。
 *
 * 【v2：为什么要"整段遮蔽"（2026-10-08，实测驱动）】
 * v1 只剪"纯思考步"（消息里含 `tool-call` 就跳过），理由是单独遮蔽助手消息会让配对的
 * `tool/result` 悬空。装完机之后一次全机扫描：571 个会话 / 63,735 条
 * assistant 消息）才发现**这个限制放弃了多数情形**：
 *   · 命中退化判据的块共 **24** 个，其中**带工具调用的 17 个（71%）**——v1 剪不到；
 *   · 背景数：**96.6%** 的 assistant 消息都带 tool-call。
 * 而 `dsh-session` 的校验规则（`lib/index.js:290-453` 四条，逐条读过）允许一条
 * **`user/message` 替换覆盖跨类型的多节点连续 span**：
 *   · `replacementRange()`：起止 seq 都必须在当前 surface 里，遮蔽集 = 这一段连续节点；
 *   · `assertSourceEventReferences()`：`sourceEventSeqs` 必须覆盖每个被遮蔽节点；
 *   · `assertToolResultRewrite()`：**只有当"新事件本身是 tool/result"时**才限一个节点
 *     （`tool-result-pruner` 走的就是那条）——我们是 `user/message`，不受这条约束；
 *   · `assertSystemHeadRewrite()`：只保护 node 0 的 system prompt。
 * ⇒ **把「那条 assistant 消息」+「它调起的全部 tool/result」整段换一条说明**，
 *   调用与结果同生共死，悬空问题自然消失。这就是 v2。
 *
 * 【v2 的安全边界】
 *   · 只剪**配对完整**的步：消息里有 N 个 `tool-call` 就必须在 surface 里紧跟 N 个
 *     `tool/result`；不够（还在飞 / 已残缺）就**这一步不剪、下一步再试**（不记 seen）。
 *   · 只处理 `surfaceOp === 'append'` 的原点事件（替换副本不再剪）。
 *   · 摘要里带上"可见文字 + 工具名 + 参数 + 结果首段"，把信息损失压小。
 *
 * 【为什么不用 surface replace 直接改 assistant 消息（两条死路，记下来）】
 *  ① `assistant/message` 做替换在 `dsh-session` 里**根本不可能**：该类型"自带 stream"
 *     不许带 `sourceEventSeqs`，而替换又要求 `sourceEventSeqs` 覆盖每个被遮蔽节点。
 *  ② 官方给插件留的正道是**消息投影**（`ctx.sessions.registerMessageProjection`，
 *     `image/offload` 就是这么做的）—— 但投影必须由一条**插件自有事件**触发，而
 *     进程内插件**没法持久化自定义事件类型**：`Session.append` 不提供 `ignorable` 标记，
 *     加载器却拒绝"未知且非 ignorable"的事件（实测：整个会话直接读不出来，
 *     `contains event type "thinking-guard/redact" ... refusing to interpret the log`）。
 *     （该标记只对**外部写入者**开放 —— `dsh-session` 的注释原文："Downstream
 *     (out-of-repo) plugin events are outside this list by construction"。）
 *  ⇒ 只剩"用**核心**事件类型做等价替换"这一条路，就是本文件现在的做法。
 *
 * 【判据从哪来】
 * 与急停阀**共用同一份 `detect`**（同目录 `escape-valve.mjs`）：阈值拿 235 个真实会话
 * 离线校准过（7 个真循环召回 7/7，误伤 11 → 0）。这里再加一道 `minChars`。
 * 正样本语料：24 个真实样本，2026-10-08 落盘）。
 *
 * 【v2 判据（2026-10-14）：为什么要第二把尺子】
 * 原判据只算"**单个**重复单元占窗口句数的比例"（`minShare: 0.20`）。
 * 而英文退化常是**多个短句轮换**（`Let me write it.` → `Go.` → `Now.` → `OK.` → `Writing.` …），
 * 尾部 4000 字符被切成 300+ 段，每个短词只占 ~15%，**没有一个够 20%** ⇒ 整块放行。
 * 本机三个真样本（2026-09-16 / 09-20 / 09-23；38,785 / 29,371 / 18,793 字符）在原判据上
 * **0/3 召回**，换 v2 后 **3/3 命中**，且 300 个正常英文块 **0 误伤**（离线回归，跑真函数）。
 * ⚠️ 这三块都发生在**没挂本插件**的会话里（standard / cordis）—— 所以"日志里没有记录"
 * 不能推出"没发生过"。判据实现与阈值依据见 `detect-v2.mjs`。
 *
 * 配置（**都有代码默认值 —— 不改 preset 的 config 也能拿到 v2 行为**）：
 *   enabled           默认 true
 *   minChars          只考虑长度 ≥ 这个值的 reasoning 块，默认 400
 *   minRepeats/minShare/maxUnit/tailChars   判据阈值（透传 detect，默认 25 / 0.20 / 30 / 4000）
 *   foldToolSteps     默认 true；false = 退回 v1 行为（带工具调用的步一律不动）
 *   digestChars       每条工具结果摘要保留多少字符，默认 200
 *   digestArgs        工具参数摘要保留多少字符，默认 160
 *   maxDigests        最多列几条工具调用/结果，默认 4
 *   textChars         该步"可见文字"摘要保留多少字符，默认 200
 *   includeSubagents  默认 true
 *   dryRun            默认 false；true = 只诊断不落地
 *   note              纯思考步的折叠说明（留空用内置文案；工具步另有内置构造器）
 *   debugFile         诊断日志路径（默认关；headless 下 ctx.logger 看不到）
 */
export const name = 'thinking-guard'

// 与急停阀共用同一套判据；装机后两个文件同在 preset 的 lib/ 下，相对导入成立。
import { detect } from './escape-valve.mjs'
// v2（2026-10-14）：英文碎片轮换的第二把尺子。**只给本插件用**，不塞进共享 detect
// （急停阀的动作是 agent.cancel，比折叠更猛，不该被新阈值连坐）。
import { rotationHit } from './detect-v2.mjs'
import fs from 'node:fs'

/** 只由 config.debugFile 开启的诊断落盘（生产默认关；headless 下 ctx.logger 看不到）。 */
let DEBUG_FILE
function dbg(message) {
  if (DEBUG_FILE === undefined) return
  try { fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`) } catch { /* 诊断失败不能影响正事 */ }
}
/**
 * 纯函数：找出消息 content 里需要剪掉的退化 reasoning 块。
 * @param {Array} content - assistant 消息的 content 数组
 * @param {object} cfg - { minChars, minRepeats, minShare, maxUnit, tailChars }
 * @returns {Array<{index:number, unit:string, count:number, share:number, chars:number}>}
 */
export function findDegenerate(content, cfg = {}) {
  const minChars = Number.isSafeInteger(cfg.minChars) ? cfg.minChars : 400
  const hits = []
  if (!Array.isArray(content)) return hits
  content.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return
    if (block.type !== 'reasoning') return
    const text = typeof block.text === 'string' ? block.text : ''
    if (text.length < minChars) return
    // 两把尺子并联：老判据（同一句逐字复读，中文为主），没中就再试 v2（短句轮换，英文碎片）。
    // 顺序有意义：老判据阈值严、误报低，先让它判；v2 只在它放行时才补刀。
    const hit = detect(text, cfg) ?? (cfg.rotationGuard === false ? null : rotationHit(text, cfg))
    if (hit === null) return
    hits.push({ index, chars: text.length, ...hit })
  })
  return hits
}

/** 子代理判定：走 session header，与急停阀同口径。 */
function isSubagent(agent) {
  try {
    const h = agent?.session?.header
    return typeof h?.delegationDepth === 'number' ? h.delegationDepth > 0 : false
  } catch { return false }
}

/** 内置折叠说明（纯思考步；可用 config.note 覆盖）。
 *
 * ⚠️ 这段文字会以 `role: "user"` 的身份送到模型面前 —— 这不是随手选的，
 * 而是**唯一能真正送达的通道**：
 *   · `developer/message` 转上游本来是 `role: "system"`（语义更对），
 *     但宿主会在 `dsh-llm/lib/index.js` 的 `projectToolUpdates()` 里把它**静默丢弃**
 *     （`if (!updateIds.has(message.id)) continue` —— 不在工具更新名单里的 developer 一律过滤）。
 *     实测：会话日志 4 次折叠全部正确落盘、`deriveMessages()` 也返回 developer，
 *     但真实 HTTP 请求体里一条都没有（代理抓包 + 三处探针交叉验证）。
 *   · 0.2.0 / 0.2.1 都有这段过滤逻辑，所以 `developer/message` 两个版本都送不到。
 *
 * 既然只能用 user 通道，文案就必须自己承担消歧责任，三条硬要求：
 *   ① **首句自报身份**（`⟪thinking-guard⟫`）—— 让模型知道这不是人在说话；
 *   ② **不含任何祈使句**（"请…""不要…""直接…"）—— 祈使句是"用户下了个命令"的强信号，
 *      正是它让模型开始编造用户说过的话（用户实报过的现象）；
 *   ③ 只说**发生了什么**，把"该怎么办"留给模型自己判断。
 */
export const DEFAULT_NOTE = '⟪thinking-guard⟫ 上一步的思考退化成了复读，已从模型可见历史中折叠'
  + '（原文仍保存在本地会话日志里）。这是一条插件提示，不是用户发言。'

/** 待剪消息里有没有工具调用。 */
export function hasToolCall(content) {
  return Array.isArray(content) && content.some((block) => block?.type === 'tool-call')
}

/** 把任意文本压成一行并截断（摘要用）。 */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > limit ? `${one.slice(0, limit)}…` : one
}

/**
 * v2 纯函数：算出"这一步该整段遮蔽哪几个 surface 节点"。
 * @param {{nodes:Array<number>, eventAt:(seq:number)=>object|undefined}} view - surface 视图
 * @param {number} seq - 退化 assistant 消息的 seq
 * @param {number} callCount - 该消息里的 tool-call 个数
 * @returns {{ok:true, span:number[]} | {ok:false, why:string, have?:number, need?:number}}
 */
export function planSpan(view, seq, callCount) {
  const nodes = Array.isArray(view?.nodes) ? view.nodes : []
  const at = view?.eventAt
  const start = nodes.indexOf(seq)
  if (start === -1) return { ok: false, why: 'not-in-surface' }
  if (!Number.isSafeInteger(callCount) || callCount <= 0) return { ok: true, span: [seq] }
  const span = [seq]
  for (let i = start + 1; i < nodes.length && span.length - 1 < callCount; i += 1) {
    const ev = typeof at === 'function' ? at(nodes[i]) : undefined
    if (ev === undefined || ev.type !== 'tool/result') break
    span.push(nodes[i])
  }
  const have = span.length - 1
  if (have < callCount) return { ok: false, why: 'incomplete-pairing', have, need: callCount }
  return { ok: true, span }
}

/**
 * v2 纯函数：为"带工具调用的退化步"构造折叠说明。
 * 说明里保留可见文字 + 每次调用的名字/参数/结果首段 —— 把信息损失压到最小。
 * @param {{unit:string, count:number, share:number, calls:Array<{name:string,args:string}>, results:Array<{name:string,args:string,isError:boolean,text:string}>, text:string}} info
 */
export function buildFoldNote(info, cfg = {}) {
  const digestChars = Number.isSafeInteger(cfg.digestChars) ? cfg.digestChars : 200
  const digestArgs = Number.isSafeInteger(cfg.digestArgs) ? cfg.digestArgs : 160
  const maxDigests = Number.isSafeInteger(cfg.maxDigests) ? cfg.maxDigests : 4
  const textChars = Number.isSafeInteger(cfg.textChars) ? cfg.textChars : 200
  const unit = String(info?.unit ?? '').slice(0, 20)
  const count = Number(info?.count ?? 0)
  const pct = Math.round((Number(info?.share ?? 0)) * 100)
  const results = Array.isArray(info?.results) ? info.results : []
  const lines = [
    `⟪thinking-guard⟫ 上一步的思考退化成了复读（「${unit}」×${count}，占该段 ${pct}%），`
    + `已连同该步的 ${results.length} 次工具调用与结果一起从模型可见历史中折叠。`
  ]
  const text = clip(info?.text, textChars)
  if (text !== '') lines.push(`· 该步可见文字：${text}`)
  const shown = results.slice(0, maxDigests)
  for (const r of shown) {
    const name = r?.name === undefined || r.name === '' ? '工具' : r.name
    const args = clip(r?.args, digestArgs)
    const body = clip(r?.text, digestChars)
    const verdict = r?.isError === true ? '失败' : '成功'
    lines.push(`· ${name}(${args}) → 结果（${verdict}）：${body}`)
  }
  if (results.length > shown.length) lines.push(`· （另有 ${results.length - shown.length} 次调用未列出）`)
  // ⭐ 这一句就是 arXiv 2601.05693 那条"软干预"（结论诱导）在 DSH 里**唯一可验证**的落点：
  //    阀在流上掐掉复读，但 cancel 会把排队/引导消息一起作废（实测 `outcome: canceled`），
  //    真正能到模型眼前的只有"替换掉毒块的这段说明"。
  lines.push('（该步内容已折叠；原文仍在本地日志里。）')
  return lines.join('\n')
}

/** 从 assistant 消息里取"可见文字"与工具调用（callId → 名字/参数）。 */
function describeStep(session, message) {
  const texts = []
  const calls = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    if (block.type === 'tool-call') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        args: typeof block.arguments === 'string' ? block.arguments : ''
      })
    }
  }
  return { text: texts.join('\n'), calls }
}

/** 从 tool/result 节点上取结果正文（供摘要）。 */
function describeResult(session, seq, call) {
  let text = ''
  let isError = false
  try {
    const ev = session.eventAt(seq)
    const msg = session.deriveEventMessage(ev)
    if (Array.isArray(msg?.content)) {
      text = msg.content.map((b) => (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n')
    }
    isError = msg?.isError === true
  } catch { /* 摘要失败就留空，不能影响折叠 */ }
  return { name: call?.name ?? '', args: call?.args ?? '', isError, text }
}

/** 扫一遍这个会话里还没检查过的 surface 节点。 */
function sweep(ctx, session, cfg, state) {
  let s = state.get(session)
  if (s === undefined) {
    // 被替换掉的节点会从 surface 里消失（`applySurfacePlan` 是 splice），
    // 所以"同一个节点剪两次"在结构上就不可能 —— 跨进程续跑也安全。
    s = { seen: new Set(), folds: 0, chars: 0 }
    state.set(session, s)
    dbg(`sweep 首次：surface ${session.surface.nodes.length} 节点`)
  }
  // 自己折叠会让被遮蔽的节点当场从 surface 消失，所以维护一份"当前还在"的集合。
  const live = new Set(session.surface.nodes)
  for (const seq of [...session.surface.nodes]) {
    if (s.seen.has(seq) || !live.has(seq)) continue
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'assistant/message') { s.seen.add(seq); continue }
    if (event.surfaceOp !== 'append') { s.seen.add(seq); continue }
    const message = session.deriveEventMessage(event)
    if (message === null || !Array.isArray(message.content)) { s.seen.add(seq); continue }
    const hits = findDegenerate(message.content, cfg)
    if (hits.length === 0) { s.seen.add(seq); continue }
    const chars = hits.reduce((sum, hit) => sum + hit.chars, 0)
    const detail = hits.map((hit) => `#${hit.index}${hit.via === 'rotation' ? '[轮换]' : ''}「${hit.unit.slice(0, 12)}」×${hit.count}/${Math.round(hit.share * 100)}%`).join(' ')

    const step = describeStep(session, message)
    if (step.calls.length > 0 && !cfg.foldToolSteps) {
      s.seen.add(seq)
      dbg(`命中但跳过 seq ${seq}（含工具调用，foldToolSteps=false）：${detail}`)
      continue
    }
    // ⚠️ 配对不完整时**不记 seen**：等结果落进 surface 之后的下一次 pre-step 再剪。
    const plan = planSpan({ nodes: Array.from(session.surface.nodes), eventAt: (q) => session.eventAt(q) }, seq, step.calls.length)
    if (!plan.ok) {
      dbg(`命中但本步还不能剪 seq ${seq}（${plan.why}${plan.have === undefined ? '' : ` ${plan.have}/${plan.need}`}）：${detail}`)
      continue
    }
    if (cfg.dryRun) {
      s.seen.add(seq)
      dbg(`DRY-RUN 命中 seq ${seq}：${chars} 字符 span=${plan.span.length} 节点 ${detail}`)
      continue
    }
    const note = step.calls.length === 0
      ? cfg.note
      : buildFoldNote({
        unit: hits[0].unit,
        count: hits[0].count,
        share: hits[0].share,
        text: step.text,
        results: plan.span.slice(1).map((rs, i) => describeResult(session, rs, step.calls[i]))
      }, cfg)
    try {
      // 用**核心**事件类型做等价替换（`user/message` + surfaceOp replace + sourceEventSeqs）。
      // 只有核心类型才能持久化：自定义事件类型在进程内没法带 `ignorable` 标记，加载器会拒绝。
      session.append('user/message', {
        id: `thinking-guard-${seq}`,
        role: 'user',
        source: { kind: 'plugin:thinking-guard' },
        content: [{ type: 'text', text: note }]
      }, {
        surfaceOp: { op: 'replace', startSeq: plan.span[0], endSeq: plan.span[plan.span.length - 1] },
        sourceEventSeqs: plan.span
      })
      for (const shadowed of plan.span) live.delete(shadowed)
      s.seen.add(seq)
      s.folds += 1
      s.chars += chars
      dbg(`已折叠 seq ${seq}（${plan.span.length} 节点 / ${chars} 字符）：${detail}`)
      ctx.logger?.info?.(`[${name}] 折叠 seq ${seq} 的退化思考（${plan.span.length} 节点 / ${chars} 字符）：${detail}`)
    } catch (error) {
      s.seen.add(seq)
      dbg(`折叠失败 seq ${seq}：${String(error)}`)
      ctx.logger?.warn?.(`[${name}] 折叠失败（已忽略，不影响本步）：${String(error)}`)
    }
  }
}

export function apply(ctx, config = {}) {
  if (typeof config.debugFile === 'string' && config.debugFile.length > 0) DEBUG_FILE = config.debugFile
  dbg(`apply 被调用：enabled=${config.enabled}`)
  // 重启验证用：这一行能区分"新代码上了没有"（旧版没有它）。
  dbg(`v2 判据（短句轮换）：${config.rotationGuard === false ? '关' : '开'}`
    + `（阈值 极短句≥${typeof config.shortShareMin === 'number' ? config.shortShareMin : 0.35}`
    + ` / top5≥${typeof config.topUnitShareMin === 'number' ? config.topUnitShareMin : 0.5}）`)
  if (config.enabled === false) return

  const cfg = {
    minChars: Number.isSafeInteger(config.minChars) ? config.minChars : 400,
    minRepeats: Number.isSafeInteger(config.minRepeats) ? config.minRepeats : 25,
    maxUnit: Number.isSafeInteger(config.maxUnit) ? config.maxUnit : 30,
    tailChars: Number.isSafeInteger(config.tailChars) ? config.tailChars : 4000,
    minShare: typeof config.minShare === 'number' && config.minShare >= 0 ? config.minShare : 0.20,
    // v2（短句轮换）默认开；阈值取实测分界的中点：
    // 3 个真样本 topUnitShare = 0.53 / 0.63 / 0.71，12,203 个正常英文块最高只到 0.41。
    rotationGuard: config.rotationGuard !== false,
    shortShareMin: typeof config.shortShareMin === 'number' ? config.shortShareMin : 0.35,
    topUnitShareMin: typeof config.topUnitShareMin === 'number' ? config.topUnitShareMin : 0.50,
    foldToolSteps: config.foldToolSteps !== false,
    digestChars: Number.isSafeInteger(config.digestChars) ? config.digestChars : 200,
    digestArgs: Number.isSafeInteger(config.digestArgs) ? config.digestArgs : 160,
    maxDigests: Number.isSafeInteger(config.maxDigests) ? config.maxDigests : 4,
    textChars: Number.isSafeInteger(config.textChars) ? config.textChars : 200,
    includeSubagents: config.includeSubagents !== false,
    dryRun: config.dryRun === true,
    note: typeof config.note === 'string' && config.note.length > 0 ? config.note : DEFAULT_NOTE
  }
  /** session -> { seen:Set<seq>, folds:number, chars:number } */
  const state = new WeakMap()

  // ⚠️ 必须走中间件形状：每条 return 路径都要 next()（漏调会让全机会话哑火）。
  // ⚠️ 不能挂 `session/event`：Session.append 拒绝在别的 append 正在发布时重入。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      const session = agent?.session
      if (session !== undefined && !signal?.aborted && (cfg.includeSubagents || !isSubagent(agent))) {
        sweep(ctx, session, cfg, state)
      }
    } catch (error) {
      dbg(`sweep 失败：${String(error)}`)
      ctx.logger?.warn?.(`[${name}] 扫描失败（已忽略，不影响本步）：${String(error)}`)
    }
    return next()
  })
}
