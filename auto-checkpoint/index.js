/**
 * dsh-auto-checkpoint — token-pressure watchdog: at a configurable threshold
 * it asks the model to write a project checkpoint file, then (optionally)
 * creates a new session seeded with a continue instruction and parks the old
 * session so it stops consuming context.
 *
 * Mechanism (verified against DSH 0.1.5-rc.2 sources):
 * - `agent/pre-step` waterfall (same seam as stock time-context /
 *   compaction-basic) runs before each step's model request.
 * - `ctx.tokenMeter.measure(agent.session).totalTokens` prices the current
 *   session surface (heuristic 4-char/token unless a routed adapter reports
 *   real usage).
 * - Crossing `triggerTokens` appends one durable plugin-sourced user message
 *   asking the model to write `<checkpointPath>` (project state, fixed bugs
 *   and causes, active plan, next step). The file lands through whatever
 *   tool the model uses (write / bash / …).
 * - Each later pre-step stats the checkpoint path (cost: one stat call per
 *   step). Once the file exists and is non-empty the plugin transitions to
 *   handoff. This detection is tool-agnostic: it does not depend on which
 *   tool wrote the file.
 * - Handoff (only when `autoNewSession` and `ctx.sessionController` exist):
 *   pauses the old session's active goal, marks the session `handoff-pending`
 *   (further steps are rejected), waits for the agent to go idle, creates a
 *   new session rooted at the same cwd with the same agent preset, hands the
 *   parent's permission preset and model selection down to it, admits the
 *   continue prompt as its first queued message, then marks the old session
 *   `parked`.
 * - A parked (or handoff-pending) session reopens ONLY on a genuine human
 *   message. Automatic continuations — goal-round-driver rounds, background
 *   job notices, subagent reports — are rejected: a session-scoped goal keeps
 *   queueing one round per quiescence, so mistaking a round for "the user is
 *   back" un-parks the old session and lets it work beside its own successor
 *   (observed in the wild: 20 more minutes of concurrent edits in the same
 *   workspace before the user stopped it by hand).
 * - While the checkpoint is pending, a short reminder is injected every
 *   `remindEverySteps` steps, so a stalled write cannot silently balloon the
 *   window toward the edge.
 * - Post-compaction re-anchor (2026-10-06): a successful `compaction/end`
 *   leaves the session holding only a summary — the workspace document map,
 *   the checkpoint's contents and every logged pitfall are gone from its
 *   context. The next pre-step therefore appends one plugin-sourced user
 *   message telling the model to re-read its checkpoint file and the workspace
 *   `AGENTS.md` before continuing. Three guards: a sequence window
 *   (`REANCHOR_WINDOW`) so a restart cannot re-anchor ancient compactions, a
 *   `compactionId` dedup, and the `reanchorAfterCompact` switch.
 * - Image watermark (2026-10-14, user-decided): a session's inline image bytes
 *   are a SECOND, independent way to die — 22 images / 21.76 MB was enough to
 *   make the upstream stop emitting for five minutes (`pi-ai stream idle
 *   timeout`), with **no HTTP error at all**. So a session whose accumulated
 *   image bytes cross `IMAGE_WATERMARK_MB` (16, built in) counts as "at the
 *   threshold", in parallel with the token gate:
 *     · marked `auto` in the panel ⇒ auto-compact (compaction halves image bytes);
 *     · not marked                 ⇒ the ordinary handoff chain (ask for a
 *       checkpoint → confirm the file → new session) — never a second mechanism.
 *   The total is read from `dsh-image-budget`'s live shared state
 *   (`globalThis[Symbol.for('dsh-image-budget.shared')]`); with that plugin
 *   absent the watermark silently never fires. One switch only —
 *   `imageWatermark` — because some upstreams have no image limit at all.
 *
 * Config (cordis.patch.yml) — static defaults:
 *   triggerTokens:   number   — pressure threshold in tokens (default 300000)
 *   taskBoundaryTokens: number — 任务边界水位（默认 150000）：完成一个 todo 任务、
 *                              且压力过这条线就交接。**可在面板上调**；
 *                              0 = 关闭该行为，退回纯阈值模式。
 *   checkpointPath:  string   — workspace-relative path (default
 *                               "checkpoint.md"); absolute paths accepted
 *   autoNewSession:  boolean  — true (default): hand off and park; false:
 *                               checkpoint only, session keeps running
 *   continuePrompt:  string   — first message fed to the new session
 *   remindEverySteps: number  — reminder cadence while checkpoint pending
 *                               (default 3)
 *   imageWatermark:  boolean  — true (default): the built-in 16 MB image
 *                               watermark joins the "at the threshold"
 *                               decision; false: token pressure only (for
 *                               upstreams that have no image limit)
 *
 * Runtime overrides (live, no restart):
 *   The web half (injected into the dsh-cost-whale menu) reads and writes
 *   `$DSH_HOME/auto-checkpoint.json` (`~/.dsh` by default):
 *     { "triggerTokens": 300000, "autoNewSession": true, "enabled": true,
 *       "imageWatermark": true }
 *   The plugin holds these in memory and re-reads them atomically on every
 *   write, so slider changes apply to the very next step. The static patch
 *   config is the fallback default when the file is absent or a field is
 *   missing. All fields are optional; unknown fields are ignored and never
 *   persisted back.
 *
 * Web surface (only when a `webServer` service exists, e.g. the web profile):
 *   - GET  /dsh-auto-checkpoint/state?sessionId=… — runtime config + current
 *     session pressure.
 *   - POST /dsh-auto-checkpoint/config               — merge { triggerTokens,
 *                                                            taskBoundaryTokens,
 *     autoNewSession, enabled } into the runtime config and persist.
 *   - GET  /dsh-auto-checkpoint/widget.js            — the in-page panel
 *     script (renders inside the dsh-cost-whale menu, no new chrome). The
 *     script is idempotent: repeated taps never duplicate the panel.
 *
 * Known limitations (stated, not hidden):
 * - The token meter is heuristic (4 chars ≈ 1 token; CJK underpriced) —
 *   keep a margin below the model's real limit.
 * - Handoff depends on `ctx.sessionController` (mounted by the web-app
 *   bundle). Without it the plugin degrades to checkpoint-only and logs a
 *   notice.
 * - The checkpoint file is produced by the model; the plugin never
 *   fabricates it. A session whose model refuses to write parks with
 *   reminders rather than growing silently.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { stat, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'auto-checkpoint'

/** Dev-only: the raw in-page panel script (syntax-checked by the test suite). */
export const _buildWidgetJs = buildWidgetJs

/** Host services this plugin requires. */
export const inject = ['agents', 'tokenMeter']

const DEFAULT_TRIGGER = 300_000
const DEFAULT_PATH = 'checkpoint-{{session}}.md'

/**
 * 任务边界触发的水位线（2026-09-21 新增）。
 *
 * ── 为什么加它 ──
 *
 * 原来的唯一触发是 `triggerTokens`（压力阈值）。它的问题不是"不灵"，
 * 而是**交接点落在哪不由任务结构决定**：阈值可能在任务做到一半时越线，
 * 于是接力棒在"改了三行、还没跑测试"的位置交接 —— 下一棒要重新建立现场。
 *
 * ── 怎么判断"任务边界"：只用真实信号，不猜 ──
 *
 * 读会话里的 `todo/write` 投影，当列表从"有 in_progress"变成
 * "全部 completed"时，就认为刚刚完成一个任务。
 *
 * 试过/想过但**刻意不用**的信号（都会误判）：
 *   · `turn/end`      —— 每次助手回话都触发，太频繁
 *   · "工具调用变少"  —— 没有可靠基线
 *   · 模型自述"做完了" —— 不可靠（模型经常说做完其实没做完）
 *
 * ── 为什么门槛低于 triggerTokens ──
 *
 * 任务边界是**更优的交接时机**，所以愿意提早交接：
 * 默认压力过 150k 就写，而不是等到 300k/380k。
 * 代价是多写几份检查点（每份几 KB），换来的是**交接点落在任务边界上**。
 *
 * 设为 0 或负数即关闭，退回"只看阈值"的旧行为。
 */
const DEFAULT_TASK_BOUNDARY_TOKENS = 150_000

// 接棒指令（2026-09-20 改写，起因：用户反馈"关键点被接棒 AI 忽略导致重复劳动"）。
//
// 旧版只说「先做检查点里写的"下一步"」——它把注意力直接引向文件末尾，
// 而真正值钱的内容在**中段**（实测某份检查点：★★关键突破在 10% 处、
// ★★已修复缺陷在 35% 处、**已知坑在 94% 处**）。结果接棒 AI 只抓"下一步"，
// 中段的坑与约束被漏掉，于是重复踩坑、重复劳动。
//
// 新版做三件事：
//   1. 明确要求「从头读到尾，不要只读下一步」；
//   2. 点名必须重点看的四类内容（★章节 / 已知坑 / 已修复缺陷 / 未决事项）；
//   3. 要求**先复述再接活**——复述是让"读到了"变成可验证的动作，
//      接棒 AI 若漏读，复述里就会缺项，用户一眼能看出来。
//
// 2026-10-02 补第 ⑤ 条。起因是 AGENTS.md 记着的一起**真实事故**：
//   一条关键更正只写在**更早**那份检查点里、最新那份没写 ——
//   接棒的 AI 只读了最新一份 ⇒ 得出**反向结论** ⇒ 一整棒白干。
// 而本指令此前只说「完整读取 {{path}}」（**单数一份**），
// 可同一目录下实测已积累几十份 `checkpoint-*.md`（`{{session}}` 展开保证互不覆盖）。
// 所以缺口是：**接棒的人不知道"还有更早的"**。
// 这里**只加提示、不加机制** —— 告诉它"还有更早的、什么情况下该往前翻"，
// 翻不翻、翻几份由它按需判断（避免为了极少数情况强制定向全量检索）。
const DEFAULT_CONTINUE =
  '这是新会话，你接手一个已经在进行中的任务。\n' +
  '请先**完整读取** {{path}}（项目状态检查点）——**从头读到尾，不要只读"下一步"那一节**。\n' +
  '读的时候重点抓这六类内容：\n' +
  '  ① 标 ★ 的章节（那是上一棒认定的重点）；\n' +
  '  ② **已知坑**（继续遵守，别重蹈覆辙）；\n' +
  '  ③ **已修复的缺陷**（别当成没修又去修一遍）；\n' +
  '  ④ **未决事项 / 待办**（哪些还没做、卡在哪）；\n' +
  '  ⑤ **更早的检查点**（别只看这一份）：同目录下可能还有更早的 `checkpoint-*.md`，\n' +
  '     关键更正有时只写在更早那份里 —— 只读最新一份会得出反向结论（真发生过）。\n' +
  '     先 `ls checkpoint-*.md` 看有几份；凡是你**要依赖的结论**、或本份标了\n' +
  '     "已作废 / 已推翻"的地方，用 grep 往前核一遍（`grep -rn "关键词" checkpoint-*.md`）。\n' +
  '  ⑥ 🛑 **检查点只给「状态」，项目的「经验」在别处 —— 不是只读检查点就够了**\n' +
  '     （2026-10-06 新增。起因是一起**真实事故**，见下）。\n' +
  '     `checkpoint-*.md` 是**接力状态**（这一棒到哪了）；项目的**长期经验**\n' +
  '     通常在另外的地方：`任务单/`、`HANDOVER.md`、`事实总表.md`、`03-工具/`、`docs/` 之类。\n' +
  '     ⇒ 动手前先 `ls` 项目根目录，找到**文档地图**（AGENTS.md 里的地图段 / HANDOVER.md / README.md），\n' +
  '       再按关键词检索**整个项目**，不要只检索检查点：\n' +
  '         grep -rn "关键词" --include="*.md" . | head -40\n' +
  '     ⚠️ 只 `grep -rn "…" checkpoint-*.md` 的后果：接棒的人连 `ls 任务单/` 都不会做。\n' +
  '       事故：session-c41a9661（千星2D，2026-10-06）把 `任务单/T-AX_*.md` 里**早已写好的**\n' +
  '       「节点库搜索框」「把编辑器自己写的节点整条抄成模板」「编辑器回存时丢边」\n' +
  '       重新摸了 2.2 小时，最后一句话都没汇报就被用户掐断。\n' +
  '  ⑦ ⭐ **看第 9 节「已读水位线」**（2026-10-09 新增，起因是一起真实事故）：\n' +
  '     检查点里有一份"上一棒**读过 / 没读过**哪些权威文档"的清单。\n' +
  '     ⇒ 把**你自己这一棒要用到的子系统**与那份"已读"清单对一遍：\n' +
  '       **凡是你要引用其结论、而清单里标着"未读"的文档，先读它再开口。**\n' +
  '     ⚠️ 事故（2026-10-09）：上一棒被问到"急停阀 + 压缩"，它**没打开**写这件事的\n' +
  '       `loop-lab/guard-test/RESULT.md`，凭记忆引用了一句写死的旧结论「压缩治不了」，\n' +
  '       去**反驳用户** —— 而用户是实测过的，**用户对、它错**。\n' +
  '       根因不是"没写下来"，是"**写了没读**"（那份文档一直在那儿）。\n' +
  '       ⇒ **引用任何结论都要带上它的日期与适用边界**；结论会随实测变，注释不会。\n' +
  '  ⑧ ⭐ **该开 goal 就自己开**（2026-10-11 新增，用户点名要求）——\n' +
  '     `goal` **不跨会话**：交接时上一棒的 goal 已被插件**主动 pause**，\n' +
  '     你**不开就没人续跑**（实测：不写这条时，接棒会话的 goal 就是 `null`）。\n' +
  '     判据（**两条都满足才开**）：① 本棒的"下一步"要**跨多轮**才做得完\n' +
  '     （不是"改一行再验证"这种一两次就收的）；② 目标能写成**一句可验收的话**。\n' +
  '     ⇒ 用 `create_goal`，objective **写窄、写成能做完的**，别写"治理所有插件"这种无边界的。\n' +
  '     ⚠️ 短活**不要**开：goal 会让会话在每轮结束后**十几毫秒就自动接着跑**，\n' +
  '        既烧 token，也让自动压缩/自动交棒更难找到空闲窗口。\n' +
  '读完先做两件事，再开始干活：\n' +
  '  · **逐项点名**回答下面三问（各一两句，别跳过任何一问）：\n' +
  '      (1) 当前状态是什么？\n' +
  '      (2) 有哪些**已知坑 / 约束**必须遵守？把它们**一条条列出来**。\n' +
  '      (3) 哪些缺陷**已经修好了**（我不该再修一遍）？\n' +
  '  · 再用**一行**回答：**本项目的经验档案在哪几个目录、你翻了哪几个**\n' +
  '     （一个都没翻就照实写"没翻"——这一行是给用户看的漏读信号）。\n' +
  '  · 然后按检查点里的"下一步"继续，不要重新问已经记录过的问题。'
const DEFAULT_REMIND_EVERY = 3

/**
 * 「压缩提醒」默认阈值（2026-10-07 加，用户点名）。
 *
 * 与 `triggerTokens` 是**两件事**，刻意分开：
 *   · triggerTokens  —— auto-checkpoint 自己的动作阈值（让 AI 写检查点 → 换会话）；
 *   · remindTokens   —— **只提醒用户**"该手动压缩了"，不做任何自动动作。
 * 用户原话：「某些会话确实有压缩起来继续的价值，跟任务单流派的是不同的情况……
 * 可以手动设置当前会话多少字之后应该压缩，或者提醒我，我来手动压缩也行，
 * 比如设置成 400k 上下文的时候触发」。
 *
 * 0 = 关闭提醒（与 taskBoundaryTokens 同一套口径：下界是 0，不是 1000）。
 */
const DEFAULT_REMIND_TOKENS = 400000

/**
 * 「图片水位」到点动作（2026-10-14 新增，用户拍板）。
 *
 * 为什么要有它：杀死会话的不只是 token 压力 —— 实测 `session-9a3f526f` 只读了 **22 张图、
 * 共 21.76 MB**，请求体每轮重发 ~29 MB，上游 5 分钟一个字都不吐（`pi-ai stream idle timeout`）
 * **沉默卡死**，而且**连 400 都不给**（看起来就像"莫名不动了"）。那时 token 水位还远远没到
 * ⇒ 这条线必须与 token 压力**并列**，而不是等 token。
 *
 * 水位**内置 16 MB**（与 `dsh-image-budget` 的 `warnMb` 一致）：用户明确要求"不要他配数字"，
 * 只留一个总开关 `imageWatermark`（有些 api 没有这种限制 ⇒ 可以关掉）。
 *
 * 到点动作（**复用既有两条路，不新增机制**）：
 *   · 会话被标记成 `auto`（面板"到点自动压缩"）⇒ **自动压缩**（与压力门并列，见 autoCompactAfterTurn）；
 *   · 没被标记 ⇒ 走既有交棒链路：催写检查点（`watching → requested`）→ 确认文件 → 换新会话。
 *
 * ⚠️ 边界（诚实写下来，别指望它治所有情况）：判定发生在 **`turn/end` / `pre-step`**，
 *    所以只在"会话还能正常收尾"时有效；已经沉默卡死的会话不会因为这条线自己活过来。
 */
const IMAGE_WATERMARK_MB = 16
const IMAGE_MB = 1024 * 1024
/** `dsh-image-budget` 把实时态挂在这个符号上（同进程 ⇒ 直接读，不必走 HTTP）。 */
const IMAGE_BUDGET_SHARED_KEY = Symbol.for('dsh-image-budget.shared')

/**
 * 该会话当前累计的图片体积（MB），读 `dsh-image-budget` 的**实时内存态**。
 * 插件不在场 / 没有这条会话 / 结构变了 ⇒ 返回 0（= 图片水位永不触发，**安全退化**）。
 */
function imageMbOf(sessionId) {
  try {
    const shared = globalThis[IMAGE_BUDGET_SHARED_KEY]
    const st = shared?.sessions?.get?.(sessionId)
    const bytes = Number(st?.bytes)
    return Number.isFinite(bytes) && bytes > 0 ? bytes / IMAGE_MB : 0
  } catch {
    return 0
  }
}

/**
 * 「按会话」的处理方式（2026-10-07 第二次改，用户拍板）。
 *
 * 第一版是「全局阈值 + 每个会话都弹横幅」，用户当场指出这是设计错误：
 * 「我只是想在有值得记忆全文的会话才压缩啊……我要是切到其他会话，那不是又得弹给我」。
 * ⇒ 改成**默认全关**，只有用户手动标记过的会话才有行为，取值：
 *   · 不写这个键（默认）  —— 什么都不做，切过去完全安静；
 *   · 'remind'          —— 到阈值在页面右上角弹提醒，我不动手；
 *   · 'auto'            —— 到阈值直接调 `/compact`（用户拍板选的就是这个），
 *                          压完由 2.2.5 的「压缩后自动接棒」接力。
 * 存在 `$DSH_HOME/auto-checkpoint.json` 的 `sessionModes` 里（key = 会话 id）。
 */
const SESSION_MODES = ['remind', 'auto']

/** 只保留合法的会话模式，其余键一律丢弃（手改坏了也不会让整个配置失效）。 */
function normalizeSessionModes(raw, fallback) {
  const base = fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...base }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (!SESSION_MODES.includes(value)) continue
    out[key] = value
  }
  return out
}

/**
 * 自动压缩的冷却时间：同一个会话失败/成功后，这段时间内不再自动触发。
 *
 * 为什么需要它：判定挂在 `agent/pre-step`（每个 step 都跑）。压缩会跑 30 秒左右，
 * 期间/之后就可能有几十个 step —— 没有冷却的话，一次失败会被无限重试，
 * 每次都是一次真实的上游请求（今天已经见过两种失败：渠道 503、prompt 过长）。
 * 10 分钟足够让"压力真的降下来"（成功）或"用户看到失败去处理"（失败）。
 */
const AUTO_COMPACT_COOLDOWN_MS = 10 * 60 * 1000

/**
 * 连续失败到第几次就停手（2026-10-07 加，用户拍板「加保险」）。
 *
 * 为什么必须有：压缩失败**跟"自动还是手按"无关**，只取决于压缩那一刻这条会话用的模型窗口
 * —— 实测同一条会话在 10 万窗口的模型上直接 `prompt is too long: 100001 > 100000`，
 * 换大窗口就压得动（25 万、17.7 万都成功过）。而失败后压力仍超阈值，于是每过一个冷却期
 * 就再发一次**真实请求**，用户完全看不见。
 * 降到 2 次即改为 `remind`：最坏多烧 1 次请求就停手，并把原因写进会话让用户看见。
 */
const AUTO_COMPACT_MAX_FAILS = 2

/**
 * `turn/end` 之后等多久再压（2026-10-07 第三次改）。
 *
 * 为什么要有延迟：回合落盘 ≠ 内部状态全部释放，立刻压仍可能撞上
 * "the agent is not idle"。1.5 秒是余量，不是精调值。
 */
const AUTO_COMPACT_IDLE_DELAY_MS = 1500

/**
 * 「等一个真空闲窗口」的轮询参数（2026-10-08 加，用户拍板 A+B 一起做）。
 *
 * 🛑 为什么固定延迟不够（真实事故 `session-a63ff73e`，用户报「到阈值了也不压缩」）：
 * 那条会话开着 **goal 模式**，`turn/end` 之后 **16 毫秒**就冒出新的 `turn/start`
 * （goal 自动续跑）⇒ agent **永远不进入空闲**，`/compact` 的准入检查必然拒绝。
 * 实测原话：`03:58:14.814 turn/end` → `03:58:14.830 turn/start`（+16ms）→
 * `03:58:16.316 command/run compact`（**+1.502 秒**，确认是插件自己发的）→
 * `03:58:16.317 command/done kind:'error'`「Compaction is unavailable because this
 * process has an active compaction, or the agent is not idle.」；而失败又把
 * `lastAutoCompactMs` 写上了 ⇒ 之后两次 `turn/end`（04:01、04:03）**在 10 分钟冷却里、
 * 连试都没试**，从用户那边看就是"死活不压"。
 *
 * ⇒ 改成**轮询等一个真正的空闲窗口**：靠 `lastTurnStartMs` 判断这期间有没有新回合冒出来，
 * 有就**继续等、一次都不试**（不刷日志、不烧请求）；没有才动手。
 * goal 总会停下来（跑完 / 等用户输入 / 被打断），**那一刻就是窗口** —— 这是这条路的
 * 确定性来源，而不是"多试几次碰运气"。
 */
const AUTO_COMPACT_POLL_INTERVAL_MS = 2000

/**
 * 轮询最多等多久就放弃（默认 5 分钟），交给下一个 `turn/end` 重新开始。
 * 为什么必须有上限：goal 连续跑几小时不停时，不能让一个待办在内存里永远挂着。
 */
const AUTO_COMPACT_MAX_WAIT_MS = 5 * 60 * 1000

/**
 * 「本地准入拒绝」的识别式（2026-10-08 加，A+B 里的 A）。
 *
 * 官方原文：`Compaction is unavailable because this process has an active compaction,
 * or the agent is not idle.`
 *
 * 🛑 为什么要单独认它：这种失败**不是压缩失败** —— 它连上游请求都没发（本地 admission
 * 直接拒），所以 ① 不该占 10 分钟冷却（否则像 `session-a63ff73e` 那样：试一次被拒，
 * 之后两次 `turn/end` 全在冷却里、连试都不试，用户看到的就是"死活不压"）；
 * ② **绝不能计入 `AUTO_COMPACT_MAX_FAILS`** —— goal 会话的 turn 之间只隔 16 毫秒，
 * 它必然连吃两次 busy，那样两次就被降级成 `remind`，而根因根本不在这条会话身上。
 */
const AUTO_COMPACT_BUSY_RE = /not idle|Compaction is unavailable|active compaction/i

/**
 * 🛑 阀开火时**顺带压缩**（2026-10-09，用户拍板）。
 *
 * ── 为什么 ──
 * 急停阀（`loop-lab` 的 `escape-valve.mjs`）掐掉一回合之后，模型可见上下文里**那坨污染还在**。
 * 实测 `session-a63ff73e`：阀在 turn 140 开火时，上下文里躺着 **559 行**独立的「做。」
 * （turn 130 起累积；全会话 2418 行）。而阀开火（04:19:08）到下一轮真的起来（04:22:01）
 * 中间**空了 2 分 53 秒** —— 用户当场看到会话"突然停了"。
 * `thinking-guard` 与压缩**都只能跑在 `agent/pre-step`**，那段时间**谁也够不着**。
 *
 * 🛑 **别把这个空档说成"正好被利用的好窗口"** —— 我 2026-10-09 就这么误读过，
 * 是**用户当场纠正的**（原话：「其实是我手动压缩的……我看会话突然停了还以为是自动压缩
 * 机制触发了，这么久没压缩就手动压缩了」）。它是一次**卡顿**，不是设计出来的窗口。
 * 这一段的价值只在于说明：**阀掐完之后，确实存在一段"没有任何机制能清理"的空窗**。
 *
 * ── 顺带查清的两件事（2026-10-09 量的，别再猜）──
 * ① **自动压缩是在干活的**：拿"插件永远在 `turn/end + idleDelayMs(1.5s)` 开火"当签名量
 *    该会话 14 次 `command/run compact`，**10 次落在 1.5–2.4 秒**（人工的 4 次是 48s/52s/136s/3.4s）。
 *    ⚠️ **`source.kind` 不能用来判谁发的** —— 插件自己发的也标 `{kind:'user'}`（第 275–280 行注释有原话）。
 * ② 该会话**没有**被降级成只提醒（`AUTO_COMPACT_MAX_FAILS` 那条路没走），
 *    `~/.dsh/auto-checkpoint.json` 里它至今仍是 `auto`。用户感觉"很久没压缩"是**真实现象**，
 *    但成因是**压力门**：只有 `pressure ≥ remindTokens`（当时 380k）才压，两次成功之间隔几小时很正常。
 *    ⇒ 这也正是本改动要解决的：**阀开火是"污染重"而不是"token 多"，不该等阈值。**

 *
 * 更本质的一点：**压缩是被动的，只在 token 压力到 `remindTokens` 才动**，
 * 而"污染最重"与"token 最多"**不是同一个时刻**。阀开火是目前最好的"这个会话坏了"信号 ⇒
 * 拿它把压缩从"等阈值"变成"出事就清"。
 *
 * ── 为什么不需要跨插件耦合 ──
 * 阀已经把签名写进会话日志了（`turn/end.data.reason`）：
 *   `{kind:'aborted', reason:{kind:'hook', reason:'loop-valve: 检测到复读（「做」×26…）'}}`
 * 所以我们只**认这个签名**即可 —— 零耦合、零新 API、阀那边一个字都不用改。
 * ⚠️ 但**必须同时要求 `reason.kind === 'hook'`**：用户自己按「停止生成」也是 `aborted`，
 * 那种情况绝不能触发压缩（实测 `a63ff73e` 的 turn 141 就是 `reason:{kind:'user'}`）。
 *
 * ── 实测依据（2026-10-09 量的）──
 * 压缩**清得掉**污染：该会话 12 次压缩，凡有累积污染时压缩后都下降，最强一次 **43 → 0 且此后零复发**。
 * （同一天更正了一句写死的旧结论「压缩治不了」—— 它只对"刚生成的那一块"成立，见 preset 注释。）
 *
 * ── 怎么关 ──
 * · **全局**：把下面这个常量改成 `false`（**要重启 web**）。
 * 🛑 **按会话关掉的路已被 2026-10-09 的改动堵死**（原来这里写着"面板里改掉「到点动作」即可"——
 * 那句话**现在是错的**）：阀开火时会**越过** `sessionModes` 那道 opt-in 门。
 * 理由与代价写在调用点 `autoCompactAfterTurn` 的注释里（事故 `b8eb5ad8`）。
 * ⚠️ 且"到阈值自动压缩"与"阀开火压缩"共用这一个常量 ⇒ 关它就是全关。
 *
 * ── 已知限制（别当成没这回事）──
 * ① **`busy` 竞态**：闭包要求 `agent` 处于 `idle`（宿主 `runMaintenance` 的判据是
 *    `phase.kind !== 'idle'` 就抛 `already has active work`）。若阀的 `followup()` 真起了下一轮，
 *    压缩就赶不上，会重试 3 次后放弃。
 *    ✅ **2026-10-09 实测清了这条的底**：`followup` 在**普通 web 会话里不自动起下一轮**
 *    （`b8eb5ad8` 17:33:25 被掐断后 5 分钟零新事件，消息停在 inbox 等人点）⇒ 掐断后确实 idle、
 *    压缩来得及。**风险只在长驻/goal 会话**（那里 driver 会自己续跑）。
 * ② 那次从阀掐断到下一轮起来中间空了 2 分 53 秒 —— 🛑 **但那是"用户手动压缩"造成的一次卡顿、
 *    不是"正好送上门的好时机"**（见上文 2026-10-09 的更正）。空窗确实存在，**不保证每次都这样**。
 * ⇒ 它是 `thinking-guard` 的**补充**（guard 清"最新那一块"，它清"历史累积"），**不是替代品**。
 */
const AUTO_COMPACT_ON_VALVE_ABORT = true

/**
 * 这次 `turn/end` 是不是**急停阀**掐的？
 * 只认阀自己写进日志的那条签名（见上），**不认插件实例、不做跨插件调用**。
 */
function isValveAbort(event) {
  const r = event?.data?.reason
  if (r?.kind !== 'aborted') return false
  const inner = r.reason
  return inner?.kind === 'hook' && /loop-valve/.test(String(inner?.reason ?? ''))
}

/**
 * **最近一次「阀开火之后插件做了什么」**（2026-10-09，治"插件在动作、但用户看不见"）。
 *
 * ── 为什么要它 ──
 * 事故 `b8eb5ad8`：阀 17:33:25 掐断该会话，但压缩因为 `sessionModes` 那道门**一声不响地没跑**，
 * 用户看到的只有"阀掐了，然后什么都没有"，来问「你不是说搞了吗」。
 * 而这已经是**同一个月里第三次**因为"动作不可见"被问（前两次：「很久没压缩」、本次）。
 * ⇒ 光让功能生效不够，**得让"它做了/没做/为什么"看得见**。
 *
 * ── 形态 ──
 * 只留**最近一条**、只活在内存里（进程重启即清）。它是"刚才发生了什么"的提示，不是账本；
 * 想查历史去会话日志（那里有 `turn/end` 与 `compaction/*` 的完整事件）。
 * 消费方两处：`GET /dsh-auto-checkpoint/state`（返回 `lastValveAbort`）、面板的提示条。
 *
 * @type {{sessionId: string, at: number, reason: string, stage: string, detail: string, updatedAt: number} | null}
 */
let lastValveAbort = null

/**
 * 给上面那条记录推进一个阶段（`stage` 取值即"卡在哪一步"的诊断口径）。
 * ⚠️ 只在**本次记录的会话**上生效，且一旦到了终态（`done`/`error`）就不再改写 ——
 * 免得后面前一个会话的迟到分支把新会话的记录写花（阀开火是串行的，但压缩是异步的）。
 */
function noteValveStep(sessionId, stage, detail) {
  if (lastValveAbort === null || lastValveAbort.sessionId !== sessionId) return
  if (lastValveAbort.stage === 'done' || lastValveAbort.stage === 'error') return
  lastValveAbort.stage = stage
  if (typeof detail === 'string') lastValveAbort.detail = detail
  lastValveAbort.updatedAt = Date.now()
}

/**
 * 撞上「本地准入拒绝」后，还允许在同一个 turn/end 里再试几次（2026-10-08）。
 *
 * 为什么不是无限重试：轮询的全部价值在于"**等 goal 停下来**"——那个判据是精确的时间戳比较。
 * 而 `busy` 说明我们判断"空闲"判断错了，再轮下去只是碰运气，还会把 command/run + command/done
 * 往会话日志里刷。所以最多再试 3 次就收手，交给下一个 `turn/end`
 * （goal 会话每轮都会触发一次，机会多得很）。
 */
const AUTO_COMPACT_BUSY_RETRIES = 3

/**
 * 「压缩前落档」—— 压缩之前先让模型把现状写进工作区（2026-10-09 加，用户拍板走 B 方案）。
 *
 * 🛑 存在理由（用户原话：「压缩之后遗忘的太狠了，是不是应该让会话压缩之前先写一个
 * checkpoint 或者项目目前现状总结文档之类的东西？」）：
 *   本机 2026-10-09 量过压缩到底吃不吃信息（`a63ff73e` 的 12 次压缩，每次前后各取 3 步数污染）：
 *   **凡有累积污染时压缩后都下降，最强一次 43 → 0 且此后零复发** ⇒ **压缩不吃信息**。
 *   真正吃的是三件事：① 写了没读；② 错结论写死在"每轮都在"的地方（压缩后**主动骗下一棒**）；
 *   ③ **"我读过哪些文档"从不落档** —— 量化：`/root/4` 浅层文档 90 份，
 *   某次压缩后那一段**没读 815 KB**，其中四份正对着当时在推理的主题
 *   ⇒ 拿没读过的记忆重做已经写好的分析，还写出新错结论。
 *   ⇒ 所以这份落档**不是"交接给下一棒"**（那是 `checkpoint-<sid>.md` 的活），
 *     而是**写给压缩后的自己**：重点在第 ③ 条（我读过什么、结论是什么、来源在哪）。
 *
 * 🛑 为什么不能用交接那份文件：读者不同（下一棒 vs 同一个会话的自己）、生命周期不同
 *   （交接是一次性的、压缩是每 2 小时一次会覆盖）⇒ 独立文件 `precompact-<sid>.md`。
 *
 * ⚠️ 阈值倒挂是这条路的**前提**：`remindTokens`（压缩，默认 330k）必须**低于** `triggerTokens`
 *   （写交接检查点，450k）—— 否则上下文永远先被压回去，自动检查点永远不可能触发
 *   （2026-10-09 实测：当时 450k/330k 正是倒挂的，用户「压缩前写检查点」的提议
 *   在配置上**物理不可能**发生）。
 */
const PRECOMPACT_PATH_TEMPLATE = 'precompact-{{session}}.md'

/**
 * 催几次落档就放弃（默认 2）。
 * 为什么必须有上限：模型可能因为模型窗口/工具失败/直接忽略而**永远不写** ——
 * 没有上限就是"压力超了却永远不压缩"的死循环（比不落档更糟）。
 * 到次数仍没写 ⇒ **照压不误**，并在接棒消息里说明"这次没落档成功"。
 */
const PRECOMPACT_MAX_ASKS = 2

/**
 * Behaviour revision, surfaced by `GET /dsh-auto-checkpoint/state`. A running
 * web keeps the module it booted with, so this field is how an operator
 * confirms which revision is actually live (`patchReload: live` reloads
 * config, not host module code).
 */
const BUILD = '2026-10-14-image-watermark+precompact-v2+reanchor-note+abs-paths'

/**
 * 收尾前纠正「闷头干活不吐字」—— **2026-10-10 02:20 关闭**。
 *
 * 用户拍板原话：「textguard 是不是可以直接卸载了，没看出有什么意义纯纯帮倒忙，
 * 提醒了你也改不回来」。**用户是对的**，关闭依据（session-9e0eeced 真机时间线，
 * 逐条出自会话日志）：
 *   · 02:11:10 注入纠正（上一回合正文 24 字）→ 下一次收尾（02:13:30）正文仍是 **0 字**
 *     ⇒ 提醒零效果；运行时计数 `textGuardSeen=2 / nags=1`，第二次还被冷却挡下。
 *   · 这条注入是**立刻开新回合**的（走 `sessionController.prompt`）⇒ 每次 `turn/end`
 *     后 0 秒又 `turn/start` ⇒ **agent 永不空闲** ⇒ 02:13:31/33/35/37 用户那次
 *     `/compact` 四连败（`agent is not idle`），自动压缩同样拿不到窗口
 *     （410k token 压不下去，用户看到的就是"该压不压、手动也压不动"）。
 *
 * 根因早已量出来（见 OWNER.md「正文缺失」节）：正文缺失是**上下文体积**造成的输出抑制
 * （>215k 起、>250k 稳定），**不是"模型忘了写"**。提醒改变不了体积，只贡献副作用。
 * 正确解法 = 压缩水位降到 250k 让它**早点压缩**（压缩完输出立刻恢复正常）。
 * 想再开：改 `true` + 重启 web（机制代码 `turnTextSignal` / `remindVisibleText` 全部保留）。
 */
const VISIBLE_TEXT_GUARD = false
/** 一轮正文少于这么多字符 =「没说清」。一句引导语（"最后把它写进插件文档："）不算正文。 */
const VISIBLE_TEXT_MIN_CHARS = 120
/** 同一会话两次纠正之间的冷却：防"每次收尾都被叫回来"演成自我唤醒风暴。 */
const VISIBLE_TEXT_NAG_COOLDOWN_MS = 10 * 60 * 1000
/**
 * 同一个会话**连续**纠正的上限（2026-10-10 加，实测事故驱动）。
 *
 * 起因：guard2 一上线就把模型「**无限拉起来**」—— 阈值 120 字符、冷却 3 分钟，
 * 而模型每轮只写一句引导语（17 字符）⇒ 每次都判定"没说清" ⇒ 再提醒 ⇒ 下轮还是同样收尾。
 * **纠正机制本身没坏，缺的是刹车**：一个"就是写不长"的模型会被无限唤醒
 * （用户原话：「你一直无限被拉起来」）。
 * 到上限就停手（`counters.last.reason` 记 `gave-up(N)`）；等它某一轮真写够了，
 * 计数**自动清零**（说明它改好了，下次还有资格被纠正）。
 */
const VISIBLE_TEXT_MAX_NAGS = 3
/** 可观测（2026-10-10 加）：闸门被调用几次 / 真纠正过几次 / 最近一次为什么没纠正。 */

/**
 * rpcId prefix stamping this plugin's own queued continue prompts. The session
 * controller admits them as user-role messages, so the prefix is what tells
 * them apart from a message a human actually typed.
 */
const RPC_PREFIX = 'auto-checkpoint-'

/**
 * 🛑 **跨实例共享状态**（2026-10-10 加，实测事故驱动）。
 *
 * 事故：`agent/turn-stopping` 的"正文缺失"闸门把用户**一两分钟内连续拉起三次**，
 * 而 state 接口上的 `counters.seen` 却是 **0** ⇒ 进程里**不止一个插件实例**在跑：
 * 当晚改了十几次 `index.js`，每次改动都可能生成新 fiber，**旧 fiber 注册的钩子没被清理**。
 * 冷却在每个实例内部都有效 —— 但 N 个实例各注入一次，用户看到的就是「冷却根本不存在」。
 *
 * 影响面远不止这个闸门：`pendingCompacts` / `states` / 压缩冷却同样是模块级的
 * ⇒ **自动压缩与落档也可能被重复触发**。
 *
 * 所以把"必须全局唯一"的状态挂到 `globalThis` 上：无论加载了几个实例，都只用一份。
 * 键用 `Symbol.for`（跨模块实例稳定），名字带插件前缀以免和别的插件撞。
 */
const SHARED_KEY = Symbol.for('dsh-auto-checkpoint.shared')
const shared = (globalThis[SHARED_KEY] ??= {
  states: new Map(),
  recentAgents: new Map(),
  pendingCompacts: new Set(),
  lastTurnStartMs: new Map(),
  lastTurnEndMs: new Map(),
  turnTextSignal: new Map(),
  counters: { seen: 0, nags: 0, last: null, lastAutoCompactDecision: null },
})

/** 跨实例共享的计数器（见上面 SHARED_KEY 的注释）。 */
const counters = shared.counters

/** Runtime config file under $DSH_HOME. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CONFIG_FILE = join(DSH_HOME, 'auto-checkpoint.json')

/** Per-session state machine. */
const states = shared.states

/**
 * sessionId → 最近一次 `agent/pre-step` 看到的 agent 对象。
 *
 * 为什么需要：自动压缩改到 `turn/end` 之后执行（见 `autoCompactAfterTurn`），
 * 而 `session/event` 只给 session、**不给 agent**，`commands.execute` 却要 agent。
 * 每一步都覆盖写，所以拿到的总是最新的那个。
 */
const recentAgents = shared.recentAgents

/** 正在等"空闲窗口"的会话，防止一个回合的多个 turn/end 排出多次压缩。 */
const pendingCompacts = shared.pendingCompacts

/**
 * 每个会话**最近一次 `turn/start` 的时刻**（2026-10-08 加，A+B 里的 B）。
 *
 * 用途：判断"这个会话还活着吗"。goal 模式会在 `turn/end` 之后十几毫秒就开新回合
 * （实测 `session-a63ff73e` 是 +16ms），所以只要这个时间戳比某个 `turn/end` 新，
 * 就说明那次 turn/end 之后**会话又被续跑了**，此刻 agent 不空闲、压了也是白压（还刷日志）。
 * 反过来，时间戳没动 = 会话真静下来了 = 可以压。
 */
const lastTurnStartMs = shared.lastTurnStartMs
/**
 * 每个会话最近一次 `turn/end` 的**时刻**（2026-10-10 加，只给手动压缩闸门用）。
 *
 * 判据与 `lastTurnStartMs` 同理：用事件的 `time` 而不是"事件先后顺序"。
 *
 * 用途：闸门等落档**文件写出**之后，还要等落档那一轮**真正收尾**才放行压缩 ——
 * 模型写完文件是 tool-call，之后它还要回一句「落档完成」才 turn/end。
 * 那一瞬间 agent 不空闲 ⇒ `compactNow` 的本地准入必然拒绝。实测 `5bf1f15d`：
 * 文件 00:58:22 写出，之后 6 次放行全被拒，直到 00:58:34 的 turn/end 才一举成功
 * —— 界面上就是连跳 6 行红字（难看，且容易被误判成"插件坏了"）。
 */
const lastTurnEndMs = shared.lastTurnEndMs
/**
 * 最近一次**阈值压缩**的决定（stage + 详情 + 时刻 + 是否阀开火）—— 2026-10-10 加。
 *
 * 为什么需要：阈值压缩这条路**全程静默**（`note()` 原本只在阀开火时才写面板），
 * 所以"为什么没压"在外部**看不到**。排查 `session-7e73f1e7` 的 parked 死锁时，
 * 只能靠"会话日志里没有 command/run"倒推它卡在某道门里 —— 读不出是哪道门。
 * 现在由 state 接口的 `counters.lastAutoCompactDecision` 暴露（**只对这条会话返回**，与
 * `lastValveAbort` 同款纪律：别的会话的决定不该弹到你当前的窗口里）。
 */
/**
 * 「这个 turn 有没有正文」的累加器（2026-10-10 加）—— 收尾前纠正"闷头干活不吐字"。
 *
 * 为什么要它：模型（尤其在长任务里）会把结论全写进 reasoning，然后直接调工具、直接收尾，
 * 用户那边**只看到工具在跑、一个字都看不到**。实测这个毛病**不会自愈** ——
 * 用户 2026-10-10 明确要求别再拿"过一段时间机制生效就自动压缩"来解释（压缩"治好"它
 * 只是碰巧打断了那条长 turn）。而"我下次注意"= 靠自觉，本机 AGENTS.md 已经写明**实测失败**。
 * 所以判据落成结构：**整个 turn 一条正文都没有 ⇒ 收尾前注入一条纠正**。
 *
 * 字段 `{ turn, sawAssistant, textChars }`：
 *   · `sawAssistant=false` ⇒ 这一轮模型压根没开口（例如 pre-step 拒绝 ⇒ `turn/end blocked`），
 *     **不纠正** —— 它本来就没什么可说的。
 *   · `sawAssistant=true` 且 `textChars < VISIBLE_TEXT_MIN_CHARS` ⇒ 干了活却几乎没给用户看
 *     ⇒ **纠正**。（按**字符数**判，不是"有没有 text 块" —— 一句引导语也是 text 块。）
 */
const turnTextSignal = shared.turnTextSignal

/**
 * 「零正文快照」（2026-10-10 加）—— 把"整轮没写正文"那一刻的现场**当场**记下来。
 *
 * 为什么需要：这个问题排查了一整夜，**七个假设被事后数据逐个否掉**（行为习惯 /
 * 上下文体量 / preset 差异 / 格式模仿 / 渠道 / thinking-guard+压缩机制 / 长工具轮 /
 * 读别人会话日志）。症结就是"事后判别不了"——每次都要新写脚本重算历史，
 * 而**当时那一刻的现场早被压缩吃掉了**。
 *
 * 所以改成**当场捕获**：`turn/end` 时若本轮零正文，就把一份**宽快照**追加到
 * `~/.dsh/zero-text-snapshots.jsonl`。字段刻意记宽（含那晚想到的**和没想到的**），
 * 下次复发时直接对比"发病轮 vs 正常轮"的全字段，而不是再逐个假设去试。
 *
 * 🛑 **只写文件、绝不注入**：注入会开新回合 ⇒ 占住 agent ⇒ 压缩永远拿不到空闲窗口
 * （text-guard 就是这么把压缩堵死的，见 `VISIBLE_TEXT_GUARD` 的注释）。本机制零副作用。
 */
if (shared.zeroTextState === undefined) {
  // 兜底式补字段：热重载时 `shared` 可能是旧对象（没有这个键），必须自己补上。
  shared.zeroTextState = { shape: new Map(), turns: new Map(), bySession: new Map(), snapshots: [] }
}
const zeroTextState = shared.zeroTextState
/** 快照落盘路径（与 `auto-checkpoint-state.json` 同目录，便于一起看）。 */
const ZERO_TEXT_SNAPSHOT_PATH = join(homedir(), '.dsh', 'zero-text-snapshots.jsonl')
/** 形态窗口长度：最近多少条 assistant 消息参与"有无正文"形态统计。 */
const ZERO_TEXT_SHAPE_LEN = 20

/**
 * 在事件对象里找出 `usage.totalTokens`（浅层递归，深度受限）。
 *
 * 为什么要找而不是直接取：**`assistant/message` 的 message 里没有 usage**
 * （实测键只有 `content` / `id` / `role` / `source`，`message.usage` 为 null），
 * 真实用量挂在 `data` 的别处。写死路径会在换版本时静默变 0，所以按字段名找。
 */
function findTotalTokens(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return 0
  if (typeof value.totalTokens === 'number') return value.totalTokens
  for (const key of Object.keys(value)) {
    const found = findTotalTokens(value[key], depth + 1)
    if (found > 0) return found
  }
  return 0
}

/** 一条零正文回合的现场 → 内存（最近 5 条给 state 接口）+ 追加落盘。 */
function writeZeroTextSnapshot(record) {
  zeroTextState.snapshots.push(record)
  if (zeroTextState.snapshots.length > 5) zeroTextState.snapshots.shift()
  try {
    appendFileSync(ZERO_TEXT_SNAPSHOT_PATH, `${JSON.stringify(record)}\n`)
  } catch (error) {
    ctx.logger.warn(
      `[auto-checkpoint] zero-text snapshot write failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  ctx.logger.info(
    `[auto-checkpoint] 零正文快照已记录 ${record.sessionId} T${record.turn} ` +
      `(${record.maxTokens} tok / ${record.assistantMsgs} 条消息 / 本会话第 ${record.zeroTextTurnsInSession} 次)`,
  )
}

/**
 * `turn/end` 时判定并记录。判据与 text-guard 同源：**整轮零正文、但模型确实开过口**
 * （`sawAssistant=false` 是空回合，不算）。**无论是否零正文都推进 `turns` 环**，
 * 这样快照里能直接看到"发病前几轮"的样子。
 */
function snapshotZeroTextTurn(session, event) {
  const sessionId = session?.id
  if (typeof sessionId !== 'string') return
  const rec = turnTextSignal.get(sessionId)
  if (rec === undefined) return
  const turns = zeroTextState.turns.get(sessionId) ?? []
  const recentTurns = turns.slice(-6)
  turns.push({
    turn: rec.turn,
    textChars: rec.textChars,
    tokens: rec.maxTokens,
    msgs: rec.assistantMsgs,
  })
  if (turns.length > 12) turns.shift()
  zeroTextState.turns.set(sessionId, turns)
  if (rec.sawAssistant !== true || rec.textChars > 0) return
  const n = (zeroTextState.bySession.get(sessionId) ?? 0) + 1
  zeroTextState.bySession.set(sessionId, n)
  writeZeroTextSnapshot({
    at: new Date(Number(event?.time) || Date.now()).toISOString(),
    sessionId,
    turn: rec.turn,
    build: BUILD,
    maxTokens: rec.maxTokens,
    assistantMsgs: rec.assistantMsgs,
    reasoningChars: rec.reasoningChars,
    toolResultChars: rec.toolResultChars,
    tools: rec.tools,
    injects: rec.injects,
    injectChars: rec.injectChars,
    shape: (zeroTextState.shape.get(sessionId) ?? []).slice(),
    recentTurns,
    endReason: event?.data?.reason?.kind ?? null,
    zeroTextTurnsInSession: n,
  })
}

function stateFor(agentId) {
  let s = states.get(agentId)
  if (!s) {
    s = {
      phase: 'watching',
      reminderStep: 0,
      confirmedPath: null,
      reanchoredCompactionId: null,
      autoCompactFails: 0,
      // 「压缩前落档」的状态（2026-10-09）：何时催的、催了几次。
      // 用 0 而不是 undefined 当"没催过"，读的时候统一 `Number.isFinite()` 判断，
      // 这样旧会话（stateFor 早已建过、没有这两个字段）也能走同一条分支。
      preflightAtMs: 0,
      preflightAsks: 0,
    }
    states.set(agentId, s)
  }
  return s
}

/**
 * 「压缩后自动接棒」只认**刚发生**的压缩：
 * 从 `compaction/end` 那条事件到当前事件数不超过这个窗口。
 *
 * 为什么必须有这道窗口（而不是只看"最后一次压缩成功过"）：
 * 会话状态是内存态，web 一重启就空。若只按 compactionId 去重，重启后每个
 * **历史上压过一次**的会话，只要用户再发一句话，就会被塞一句"你刚被压缩过"——
 * 明明没压。窗口把"刚压完"和"很久以前压过"分开：压缩后紧接着的几步内
 * seq 差只有个位数，几十步之后就不可能再命中。
 */
const REANCHOR_WINDOW = 20

/**
 * Phases that quarantine a session: it has been handed off (or a handoff is in
 * flight), so no automatic work may be admitted again. Only these are written
 * to disk, because only their loss is a *safety* problem — they are what keeps
 * a handed-off session quiet. Losing 'resumed' or 'checkpoint-only' merely
 * re-arms automatic checkpointing, which is what a fresh web process has always
 * done and what a restart is understood to do.
 */
const QUARANTINED = new Set(['parked', 'handoff-pending'])

/** Quarantine file: read at module load, rewritten on every quarantine move. */
const STATE_FILE = join(DSH_HOME, 'auto-checkpoint-state.json')

/**
 * Restore quarantined sessions at module load — before `apply` registers any
 * hook, so a step arriving right after boot cannot slip past a gate that has
 * not been re-armed yet.
 *
 * `states` used to be in-memory only, which made every web restart drop the
 * park flag silently: a handed-off session came back as 'watching', and an
 * automatic injection (goal round, job notice, subagent report) could wake it
 * beside its own successor — the exact failure the park gate exists to stop.
 * Keys are `agent.id`, which the agent registry pins to the session id, so a
 * restored entry still matches the same session after a restart.
 *
 * A missing or unreadable file is not an error: it means nothing is quarantined.
 */
function restoreQuarantine() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
  for (const [agentId, record] of Object.entries(parsed)) {
    if (!QUARANTINED.has(record?.phase)) continue
    states.set(agentId, {
      phase: record.phase,
      reminderStep: Number.isInteger(record.reminderStep) ? record.reminderStep : 0,
      confirmedPath: typeof record.confirmedPath === 'string' ? record.confirmedPath : null,
      reanchoredCompactionId: null,
    })
  }
}

restoreQuarantine()

/** Parse one runtime config file entry; invalid values fall back to the base. */
function normalizeRuntime(raw, base, key) {
  if (raw === undefined) return base[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return base[key]
}

/**
 * Whether a claimed step carries a genuine human message. The UI submits
 * `source.kind === "user"`; this plugin's own continue prompt is also a
 * user-role message but is stamped with an `auto-checkpoint-…` rpcId, and
 * every automatic injection (goal rounds, job notices, subagent reports)
 * carries a source kind of its own. Only a real human reopens a parked
 * session — see the park gate in `agent/pre-step`.
 */
function claimedHumanMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const source = message?.source
    if (source?.kind !== 'user') return false
    return !String(source.rpcId ?? '').startsWith(RPC_PREFIX)
  })
}

/**
 * 落档催办文案的**固定开头** —— 与生成它的地方（`[auto-checkpoint] 上下文即将压缩（当前 …`）
 * 共用同一个常量：**改文案时两处一起改**，否则白名单会静默失效。
 */
const PRECOMPACT_NUDGE_LEAD = '[auto-checkpoint] 上下文即将压缩（当前 '

/**
 * 判断"这批待处理消息里是不是本插件的**落档催办**"（2026-10-11 加，用户拍板）。
 *
 * 为什么要它：落档催办是插件自己注入的，`rpcId` 带本插件的 `RPC_PREFIX` ⇒ 被
 * `claimedHumanMessage` 判成"非真人" ⇒ 撞上 **park 门**被 `reject`。实测 `8ec526d7`：
 * 07:09:48 / 07:09:50 两次催办**全被拒**（`turn/end {"kind":"blocked"}`）⇒ 落档永远写不出来
 * ⇒ 压缩只能**跳过落档直接压**，用户看到的就是"没头没尾"。
 *
 * 为什么放行它是安全的：催办只要模型**写一份 md 然后就停**，不会造成 park 门真正要防的
 * 那件事（两个会话**并发改同一个项目**）；而且它**只发生一次**（写完就压）。
 *
 * ⚠️ 识别必须**按内容**，不能只按 `rpcId` 前缀 —— re-anchor、正文提醒等注入**共用同一个
 * 前缀**，只按前缀放行等于把 park 门废掉。结构不符时**返回 false**（退回原行为=拒绝），
 * 所以这里判错只会让落档写不成，不会让不该跑的回合跑起来。
 */
function claimsPrecompactNudge(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const source = message?.source
    if (source?.kind !== 'user') return false
    if (!String(source.rpcId ?? '').startsWith(RPC_PREFIX)) return false
    const content = message?.content
    if (!Array.isArray(content)) return false
    return content.some(
      (block) =>
        block?.type === 'text' &&
        String(block.text ?? '').startsWith(PRECOMPACT_NUDGE_LEAD),
    )
  })
}

/**
 * 判断"刚刚完成了一个任务"——用于任务边界触发（2026-09-21 新增）。
 *
 * 判据：会话里**最后一次** `todo/write` 的快照满足
 *   ① 列表非空；
 *   ② 每一项都是 `completed`；
 *   ③ 上一次快照**确实有过** `in_progress`（否则不算"刚完成"）。
 *
 * ③ 是必需的：如果模型从头到尾都没把任何一项标成 in_progress，
 * 那"全 completed"只是它一次性写完列表，不构成任务边界信号。
 *
 * @returns {boolean} 是否刚跨过一个任务边界
 */
function justCompletedTask(session) {
  try {
    let prev = null
    let last = null
    const length = session?.seq
    if (!Number.isSafeInteger(length)) return false
    for (let seq = 0; seq < length; seq += 1) {
      const event = session.eventAt?.(seq)
      if (event === undefined || event === null) continue
      if (event.type !== 'todo/write') continue
      const todos = event.data?.todos
      if (!Array.isArray(todos)) continue
      prev = last
      last = todos
    }
    if (last === null || last.length === 0) return false
    // ② 全部 completed
    const allDone = last.every(
      (t) => t !== null && typeof t === 'object' && t.status === 'completed',
    )
    if (!allDone) return false
    // ③ 上一次必须真的有 in_progress
    if (prev === null) return false
    const hadActive = prev.some(
      (t) => t !== null && typeof t === 'object' && t.status === 'in_progress',
    )
    return hadActive
  } catch {
    // 读会话出错绝不能影响门控本身
    return false
  }
}

/**
 * 找本会话**最后一次**压缩并判断成没成（2026-10-06 新增）。
 *
 * 用途：「压缩后自动接棒」——compact 成功后模型手里只剩一份摘要，项目的文档
 * 地图、检查点文件、踩过的坑都不在里面了；此时最危险的行为是**凭记忆接着干**。
 * pre-step 检测到"刚压完"，就自动注入一条接棒词（先读文件，再动手）。
 *
 * 判据（倒着扫，遇到第一条 `compaction/end` 就停）：
 *   · 该事件带 `error` ⇒ 这一次压缩没成（例如"摘要不比被折叠内容小"），返回 null；
 *   · 找不到任何 `compaction/end` ⇒ 返回 null；
 *   · 否则返回 `{ id, seq }`：`id` 去重（同一个 compactionId 只注入一次），
 *     `seq` 交给 pre-step 的窗口判定（只认刚发生的那一次）。
 *
 * `session.seq` / `session.eventAt(seq)` 与 `justCompletedTask` 用的是同一套
 * 只读接口：读会话失败一律当作"没有压缩"，绝不影响门控本身。
 */
function lastSuccessfulCompaction(session) {
  try {
    const length = session?.seq
    if (!Number.isSafeInteger(length)) return null
    for (let seq = length - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt?.(seq)
      if (event === undefined || event === null) continue
      if (event.type !== 'compaction/end') continue
      const id = event.data?.compactionId
      if (typeof id !== 'string' || id.length === 0) return null
      if (event.data?.error !== undefined) return null
      return { id, seq }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 「最近一次成功压缩结束」的**墙上时刻**（epoch ms）；没压过 ⇒ null。
 *
 * 用途：判断工作区里那份 `precompact-<sid>.md` 是**这一轮**写的、还是**上一轮**留下的。
 *
 * 🛑 为什么不能再用内存 state 里的 `st.preflightAtMs`：
 *   ① 它**不持久化** —— `persistQuarantine` 只写 `parked` / `handoff-pending` 两种 phase
 *      （见 `1124` 的 `if (!QUARANTINED.has(s.phase)) continue`）⇒ web 一重启就没了；
 *   ② 压缩成功还会主动把它**归零**（`2176`）。
 *   两条叠加 ⇒ 判据降级成 `size > 0` ⇒ **上一轮压缩前写的旧落档永远满足** ⇒ 从此再也催不到落档。
 *   实测（2026-10-12，会话 `7e73f1e7`，cwd `/root/aa/千星2D`）：
 *   落档停在 `10-11 09:43`（`precompact-7e73f1e7.md`），此后**压缩了 15 次、一次都没落档**，
 *   用户报的症状是「压缩后记忆丢了，**还以为之前那些是另一个会话干的**」。
 *
 * ⇒ 改用会话日志里的时刻做下界：**不依赖内存 state，重启后判据依然成立**。
 */
function lastCompactionEndMs(session) {
  try {
    const found = lastSuccessfulCompaction(session)
    if (found === null) return null
    const event = session.eventAt?.(found.seq)
    const t = event?.time
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/** Read the runtime config file once (absent/corrupt → defaults). */
async function loadRuntimeFile(base) {
  let text
  try {
    text = await readFile(CONFIG_FILE, 'utf8')
  } catch {
    return { ...base }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...base }
  }
  if (parsed === null || typeof parsed !== 'object') return { ...base }
  return {
    triggerTokens: normalizeRuntime(parsed.triggerTokens, base, 'triggerTokens'),
    // 任务边界水位（2026-09-21 加，用户要求可调：150k 常常"活没干两轮就触发"）。
    // normalizeRuntime 已能处理 number / 数字字符串；<=0 表示关闭该行为。
    taskBoundaryTokens: normalizeRuntime(parsed.taskBoundaryTokens, base, 'taskBoundaryTokens'),
    autoNewSession: typeof parsed.autoNewSession === 'boolean' ? parsed.autoNewSession : base.autoNewSession,
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : base.enabled,
    // 🆕 图片水位总开关（2026-10-14）：与 autoNewSession / enabled 同样的"布尔才认"口径。
    imageWatermark: typeof parsed.imageWatermark === 'boolean' ? parsed.imageWatermark : base.imageWatermark,
    remindTokens: normalizeRuntime(parsed.remindTokens, base, 'remindTokens'),
    sessionModes: normalizeSessionModes(parsed.sessionModes, base.sessionModes),
    // 自动压缩的冷却时长。**刻意不进 POST /config** —— 它是安全阀不是旋钮，
    // 让用户能把它调成 0 就等于把"防无限重试"关掉了。它存在的唯一理由：
    // 回归探针要能在毫秒级验证「连续失败两次就降级」（否则得真等 20 分钟）。
    autoCompactCooldownMs: normalizeRuntime(parsed.autoCompactCooldownMs, base, 'autoCompactCooldownMs'),
    // 同上，也是给探针留的把手（默认 AUTO_COMPACT_IDLE_DELAY_MS）。
    autoCompactIdleDelayMs: normalizeRuntime(parsed.autoCompactIdleDelayMs, base, 'autoCompactIdleDelayMs'),
    autoCompactPollMs: normalizeRuntime(parsed.autoCompactPollMs, base, 'autoCompactPollMs'),
  }
}

/** Atomically persist the runtime config file. */
async function saveRuntimeFile(runtime) {
  const tmp = `${CONFIG_FILE}.tmp`
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  await writeFile(tmp, JSON.stringify({
    triggerTokens: runtime.triggerTokens,
    taskBoundaryTokens: runtime.taskBoundaryTokens,
    autoNewSession: runtime.autoNewSession,
    enabled: runtime.enabled,
    imageWatermark: runtime.imageWatermark,
    remindTokens: runtime.remindTokens,
    sessionModes: runtime.sessionModes,
    autoCompactCooldownMs: runtime.autoCompactCooldownMs,
    autoCompactIdleDelayMs: runtime.autoCompactIdleDelayMs,
    autoCompactPollMs: runtime.autoCompactPollMs,
  }, null, 2) + '\n', 'utf8')
  await rename(tmp, CONFIG_FILE)
}

export function apply(ctx, config = {}) {
  const base = {
    triggerTokens: Number.isFinite(config.triggerTokens)
      ? config.triggerTokens
      : DEFAULT_TRIGGER,
    // 任务边界水位线（2026-09-21 新增）。<=0 即关闭该行为。
    // 刻意**不放进运行时文件**：它是行为开关，不是用户会频繁拖的旋钮；
    // 放进来会让"配置优先级"（AGENTS.md 第六节）多一层，收益不抵复杂度。
    taskBoundaryTokens: Number.isFinite(config.taskBoundaryTokens)
      ? config.taskBoundaryTokens
      : DEFAULT_TASK_BOUNDARY_TOKENS,
    autoNewSession: config.autoNewSession !== false,
    enabled: true,
    // 🆕 图片水位总开关（2026-10-14 用户拍板）：**只留这一个开关，水位内置 16 MB**。
    //    理由（用户原话）：「有些 api 应该没有这种限制」⇒ 不该强迫所有渠道都按图片体积交棒/压缩。
    //    默认 **true**（允许图片水位参与到点判定）。
    imageWatermark: config.imageWatermark !== false,
    // 「到点动作」的水位（2026-10-07）：到点做什么由该会话的 sessionModes 决定
    // —— `remind` 只弹横幅、`auto` 执行 /compact；**没被标记的会话什么都不做**。0 = 两者都关。
    remindTokens: Number.isFinite(config.remindTokens) ? config.remindTokens : DEFAULT_REMIND_TOKENS,
    // 按会话的处理方式（默认全关 —— 见 SESSION_MODES 的注释）。
    sessionModes: normalizeSessionModes(config.sessionModes, {}),
    // 自动压缩的冷却（安全阀，**不进 POST /config** —— 理由见 loadRuntimeFile 那段注释）。
    autoCompactCooldownMs: Number.isFinite(config.autoCompactCooldownMs)
      ? config.autoCompactCooldownMs
      : AUTO_COMPACT_COOLDOWN_MS,
    autoCompactIdleDelayMs: Number.isFinite(config.autoCompactIdleDelayMs)
      ? config.autoCompactIdleDelayMs
      : AUTO_COMPACT_IDLE_DELAY_MS,
    autoCompactPollMs: Number.isFinite(config.autoCompactPollMs)
      ? config.autoCompactPollMs
      : AUTO_COMPACT_POLL_INTERVAL_MS,
  }
  const checkpointPath = typeof config.checkpointPath === 'string' && config.checkpointPath.length > 0
    ? config.checkpointPath
    : DEFAULT_PATH
  const continuePrompt = typeof config.continuePrompt === 'string' && config.continuePrompt.length > 0
    ? config.continuePrompt
    : DEFAULT_CONTINUE
  /** Per-session continue text: `{{path}}` resolves to that session's file. */
  // 🛑 2026-10-14：`pathFor`（工作区相对）→ `checkpointAbspath`（绝对）—— 与落档同一处事故：
  // 模型按"自己正在干活的仓库"解析相对路径，读到/写到别处。
  const continueTextFor = (agent) => continuePrompt.replaceAll('{{path}}', checkpointAbspath(agent))

  /**
   * 「压缩后自动接棒」的注入正文（2026-10-06 新增）。
   *
   * 与 continueTextFor 的分工：那条用于**换会话**（新会话什么都看不到，所以要它
   * 通读检查点并复述）；这条用于**同一个会话被压缩之后** —— 它还记得"我是谁、
   * 在干什么"，但丢了文档地图、检查点内容、踩过的坑。所以重点是三句：
   * 别凭记忆 → 回去读文件 → 用复述证明读到了。
   */
  const reanchorTextFor = async (agent) => {
    // 🛑 2026-10-14：两条路径都改成**绝对路径** —— 与 `requestPreflightNote` 是同一处事故
    // （模型按"自己正在干活的仓库"解析相对路径 ⇒ 读到别的目录）。这里尤其致命：读到别的仓库
    // 那份旧档，压缩后的自己会拿**过期结论**接着干活。
    const path = checkpointAbspath(agent)
    // 2026-10-07 补：先 stat 一下，文件在不在决定第一句怎么写。
    // 起因是实测 session-0192c408 —— 它压缩时**从没写过检查点**（压力没到过阈值），
    // 于是接棒词指着 `checkpoint-0192c408.md` 让 AI 去读一个不存在的文件。
    // 那条消息里虽有兜底括号，但第一句就是假的；不如直说"它不存在"。
    let exists = false
    try {
      const s = await stat(checkpointAbspath(agent))
      exists = s.size > 0
    } catch {
      exists = false
    }
    // 🆕 2026-10-14（用户实测后点名要的）：**落档也要被读回来**。
    // 起因：长任务被反复压缩后"忘掉太多"，而交棒路径反而恢复得好 —— 差别就在这份
    // **压缩前一刻刚写**的落档：它比摘要准得多（有"读过哪些文档""下一步第一件事"），
    // 但这段接棒词**从来没提过它**，压缩后的会话只能靠"自己想起来"，实际等于没有。
    const noteAbs = preflightAbspath(agent)
    let noteExists = false
    try {
      const s = await stat(noteAbs)
      noteExists = s.size > 0
    } catch {
      noteExists = false
    }
    let step = 0
    const num = () => `${++step}. `
    return (
      '[auto-checkpoint] 你刚被压缩过：**较早那段对话已经被折叠成摘要，原文你看不到了**。\n' +
      '\n' +
      '🛑 **第一件事 —— 先不要调用任何工具**，用三句话回答我（这三句是给用户看的\n' +
      '"你确实读到了"信号，不许跳过）：\n' +
      '   ①现在到哪一步 ②有哪些已知坑 / 约束 ③下一步第一件事做什么\n' +
      '\n' +
      '回答完再把状态读回来：\n' +
      (noteExists
        ? num() +
          '🛑 **先读你压缩前一刻自己写的落档**：`' + noteAbs + '` ——\n' +
          '   那是**上一个你**专门留给现在这个你的（到哪一步 / 踩过的坑 / 读过哪些文档 /\n' +
          '   下一步第一件事），**比摘要准得多**，先读它，再读别的。\n'
        : '') +
      (exists
        ? num() + '读本会话的检查点文件：`' + path + '`\n'
        : num() + '⚠️ 本会话的检查点 `' + path + '` **目前不存在**（这个会话还没写过检查点）——\n' +
          '   那就自己在工作区里找交接文档，别去读那个不存在的文件：\n') +
      '   `checkpoint*.md`、`事实总表.md`、`HANDOVER.md`、`02-交接检查点/`、\n' +
      '   `任务单/`、`04-成果/*/回执.md`、项目 `AGENTS.md` —— 有哪个用哪个。\n' +
      num() + '读工作区的 `AGENTS.md`，**只看「文档地图」那一节** —— 它写着"找什么该去哪"，\n' +
      '   以及本项目不许再犯的坑。\n' +
      num() + '查项目长期经验时检索**整个项目**，不要只检索检查点：\n' +
      '   `grep -rn "关键词" --include="*.md" . | head -40`\n' +
      '\n' +
      '之后继续干活。\n' +
      '⚠️ 不要为了"重新理解项目"去重做已经完成的工作 —— 以检查点和文档为准。'
    )
  }
  const remindEvery = Number.isInteger(config.remindEverySteps) && config.remindEverySteps >= 1
    ? config.remindEverySteps
    : DEFAULT_REMIND_EVERY

  /**
   * 「压缩后自动接棒」（2026-10-06 新增，用户点名要做）。
   *
   * 为什么需要它：compact（手动 `/compact` 或自动压缩）会把较早的对话折叠成
   * 一份摘要。摘要保得住方向，保不住细节 —— 文档地图、检查点文件路径、
   * 踩过的坑都在原文里。实测 2026-10-06 那次压缩：17.7 万 token 折叠成
   * 4652 字符，之后模型只能靠"自己记得"继续，风险全压在记忆上。
   * 这个开关打开后，压缩刚结束就自动注入一条接棒词要它先读文件。
   *
   * 刻意**不放进运行时文件**（同 taskBoundaryTokens 的理由）：它是行为开关，
   * 不是会频繁拖的旋钮。要关掉就在 profile 配置里写 reanchorAfterCompact: false。
   */
  const reanchorAfterCompact = config.reanchorAfterCompact !== false

  /**
   * Live runtime config; starts from the file (or static defaults).
   *
   * ⚠️ 竞态修复（2026-09-21）：初版是 `void loadRuntimeFile(base).then(loaded =>
   * Object.assign(runtime, loaded))` —— 异步读盘**无条件覆盖** runtime。
   * 于是"web 刚起来、用户立刻拖滑块"这个时序下：
   *   ① 异步 load 还没回来 → runtime 是编译期默认
   *   ② POST 写入新值 → runtime 与磁盘都更新
   *   ③ 异步 load 回来了 → **用启动前读到的旧文件内容覆盖掉刚写入的新值**
   * 实测后果：POST 返回的就是旧值，**改动被完全吞掉**（不只是响应错）。
   *
   * 修法：用一个 `runtimeDirty` 标志。只要发生过主动写入，异步 load 就**不再覆盖**。
   * 这样两种时序都正确：
   *   · load 先回来 → 正常读盘（用户改动随后生效）
   *   · POST 先发生 → load 放弃覆盖（用户改动保留）
   */
  const runtime = { ...base }
  let runtimeDirty = false
  void loadRuntimeFile(base).then((loaded) => {
    if (runtimeDirty) return
    Object.assign(runtime, loaded)
  }).catch(() => {})

  /** Serialized quarantine writes; a failed write is logged, never fatal. */
  let quarantineWrite = Promise.resolve()

  /**
   * Rewrite the quarantine file from the live map. Serialized, so two sessions
   * moving at once cannot interleave into the same tmp file, and swallowed, so
   * an unwritable $DSH_HOME can never break the gate itself.
   */
  function persistQuarantine() {
    const run = async () => {
      try {
        const payload = {}
        for (const [agentId, s] of states) {
          if (!QUARANTINED.has(s.phase)) continue
          payload[agentId] = { phase: s.phase, reminderStep: s.reminderStep, confirmedPath: s.confirmedPath }
        }
        const tmp = `${STATE_FILE}.tmp`
        await mkdir(dirname(STATE_FILE), { recursive: true })
        await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
        await rename(tmp, STATE_FILE)
      } catch (error) {
        ctx.logger.warn(`[auto-checkpoint] quarantine state not persisted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    quarantineWrite = quarantineWrite.then(run, run)
    return quarantineWrite
  }

  /**
   * Move a session to another phase, persisting whenever the move enters or
   * leaves quarantine. The handoff paths await it, so the flag is on disk
   * before the handoff reports success: a crash right after must not resurrect
   * the old session as free.
   */
  async function setPhase(st, phase) {
    const before = st.phase
    st.phase = phase
    if (QUARANTINED.has(before) || QUARANTINED.has(phase)) await persistQuarantine()
  }

  /** Absolute checkpoint path under the session cwd. Accepts an agent **or** a session. */
  function checkpointAbspath(agentOrSession) {
    const session = agentOrSession?.session ?? agentOrSession
    const cwd = session?.header?.cwd ?? process.cwd()
    const rel = pathForSession(session?.id)
    return isAbsolute(rel) ? rel : join(cwd, rel)
  }

  /**
   * Per-session checkpoint path: `{{session}}` expands to a short session id,
   * so a hand-off chain never overwrites an earlier checkpoint
   * (`checkpoint-9b1a8732.md`, `checkpoint-4c201fa3.md`, …). A literal path
   * without the placeholder keeps its old single-file behavior.
   */
  function pathForSession(sessionId) {
    // No session in hand: return the raw template (`checkpoint-{{session}}.md`)
    // instead of a plausible-looking fake name like `checkpoint-session.md`,
    // so the panel never shows a path that cannot exist.
    if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) {
      return checkpointPath
    }
    const short = String(sessionId).replace(/^session-/, '').slice(0, 8) || 'session'
    return checkpointPath.replaceAll('{{session}}', short)
  }

  /** Same path, resolved from a live agent. */
  function pathFor(agent) {
    return pathForSession(agent?.session?.id ?? agent?.id)
  }

  /** Size of the checkpoint file, 0 when missing/empty. */
  async function checkpointSize(agent) {
    try {
      const s = await stat(checkpointAbspath(agent))
      return s.size > 0 ? s.size : 0
    } catch {
      return 0
    }
  }

  /**
   * 「压缩前落档」文件的绝对路径（2026-10-09，PRECOMPACT_PATH_TEMPLATE）。
   *
   * 为什么**不复用**交接检查点那份 `checkpoint-<sid>.md`：
   *   读者不同 —— 交接是写给**下一棒的 AI**（它看不到这段对话），
   *   落档是写给**压缩后的同一个会话自己**（它看得到摘要、但看不到原文）。
   *   生命周期也不同 —— 交接是一次性的，落档是每压一次就覆盖一次。
   *   混在一份文件里，两种读者会互相踩。
   */
  function preflightAbspath(agentOrSession) {
    const session = agentOrSession?.session ?? agentOrSession
    const cwd = session?.header?.cwd ?? process.cwd()
    const sid = session?.id
    const short = typeof sid === 'string' && sid.length > 0
      ? (sid.replace(/^session-/, '').slice(0, 8) || 'session')
      : 'session'
    const rel = PRECOMPACT_PATH_TEMPLATE.replace('{{session}}', short)
    return isAbsolute(rel) ? rel : join(cwd, rel)
  }

  /**
   * 落档文件「写好了吗」—— 判据与 `freshCheckpointSize` 同款（mtime ≥ 我们催的时刻，
   * 容忍 2 秒粒度/时钟偏差），但用**独立的** `st.preflightAtMs`：
   * 交接那条路用的是 `st.askedAtMs`，两个字段必须分开，否则一边催过就会让另一边
   * 误判成"已经写好了"，而文件其实是上一次的。
   */
  async function freshPreflightSize(agent, st) {
    try {
      const abs = preflightAbspath(agent)
      const s = await stat(abs)
      if (!(s.size > 0)) return 0
      const askedAt = st && Number.isFinite(st.preflightAtMs) && st.preflightAtMs > 0
        ? st.preflightAtMs
        : null
      const mtimeMs = typeof s.mtimeMs === 'number' ? s.mtimeMs : s.mtime.getTime()
      // 🛑 2026-10-12 修「旧落档冒充新落档」：`askedAt` 缺席时**不再降级成 `size > 0`**
      //（理由见 `lastCompactionEndMs` 的注释：该字段不持久化 + 压缩成功会把它归零）。
      // 下界 = 「我们这次催过」(askedAt) ?? 「最近一次压缩结束」(compactedAt)：
      //   · 压缩之后重写的落档 ⇒ mtime ≥ 下界 ⇒ 算数，不催；
      //   · 上一轮留下的旧档   ⇒ mtime <  下界 ⇒ 不算数，**重新催** —— 这正是设计意图，
      //     见 `2172-2174`：「压完了 ⇒ 落档状态归零，下一次压缩前重新要一份」。
      // 两个下界都取不到（全新会话、从没压过）⇒ 保持旧行为 `size > 0`，不误伤。
      const floor = askedAt ?? lastCompactionEndMs(agent?.session)
      if (floor === null) return s.size
      if (mtimeMs + MTIME_SLACK_MS < floor) return 0
      return s.size
    } catch {
      return 0
    }
  }

  /**
   * Freshness-guarded size: **only counts a checkpoint written after we asked.**
   *
   * Why this exists (2026-09-26, real incident):
   *   The old check was `size > 0`, which a *stale* file left by the PREVIOUS
   *   session in the chain also satisfies. So when the model failed to
   *   overwrite it — e.g. the official `dsh-fs-observation-policy` rejects a
   *   write to a file the model never read (`FS_NOT_OBSERVED`) — the plugin
   *   still saw "file exists, non-empty" and handed off. The next session then
   *   resumed from an obsolete checkpoint and acted on superseded conclusions.
   *
   * Fix: record the wall-clock time at which we asked for the write
   * (`st.askedAtMs`) and require the file mtime to be at or after it. A stale
   * file now reads as "not yet written", so the plugin re-reminds instead of
   * handing off.
   *
   * Tolerances:
   *   - 2s slack for mtime granularity / clock skew.
   *   - Missing `askedAtMs` (older state, restored session) degrades to the
   *     legacy `size > 0` behaviour rather than blocking hand-offs forever.
   */
  const MTIME_SLACK_MS = 2000
  async function freshCheckpointSize(agent, st) {
    try {
      const abs = checkpointAbspath(agent)
      const s = await stat(abs)
      if (!(s.size > 0)) return 0
      const askedAt = st && Number.isFinite(st.askedAtMs) ? st.askedAtMs : null
      if (askedAt === null) return s.size
      const mtimeMs = typeof s.mtimeMs === 'number' ? s.mtimeMs : s.mtime.getTime()
      if (mtimeMs + MTIME_SLACK_MS < askedAt) {
        ctx.logger.warn(
          `[auto-checkpoint] checkpoint looks STALE: ${abs} (mtime ` +
            `${new Date(mtimeMs).toISOString()} < asked ${new Date(askedAt).toISOString()}); ` +
            `treating as NOT written and re-reminding instead of handing off`,
        )
        return 0
      }
      return s.size
    } catch {
      return 0
    }
  }

  /**
   * 🛑 用户拍板（2026-10-11）：「**落档内容里出现交棒意图时 → 只提醒用户、不自动开**」。
   *
   * 为什么必须是这条形状：
   *   - `precompact-*.md`（**压缩前落档**）里天然常带"下一棒"字样，而**压缩不该换会话**
   *     （见本文件 433 行附近的注释）；
   *   - 会话自己喊"请开新会话"然后停住，是真实浪费（2026-10-11：`4702a65a` 干到 229 步、
   *     读图 39 张、写了落档、喊了"请开新会话"，然后**停在那里没人接**）。
   *     这时**该由人来决定**，而不是插件替用户换会话。
   *
   * ⇒ 本函数**只做两件事**：读文件、置一个待注入的提醒标记。
   *   🛑 **它永远不许调用 `handoff()`，也不许改 `phase`** —— 任何"按内容自动开新会话"的改动
   *   都违反用户拍板，且会误伤压缩流程。
   */
  const HANDOFF_INTENT_PATTERNS = [
    // ⚠️ 必须**高精度**：检查点模板自带「项目知识档案（**下一棒**必看）」这类固有词，
    //    匹配宽了会把**每一份**检查点都判成"想交棒"（那就成了每次都提醒的噪音）。
    //    `handoff.sh` 也**不能裸匹配** —— 检查点里"知识档案：~/.dsh/tools/handoff.sh（会话自己交棒）"
    //    这种**描述性**提到是常态（本插件自己的文档就这么写）⇒ 只认**祈使语境**（调/跑/执行/bash…）。
    /(调|调用|跑|执行|走|bash)[^\n]{0,60}?handoff\.sh/,
    /(请|必须|务必|建议|应当|需要|快来|赶紧)\s*开(一个|个)?新会话/,
    /开(一个|个)?新会话(接着|继续|来|接手|做)/,
    /新会话(接手|接着做|继续做|继续)/,
    /请下一棒(接手|继续|接着做)/,
  ]
  const HANDOFF_INTENT_READ_CAP = 8192
  const HANDOFF_INTENT_CHECK_MS = 15 * 60 * 1000

  /** 命中返回命中的那段文字（便于写进提醒/日志），否则返回 null。 */
  function wantsHandoff(text) {
    if (typeof text !== 'string' || text.length === 0) return null
    for (const re of HANDOFF_INTENT_PATTERNS) {
      const m = text.match(re)
      if (m) return m[0]
    }
    return null
  }

  /**
   * 读落档/检查点正文找"交棒意图"；命中就置 `st.pendingHandoffNote`，
   * 由**下一个 `agent/pre-step`** 注入提醒。
   *
   * 🛑 为什么不在检测当场提醒：唯一能"发消息出去"的通道是
   *   `sessionController.prompt`，而它是**立刻开新回合**的 —— agent 会因此永不空闲、
   *   自动压缩拿不到窗口（§2.2.14 记过这个实害：用户那晚 `/compact` 四连败「agent is not idle」）。
   *   走 pre-step 注入则只在**本来就有新一轮**时附带一句话，零副作用。
   */
  async function detectHandoffIntent(agent, st, which) {
    try {
      // 只对"还在盯着"的会话做（`requested` 会走正规交接、`parked` 已经交出去了）。
      if (!st || st.phase !== 'watching') return
      const now = Date.now()
      // 节流按来源分开记，免得检查点那次把落档那次挤掉。
      if (!st.intentCheckedAt || typeof st.intentCheckedAt !== 'object') st.intentCheckedAt = {}
      const last = st.intentCheckedAt[which]
      if (Number.isFinite(last) && now - last < HANDOFF_INTENT_CHECK_MS) return
      st.intentCheckedAt[which] = now
      if (st.pendingHandoffNote) return // 已经有一条待注入，别叠加
      const abs = which === 'preflight' ? preflightAbspath(agent) : checkpointAbspath(agent)
      let text
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        return // 文件没写/读不到：静默，不是错误
      }
      const hit = wantsHandoff(text.slice(0, HANDOFF_INTENT_READ_CAP))
      if (hit === null) return
      st.pendingHandoffNote = { file: abs, which, hit, at: now }
      ctx.logger.info(
        `[auto-checkpoint] handoff intent found in ${abs} (matched "${hit}", source ${which}) — ` +
          `NOT auto-opening; the user will be asked instead`,
      )
    } catch (error) {
      ctx.logger.warn(
        `[auto-checkpoint] handoff-intent probe failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 🛑 归档上一份检查点 —— 治「**同一个会话**多次接力互相覆盖」（2026-10-09）。
   *
   * 实测：`DEFAULT_PATH = 'checkpoint-{{session}}.md'` 的 `{{session}}` 只保证
   * **跨会话**不覆盖（不同 session id ⇒ 不同文件名）。但**同一个会话**第二次触发检查点时
   * 写的是**同一个路径** ⇒ 前一份被整个吃掉。`checkpoint-8ec526d7.md` 头部自己就写着
   * 「本文件**覆盖**了上一棒（benchlab 泄漏审计）的检查点内容」—— 被吃掉的那份正文，
   * 事后扫全机 424 个会话也**再也检索不到**（该工作区只剩 11 份检查点，覆盖痕迹留在文件名之外）。
   *
   * 做法：把已存在的旧文件**改名留档**为 `checkpoint-<sid>.prev-<YYYYMMDD-HHMM>.md`，
   * 让规范路径空出来给新的一份（`freshCheckpointSize` 仍按规范路径 + mtime 判新，不受影响；
   * 接棒词里本来就有 `ls checkpoint-*.md` 看历史的那一条，留档文件天然可被发现）。
   *
   * 三条纪律：
   *   ① 归档是**附加价值**，失败绝不能阻断接力 ⇒ 全程 try/catch，出错就返回 null；
   *   ② 只在"这一轮还没归档过"时做（`st.archivedAtMs`）—— 模型没写成、插件重提醒时别反复改名；
   *   ③ 必须在 `st.askedAtMs = Date.now()` **之前**调用，否则与新鲜度判据同一瞬间打架。
   */
  async function archivePreviousCheckpoint(agent, st) {
    try {
      const abs = checkpointAbspath(agent)
      const s = await stat(abs)
      if (!(s.size > 0)) return null
      const mtimeMs = typeof s.mtimeMs === 'number' ? s.mtimeMs : s.mtime.getTime()
      if (st.archivedAtMs && mtimeMs <= st.archivedAtMs) return null
      const d = new Date(mtimeMs)
      const pad = (n) => String(n).padStart(2, '0')
      const stamp =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}`
      const base = abs.replace(/\.md$/i, '') + `.prev-${stamp}`
      let dest = `${base}.md`
      for (let i = 2; i < 100; i += 1) {
        try {
          await stat(dest)
          dest = `${base}-${i}.md`
        } catch {
          break // 该名字空着，可用
        }
      }
      await rename(abs, dest)
      st.archivedAtMs = mtimeMs
      ctx.logger.info(`[auto-checkpoint] archived previous checkpoint -> ${dest} (${s.size} bytes)`)
      return dest
    } catch {
      return null // 文件不存在 = 本会话第一次检查点，属正常
    }
  }

  /**
   * The source session's agent preset, when this deployment can read it.
   * Web mounts the `agentPresets` projection; headless does not, so a missing
   * projection degrades to `undefined` (the child then takes the default
   * composition, exactly as before this change).
   */
  function presetOf(agent) {
    try {
      const session = agent?.session
      if (session === undefined) return undefined
      const projections = ctx.get('sessionProjections')
      const fromProjection = projections?.stateOf?.(session, 'agentPreset')
      if (typeof fromProjection === 'string' && fromProjection.length > 0) return fromProjection
      const fromHeader = session.header?.agentPreset
      return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Pause the old session's active goal before handing it off. A
   * session-scoped goal keeps its round driver queueing one `<goal_round>` per
   * quiescence — that is, the moment the handed-off turn closes, which is
   * BEFORE the child session even exists. Pausing is durable, so a web restart
   * cannot resurrect the old session's autonomous work, and goals never cross
   * sessions: the successor arms its own goal from the checkpoint file.
   *
   * Runs synchronously, before the first await of `handoff()`, so the pause
   * lands before the turn closes and the driver gets a chance to queue.
   */
  function pauseActiveGoal(agent) {
    try {
      const goals = ctx.get('goals')
      if (typeof goals?.get !== 'function' || typeof goals?.pause !== 'function') return
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active') return
      goals.pause(agent, { id: goal.id, revision: goal.revision })
      ctx.logger.info(`[auto-checkpoint] paused goal ${goal.id} on handed-off session ${agent.id}`)
    } catch (error) {
      // Goal bookkeeping must never break a handoff: a goal that cannot be
      // paused (already paused/blocked, revision raced) is still covered by
      // the park gate, which rejects its rounds.
      ctx.logger.warn(`[auto-checkpoint] goal pause skipped on ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Hand the parent's permission preset down to the relay child.
   *
   * A child session is published with the profile's default knobs
   * (`workspace-write` + `ask`), regardless of what the parent was running
   * with. In a relay that matters: the parent may have been widened to
   * `danger-full-access` by the user, and the child — which continues the very
   * same task, in the same workspace, from the checkpoint file — would come
   * back strictly weaker, silently stalling on every write outside the
   * workspace. Observed in the wild 2026-09-17: session `095fb27a` ran with
   * full access, its handoff child `27175d59` started as `workspace-write`.
   *
   * A `custom` parent preset has no table entry to re-apply, and any failure
   * here must never break a handoff — both cases are logged, not thrown.
   */
  function inheritPermissionPreset(parentSession, childId) {
    try {
      const presets = ctx.get('permissionPresets')
      if (typeof presets?.current !== 'function' || typeof presets?.set !== 'function') return
      const sessions = ctx.get('sessions')
      const childSession = typeof sessions?.get === 'function' ? sessions.get(childId) : undefined
      if (parentSession === undefined || childSession === undefined) return
      const name = presets.current(parentSession)
      // `custom` means the parent's knobs match no table entry: there is no
      // preset name to re-apply, so say so instead of guessing.
      if (typeof name !== 'string' || name.length === 0) return
      if (name === 'custom') {
        ctx.logger.warn(`[auto-checkpoint] parent preset is "custom" — child ${childId} keeps the default sandbox knobs`)
        return
      }
      presets.set(childSession, name)
      ctx.logger.info(`[auto-checkpoint] child ${childId} inherited permission preset "${name}"`)
    } catch (error) {
      ctx.logger.warn(`[auto-checkpoint] permission preset not inherited by ${childId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The source session's live model selection, when this deployment exposes the
   * `modelSelection` projection (the web session controller registers it).
   *
   * Mirrors the controller's own resolution: a pending switch wins, then the
   * model the last request actually used — i.e. `pending ?? lastUsed`, which is
   * exactly what the projection's wire view calls `next`. A session that never
   * made a request leaves both null and degrades to `undefined`, so the child
   * keeps the deployment default exactly as before this change.
   */
  function modelSelectionOf(agent) {
    try {
      const session = agent?.session
      if (session === undefined) return undefined
      const state = ctx.get('sessionProjections')?.stateOf?.(session, 'modelSelection')
      const picked = state?.pending ?? state?.lastUsed
      if (picked === undefined || picked === null) return undefined
      if (typeof picked.provider !== 'string' || typeof picked.model !== 'string') return undefined
      return {
        provider: picked.provider,
        model: picked.model,
        ...(typeof picked.reasoningEffort === 'string' ? { reasoningEffort: picked.reasoningEffort } : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Hand the parent's model selection down to the relay child.
   *
   * Same blind spot as the permission preset above: `sessionController.create()`
   * builds the child from `agentDefaultModel.currentSelection()`, so a session
   * the user switched to another model (or another reasoning effort) relays into
   * a child that silently snaps back to the deployment default.
   *
   * `selectModel` is the controller's own switch — the same call the GUI makes —
   * and it normalizes the selection through `llm.resolveCallConfig`, so an
   * unavailable model cannot be installed. One side effect is worth knowing: it
   * also saves the selection as the deployment default, which is why a parent
   * already sitting on the default is skipped entirely (the child starts there
   * anyway, and there is nothing to hand down).
   *
   * A failure here is logged, never fatal: a child on the default model still
   * continues the task, while a broken handoff loses the relay outright.
   */
  async function inheritModelSelection(controller, agent, childId) {
    try {
      if (typeof controller?.selectModel !== 'function') return
      const wanted = modelSelectionOf(agent)
      if (wanted === undefined) return
      const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (
        fallback !== undefined &&
        fallback.provider === wanted.provider &&
        fallback.model === wanted.model &&
        (fallback.reasoningEffort ?? undefined) === (wanted.reasoningEffort ?? undefined)
      ) {
        return
      }
      await controller.selectModel({ sessionId: childId, ...wanted })
      ctx.logger.info(
        `[auto-checkpoint] child ${childId} inherited model ${wanted.provider}/${wanted.model}` +
          `${wanted.reasoningEffort === undefined ? '' : ` (effort ${wanted.reasoningEffort})`}`,
      )
    } catch (error) {
      ctx.logger.warn(`[auto-checkpoint] model not inherited by ${childId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Hand off: park old session, create new one, feed continue prompt. */

  // ── 自动回报（2026-10-06）：派活会话收尾时由插件回报父会话，不靠 AI 记得调用 ──
  const PARENTS_FILE = join(homedir(), '.dsh', 'spawn-parents.json')
  const loadParents = async () => { try { return JSON.parse(await readFile(PARENTS_FILE, 'utf8')) } catch { return {} } }
  const saveParents = async (m) => { try { await writeFile(PARENTS_FILE, JSON.stringify(m, null, 2) + '\n', 'utf8') } catch {} }
  async function linkParent(childId, parentId) {
    if (!childId || !parentId) return
    const m = await loadParents(); m[childId] = parentId; await saveParents(m)
  }
  /**
   * 🛑 2026-10-11（**用户洞见**）：把报话**插到 `next-turn` 队首**，而不是队尾。
   *
   * 为什么必须这么做：
   *   - `sessionController.prompt` 只有两种投递（`dsh-api-session-controller/lib/index.js:882`）：
   *     `mode:'steer'` → `agent.steer()` = 插 `next-step`（**打断当前回合的连贯性**）；
   *     其余 → `agent.followup()` = **追加到 `next-turn` 队尾**（`dsh-agent-loop/lib/index.js:807`）。
   *   - 而 **goal 回合也是队尾追加**（`dsh-goal-round-driver` 里 `agent.followup(message)`）
   *     ⇒ 排在队尾的报话要等 goal 的**下一轮**跑完才轮到它
   *     （用户体感原话：「只有 goal 完了才能报话，到时候黄花菜都凉了」）。
   *   - 宿主 Inbox 公开了 `prepend(target, message)`（`typert.host.js:1817`）⇒ 插队首：
   *     **不打断当前回合**（用户原话「让插话位置在 goal 前，这样就不会有什么扰乱」），
   *     但当前回合结束**下一条就是它**。
   *
   * 降级：拿不到 agent（未加载/已销毁）或 Inbox 不给 prepend/remove ⇒ 就是普通 queue 语义，**不报错**。
   * ⚠️ 顺序：**先投递、再调前** —— 投递那条路走完整准入（附件回执、绑定），别自己造 message。
   */
  async function promptToFront(sessionId, text) {
    const controller = ctx.get('sessionController')
    const agents = ctx.get('agents')
    let agent = null
    try {
      agent = agents?.get?.(sessionId) ?? null
    } catch {
      agent = null
    }
    const before = new Set((agent?.inbox?.nextTurn ?? []).map((m) => m.id))
    await controller.prompt(
      {
        sessionId,
        requestId: `${RPC_PREFIX}${randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    )
    try {
      const inbox = agent?.inbox
      if (!inbox || typeof inbox.prepend !== 'function' || typeof inbox.remove !== 'function') return
      const mine = (inbox.nextTurn ?? []).find((m) => !before.has(m.id))
      if (mine === undefined) return // 已被认领 / 不在队里：别动它
      if (inbox.remove(mine.id)) inbox.prepend('next-turn', mine)
    } catch (error) {
      // 调前失败只是"慢一点"（退回队尾），**绝不因为调前而把报话弄丢**。
      ctx.logger.warn(
        `[auto-checkpoint] prompt-to-front failed for ${sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * ⭐ 2026-10-11（用户第二轮反馈）：**尽量插进"正在跑的那一轮"**。
   *
   * 为什么还需要它：`promptToFront` 只能排到"**还没开跑**的回合"前面 —— 而那一条实测不够用：
   * 目标会话的 goal 回合在 `969` 排队、`973` 就开跑了，报话 `996` 才投进来 ⇒ 只能等那一轮跑完，
   * 用户体感是「都完成一轮了，结果还是 goal 先触发，派话在后面」。
   * ⇒ **在跑的时候**用 `mode:'steer'`（`agent.steer()` = 插 `next-step`，**当前回合的下一步**就认领）。
   *
   * 三条保底（缺一不可）：
   *   ① **空闲时不用 steer** —— 空闲走 `promptToFront`（插队首），语义更稳
   *      （steer 的 `next-step` 在空闲态是否触发新一轮取决于宿主，没必要赌）；
   *   ② **steer 失败必须降级** —— 宿主会返回 `session/steer-unavailable` 之类
   *      （客户端代码里就有这个错误码）⇒ 退回 `promptToFront`，**绝不把报话弄丢**；
   *   ③ 拿不到 agent ⇒ 直接 `promptToFront`（它自己还有一层降级）。
   *
   * 返回实际用的模式（写进 HTTP 响应，便于排查）：`'steer'` 或 `'front'`。
   */
  async function promptFast(sessionId, text) {
    const controller = ctx.get('sessionController')
    const agents = ctx.get('agents')
    let agent = null
    try {
      agent = agents?.get?.(sessionId) ?? null
    } catch {
      agent = null
    }
    const busy = typeof agent?.status === 'string' && agent.status !== 'idle'
    if (busy) {
      try {
        await controller.prompt(
          {
            sessionId,
            requestId: `${RPC_PREFIX}${randomUUID()}`,
            mode: 'steer',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        return 'steer'
      } catch (error) {
        ctx.logger.warn(
          `[auto-checkpoint] steer failed for ${sessionId}, falling back to queue front: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    await promptToFront(sessionId, text)
    return 'front'
  }

  async function autoNotifyIfDone(agent) {
    const m = await loadParents()
    const parentId = m[agent.id]
    if (!parentId) return
    try {
      const goal = ctx.get('goals')?.get?.(agent)
      if (goal !== undefined && goal.phase === 'active') return
    } catch {}
    delete m[agent.id]; await saveParents(m)
    try {
      // ⚠️ 2026-10-11：走 promptFast —— 父会话**正在跑**就 steer 插进当前回合（秒级），
      //    空闲就插 `next-turn` 队首；都失败也不会丢消息（它内部还有降级）。
      //    裸 prompt('queue') 是队尾，父会话开着 goal 时要等 goal 下一轮跑完才轮到（用户报的痛点）。
      await promptFast(
        parentId,
        `[派活回报·自动] 派活会话 ${agent.id} 已收尾（cwd=${agent.session?.header?.cwd ?? '?'}）。请去读它的回执并验收。`,
      )
      ctx.logger.info(`[auto-checkpoint] auto-notify ${agent.id} -> ${parentId}`)
    } catch (error) {
      ctx.logger.warn(`[auto-checkpoint] auto-notify failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function handoff(agent, st, confirmedFile) {
    let childId = null
    try {
      const controller = ctx.get('sessionController')
      if (!controller) {
        ctx.logger.warn(`[auto-checkpoint] sessionController absent — checkpoint only, session keeps running (file: ${confirmedFile})`)
        await setPhase(st, 'checkpoint-only')
        return
      }
      pauseActiveGoal(agent)
      await agent.whenIdle?.()
      // Inherit the workspace (cwd) and the agent preset, so a relay chain
      // keeps the user's chosen mode (e.g. loli-mom) and writes its files in
      // the same project directory the task started in. The permission preset
      // is handed down right after the child is published.
      const preset = presetOf(agent)
      const created = await controller.create({
        cwd: agent.session?.header?.cwd,
        ...(preset === undefined ? {} : { agentPreset: preset }),
      })
      childId = created.sessionId
      ctx.logger.info(`[auto-checkpoint] child session ${childId} created (cwd=${agent.session?.header?.cwd ?? '?'} preset=${preset ?? 'default'})`)
      // The child is published with the profile's DEFAULT permission knobs, so
      // a session the user had widened must hand its own preset down before the
      // continue prompt admits any work.
      inheritPermissionPreset(agent.session, childId)
      { const m = await loadParents(); if (m[agent.id]) { m[childId] = m[agent.id]; delete m[agent.id]; await saveParents(m) } }
      // Same rule as the preset: the child must be fully equipped before the
      // continue prompt admits any work, so `selectModel` is awaited here, not
      // fired alongside the prompt.
      await inheritModelSelection(controller, agent, childId)
      await controller.prompt(
        {
          sessionId: childId,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text: continueTextFor(agent) }],
        },
        new AbortController().signal,
      )
      ctx.logger.info(`[auto-checkpoint] handoff complete: checkpoint=${confirmedFile} newSession=${childId}`)
    } catch (error) {
      ctx.logger.error(`[auto-checkpoint] handoff failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        if (childId !== null) await ctx.get('sessionController').cancel({ sessionId: childId })
      } catch {}
      // Stay parked-safe: without a clean handoff the old session must not
      // silently resume growing.
      await setPhase(st, 'parked')
      return
    }
    await setPhase(st, 'parked')
  }

  // Gate every step of every agent.
  /**
   * 压缩后自动接棒 —— **以用户身份把接棒词投递进会话**（2026-10-07 追加，用户要求）。
   *
   * 为什么要换投递方式：上一版是在 `agent/pre-step` 里注入一条
   * `source.kind = plugin:auto-checkpoint` 的上下文消息。实测（session-0192c408 的
   * 00:01:13 那次）它**确实注入了**，但前端分类规则是"来源不是 `user` 的消息一律按
   * 「上下文注入」渲染成灰色小字"，而它前后还挤着 system-reminder / runtime-context /
   * 技能目录三条同类灰行 —— 用户根本注意不到（原话："还是因为界面被盖住了"）。
   * 而换会话（handoff）时用的 `sessionController.prompt` 投递出来的是
   * `source.kind = "user"` 的**用户气泡**，显眼得多，模型也更当回事。
   *
   * 为什么不会和真人消息混淆：rpcId 统一带 `auto-checkpoint-` 前缀，而 pre-step 的
   * park 门禁正是靠这个前缀把"插件自己发的"与"真人发的"分开（见 `claimedHumanMessage`）
   * —— 所以这条投递**不会**误解除一个已经交棒的会话（真发生过的 20 分钟并发事故）。
   *
   * 兜底：没有 `sessionController` 时直接返回；投递抛错时清掉去重键 —— 两种情况下
   * pre-step 那条注入路径都仍然会把接棒词送达。
   */
  ctx.on('session/event', (session, event) => {
    void deliverReanchor(session, event).catch((error) => {
      ctx.logger.warn(
        `[auto-checkpoint] re-anchor delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    // B（2026-10-08）：登记每个会话最近一次 `turn/start` 的**时刻**。
    // 为什么按 `time`（epoch ms）而不是"事件先后顺序"：同一个事件流里还混着
    // 别的参与者（goal driver、插件自己），顺序会被交错影响；
    // 时间戳是唯一能可靠回答"这次 turn/end 之后会话又被续跑了吗"的字段。
    // （判"压缩是谁触发的"用的是同一个字段 —— 见 AUTO_COMPACT_POLL_INTERVAL_MS 的注释。）
    if (event?.type === 'turn/start' && typeof session?.id === 'string') {
      const at = Number(event.time)
      if (Number.isFinite(at)) lastTurnStartMs.set(session.id, at)
      // 新回合开始 ⇒ 重置"有没有正文"的累加器（见 turnTextSignal 的注释）。
      // 2026-10-10 扩展：同时重置「零正文快照」要用的现场字段（见 zeroTextState）。
      turnTextSignal.set(session.id, {
        turn: Number(event?.data?.turn),
        sawAssistant: false,
        textChars: 0,
        assistantMsgs: 0,
        reasoningChars: 0,
        toolResultChars: 0,
        maxTokens: 0,
        tools: {},
        injects: {},
        injectChars: {},
      })
    }
    // 「正文缺失」累加（2026-10-10）：只认**有内容的** text 块，空块不算。
    if (event?.type === 'assistant/message' && typeof session?.id === 'string') {
      const rec = turnTextSignal.get(session.id)
      if (rec !== undefined) {
        rec.sawAssistant = true
        const content = event?.data?.message?.content
        let textChars = 0
        let reasoningChars = 0
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text') {
              textChars += String(block.text ?? '').trim().length
            } else if (block?.type === 'reasoning') {
              // ⚠️ reasoning 块的正文挂在 `text` 字段（`reasoning` 字段实测为空）—— 两个都取。
              reasoningChars += String(block.text ?? block.reasoning ?? '').length
            }
          }
        }
        rec.textChars += textChars
        rec.assistantMsgs = (rec.assistantMsgs ?? 0) + 1
        rec.reasoningChars = (rec.reasoningChars ?? 0) + reasoningChars
        // 形态窗口：**按单条消息**记"这条有没有正文"（1=没有），超出窗口丢最老的。
        const shape = zeroTextState.shape.get(session.id) ?? []
        shape.push(textChars > 0 ? 0 : 1)
        if (shape.length > ZERO_TEXT_SHAPE_LEN) shape.shift()
        zeroTextState.shape.set(session.id, shape)
        const tok = findTotalTokens(event?.data)
        if (tok > (rec.maxTokens ?? 0)) rec.maxTokens = tok
      }
    }
    // 「零正文快照」的其余现场累加（2026-10-10）：工具清单 / 工具结果体量 / 注入构成。
    // 全部只是加法，**不注入、不改任何行为**（注入会开新回合占住 agent，见 text-guard 的教训）。
    if (typeof session?.id === 'string' && turnTextSignal.has(session.id)) {
      const rec = turnTextSignal.get(session.id)
      if (event?.type === 'tool/call') {
        const name = String(event?.data?.name ?? '?')
        rec.tools = rec.tools ?? {}
        rec.tools[name] = (rec.tools[name] ?? 0) + 1
      } else if (event?.type === 'tool/result') {
        const content = event?.data?.message?.content
        if (Array.isArray(content)) {
          let len = 0
          for (const block of content) {
            if (block?.type === 'text') len += String(block.text ?? '').length
          }
          rec.toolResultChars = (rec.toolResultChars ?? 0) + len
        }
      } else if (event?.type === 'user/message') {
        const kind = String(event?.data?.source?.kind ?? 'user')
        let len = 0
        const content = event?.data?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text') len += String(block.text ?? '').length
          }
        }
        rec.injects = rec.injects ?? {}
        rec.injectChars = rec.injectChars ?? {}
        rec.injects[kind] = (rec.injects[kind] ?? 0) + 1
        rec.injectChars[kind] = (rec.injectChars[kind] ?? 0) + len
      }
    }
    if (event?.type === 'turn/end') {
      // 手动压缩闸门用：等落档那一轮收尾（见 lastTurnEndMs 的注释）。
      if (typeof session?.id === 'string') {
        const at = Number(event.time)
        if (Number.isFinite(at)) lastTurnEndMs.set(session.id, at)
      }
      // 「零正文快照」（2026-10-10 加）：整轮没写正文 ⇒ 把这一刻的现场**当场**记下来。
      // 🛑 只写文件、不注入任何消息 —— 见 zeroTextState 上方那段注释（注入会占住 agent）。
      snapshotZeroTextTurn(session, event)
      // 🛑 阀开火 ⇒ 顺带压一次（**两道门都跳过**：`sessionModes` 与压力门；冷却等照旧）。
      //    理由与边界全写在 AUTO_COMPACT_ON_VALVE_ABORT 的注释里。
      const valveFired = AUTO_COMPACT_ON_VALVE_ABORT && isValveAbort(event)
      if (valveFired) {
        // 记一条"看得见"的动作（见 lastValveAbort 的注释）；后续每个分支都会推进它的 stage。
        const inner = event?.data?.reason?.reason?.reason
        lastValveAbort = {
          sessionId: session?.id ?? '',
          at: Number(event.time) || Date.now(),
          reason: typeof inner === 'string' ? inner : 'loop-valve（原文未取到）',
          stage: 'requested',
          detail: '已请求顺带压缩一次',
          updatedAt: Date.now(),
        }
        ctx.logger.info(
          `[auto-checkpoint] 急停阀掐了 ${session?.id} 的这一回合 ⇒ 顺带触发一次压缩` +
            `（跳过压力门与 sessionModes；仍受冷却等约束）`,
        )
      }
      void autoCompactAfterTurn(session, Number(event.time), { valveFired }).catch((error) => {
        ctx.logger.warn(
          `[auto-checkpoint] auto compact hook failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  })

  const cooldownMs = () => (Number.isFinite(runtime.autoCompactCooldownMs)
    ? runtime.autoCompactCooldownMs
    : AUTO_COMPACT_COOLDOWN_MS)
  const idleDelayMs = () => (Number.isFinite(runtime.autoCompactIdleDelayMs)
    ? runtime.autoCompactIdleDelayMs
    : AUTO_COMPACT_IDLE_DELAY_MS)
  const pollMs = () => (Number.isFinite(runtime.autoCompactPollMs)
    ? runtime.autoCompactPollMs
    : AUTO_COMPACT_POLL_INTERVAL_MS)
  // 等待上限跟着轮询间隔走：默认 2000ms × 150 = 5 分钟。
  // 探针把间隔调到几十毫秒，整段"等到放弃"也就两秒内跑完（否则一条断言要等 5 分钟）。
  const maxWaitMs = () => pollMs() * 150

  /**
   * 催模型在压缩**之前**落一份档（2026-10-09 加，用户拍板走 B 方案）。
   *
   * 与交接检查点那条提示词（`setPhase('requested')` 那段）的**根本区别是读者**：
   *   · 那份写给「**看不到这段对话的下一棒**」⇒ 重点是项目档案地图；
   *   · 这份写给「**压缩后的同一个会话自己**」⇒ 重点是"我读过什么、结论是什么、来源在哪"。
   * 后者治的是 2026-10-09 复盘出来的真病根：**压缩不吃信息**，
   * 吃的是「**我读过它**」这个记忆 —— 不落档，压缩后就会拿没读过的记忆重做已写完的分析。
   *
   * 身份与去重：与接棒消息一样走 `sessionController.prompt` + `RPC_PREFIX` 前缀，
   * 这样 pre-step 的 park 门禁不会把这条自动消息误当成「真人回来了」（有前科，见 RPC_PREFIX 的注释）。
   *
   * 返回值 = 是否真的投出去了。投失败**不设** `preflightAtMs`，免得把"没催成"记成"催过了"。
   */
  async function requestPreflightNote(agent, session, total, threshold) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt !== 'function') return false
    const sid = session?.id
    const short = typeof sid === 'string' && sid.length > 0
      ? (sid.replace(/^session-/, '').slice(0, 8) || 'session')
      : 'session'
    // 🛑 2026-10-14：**改给绝对路径**。原先这里是工作区相对路径（`precompact-<sid>.md`），
    // 而模型会按**"自己正在干活的仓库"**去解析它。实测会话 `7e73f1e7`（cwd `/root/aa/千星2D`，
    // 活儿却全在 `/root/aa/千星图元拟合`）就把落档写进了后者 ⇒ 插件在 cwd 下看不到
    // ⇒ 白催一遍（`PRECOMPACT_MAX_ASKS = 2` 于是催了两遍）、白写一份 16.5 KB，
    // 而且压缩后接棒词读的也是 cwd 那份**六小时前的旧档**。绝对路径没有解析余地。
    const noteAbs = preflightAbspath(agent)
    const today = new Date()
    const ymd =
      `${today.getFullYear()}-` +
      `${String(today.getMonth() + 1).padStart(2, '0')}-` +
      `${String(today.getDate()).padStart(2, '0')}`
    const text =
      `${PRECOMPACT_NUDGE_LEAD}${Math.round(total)} token，压缩水位 ${Math.round(threshold)}）。\n` +
      `压缩后你**看不到这段对话的原文**，只会拿到一份摘要 —— 而摘要里不会写「你读过什么」。\n` +
      `\n` +
      `所以请**先把下面这些写进这个文件**（**绝对路径，就写它**）：\n` +
      `\n` +
      `    ${noteAbs}\n` +
      `\n` +
      `🛑 **不要写成相对路径，也不要写到你正在干活的别的仓库目录去** —— 插件只认上面这一个路径。\n` +
      `（2026-10-14 真实事故：会话把落档写进了另一个仓库目录 ⇒ 插件看不到，白写一份、还被催第二遍，\n` +
      `  而压缩后的自己读到的仍是旧档。）\n` +
      `\n` +
      `写完我再压：\n` +
      `文件**第一行**必须原样照抄下面这行标题（照抄，不要改、不要自己另起一个）：\n` +
      `\n` +
      `# precompact 落档（session-${short}，${ymd}）\n` +
      `\n` +
      `🛑 **不要抄工作区里已有的落档文件当模板** —— 标题里的会话 id 和日期必须是当前这个。\n` +
      `（2026-10-09 真实事故：内容写对了，标题却抄成别的会话 + 三天前的日期，\n` +
      `  下一个读者会当成旧档，可能照着过期结论干活。）\n` +
      `\n` +
      `1. \`## 现在在做什么 / 到哪一步\` —— 一两句。\n` +
      `2. \`## ⚠️ 已踩过的坑 / 验错的假设\` —— **最重要的一节**，压缩后最容易重蹈。\n` +
      `   一条一行，写清"不要做什么"和"为什么"。没有就写"（暂无）"，别省略。\n` +
      `3. \`## 已修复的缺陷\` —— 修过什么、根因是什么。**压缩后的你不该再修一遍**。\n` +
      `   没有就写"（暂无）"。\n` +
      `4. \`## ⭐ 我读过哪些文档\` —— **这一节是写给压缩后的你自己**。\n` +
      `   一行一条：\`路径\` → 读出了什么结论 → 哪个结论还在用。\n` +
      `   为什么必须写：压缩吃掉的是「**我读过它**」这个记忆。不写下来，压缩后你就会\n` +
      `   拿没读过的记忆重做已经写完的分析，甚至写出新的错结论（2026-10-09 真实事故：\n` +
      `   本机 \`/root/4\` 的 90 份文档里有 815 KB 在压缩后那一段没被读过，其中四份正对着\n` +
      `   当时在推理的主题）。\n` +
      `5. \`## 结论 / 当前状态\` —— 哪些已验证、哪些还没验。\n` +
      `6. \`## 未决事项 / 卡点\`。\n` +
      `7. \`## 环境事实\` —— 路径、版本号、关键命令等**可复核**的事实（一行一条）。\n` +
      `8. \`## 📚 项目知识档案（压缩后的你必看）\` —— **一行一条**：哪份文档 / 哪个目录装\n` +
      `   什么经验（带路径），以及"你这一轮真正用上的是哪几份"。没有就写"（暂无）"，别省略。\n` +
      `   ⚠️ 为什么必须写：压缩后的你**不会自动知道项目里有哪些文档** —— 你不把路径写下来，\n` +
      `   项目里早已写好的经验就等于不存在（2026-10-06 真实事故 session-c41a9661）。\n` +
      `9. \`## 下一步第一件事\` —— 只写**一件**，具体到可以直接动手。\n` +
      `\n` +
      `写完只回一句「落档完成」，不要展开。`
    const st = stateFor(agent.id)
    try {
      await controller.prompt(
        {
          sessionId: sid ?? agent.id,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      st.preflightAtMs = Date.now()
      st.preflightAsks = (Number.isFinite(st.preflightAsks) ? st.preflightAsks : 0) + 1
      ctx.logger.info(
        `[auto-checkpoint] pre-compact note requested for ${agent.id} ` +
          `(ask ${st.preflightAsks}/${PRECOMPACT_MAX_ASKS}, target ${noteAbs}, pressure ${Math.round(total)})`,
      )
      return true
    } catch (error) {
      ctx.logger.warn(
        `[auto-checkpoint] pre-compact note request failed for ${agent.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /**
   * 会话「停下来」之后的自动压缩（2026-10-08 第四次改 —— 修 goal 会话永不空闲）。
   *
   * 演进史（三版的教训都在这，**别退回去**）：
   * ① v1 在 `agent/pre-step` 里压 —— 那一刻 agent 正在跑这个回合，准入必然拒绝。
   *    实测：`session-8ec526d7` 的 seq 1764 / 1786 两条 `command/run compact` 都精确落在
   *    `step/end` 与下一个 `step/start` 之间（= pre-step 的位置），`command/done` 全是
   *    `kind:'error'`。**那条路永远不可能成功。**
   * ② v2 搬到 `turn/end` + 固定延迟 1.5 秒 —— 对普通会话够用（`session-9e0eeced` 实测
   *    `turn/end` → `command/run` = **+1.502 秒**，成功压掉 224 条 / 87340 token），
   *    但对 **goal 会话**不够：它在 `turn/end` 后 **16 毫秒**就续跑，agent 从不空闲
   *    （`session-a63ff73e` 实测，用户报"到阈值了也不压缩"）。
   * ③ v3（本版）改成**轮询等一个真正的空闲窗口**，判据是 B（见下）。
   *
   * 判据（A+B 里的 B）：`lastTurnStartMs` 里该会话的时刻 **> 本次 turn/end 的时刻**
   * ⇒ 这期间又开过新回合 ⇒ 会话还在跑 ⇒ **继续等、一次都不试**；
   * 否则说明它真静下来了 ⇒ 才试一次。
   * 为什么"不试"有价值：`busy` 虽是本地拒绝（不烧上游请求），但每次都会往会话日志里写
   * 一对 command/run + command/done；goal 连续跑几小时就是几千条噪音。而判据本身是
   * **精确的时间戳比较**，不需要"试了才知道"。
   *
   * 放弃条件：等满 `maxWaitMs()`（默认 5 分钟）退出，交给下一个 `turn/end` 重新开始。
   * **整段等待全是本地轮询，一次上游请求都没发**，所以等多久都不花钱。
   */
  async function autoCompactAfterTurn(session, turnEndedAt, opts = {}) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const valveFired = opts?.valveFired === true
    // 阀开火的那一次：把"卡在哪一步"记进 lastValveAbort，好让面板说清"做了 / 没做 / 为什么"。
    // 非阀开火的路径 `note()` 是**空操作** —— 那条路本来就是静默的阈值压缩，不打扰用户。
    const note = (stage, detail) => {
      // 🛑 **总是**记一条决定（2026-10-10 加，可观测性修复）。
      // 起因：阈值压缩这条路**全程静默** —— `note()` 原本只在阀开火时写面板，
      // 于是"为什么没压"在外部**完全看不到**。排查 `session-7e73f1e7` 卡死时只能靠
      // "日志里没有 command/run"倒推它卡在某道门里，**没法直接读出来**。
      // 现在每次决定都落进 state 接口的 `counters.lastAutoCompactDecision`（只对这条会话返回），
      // 一条 curl 就能回答"卡在哪道门"。
      counters.lastAutoCompactDecision = {
        sessionId,
        stage,
        detail: typeof detail === 'string' ? detail : '',
        at: Date.now(),
        valveFired,
      }
      if (valveFired) noteValveStep(sessionId, stage, detail)
      return undefined
    }
    if (!runtime.enabled) return note('disabled', '插件已停用（enabled=false）')
    // ── 阀开火的那一次：**两道门一起跳过**（2026-10-09，事故驱动 + 用户拍板）──
    //    ① 跳过 `sessionModes`（面板里的显式 opt-in）；
    //    ② 跳过压力门（见下方 `if (!valveFired && pressure < threshold) return`）。
    //
    // 🛑 **事故（1 的由来）**：会话 `b8eb5ad8`（cwd `/root/1`）2026-10-09 17:33:25 被阀掐断
    //    （`「做」×67，占窗口 23%`），但**它不在面板的 `auto` 名单里** ⇒ 这一行提前 return，
    //    压缩**一声不响地没跑**。用户看到的只有"阀掐了，然后什么都没有"，来问"你不是说搞了吗"。
    //    ⇒ 判据：**阀开火 = "这条会话确实坏了"的强信号**，而压缩实测清得掉污染
    //      （最强一次 43→0 且零复发）⇒ 值得越过 opt-in 这道门。
    //
    // ⚠️ **已知代价（用户 2026-10-09 知情并选择接受）**：
    //    面板上"我没开自动压缩"**不再等于**"绝不会压缩"。
    //    而且面板里**没有"显式关闭"这个值**（只有"不在名单里"）⇒ 代码分不出
    //    "没设置"和"故意关掉"，两者都会被阀开火越过。
    //    想彻底关掉：把常量 `AUTO_COMPACT_ON_VALVE_ABORT` 改 `false` + 重启 web。
    //
    // ⚠️ **只多开这一道门，不是取消所有刹车**：冷却（10 分钟）、`pendingCompacts`、
    //    `QUARANTINED`、`recentAgents`、busy 重试**全部照旧生效**。
    //
    // ✅ **安全性已验（2026-10-09，不再靠推测）**：压缩**不会**吃掉阀留在队里的那条
    //    `⟪loop-valve⟫` 消息 —— ① 源码：`selectCompactableRange` 只取 `session.surface.nodes`，
    //    而队列消息在 `agent.inbox` 里、尚未落地 ⇒ 两者不相交；
    //    ② 端到端：用户 17:44:54 手动压缩该会话，队列里正躺着那条消息，**压缩照样成功**
    //    （`Compacted 566 history items (~156549 tokens)`）。
    //    另：阀 `cancel` 带的是 `keepInbox: true`，那条消息是**有意保下来**的。
    if (!valveFired && runtime.sessionModes[sessionId] !== 'auto') return
    // 🆕 图片水位（2026-10-14）：与 token 压力门**并列**的另一条"到点"判据。
    //    能走到这里的会话要么被标了 `auto`、要么是阀开火 ⇒ auto 会话靠压缩续命，图片撑到水位就压。
    //    ⚠️ 压缩对图片是**折半**（不是清零，铁证 session-8a5b6135：压前 95 张被 400 拒 → 压后又读 21 张）
    //       ⇒ 16 MB 压完约剩 8 MB，不会立刻再次触发；10 分钟冷却另有一道兜底。
    const imageMb = runtime.imageWatermark !== false ? imageMbOf(sessionId) : 0
    const imageOver = imageMb >= IMAGE_WATERMARK_MB
    if (imageOver) {
      ctx.logger.info(
        `[auto-checkpoint] image watermark crossed for ${sessionId}: ` +
          `${imageMb.toFixed(1)} MB ≥ ${IMAGE_WATERMARK_MB} MB — compacting (auto mode)`,
      )
    }
    const threshold = Number(runtime.remindTokens)
    const thresholdOk = Number.isFinite(threshold) && threshold > 0
    // 图片水位要能**单独**把压缩拉起来 ⇒ remindTokens 非法/为 0 时不该拦住它。
    if (!valveFired && !imageOver && !thresholdOk) return note('no-threshold', 'remindTokens 不合法')
    const st = stateFor(sessionId)
    // ── 交棒态：只拦「进行中」，**放开 parked**（2026-10-10 修，用户报的三个卡死案例）──
    // 原来 `QUARANTINED`（`parked` / `handoff-pending`）**一律**拦压缩，造出**死锁**：
    //   压力超 `taskBoundary`(350000) ⇒ 模型写交接检查点 ⇒ `setPhase('parked')`
    //   ⇒ 压缩被这道门拦住；而"下一棒"那个回合又被 pre-step 拒绝（`turn/end blocked`）
    //   ⇒ 会话**既不压、也不换**，挂在 354K 上下文上，而且**全程静默**（见 note() 的修复）。
    // 实测铁证：`session-7e73f1e7`（10-10 00:10，cwd `/root/aa/千星2D`）——
    //   `~/.dsh/auto-checkpoint-state.json` 里它的 phase = `parked`、压力 354133、
    //   `precompact-7e73f1e7.md` 已写好，**就差压缩那一步**；同文件 **48 条记录全是 parked**
    //   ⇒ **每个交棒过的会话都中招**，不是个案。
    // 为什么放开 `parked` 是安全的：压缩只折叠 `session.surface`（内存历史），
    //   **不动工作区的文件** —— 而交棒的下一棒读的正是 `checkpoint-<sid>.md`（文件），
    //   不依赖这条会话的历史；压缩成功后 `deliverReanchor` 照旧把接棒词投回来（那条路没动）。
    // 保留 `handoff-pending`：交棒**进行中**（检查点可能正写到一半），这时压缩纯属干扰。
    if (st.phase === 'handoff-pending') {
      return note('quarantined', '交棒进行中（handoff-pending），等它落定再压')
    }
    const agent = recentAgents.get(sessionId)
    if (agent === undefined) return note('no-agent', '插件进程里没有这条会话的 agent 引用')
    if (pendingCompacts.has(sessionId)) return note('pending', '已有一次压缩在飞')
    pendingCompacts.add(sessionId)
    const endedAt = Number.isFinite(turnEndedAt) ? turnEndedAt : Date.now()
    const startedWaiting = Date.now()
    let busyRetries = 0
    try {
      // 先按老规矩歇一下：回合落盘 ≠ 内部状态全部释放（v2 实测出来的余量，别删）。
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs()))
      for (;;) {
        // 冷却与压力**每一轮都重判**：等待期间会话可能又跑了别的回合、压力也变了。
        const now = Date.now()
        if (Number.isFinite(st.lastAutoCompactMs) && now - st.lastAutoCompactMs < cooldownMs()) {
          return note('cooldown', `冷却中：距上次自动压缩不足 ${Math.round(cooldownMs() / 60000)} 分钟`)
        }
        const startedAt = lastTurnStartMs.get(sessionId)
        if (Number.isFinite(startedAt) && startedAt > endedAt) {
          // 还在自动续跑（goal driver）⇒ agent 不空闲，压了必被拒。只等，不试。
          if (now >= startedWaiting + maxWaitMs()) {
            ctx.logger.info(
              `[auto-checkpoint] auto compact gave up waiting for an idle window on ${sessionId} ` +
                `after ${Math.round((now - startedWaiting) / 1000)}s (session keeps auto-continuing)`,
            )
            return note('no-idle-window', `会话一直在自动续跑，等了 ${Math.round((now - startedWaiting) / 1000)} 秒仍无空闲窗口`)
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs()))
          continue
        }
        let pressure = NaN
        try {
          pressure = ctx.tokenMeter.measure(agent.session ?? session).totalTokens
        } catch {
          pressure = NaN
        }
        // 量不出来就别动（原行为；`runAutoCompact` 拿 pressure 记日志，NaN 没意义）
        if (!Number.isFinite(pressure)) return note('no-pressure', '量不出上下文大小（tokenMeter 抛错）')
        // 压力门：阀开火时**跳过** —— "污染最重"与"token 最多"不是同一个时刻，
        // 等阈值就意味着那 559 行污染会被原样带进下一轮。
        // 🆕 2026-10-14：图片水位与它是**并列**关系（图片撑爆是另一条独立的死法，token 可能远没到）。
        // 等待期间会话可能又读了图 ⇒ 这里**每一轮重算**，与 pressure 同一套"重判"口径。
        const imageOverNow = runtime.imageWatermark !== false && imageMbOf(sessionId) >= IMAGE_WATERMARK_MB
        if (!valveFired && !imageOverNow && pressure < threshold) return
        // ── 压缩前落档（2026-10-09，用户拍板走 B 方案）────────────────────────────
        // 顺序：**先确认该压 → 再看落档写了没 → 写了才压**。
        // 放在压力门之后：不该压的时候催模型写文档，纯属白烧一轮 token。
        //
        // 🛑 **落档要额外过一道 `sessionModes` 门**（同日第二次改，用户拍板 B）：
        //   上面那道门在**阀开火时会被跳过**（`if (!valveFired && …optin…)`），
        //   于是**未标记的会话**也会走到这里。而用户的设计原则是
        //   「默认全关、只干**手动标记过**的会话」—— 落档不该是例外：
        //   未标记的会话被阀掐断后**直接压**，不额外多跑一轮去写文档。
        if (runtime.sessionModes[sessionId] === 'auto') {
          const noteSize = await freshPreflightSize(agent, st)
          if (noteSize > 0) {
            // 🛑 用户拍板（2026-10-11）：落档里出现交棒意图 ⇒ **只提醒用户、不自动开**。
            //    ⚠️ 这条检测**绝不改变压缩行为** —— 下面该怎么压还怎么压（压缩不该换会话）。
            void detectHandoffIntent(agent, st, 'preflight').catch(() => {})
          }
          if (noteSize <= 0) {
            const asks = Number.isFinite(st.preflightAsks) ? st.preflightAsks : 0
            if (asks < PRECOMPACT_MAX_ASKS) {
              // 催一次就收手 —— 模型会在自己那一轮里写文件，写完的 turn/end 会再进这个函数。
              if (await requestPreflightNote(agent, session, pressure, threshold)) {
                return note(
                  'preflight',
                  `已要求先落档（第 ${asks + 1}/${PRECOMPACT_MAX_ASKS} 次，目标 ` +
                    `${PRECOMPACT_PATH_TEMPLATE.replace('{{session}}', sessionId.slice(-8))}）—— 写完再压`,
                )
              }
              // 投递失败（没有 sessionController 之类）：**不设 preflightAtMs**，往下走照压。
              // 不能因为"落档这条路不通"就把压缩一起卡死。
            } else {
              // 催满了还不写 ⇒ **照压不误**。没有这个上限就是"压力超了却永远不压"的死循环，
              // 比不落档更糟（上下文会一直涨到撑爆）。
              ctx.logger.warn(
                `[auto-checkpoint] pre-compact note still missing after ${asks} asks for ${agent.id} ` +
                  `(target ${preflightAbspath(agent)}); compacting anyway`,
              )
            }
          }
        }
        const outcome = await runAutoCompact(agent, pressure, thresholdOk ? threshold : 0)
        if (outcome === 'busy') {
          // 本地准入拒绝：不写冷却、不记失败。但**也不无限重试** —— 见 AUTO_COMPACT_BUSY_RETRIES。
          busyRetries += 1
          if (busyRetries > AUTO_COMPACT_BUSY_RETRIES) {
            return note('busy', `本地准入连续拒绝 ${busyRetries} 次，放弃（会话一直不空闲）`)
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs()))
          continue
        }
        if (outcome === 'ok') {
          // 压完了 ⇒ 落档状态归零，下一次压缩前重新要一份。
          // 不归零的话，第二轮会因为 `preflightAsks` 还停在 2 而**直接跳过落档** ——
          // 第一次有效、之后次次失效，是最难发现的那种坏法。
          st.preflightAsks = 0
          st.preflightAtMs = 0
          // 把"上下文从多少变多少"也记下来 —— 这是用户唯一能直观看到压缩效果的数字。
          let after = NaN
          try {
            after = ctx.tokenMeter.measure(agent.session ?? session).totalTokens
          } catch {
            after = NaN
          }
          return note(
            'done',
            Number.isFinite(after)
              ? `已压缩：${Math.round(pressure / 1000)}k → ${Math.round(after / 1000)}k token`
              : `已压缩（压缩前 ${Math.round(pressure / 1000)}k token）`,
          )
        }
        return note('error', '压缩没有成功（失败详情只在插件日志里，不落 web.log）')
      }
    } finally {
      pendingCompacts.delete(sessionId)
    }
  }

  async function deliverReanchor(session, event) {
    if (!reanchorAfterCompact || !runtime.enabled) return
    if (event?.type !== 'compaction/end') return
    if (event.data?.error !== undefined) return
    const compactionId = event.data?.compactionId
    const sessionId = session?.id
    if (typeof compactionId !== 'string' || typeof sessionId !== 'string') return
    const st = stateFor(sessionId)
    if (st.reanchoredCompactionId === compactionId) return
    // 已交棒 / 正在交棒的会话不许被自动消息吵醒（与 pre-step 的门禁同一条规矩）。
    if (QUARANTINED.has(st.phase)) return
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt !== 'function') return
    // 先占位再投递：投递是异步的，占位能挡住"投递还没回来、pre-step 已经注入一条"的竞态；
    // 投递失败时把占位清掉，让 pre-step 那条注入路径补上。
    st.reanchoredCompactionId = compactionId
    try {
      const text = await reanchorTextFor(session)
      await controller.prompt(
        {
          sessionId,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      ctx.logger.info(
        `[auto-checkpoint] post-compaction re-anchor DELIVERED as a user message ` +
          `(session ${sessionId}, compaction ${compactionId})`,
      )
    } catch (error) {
      if (st.reanchoredCompactionId === compactionId) st.reanchoredCompactionId = null
      throw error
    }
  }

  /**
   * 把「自动压缩」降级为「只提醒」（2026-10-07 加，用户拍板「加保险」）。
   *
   * 触发条件见 `AUTO_COMPACT_MAX_FAILS`。降级是**三件事**，缺一不可：
   * ① 改内存里的 `sessionModes`（立刻停止再试）；② 落盘（否则 web 一重启又变回 auto）；
   * ③ 往会话里注入一条说明 —— 日志用户看不到，只改配置他会以为"功能坏了"。
   */
  async function downgradeToRemind(agent, detail) {
    const sessionId = agent.id
    if (runtime.sessionModes[sessionId] !== 'auto') return
    runtime.sessionModes[sessionId] = 'remind'
    try {
      await saveRuntimeFile(runtime)
    } catch (error) {
      ctx.logger.warn(
        `[auto-checkpoint] downgrade PERSIST FAILED for ${sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    ctx.logger.warn(`[auto-checkpoint] auto compact DOWNGRADED to remind (${sessionId}): ${detail}`)
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt !== 'function') return
    const text = [
      '[auto-checkpoint] ⚠️ 本会话的「到点自动压缩」已经停手',
      '',
      `连续 ${AUTO_COMPACT_MAX_FAILS} 次压缩失败，我已把这条会话改回 **只提醒**，不会再自动重试。`,
      '',
      '最后一次的失败原文：',
      `> ${detail}`,
      '',
      '**最可能的原因**：压缩要把整段历史发给模型，所以会话越大、对模型窗口要求越高。',
      '此刻若停在 10 万窗口的模型上，超过 10 万的会话就压不动（实测报 prompt is too long）。',
      '',
      '你可以：① 换一个窗口更大的模型，再手动 `/compact` 一次；',
      '② 或者就这样继续用 —— 到阈值我只提醒你，不再动手。',
      '',
      '（这条是插件发的通知，不是用户说的话，不必回复。）',
    ].join('\n')
    try {
      await controller.prompt(
        {
          sessionId,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
    } catch (error) {
      ctx.logger.warn(
        `[auto-checkpoint] downgrade NOTICE FAILED for ${sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 到阈值自动压缩（2026-10-07 第二次改，用户拍板：默认全关、只干他标记过的会话）。
   *
   * 走 `ctx.commands.execute(agent, '/compact', …)` 而不是直接调 `ctx.compaction`：
   * 官方 `/compact` 命令内部就是 `ctx.compaction.compactNow(agent, …)`
   * （见 `@deepseek-ai/dsh-command-compact`），但那个服务被 `isolate` 在 preset 的
   * realm 里（cordis.patch.yml 的 `compaction` group），**根 ctx 拿不到它**；
   * 而 commands 是全局注册表（api-catalog: "Plain-context definitions are global"），
   * 这条路不受 realm 隔离影响。`canCompact` 自检字段就是用来确认这点的。
   *
   * 不阻塞 pre-step：压缩要跑 30 秒左右，这里 fire-and-forget。
   * 成功清零失败计数；计数到 `AUTO_COMPACT_MAX_FAILS` 调 `downgradeToRemind` 停手。
   * 冷却由调用点负责 ⇒ 两次失败至少隔一个冷却期 ⇒ 最坏只多烧 1 次请求。
   */
  /**
   * 手动压缩（`/compact`）也要**先落档**（2026-10-10，用户拍板）。
   *
   * 为什么能拦住：官方 `/compact` 命令的 handler 里只有
   * `ctx.compaction.compactNow(agent, signal, commandId)`，而 `compaction` 服务被
   * `isolate` 在 preset 的 realm 里 —— **根 ctx 拿不到它**，包不了。
   * 但**手动和自动都必经 `commands.execute`**（全局服务，我们拿得到）：
   * dsh-commands 的 `execute()` 自己 `parseCommand(line)` → append `command/run`
   * → 调 `definition.handler`。所以在这一层包一道闸门，两条路一次覆盖。
   *
   * 🛑 自锁：自动路径（`runAutoCompact`）也调 `commands.execute('/compact')`。
   * 本闸门会把 `preflightAtMs` 推到现在 ⇒ 刚落好的档被判成"过期" ⇒ 再催一次 ⇒
   * **死循环**。所以 `installManualCompactGate()` 把原方法存进 `rawCommandsExecute`，
   * 自动路径走那一份，**永远不经过闸门**。
   *
   * 🛑 只做加法：闸门里任何失败（取不到 session、投递失败、等超时）都**必须放行压缩**。
   * 落档是保险、不是前提 —— 卡死压缩比不落档更糟（上下文会一直涨到撑爆）。
   */
  let rawCommandsExecute = null
  let manualCompactGateState = 'pending'
  // 闸门**实际被调用**的次数（不是"装上了"）—— 这是判"前端 RPC 有没有走这层包装"的硬判据。
  let manualGateHits = 0
  // 闸门为"等落档那一轮收尾"而做的 busy 重试次数（累计）。正常应为 0–2；
  // 一直涨说明 agent 长时间不空闲，压缩会一直压不下去（错误会原样交回前端）。
  let manualGateBusyRetries = 0
  // 等落档**文件写出**的上限。原来 5 分钟太长 —— 实测 `cc6c6151` 第二次按压缩时，
  // 模型看到落档文件已存在就只读不写，闸门空等满上限才放行（用户观感="没动静了"）。
  const MANUAL_PRECOMPACT_WAIT_MS = 2 * 60 * 1000
  const MANUAL_PRECOMPACT_POLL_MS = 1500
  // 落档**可复用的新鲜窗口**（2026-10-10，`cc6c6151` 真机踩坑驱动）：
  // 30 分钟内已经落过档 ⇒ 直接拿它压缩，**不再要求重写**。
  // 为什么必须有：用户连按两次压缩、或第一次被 busy 拒掉后再按 —— 文件已经躺在那里，
  // 模型**不会重写**（它会回一句「落档完成」就结束那一轮），而"只认本次催之后写的档"
  // 的判据会**死等一个永不出现的文件**。
  // 30 分钟足够新（挡得住真正的旧档），也覆盖了"同一次压缩意图下的连续重试"。
  const MANUAL_PRECOMPACT_REUSE_MS = 30 * 60 * 1000
  // 文件写出后，再等落档那一轮**收尾**的上限（见 lastTurnEndMs）。
  const MANUAL_PRECOMPACT_IDLE_WAIT_MS = 90 * 1000
  const MANUAL_COMPACT_RE = /^\s*\/compact(?:\s|$)/
  // 放行压缩后的 busy 重试（兜底）。
  // 主力判据已经换成"等一个 turn/end"（见 ④ 与 lastTurnEndMs）—— 实测 `5bf1f15d`
  // 那时还没有它，界面上连跳了 6 行红字才成功。这里只留少量兜底：
  // 万一 turn/end 之后 agent 又被续跑（goal 会话就会），还是要留第二次机会。
  // 真不行就把错误原样交回前端（**不假装成功**）。
  const MANUAL_COMPACT_BUSY_RETRIES = 3
  const MANUAL_COMPACT_BUSY_POLL_MS = 2000

  async function ensurePreflightNoteBeforeManualCompact(agent, signal) {
    const session = agent?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 'no-session'
    if (!runtime.enabled) return 'disabled'
    const st = stateFor(agent.id)
    const startedAt = Date.now()
    // ① 已有**新鲜**落档 ⇒ 直接复用，不再要求重写（见 MANUAL_PRECOMPACT_REUSE_MS）。
    st.preflightAtMs = startedAt - MANUAL_PRECOMPACT_REUSE_MS
    if ((await freshPreflightSize(agent, st)) > 0) {
      st.preflightAtMs = 0
      return 'reused'
    }
    // ② 需要一份新的：判据收紧到"本次催之后写的"（旧文件立刻算过期）。
    st.preflightAtMs = startedAt
    st.preflightAsks = 0
    let pressure = NaN
    try {
      pressure = ctx.tokenMeter.measure(session).totalTokens
    } catch {
      pressure = NaN
    }
    const threshold = Number(runtime.remindTokens)
    const asked = await requestPreflightNote(
      agent,
      session,
      Number.isFinite(pressure) ? pressure : 0,
      Number.isFinite(threshold) ? threshold : 0,
    )
    if (!asked) {
      st.preflightAtMs = 0
      return 'ask-failed'
    }
    // ③ 等落档**文件写出**。
    // 这段等待会让前端的 `/compact` RPC 一直挂着 ⇒ 必须尊重它的取消信号：
    // 用户点了停止、或前端自己超时，就**立刻收手**，别在已取消的 signal 上继续等。
    const deadline = Date.now() + MANUAL_PRECOMPACT_WAIT_MS
    let written = false
    for (;;) {
      if ((await freshPreflightSize(agent, st)) > 0) {
        written = true
        break
      }
      if (signal?.aborted) return 'aborted'
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, MANUAL_PRECOMPACT_POLL_MS))
    }
    if (!written) {
      // 没等到文件也**不能卡死压缩**（可能只是模型失误）。往下走去等收尾、照压。
      ctx.logger.warn(
        `[auto-checkpoint] manual /compact gate: pre-compact note not written for ${agent.id} ` +
          `(waited ${MANUAL_PRECOMPACT_WAIT_MS}ms); compacting with whatever note exists`,
      )
    }
    // ④ 再等落档那一轮**收尾**才放行 —— 否则 `compactNow` 的本地准入必然拒绝
    //    （模型写完文件还要回一句「落档完成」才 turn/end，见 lastTurnEndMs 的注释）。
    const idleDeadline = Date.now() + MANUAL_PRECOMPACT_IDLE_WAIT_MS
    for (;;) {
      if ((lastTurnEndMs.get(sessionId) ?? 0) >= startedAt) {
        return written ? 'written+idle' : 'stale+idle'
      }
      if (signal?.aborted) return 'aborted'
      if (Date.now() >= idleDeadline) return written ? 'written(no-idle)' : 'timeout'
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  /**
   * 把手动 `/compact` 接到落档闸门上。
   *
   * ⚠️ 装不上**不报错、不影响任何功能**：`commands.execute` 带 `@Remote` 装饰，
   * 前端 RPC 派发究竟是走 `obj.execute(...)`（实例属性遮蔽 prototype getter ⇒ 生效）
   * 还是走保存好的原型引用（⇒ 只影响本地调用者），**静态读代码定不了，必须真机验**。
   * 所以这里必须能失败，且失败后一切照旧。自检字段 `manualCompactGate` 就是给这件事用的。
   */
  function installManualCompactGate() {
    const commands = ctx.get('commands')
    if (typeof commands?.execute !== 'function') {
      manualCompactGateState = 'no-commands'
      ctx.logger.warn('[auto-checkpoint] manual compact gate skipped: commands.execute unavailable')
      return
    }
    if (rawCommandsExecute !== null) return
    const original = commands.execute
    rawCommandsExecute = original
    const gated = async function (agent, line, attachments, signal) {
      try {
        if (MANUAL_COMPACT_RE.test(String(line ?? ''))) {
          // 命中计数：**这是"闸门真的拦到前端 RPC 了吗"的唯一硬判据**。
          // 'installed' 只证明实例属性赋值成功，不证明 Typert 的 RPC 派发走了它。
          manualGateHits += 1
          const outcome = await ensurePreflightNoteBeforeManualCompact(agent, signal)
          ctx.logger.info(
            `[auto-checkpoint] manual /compact gate: pre-compact note ${outcome} ` +
              `for ${agent?.id ?? '?'}`,
          )
        }
      } catch (error) {
        // 闸门自身出错绝不阻塞压缩。
        ctx.logger.warn(
          `[auto-checkpoint] manual /compact gate errored (compacting anyway): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // 🛑 落档写完 ≠ 那一轮结束（模型还要回一句「落档完成」才 turn/end）。
      // 2026-10-10 00:52 真机实测：文件 00:52:08 写出，**同一秒**放行的压缩被本地准入拒绝 ——
      // "Compaction is unavailable because this process has an active compaction, or the agent
      // is not idle." ⇒ 用户看到的是"按了压缩却什么都没发生"。
      // 所以这里**自己吃掉 busy 重试**：判据是 execute 的返回值，不是猜延迟。
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await original.call(commands, agent, line, attachments, signal)
        const result = outcome?.result ?? outcome
        const text = String(result?.text ?? '')
        if (result?.kind !== 'error' || !AUTO_COMPACT_BUSY_RE.test(text)) return outcome
        if (attempt >= MANUAL_COMPACT_BUSY_RETRIES || signal?.aborted) return outcome
        manualGateBusyRetries += 1
        ctx.logger.info(
          `[auto-checkpoint] manual /compact deferred (admission busy), ` +
            `retry ${attempt + 1}/${MANUAL_COMPACT_BUSY_RETRIES}`,
        )
        await new Promise((resolve) => setTimeout(resolve, MANUAL_COMPACT_BUSY_POLL_MS))
      }
    }
    try {
      commands.execute = gated
      manualCompactGateState = 'installed'
      ctx.logger.info('[auto-checkpoint] manual /compact gate installed (pre-compact note required)')
    } catch (error) {
      rawCommandsExecute = null
      manualCompactGateState = 'failed'
      ctx.logger.warn(
        `[auto-checkpoint] manual /compact gate NOT installed (compaction unaffected): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  installManualCompactGate()

  /**
   * ── goal 让路（2026-10-11 加，用户拍板选 C）──
   *
   * 症状（实测 `session-7e73f1e7`）：goal 会话在 `turn/end` 之后**同一秒**就被
   * `<goal_round>` 续跑（09:21:01 / 09:29:43 / 09:36:49 三次全是同一秒）⇒
   * **agent 永远不空闲** ⇒ `compactNow` 的本地准入必然拒绝 ⇒ 自动压缩干等到
   * **460k**，最后是用户自己看到水位手动压的（还先撞了四连败）。
   *
   * 对策：打算压缩时**主动暂停 goal** —— driver 不再排新一轮，当前那一轮跑完
   * 会话就真的空闲了，压缩窗口才会出现。压成功后立刻恢复。
   *
   * ⚠️ 为什么不是"暂停 → 立刻压 → 立刻恢复"：当前 round 还要跑几分钟
   * （实测一轮 7–8 分钟），那一瞬间仍是 busy。所以暂停状态必须**跨多次轮询保持**，
   * 用 `st.goalPausedForCompactAt` 记时间戳，超过 `GOAL_PAUSE_MAX_MS` **无条件恢复**
   * —— 绝不能让用户的 goal 被这个插件永久停住。
   *
   * ⚠️ 恢复前必查两个条件：**phase 仍是 `paused`** 且 **仍是同一个 goal** ——
   * 否则可能把用户自己手动暂停的 goal 硬拉起来，或抢在用户操作之后乱动。
   */
  const GOAL_PAUSE_MAX_MS = 10 * 60 * 1000

  /**
   * 暂停会话的 active goal（为压缩让路）。
   *
   * @returns 真暂停了就返回那个 goal 的 id；没暂停（无 goal / 本来就 paused / 服务不可用）
   *   返回 `null` —— 调用方**只在拿到 id 时才记时间戳**，避免拿一个没生效的暂停去超时。
   */
  function pauseGoalForCompact(agent) {
    try {
      const goals = ctx.get('goals')
      if (typeof goals?.get !== 'function' || typeof goals?.pause !== 'function') return null
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active') return null
      goals.pause(agent, { id: goal.id, revision: goal.revision })
      ctx.logger.info(
        `[auto-checkpoint] 为压缩让路：暂停 goal ${goal.id}（${agent.id}），压完恢复`,
      )
      return goal.id
    } catch (error) {
      // goal 记账绝不能挡压缩：暂停失败就照常压（大不了再等窗口）。
      ctx.logger.warn(
        `[auto-checkpoint] goal 暂停失败（不影响压缩）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  /** 恢复 goal —— 只在"它仍是 `paused` 且还是我们暂停的那一个"时才动手。 */
  function resumeGoalAfterCompact(agent, expectedId) {
    try {
      const goals = ctx.get('goals')
      if (typeof goals?.get !== 'function' || typeof goals?.resume !== 'function') return
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'paused') return
      if (typeof expectedId === 'string' && goal.id !== expectedId) return
      goals.resume(agent, { id: goal.id, revision: goal.revision })
      ctx.logger.info(`[auto-checkpoint] 压缩让路结束：恢复 goal ${goal.id}（${agent.id}）`)
    } catch (error) {
      ctx.logger.warn(
        `[auto-checkpoint] goal 恢复失败（它会停在 paused，需要手动 resume）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function runAutoCompact(agent, pressure, threshold) {
    const commands = ctx.get('commands')
    if (typeof commands?.execute !== 'function') {
      ctx.logger.warn('[auto-checkpoint] auto compact skipped: commands.execute is unavailable in this context')
      return
    }
    const st = stateFor(agent.id)
    ctx.logger.info(
      `[auto-checkpoint] auto compact START for ${agent.id} ` +
        `(pressure ${Math.round(pressure)} ≥ remindTokens ${Math.round(threshold)})`,
    )
    // ── goal 让路（见 GOAL_PAUSE_MAX_MS 的注释）──
    // 已暂停的（上一次轮询暂停的）就**保持**：当前 round 跑完会话才真空闲，
    // 那一刻压缩才可能成功。超过上限则无条件恢复（绝不永久停住用户的 goal）。
    const goalPausedAt = Number.isFinite(st.goalPausedForCompactAt) ? st.goalPausedForCompactAt : 0
    if (goalPausedAt > 0 && Date.now() - goalPausedAt > GOAL_PAUSE_MAX_MS) {
      ctx.logger.warn(
        `[auto-checkpoint] goal 为压缩让路已超 ${GOAL_PAUSE_MAX_MS / 60000} 分钟，` +
          `先恢复再说（否则用户的 goal 会被永久停住）`,
      )
      resumeGoalAfterCompact(agent, st.goalPausedForCompactId)
      st.goalPausedForCompactAt = 0
      st.goalPausedForCompactId = undefined
    } else if (goalPausedAt === 0) {
      const pausedGoalId = pauseGoalForCompact(agent)
      if (pausedGoalId !== null) {
        st.goalPausedForCompactAt = Date.now()
        st.goalPausedForCompactId = pausedGoalId
      }
    }
    // 成败判据**不能只看 catch**：`commands.execute` 的结算形态是
    // `{ commandId, result: { kind, text } }`（dsh-commands 的 settle()），而官方
    // `executeCompact` 把预期失败转成 `{ kind: 'error', text }` **直接返回、不抛异常**
    // （`@deepseek-ai/dsh-command-compact` 的 expectedFailure）。
    // ⇒ 只 catch 会把"压缩失败"记成"压缩成功"，保险永远不触发。
    // `outcome === undefined` = 语法或命令名没解析到；探针的假 execute 返回裸 result，
    // 所以 `outcome?.result ?? outcome` 两种形态都认。
    let ok = false
    let detail = ''
    try {
      // 走**未包装**的原方法：闸门会把 `preflightAtMs` 推到现在，自动路径撞上去
      // 会被判成"没落档" ⇒ 再催一次 ⇒ 死循环（见 installManualCompactGate 的注释）。
      const exec = rawCommandsExecute ?? commands.execute
      const outcome = await exec.call(commands, agent, '/compact', [], new AbortController().signal)
      const result = outcome?.result ?? outcome
      if (outcome === undefined) {
        detail = 'command did not resolve (no /compact reachable from this agent)'
      } else if (result?.kind === 'error') {
        detail = String(result.text ?? 'compaction reported an error')
      } else {
        ok = true
        detail = String(result?.text ?? 'ok')
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    if (ok) {
      st.autoCompactFails = 0
      // 只有**真压成功**才写长冷却（v3 的 A 部分：失败不再占冷却，见 AUTO_COMPACT_BUSY_RE）。
      st.lastAutoCompactMs = Date.now()
      // 压缩成功 ⇒ 立刻把 goal 还回去：让路结束，别让用户的目标白停着。
      if (Number.isFinite(st.goalPausedForCompactAt) && st.goalPausedForCompactAt > 0) {
        resumeGoalAfterCompact(agent, st.goalPausedForCompactId)
        st.goalPausedForCompactAt = 0
        st.goalPausedForCompactId = undefined
      }
      ctx.logger.info(`[auto-checkpoint] auto compact DONE for ${agent.id}: ${detail}`)
      return 'ok'
    }
    if (AUTO_COMPACT_BUSY_RE.test(detail)) {
      // 本地准入拒绝：没发上游请求、不烧钱、不算失败，交给调用方继续等窗口。
      ctx.logger.info(`[auto-checkpoint] auto compact deferred (admission busy) for ${agent.id}: ${detail}`)
      return 'busy'
    }
    const strikes = (Number.isFinite(st.autoCompactFails) ? st.autoCompactFails : 0) + 1
    st.autoCompactFails = strikes
    st.lastAutoCompactMs = Date.now()
    ctx.logger.warn(
      `[auto-checkpoint] auto compact FAILED for ${agent.id} ` +
        `(strike ${strikes}/${AUTO_COMPACT_MAX_FAILS}): ${detail}`,
    )
    if (strikes >= AUTO_COMPACT_MAX_FAILS) await downgradeToRemind(agent, detail)
    return 'failed'
  }

  ctx.on('agent/pre-step', async ({ agent, step, signal, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const st = stateFor(agent.id)

    // Parked / handoff-pending: reject automatic continuation steps (step > 1)
    // and every automatic injection, but always let a genuine human message
    // through (step 1 of a turn) — the checkpoint handoff must never freeze the
    // chat. Only that human message promotes the session to 'resumed': free
    // use, no more automatic checkpointing until the user re-arms it.
    //
    // Why the human test is load-bearing: a session-scoped goal makes the
    // goal-round-driver queue one `<goal_round>` per quiescence. Reading that
    // injected round as "the user is back" promoted a handed-off session to
    // 'resumed' and let it keep working beside its own successor — observed in
    // the wild as 20 minutes of concurrent edits in the same workspace, which
    // the user had to stop by hand.
    if (st.phase === 'parked' || st.phase === 'handoff-pending') {
      // ── 落档催办免疫 park 门（2026-10-11 加，用户拍板）──
      // 见 `claimsPrecompactNudge` 的注释：它不会造成"两个会话并发改同一个项目"，
      // 收益是"压缩前把细节落到文件里"（不落档就压 ⇒ 那段上下文只剩摘要）。
      // ⚠️ 放行它**不解 park**（只有真人消息才解）—— 写完落档，会话仍待在交棒状态。
      const precompactNudge = claimsPrecompactNudge(messages)
      if (!precompactNudge && (step > 1 || !claimedHumanMessage(messages))) {
        return { kind: 'reject' }
      }
      if (!precompactNudge && st.phase === 'parked') {
        await setPhase(st, 'resumed')
        st.confirmedPath = null
        st.reminderStep = step
        ctx.logger.info(`[auto-checkpoint] human message resumed parked session ${agent.id}`)
      }
      return decision
    }
    // ── 压缩后自动接棒（2026-10-06 新增，用户点名）──
    //
    // compact 成功（`compaction/end` 且无 `error`）之后，模型手里只剩一份摘要：
    // 项目文档地图、检查点内容、踩过的坑都不在里面了，此时最危险的行为是
    // **凭记忆接着干**。这里检测到"刚压完"就补一条接棒词，要它先读文件。
    //
    // 三条护栏：
    //   ① 只认**刚发生**的压缩（`REANCHOR_WINDOW` 序号窗口）—— 会话状态是内存态，
    //      只看"历史上压过"的话，web 一重启每个老会话都会被塞一句"你刚被压缩"。
    //   ② 同一个 `compactionId` 只注入一次（内存去重，天然幂等）。
    //   ③ 总开关 `reanchorAfterCompact`（配置里可关）。
    //
    // 位置刻意放在 parked 门禁**之后**、resumed 分支**之前**：已经交接出去的
    // 会话不许被任何自动消息吵醒；但"用户自己收回来的会话"压缩之后同样需要它。
    if (reanchorAfterCompact && runtime.enabled) {
      const compacted = lastSuccessfulCompaction(agent.session)
      const seq = agent.session?.seq
      if (
        compacted !== null &&
        compacted.id !== st.reanchoredCompactionId &&
        Number.isSafeInteger(seq) &&
        seq - compacted.seq <= REANCHOR_WINDOW
      ) {
        st.reanchoredCompactionId = compacted.id
        const text = await reanchorTextFor(agent)
        ctx.logger.info(
          `[auto-checkpoint] post-compaction re-anchor injected for ${agent.id} ` +
            `(compaction ${compacted.id}, seq ${compacted.seq} → ${seq})`,
        )
        return {
          ...decision,
          messages: [
            ...decision.messages,
            {
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: {
                kind: `plugin:${name}`,
                form: 'snapshot',
                sections: [{ name: 'auto-checkpoint', text }],
              },
            },
          ],
        }
      }
    }

    // ── 到阈值自动压缩：**触发点已搬走**（2026-10-07 第三次改）──
    //
    // 原来在这里当场压，实测**必失败**（agent 正忙 ⇒ `busy` 准入拒绝，见
    // `autoCompactAfterTurn` 的注释与 session-8ec526d7 的 seq 1764 / 1786 证据）。
    // 现在这里只**登记 agent**（`session/event` 只给 session、不给 agent），
    // 真正的判定与执行都在 `turn/end` 之后的 `autoCompactAfterTurn` 里。
    // 原来的三道保险（没标记跳过 / 阈值≤0 跳过 / 冷却防无限重试）原样保留在那里。
    recentAgents.set(agent.id, agent)

    // 'resumed': the session was handed off and the user took it back —
    // plain chat, no automatic checkpointing until re-armed.
    if (st.phase === 'resumed') return decision
    if (st.phase === 'checkpoint-only') return decision
    if (st.phase !== 'watching' && st.phase !== 'requested') return decision
    if (!runtime.enabled) return decision

    // ── 勾了「自动压缩」的会话 ⇒ 交棒让路（2026-10-11 用户拍板，二选一）──
    // 用户原话：「如果不选该会话自动压缩，那自动交接棒那些机制就正常运行；选了就不要运行了」。
    // 所以这里是**二选一**，不是两个各自独立的开关：
    //   · 勾了 `auto` = 这个会话要一直活着、靠压缩续命 ⇒ **交棒整条路不走**
    //     （不催写检查点、不开新会话、不冻结旧会话）；
    //   · 没勾       = 这个会话可以换人 ⇒ 交棒照常运行。
    // ⚠️ 只拦**发起**：`st.phase === 'watching'` 才拦。已经在 `requested`
    //   （检查点催过了）或 `handoff-pending`（交棒已经在飞）的会话**必须走完** ——
    //   半途停下会卡在"催了不认、也不换"的死状态。
    //   ⇒ 中途改勾选：本轮照旧走完，下一次从 `watching` 重新开始才生效。
    // 📌 为什么要有这道门（2026-10-11 事故）：交棒原先是**无条件**的，
    //   实测 48 个**从未勾选过**的会话被它换掉、旧会话冻结成 `parked`
    //   （用户报"压缩之后干着干着突然停在调用工具"）。勾选只管压缩、不管交棒 = 名不副实。
    if (st.phase === 'watching' && runtime.sessionModes[agent.id] === 'auto') return decision

    let total
    try {
      total = ctx.tokenMeter.measure(agent.session).totalTokens
    } catch {
      return decision
    }
    // ── 触发判定（2026-09-21 改：两条路，任一成立即触发）──
    //
    // ① 压力阈值（原有行为）：total >= triggerTokens
    // ② 任务边界（新增）：刚完成一个 todo 任务，且 total >= taskBoundaryTokens
    //
    // ② 的意义是把交接点从"压力越线的随机位置"移到"任务与任务的接缝"——
    // 下一棒拿到的是"一件事刚做完"的现场，而不是"改了三行还没跑测试"。
    //
    // ⚠️ 两条路的**门槛不同是故意的**：② 更早触发（默认 150k vs 300k），
    //    因为任务边界是更好的交接时机，值得提前交。
    // ⚠️ taskBoundaryTokens <= 0 时 ② 整体关闭，行为退回纯阈值模式。
    if (!Number.isFinite(total)) return decision
    const overPressure = total >= runtime.triggerTokens
    const boundaryEnabled = Number.isFinite(runtime.taskBoundaryTokens) && runtime.taskBoundaryTokens > 0
    const atBoundary =
      boundaryEnabled && total >= runtime.taskBoundaryTokens && justCompletedTask(agent.session)
    // 🆕 图片水位（2026-10-14 用户拍板）：图片体积是**另一条独立的死法** —— 实测 22 张 / 21.76 MB
    //    就把会话沉默卡死（`pi-ai stream idle timeout`，**连 400 都不给**），而那时 token 可能远没到阈值。
    //    ⇒ 与 token 两条路**并列**：命中就走**同一条既有链路**（催写检查点 → 确认文件新鲜 → 换新会话），
    //      **不新增第二种交棒机制**（2026-10-11 那条教训：watching 阶段认文件必须靠 askedAtMs 锚点，
    //      而锚点正是在下面 `setPhase('requested')` 那里盖的）。
    //    ⚠️ auto 名单里的会话在这之前已经 return（用户 2026-10-11 拍板"压缩与交棒二选一"）
    //       ⇒ 这里只服务"交棒"那条路；auto 会话的图片处置在 autoCompactAfterTurn 里。
    const imageMb = runtime.imageWatermark !== false ? imageMbOf(agent.id) : 0
    const imageGateOpen = imageMb >= IMAGE_WATERMARK_MB
    if (imageGateOpen) {
      ctx.logger.info(
        `[auto-checkpoint] image watermark crossed for ${agent.id}: ` +
          `${imageMb.toFixed(1)} MB ≥ ${IMAGE_WATERMARK_MB} MB — asking for a checkpoint`,
      )
    }
    const pressureGateOpen = overPressure || atBoundary || imageGateOpen
    // 🛑 2026-10-11 修「交棒被 token 水位绑架」（会话 cd4feb96 查实，代码级）：
    //    水位门只管「发起」（watching → requested）。**一旦 `requested`，就再也不看水位** ——
    //    否则自动压缩把 token 压回阈值以下之后，每一步都在这里早退，
    //    已经写好的检查点永远走不到下面的「文件写好了吗」确认分支
    //    （实测：00:51:03 写好检查点 → 01:18 被压缩 463,759 → 68,311 → 此后每步早退 ⇒ 永不交棒）。
    //    ⚠️ 只放宽 `requested`，**不给 `watching` 增加任何触发点** ——
    //    watching 阶段的 state 没有 `askedAtMs` 锚点（`freshCheckpointSize` 会降级成 `size > 0`），
    //    在那里认文件等于「工作区里躺着一份旧检查点就交棒」，会误伤正在用的会话。
    if (st.phase === 'watching' && !pressureGateOpen) {
      // 🛑 用户拍板（2026-10-11）：「落档/检查点里出现交棒意图 → **只提醒用户、不自动开**」。
      //    提醒放在**这里**（水位门关着 = 这一轮不会交棒）：压力够的时候正规交接马上就发生，
      //    再问一句"要不要交棒"纯属多嘴。
      //    ⚠️ 这条分支**只注入一句话**：不调 handoff()、不改 phase —— 下面的确认/交接分支才是那条路。
      if (st.pendingHandoffNote) {
        const note = st.pendingHandoffNote
        st.pendingHandoffNote = null
        const text =
          `[auto-checkpoint·请转告用户] 我在 \`${note.file}\` 里读到了**交棒意图**` +
          `（命中「${note.hit}」；来源：${note.which === 'preflight' ? '压缩前落档' : '交接检查点'}）。\n` +
          `🛑 按 2026-10-11 用户拍板的规矩：**插件只提醒、绝不自动开新会话** ——\n` +
          `   ① 压缩前落档（\`precompact-*.md\`）里天然常带"下一棒"字样，而**压缩不该换会话**；\n` +
          `   ② 会话自己喊"请开新会话"然后停住时，**该由人来决定**（别替用户换会话）。\n` +
          `👉 所以现在**不要自己调 handoff.sh** —— 请把这句话原样告诉用户：\n` +
          `   「这个会话的落档里写着想交棒，要我开新会话接手吗？要的话说一声，我调 handoff.sh。」\n` +
          `（每个来源每 15 分钟最多提醒一次，不会刷屏。）`
        return {
          ...decision,
          messages: [
            ...decision.messages,
            {
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: {
                kind: `plugin:${name}`,
                form: 'snapshot',
                sections: [{ name: 'auto-checkpoint', text }],
              },
            },
          ],
        }
      }
      return decision
    }
    if (st.phase === 'requested' && !pressureGateOpen) {
      ctx.logger.info(
        `[auto-checkpoint] pressure released (${Math.round(total)} < ${Math.round(runtime.triggerTokens)}) ` +
          `but phase=requested: still confirming the checkpoint written earlier`,
      )
    }

    // Threshold crossed while watching: ask the model to write the file.
    if (st.phase === 'watching') {
      // 🛑 先给上一份留档，再让模型写新的（且必须早于 `askedAtMs` 盖戳）——
      //    否则同一会话的第二次检查点会整个吃掉第一次。详见 archivePreviousCheckpoint。
      await archivePreviousCheckpoint(agent, st)
      await setPhase(st, 'requested')
      st.reminderStep = step
      // Stamp the request time so the confirmation below can tell a genuinely
      // re-written checkpoint from a stale one left by the previous session.
      st.askedAtMs = Date.now()
      // 🆕 图片水位触发时**别再说"上下文压力已达 X token"** —— 那句话在图片这条路上是假的，
      //    而写死的错话会主动误导下一棒（AGENTS §6.4 的教训）⇒ 按真实触发原因写 header。
      const header = imageGateOpen && !overPressure && !atBoundary
        ? `[auto-checkpoint] 这个会话的**图片体积已达 ${imageMb.toFixed(1)} MB**` +
          `（图片水位 ${IMAGE_WATERMARK_MB} MB；token 只到 ${Math.round(total)}）。\n` +
          `⚠️ 图片是**另一条独立的死法**：体积撑爆请求体 ⇒ 上游 5 分钟不吐字、**沉默卡死**、连 400 都不给。\n`
        : `[auto-checkpoint] 当前上下文压力已达 ${Math.round(total)} token` +
          (atBoundary && !overPressure
            ? `（你刚完成一个任务，且在任务边界水位 ${Math.round(runtime.taskBoundaryTokens)} 之上——` +
              `**趁任务接缝交接，比做到一半被切断更好**）。`
            : `（阈值 ${Math.round(runtime.triggerTokens)}）。`)
      const text =
        header +
        `请立即把项目当前状态写入这个文件（**绝对路径**）：${checkpointAbspath(agent)}。\n` +
        `\n` +
        `**这份文件是写给下一棒的 AI 看的，它看不到你的对话。**\n` +
        `⚠️ 但它**不是唯一的**知识来源：项目里还有长期经验档案（\`任务单/\`、\`HANDOVER.md\`、\n` +
        `\`事实总表.md\`、\`03-工具/\` 之类）。**接棒者默认只会读检查点** ——\n` +
        `你不把档案的位置写下来，项目里早已写好的经验就等于不存在（2026-10-06 真实事故）。\n` +
        `所以请按下面的结构写，**顺序不要变**——最重要的放在最前面，` +
        `因为接棒者容易漏掉文件末尾的内容：\n` +
        `\n` +
        `1. \`## 任务（不变）\` —— 一两句话说明在做一件什么事。\n` +
        `2. \`## ⚠️ 已知坑 / 约束（必读，别重蹈覆辙）\` —— **必须是第一节实质内容**。\n` +
        `   这一项最重要：把**已经踩过的坑、验错的假设、不能碰的东西、必须遵守的规矩**\n` +
        `   一条一条列出来（每条一行，写清"不要做什么"和"为什么"）。\n` +
        `   如果暂时没有，就写"（暂无）"，不要省略这一节。\n` +
        `3. \`## 已修复的缺陷\` —— 修过什么、根因是什么。接棒者不该再修一遍。\n` +
        `4. \`## 当前状态 / 本轮结论\` —— 现在到哪一步了，哪些已验证、哪些还没验。\n` +
        `5. \`## 未决事项 / 卡点\` —— 还没做的、卡住的、等用户确认的。\n` +
        `6. \`## 下一步要做的第一件事\` —— 只写**一件**，具体到可以直接动手。\n` +
        `7. \`## 环境事实\` —— 路径、版本号、关键命令等可复核的事实。\n` +
        `8. \`## 项目知识档案（下一棒必看）\` —— **一行一条**：哪份文档 / 哪个目录装什么经验，\n` +
        `   以及"这一棒真正用上的是哪几份"（带路径）。没有就写"（暂无）"，**不要省略这一节**。\n` +
        `   ⚠️ 下一棒默认只会读检查点。你不写这一节，它就不知道去翻 ——\n` +
        `   项目里早已写好的经验等于不存在（2026-10-06 事故 session-c41a9661）。\n` +
        `9. \`## 📖 已读水位线（本棒读过 / 没读过哪些权威文档）\` —— **两行，必须写**：\n` +
        `   \`已读：\`（带路径，逗号分隔）｜ \`未读但可能相关：\`（带路径；一条都没有就写"（无）"）。\n` +
        `   ⚠️ 为什么必须有：**压缩会吃掉"我读过它"这件事，而文档不会跟着消失** ——\n` +
        `   于是下一棒会用**没读过的记忆**重做**已经写好的分析**。2026-10-09 真实事故：\n` +
        `   上一棒被问到"急停阀 + 压缩"时没打开写这件事的 \`loop-lab/guard-test/RESULT.md\`，\n` +
        `   凭记忆引用了一句写死的旧结论「压缩治不了」去**反驳用户**（用户实测过，**用户对**）。\n` +
        `   同一天盘点：本项目浅层文档 90 份、上一棒**未读 815 KB**，其中四份正对着它在推理的主题\n` +
        `   （最典型：\`复读失控-归因.md\` 开头写的现象，就是它当轮"新发现"的那个）。\n` +
        `\n` +
        `10. ⭐ 如果你判断**这一棒该交出去了**（图额度将尽 / 任务告一段落 / 上下文该换干净的），\n` +
        `   **别再只写一句"请开新会话"然后停下** —— 2026-10-11 真实浪费：会话 \`4702a65a\` 干到 229 步 /\n` +
        `   读图 39 张，自己判断该交棒、写了落档、喊了"请开新会话"，然后**停在那里**：\n` +
        `   本插件只认 token 水位，看不到"图额度将尽"。\n` +
        `   ⇒ 调这个脚本（它会**开新会话接手并继承你的 provider/model/effort**）：\n` +
        `     \`bash ~/.dsh/tools/handoff.sh "<交接说明>" --next "<下一棒第一件事>"\`\n` +
        `   ⚠️ 它**不会**帮你 park ⇒ 拿到 \`ok:true\` 后**你自己必须停止工作**，否则两个会话同改一个项目。\n` +
        `   🛑 如果你自己**有 active 的 goal**：先把 \`update_goal\` 暂停它，**再**调这个脚本 ——\n` +
        `      否则你交了班却还在自动续跑，两个会话会同时改同一个项目（\`handoff.sh\` 不管 goal）。\n` +
        `\n` +
        `要求：具体、可核对（带文件路径/行号/命令），不要写成流水账，不要复述对话过程。\n` +
        `写完后用一句话确认文件路径。`
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: {
              kind: `plugin:${name}`,
              form: 'snapshot',
              sections: [{ name: 'auto-checkpoint', text }],
            },
          },
        ],
      }
    }

    // Requested: check whether the file has landed (tool-agnostic). If it has,
    // reject this step so the session converges without another model call;
    // the fire-and-forget handoff then parks the session as soon as the agent
    // is idle. This rejects step-internal continuation (tool results / model
    // follow-up steps), never a fresh user message: a user message is only
    // claimed at a turn boundary, and by then the file was already detected at
    // the previous step's pre-step.
    // NOTE: `freshCheckpointSize` (not `checkpointSize`) — a stale file from the
    // previous session in the chain must NOT count as this session's checkpoint.
    const size = await freshCheckpointSize(agent, st)
    if (size > 0) {
      st.confirmedPath = checkpointAbspath(agent)
      ctx.logger.info(`[auto-checkpoint] checkpoint file confirmed: ${st.confirmedPath} (${size} bytes)`)
      if (runtime.autoNewSession) {
        await setPhase(st, 'handoff-pending')
        void handoff(agent, st, st.confirmedPath).catch((error) => {
          ctx.logger.error(`[auto-checkpoint] handoff crashed: ${error instanceof Error ? error.message : String(error)}`)
        })
      } else {
        await setPhase(st, 'checkpoint-only')
        ctx.logger.info('[auto-checkpoint] checkpoint only (autoNewSession=false); session continues')
      }
      return { kind: 'reject' }
    }
    if (step - st.reminderStep >= remindEvery) {
      st.reminderStep = step
      const text =
        `[auto-checkpoint] 检查点文件 ${checkpointAbspath(agent)} 尚未写入，当前压力 ${Math.round(total)} token。` +
        `请现在完成写入（如已写入请直接确认路径）。\n` +
        `别忘了结构要求——**第一节实质内容必须是「⚠️ 已知坑 / 约束」**，` +
        `然后是「已修复的缺陷」「当前状态」「未决事项」「下一步第一件事」，` +
        `最后别忘了第 8 节「项目知识档案（下一棒必看）」**和第 9 节「已读水位线」**\n` +
        `（第 9 节 = 本棒读过 / 没读过哪些权威文档，两行即可 —— 压缩会吃掉"我读过它"这件事）。\n` +
        `⚠️ 接棒者看不到你的对话，且**默认只会读检查点** —— 项目的长期经验在别的文档里，` +
        `你不把它们的路径写下来，下一棒就找不到（见 ~/.dsh/AGENTS.md §6.4）。`
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: {
              kind: `plugin:${name}`,
              form: 'snapshot',
              sections: [{ name: 'auto-checkpoint', text }],
            },
          },
        ],
      }
    }
    return decision
  })

  // Turn-boundary detection: the model may finish writing the checkpoint and
  // close the turn in the same breath; pre-step only runs at a step boundary,
  // and no further step may ever come. turn-stopping fires right before an
  // otherwise-completed turn closes, which is exactly the last chance to
  // detect the file without waiting for a next user message.
  /**
   * 收尾前纠正「闷头干活不吐字」（2026-10-10 加，用户点名要求**治本**）。
   *
   * 为什么落在这一钩子：`agent/turn-stopping` 是**收尾前的最后一次机会**。⚠️ 但它
   * **不是中间件**（签名 `(payload) => Promise<void> | void`，没有 `next`）⇒ **拦不住
   * turn 结束**，所以这里只能"纠正"，不能"阻止"。（能拦的是 `agent/pre-step`。）
   *
   * 判据（读 `turnTextSignal`，由 `session/event` 喂）：
   *   · 整个 turn 一条正文都没有、**但模型确实开过口** ⇒ 纠正；
   *   · 模型压根没开口（`turn/end blocked` 那种）⇒ 放过 —— 它本来就没话说。
   *
   * 动作：投一条极短的消息（走 `sessionController.prompt`，与落档/接棒**同一条已验证通路**），
   * 逼它**新开一个 turn 把话说出来**。
   * ⚠️ 用户仍然会先看到那个"没正文"的回合 ⇒ 这是**持续纠偏**，不是"当场补全"；
   * 但它的价值在于**不依赖模型"记得"**（"我下次注意"这条本机已实测失败）。
   *
   * 🛑 **同一个 turn 只纠正一次**（`st.textNaggedTurn`）—— 否则模型每次收尾都被叫回来，
   * 就成了自我唤醒的死循环。
   */
  async function remindVisibleText(agent, turn) {
    if (!VISIBLE_TEXT_GUARD) return
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return
    counters.seen += 1
    const rec = turnTextSignal.get(sessionId)
    if (rec === undefined) {
      counters.last = { at: Date.now(), sessionId, reason: 'no-signal' }
      return
    }
    if (Number.isFinite(rec.turn) && Number.isFinite(turn) && rec.turn !== turn) {
      counters.last = { at: Date.now(), sessionId, reason: `turn-mismatch(${rec.turn}≠${turn})` }
      return
    }
    if (rec.sawAssistant !== true) {
      counters.last = { at: Date.now(), sessionId, reason: 'model-said-nothing' }
      return
    }
    // ⚠️ 判据（2026-10-10 第二次修）：**不能只问"有没有 text 块"** —— 一句引导语
    //（"最后把它写进插件文档："）就是一个合格的 text 块，但它对用户毫无信息量。
    // 实测踩过：用户重启后仍然只看到思考，而那一行让闸门放行。
    // 所以按**字符数**判：整轮正文加起来不足 `VISIBLE_TEXT_MIN_CHARS` 就算"没说清"。
    const chars = Number.isFinite(rec.textChars) ? rec.textChars : 0
    if (chars >= VISIBLE_TEXT_MIN_CHARS) {
      counters.last = { at: Date.now(), sessionId, reason: `enough-text(${chars})` }
      return
    }
    const st = stateFor(sessionId)
    // 🛑 节流**不能只写成 `st.textNaggedTurn === turn`**：若钩子回传的 `turn` 是
    // `undefined`（运行时实际传什么，不能照 api-catalog 的声明想当然），而
    // `st.textNaggedTurn` 的初值**也是 undefined**，那么 `undefined === undefined` 成立
    // ⇒ **第一次进来就 return**，闸门从上线起就不可能触发。
    // 所以主节流用**时间冷却**，`turn` 只当"同一轮别重复"的加分判据。
    const lastAt = Number.isFinite(st.textNaggedAtMs) ? st.textNaggedAtMs : 0
    if (Date.now() - lastAt < VISIBLE_TEXT_NAG_COOLDOWN_MS) {
      counters.last = { at: Date.now(), sessionId, reason: 'cooldown' }
      return
    }
    if (Number.isFinite(turn) && st.textNaggedTurn === turn) {
      counters.last = { at: Date.now(), sessionId, reason: `same-turn(${turn})` }
      return
    }
    st.textNaggedAtMs = Date.now()
    if (Number.isFinite(turn)) st.textNaggedTurn = turn
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt !== 'function') {
      counters.last = { at: Date.now(), sessionId, reason: 'no-session-controller' }
      return
    }
    const text =
      `[auto-checkpoint] 你刚才这一整轮**几乎没给用户正文**（共 ${chars} 字）—— ` +
      `他那边只看到工具在跑，看不到你的结论。\n` +
      `请**立刻用正文**把这一轮说清楚（一到三句就够）：做到哪一步、结论是什么、下一步做什么。\n` +
      `不要只回"完成"两个字，也不要再调工具。`
    try {
      await controller.prompt(
        {
          sessionId: agent.session?.id ?? sessionId,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      counters.nags += 1
      counters.last = { at: Date.now(), sessionId, reason: `nagged(text=${chars}, turn=${turn})` }
      ctx.logger.info(
        `[auto-checkpoint] visible-text reminder delivered for ${sessionId} ` +
          `(turn ${turn}, visible text ${chars} chars)`,
      )
    } catch (error) {
      counters.last = {
        at: Date.now(),
        sessionId,
        reason: `failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      ctx.logger.warn(
        `[auto-checkpoint] visible-text reminder failed for ${sessionId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    // 「闷头不吐字」纠正（2026-10-10）—— 放在**最前面**：它与交棒/落档无关，
    // 而下面那些分支会 return，放后面会被它们吞掉。
    //
    // 🛑 **2026-10-10 差点误改（用户当场纠正）**：我一度认为「`turn=82` 那次数到 0 是误报，
    // 因为模型明明写了 40+ 字正文」，准备把检测挪到 `turn/end`。**用户纠正：那一轮模型
    // 确实一个字正文都没写**（内容全在 reasoning 里）⇒ **闸门判对了，不是误报**。
    // 我"以为自己写了"，恰恰是这个症状本身 —— 对模型来说 reasoning 与 text 都是"自己写的"，
    // **无法从内部区分**。
    // ⇒ **纪律：别拿"我记得我写了正文"去推翻计数器**。以 `counters.last.reason` 和
    //    用户的观感为准；那个数字才是真相。
    void remindVisibleText(agent, turn).catch((error) => {
      ctx.logger.warn(
        `[auto-checkpoint] visible-text guard crashed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    const st = stateFor(agent.id)
    // 🛑 用户拍板（2026-10-11）：落档/检查点里出现交棒意图 ⇒ **只提醒用户、不自动开**。
    //    每回合结束顺带看一眼（15 分钟节流），命中会置标记、由下一个 pre-step 注入提醒。
    void detectHandoffIntent(agent, st, 'checkpoint').catch(() => {})
    if (st.phase !== 'requested') {
      if (!QUARANTINED.has(st.phase)) await autoNotifyIfDone(agent).catch(() => {})
      return
    }
    // Freshness-guarded: a stale file left by the previous session must not
    // trigger a hand-off (see `freshCheckpointSize`).
    const size = await freshCheckpointSize(agent, st)
    if (size <= 0) return
    st.confirmedPath = checkpointAbspath(agent)
    ctx.logger.info(`[auto-checkpoint] checkpoint file confirmed at turn close: ${st.confirmedPath} (${size} bytes)`)
    if (runtime.autoNewSession) {
      await setPhase(st, 'handoff-pending')
      void handoff(agent, st, st.confirmedPath).catch((error) => {
        ctx.logger.error(`[auto-checkpoint] handoff crashed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else {
      await setPhase(st, 'checkpoint-only')
      ctx.logger.info('[auto-checkpoint] checkpoint only (autoNewSession=false); session continues')
    }
  })

  // Web half: only mounted when a webServer service exists (web profile);
  // headless boots skip this block entirely.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer

    /** Current session pressure, or null when the session is unknown. */
    const measurePressure = (sessionId) => {
      try {
        const sessions = ctx.get('sessions')
        const session = sessions && sessionId ? sessions.get(sessionId) : undefined
        if (session === undefined) return null
        return { totalTokens: ctx.tokenMeter.measure(session).totalTokens }
      } catch {
        return null
      }
    }

    const sendJson = (res, body, status = 200) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('access-control-allow-origin', '*')
      res.end(JSON.stringify(body))
    }

    const statePayload = (sessionId) => ({
      ok: true,
      build: BUILD,
      triggerTokens: runtime.triggerTokens,
      taskBoundaryTokens: runtime.taskBoundaryTokens,
      autoNewSession: runtime.autoNewSession,
      enabled: runtime.enabled,
      // 🆕 图片水位（2026-10-14）：开关 + **内置**水位 + 本会话当前图片体积（观测用）。
      //    为什么体积也要露出来：看不到"它到底读到了多少 MB"，就分不清"这条路没触发"与"根本没数据"。
      imageWatermark: runtime.imageWatermark !== false,
      imageWatermarkMb: IMAGE_WATERMARK_MB,
      imageMb: sessionId ? Number(imageMbOf(sessionId).toFixed(2)) : 0,
      checkpointPath: pathForSession(sessionId),
      pressure: measurePressure(sessionId),
      // 压缩提醒阈值：前端横幅用它判断"该提醒了吗"（0 = 关）。
      remindTokens: runtime.remindTokens,
      // 本会话的处理方式（null = 没标记 ⇒ 什么都不做，这是默认）。
      sessionMode: (sessionId && runtime.sessionModes[sessionId]) || null,
      // 自检：自动压缩这条路通不通（能不能程序化执行 /compact）。
      // 暴露出来是为了重启后**一条 curl 就能确认**，不用去猜 realm 隔离。
      canCompact: typeof ctx.get('commands')?.execute === 'function',
      // 手动 `/compact` 的落档闸门装上了吗（2026-10-10 加）。
      // `installed` = 包装生效；`failed` / `no-commands` = 装不上，**手动压缩行为与以前完全一样**。
      // 这个字段是"能不能拦住手动压缩"的唯一判据 —— 别靠读代码推断 RPC 派发路径。
      manualCompactGate: manualCompactGateState,
      // 闸门被调用过的次数。按一次 `/compact` 后它从 0 → 1，才证明**前端 RPC 真的
      // 走进了我们的包装**（`installed` 只说明赋值成功，说明不了派发路径）。
      manualGateHits,
      // 闸门为等落档轮收尾而做的 busy 重试次数（累计）。正常 0–2；
      // 一直涨 = agent 长时间不空闲，压缩压不下去（错误原样交回前端）。
      manualGateBusyRetries,
      // 「最近一次阀开火之后插件做了什么」（2026-10-09 加，治"插件在动作、但用户看不见"）。
      // ⚠️ **只对"这条会话自己"返回** —— 别的会话的阀开火不该弹到你当前的窗口里。
      lastValveAbort: lastValveAbort !== null && sessionId === lastValveAbort.sessionId
        ? { ...lastValveAbort }
        : null,
      // 最近一次阈值压缩的决定（2026-10-10 加）—— "**为什么没压**"的唯一可读答案。
      // stage 取值就是 `note()` 的第一个参数：disabled / quarantined / no-threshold /
      // pending / no-agent / cooldown / no-idle-window / no-pressure / preflight /
      // busy / error / done。同样**只对这条会话返回**。
      lastAutoCompactDecision:
        counters.lastAutoCompactDecision !== null && sessionId === counters.lastAutoCompactDecision.sessionId
          ? { ...counters.lastAutoCompactDecision }
          : null,
      // 「正文缺失」闸门（2026-10-10 加）：全局计数 + 最近一次为什么没纠正。
      // `counters.seen` 应在每个 turn 收尾时 +1；**它一直是 0 ⇒ 钩子根本没被调到**。
      // `counters.last.reason` 的取值：no-signal / turn-mismatch / model-said-nothing /
      // enough-text(N) / cooldown / same-turn(N) / no-session-controller / nagged(...) / failed:…
      textGuardSeen: counters.seen,
      textGuardNags: counters.nags,
      textGuardLast: counters.last,
      // 「零正文快照」（2026-10-10 加）：最近 5 条发病现场 + 落盘路径。
      // 只看当前会话的（与 lastAutoCompactDecision 同款纪律：别的会话的事不该弹到你窗口里）。
      zeroTextSnapshotPath: ZERO_TEXT_SNAPSHOT_PATH,
      zeroTextSnapshots: zeroTextState.snapshots.filter((item) => item.sessionId === sessionId),
    })

    // Route registration is tolerant of hot-reload duplicates, mirroring the
    // cost-whale plugin: a stale fiber's route may still hold the path.
    const route = (path, handler) => {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
            }
          },
        })
        ctx.effect(() => () => {
          try {
            dispose()
          } catch {}
        })
      } catch (error) {
        ctx.logger.warn(`[auto-checkpoint] route ${path} registration failed (stale instance?): ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    route('/dsh-auto-checkpoint/state', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      sendJson(res, statePayload(url.searchParams.get('sessionId') ?? undefined))
    })

    route('/dsh-auto-checkpoint/config', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return
      }
      let body
      try {
        body = await new Promise((resolve, reject) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk })
          req.on('end', () => {
            try {
              resolve(data.length > 0 ? JSON.parse(data) : {})
            } catch (error) {
              reject(error)
            }
          })
          req.on('error', reject)
        })
      } catch (error) {
        sendJson(res, { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }, 400)
        return
      }
      const next = { ...runtime }
      if (body.triggerTokens !== undefined) {
        const n = Number(body.triggerTokens)
        if (!Number.isFinite(n) || n < 1000) {
          sendJson(res, { ok: false, error: 'triggerTokens must be a number ≥ 1000' }, 400)
          return
        }
        next.triggerTokens = Math.round(n)
      }
      // 任务边界水位（2026-09-21 加）。允许 0 —— 0 明确表示"关闭任务边界触发"，
      // 所以下界是 0 而不是 1000（与压力阈值不同：压力阈值不能为 0，
      // 那会让每个 step 都触发）。
      if (body.taskBoundaryTokens !== undefined) {
        const n = Number(body.taskBoundaryTokens)
        if (!Number.isFinite(n) || n < 0) {
          sendJson(res, { ok: false, error: 'taskBoundaryTokens must be a number ≥ 0 (0 disables it)' }, 400)
          return
        }
        next.taskBoundaryTokens = Math.round(n)
      }
      if (body.autoNewSession !== undefined) {
        if (typeof body.autoNewSession !== 'boolean') {
          sendJson(res, { ok: false, error: 'autoNewSession must be a boolean' }, 400)
          return
        }
        next.autoNewSession = body.autoNewSession
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          sendJson(res, { ok: false, error: 'enabled must be a boolean' }, 400)
          return
        }
        next.enabled = body.enabled
      }
      // 🆕 图片水位总开关（2026-10-14）：布尔才认 —— 与 autoNewSession / enabled 同一套口径。
      if (body.imageWatermark !== undefined) {
        if (typeof body.imageWatermark !== 'boolean') {
          sendJson(res, { ok: false, error: 'imageWatermark must be a boolean' }, 400)
          return
        }
        next.imageWatermark = body.imageWatermark
      }
      // 压缩提醒阈值（2026-10-07）：0 = 关闭；与 taskBoundaryTokens 同一套下界口径。
      if (body.remindTokens !== undefined) {
        const n = Number(body.remindTokens)
        if (!Number.isFinite(n) || n < 0) {
          sendJson(res, { ok: false, error: 'remindTokens must be a number ≥ 0 (0 disables the reminder)' }, 400)
          return
        }
        next.remindTokens = Math.round(n)
      }
      // 按会话的处理方式（2026-10-07 第二次改）：{ sessionId, sessionMode }。
      // sessionMode 传 null / 空串 = 清除标记（回到"这个会话什么都不做"）。
      if (body.sessionId !== undefined || body.sessionMode !== undefined) {
        const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sid.length === 0) {
          sendJson(res, { ok: false, error: 'sessionId is required to set a session mode' }, 400)
          return
        }
        const raw = body.sessionMode
        if (raw === null || raw === undefined || raw === '') {
          const cleared = { ...next.sessionModes }
          delete cleared[sid]
          next.sessionModes = cleared
        } else if (SESSION_MODES.includes(raw)) {
          next.sessionModes = { ...next.sessionModes, [sid]: raw }
        } else {
          sendJson(res, { ok: false, error: `sessionMode must be ${SESSION_MODES.join(' / ')} or null` }, 400)
          return
        }
      }
      Object.assign(runtime, next)
      runtimeDirty = true
      try {
        await saveRuntimeFile(runtime)
      } catch (error) {
        sendJson(res, { ok: false, error: `persist failed: ${error instanceof Error ? error.message : String(error)}` }, 500)
        return
      }
      ctx.logger.info(`[auto-checkpoint] config updated: trigger=${Math.round(runtime.triggerTokens)} taskBoundary=${Math.round(runtime.taskBoundaryTokens)} autoNewSession=${runtime.autoNewSession} enabled=${runtime.enabled} imageWatermark=${runtime.imageWatermark !== false}`)
      const url = new URL(req.url ?? '/', 'http://localhost')
      sendJson(res, statePayload(url.searchParams.get('sessionId') ?? undefined))
    })

    // ── /spawn（2026-09-29 加）：让"项目经理"会话派活给别的模式/模型的新会话 ──
    // 与 handoff 同一套三步：create(cwd, agentPreset) → selectModel → prompt。
    // 🛑 鉴权：插件路由**不经过** web 的 token 校验（实测无 cookie 也 200），
    //   且公网隧道也转发到本端口 ⇒ 必须自带密钥：~/.dsh/spawn-token（0600，首次自动生成）。
    //   请求头 `x-spawn-token` 必须与文件内容一致，否则 403。
    const spawnTokenPath = join(homedir(), '.dsh', 'spawn-token')
    const spawnToken = async () => {
      try {
        const t = (await readFile(spawnTokenPath, 'utf8')).trim()
        if (t.length >= 32) return t
      } catch {}
      const t = randomUUID() + randomUUID()
      await writeFile(spawnTokenPath, t + '\n', { mode: 0o600 })
      return t
    }
    spawnToken().catch(() => {})
    route('/dsh-auto-checkpoint/spawn', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return
      }
      const expected = await spawnToken()
      if (req.headers['x-spawn-token'] !== expected) {
        sendJson(res, { ok: false, error: 'forbidden' }, 403)
        return
      }
      let body
      try {
        body = await new Promise((resolve, reject) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk })
          req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
          req.on('error', reject)
        })
      } catch (error) {
        sendJson(res, { ok: false, error: 'invalid JSON' }, 400)
        return
      }
      const { cwd, agentPreset, provider, model, reasoningEffort, prompt, permissionPreset, parentSessionId } = body
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof prompt !== 'string' || !prompt) {
        sendJson(res, { ok: false, error: 'need absolute cwd and non-empty prompt' }, 400)
        return
      }
      const controller = ctx.get('sessionController')
      if (!controller) {
        sendJson(res, { ok: false, error: 'sessionController absent' }, 503)
        return
      }
      const created = await controller.create({
        cwd,
        ...(typeof agentPreset === 'string' ? { agentPreset } : {}),
      })
      const sessionId = created.sessionId
      if (typeof permissionPreset === 'string' && permissionPreset) {
        try {
          const presets = ctx.get('permissionPresets')
          const child = ctx.get('sessions')?.get?.(sessionId)
          if (presets?.set && child) presets.set(child, permissionPreset)
        } catch (error) {
          sendJson(res, { ok: false, sessionId, error: `permissionPreset failed: ${error instanceof Error ? error.message : String(error)}` }, 500)
          return
        }
      }
      if (typeof provider === 'string' && typeof model === 'string') {
        // ⚠️ `controller.selectModel()` 内部**一定会**调
        // `agentDefaultModel.saveSelection()`（见 dsh-api-session-controller/lib/index.js:621），
        // 也就是会把**全局默认模型**改成这里传的值 —— 那是 GUI "切模型"共用的副作用。
        // 用户 2026-10-02 明确要求：全局默认 `agent-default-model` **由他手动管理**，
        // 派活不该动它。所以这里先记下原值，改完会话再还原。
        const defaultModel = ctx.get('agentDefaultModel')
        let previousDefault
        try {
          previousDefault = defaultModel?.currentSelection?.()
        } catch {
          previousDefault = undefined
        }
        await controller.selectModel({
          sessionId, provider, model,
          ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
        })
        if (previousDefault?.provider && previousDefault?.model) {
          try {
            await defaultModel.saveSelection(previousDefault)
          } catch (error) {
            ctx.logger.warn(`[auto-checkpoint] spawn ${sessionId} 全局默认模型还原失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await controller.prompt(
        {
          sessionId,
          requestId: `${RPC_PREFIX}${randomUUID()}`,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        new AbortController().signal,
      )
      ctx.logger.info(`[auto-checkpoint] spawn ${sessionId} cwd=${cwd} preset=${agentPreset ?? 'default'} model=${provider ?? '?'}/${model ?? '?'}`)
      await linkParent(sessionId, parentSessionId)
      sendJson(res, { ok: true, sessionId })
    })

    // /notify：派活会话收尾时回报给"派它的会话"（父会话）。同一把 spawn-token 鉴权。
    // body: { sessionId: <父会话id>, text: <回报内容> } → 以 queue 模式注入父会话。
    route('/dsh-auto-checkpoint/notify', async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'method not allowed' }, 405); return }
      const expected = await spawnToken()
      if (req.headers['x-spawn-token'] !== expected) { sendJson(res, { ok: false, error: 'forbidden' }, 403); return }
      let body
      try {
        body = await new Promise((resolve, reject) => {
          let data = ''
          req.on('data', (c) => { data += c })
          req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
          req.on('error', reject)
        })
      } catch { sendJson(res, { ok: false, error: 'invalid JSON' }, 400); return }
      const { sessionId, text, mode } = body
      if (typeof sessionId !== 'string' || !sessionId || typeof text !== 'string' || !text) {
        sendJson(res, { ok: false, error: 'need sessionId and text' }, 400); return
      }
      const note = `[派活回报] ${text.slice(0, 4000)}`
      const controller = ctx.get('sessionController')
      try {
        let used
        if (mode === 'steer' || mode === 'queue') {
          // 显式指定的老语义：
          //   'queue' = 追加 `next-turn` 队尾 —— 目标若开着 goal，要等 goal **下一轮**跑完才轮到；
          //   'steer' = 插 `next-step` —— 当前回合的下一步就认领（**会打断连贯性**）。
          used = mode
          await controller.prompt(
            { sessionId, requestId: `${RPC_PREFIX}${randomUUID()}`, mode, content: [{ type: 'text', text: note }] },
            new AbortController().signal,
          )
        } else {
          // ⭐ 默认（用户 2026-10-11 两轮反馈后的定稿）：
          //   目标**正在跑** ⇒ steer 插进当前回合（秒级，代价是打断它当前的操作连贯性）；
          //   目标**空闲**   ⇒ 插 `next-turn` 队首（下一轮就是它）；
          //   steer 失败     ⇒ 自动降级成队首（不丢消息）。
          used = await promptFast(sessionId, note)
        }
        ctx.logger.info(`[auto-checkpoint] notify -> ${sessionId} (mode=${used})`)
        sendJson(res, { ok: true, mode: used })
      } catch (error) {
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    })

    const widgetJs = buildWidgetJs()
    route('/dsh-auto-checkpoint/widget.js', (req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/javascript; charset=utf-8')
      // 2026-10-10：这个 widget 之前漏了缓存指令（同一个文件里的 sendJson 一直都有）。
      // 后果：手机浏览器有资格把旧版 widget.js 长期留在本地 → 小鲸鱼菜单里
      // 「自动检查点」那一整块根本不出现。用户报「Tailscale 打开的网页少了现在的很多功能」
      // 就是这个形态。与小鲸鱼（其 sendFile 带 no-store）对齐。
      res.setHeader('cache-control', 'no-store')
      res.end(widgetJs)
    })

    let disposeTap
    try {
      disposeTap = webServer.tapIndex((html) => {
        if (html.includes('/dsh-auto-checkpoint/widget.js')) return html
        const tag = '<script defer src="/dsh-auto-checkpoint/widget.js"></script>'
        return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
      })
    } catch (error) {
      ctx.logger.warn(`[auto-checkpoint] tapIndex registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (disposeTap !== undefined) {
      ctx.effect(() => () => {
        try {
          disposeTap()
        } catch {}
      })
    }
  })
}

/**
 * The in-page panel script: renders one "自动检查点" block inside the
 * dsh-cost-whale menu (`.dshwv-menu`), polls the state route, and POSTs
 * slider/checkbox changes. Pure ES5-style DOM code, idempotent, no deps.
 * The script must not contain backticks or `${` — it is embedded in a
 * template literal below.
 */
function buildWidgetJs() {
  return `(function () {
if (window.__dshAutoCheckpoint) return
window.__dshAutoCheckpoint = true

var STATE_URL = '/dsh-auto-checkpoint/state'
var CONFIG_URL = '/dsh-auto-checkpoint/config'
var SESSION_KEY = 'dsh.sessions.current'
var POLL_MS = 15000
var RANGE_MIN = 50000
var RANGE_MAX = 1000000
var RANGE_STEP = 10000

var css = [
  '.ac-panel{margin:8px 0 2px;padding:8px 9px;background:rgba(32,49,112,.06);border:1px solid rgba(32,49,112,.22);border-radius:8px;color:#203170;font-size:11.5px;color-scheme:light}',
  '.ac-title{font-weight:700;margin-bottom:5px;letter-spacing:.02em}',
  '.ac-row{display:flex;align-items:center;gap:6px;margin:4px 0;white-space:nowrap}',
  '.ac-label{flex:0 0 auto;opacity:.85}',
  '.ac-range{flex:1;min-width:0;accent-color:#203170;height:14px}',
  '.ac-num{width:74px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:11.5px;color:#203170;background:#fff;box-sizing:border-box}',
  '.ac-check{width:15px;height:15px;accent-color:#203170;cursor:pointer;flex:0 0 auto;margin:0}',
  '.ac-txt{flex:1;min-width:0}',
  '.ac-bar{height:6px;border-radius:3px;background:rgba(32,49,112,.15);overflow:hidden;margin:3px 0 1px}',
  '.ac-bar-fill{height:100%;width:0;background:#2f6fd0;transition:width .3s ease}',
  '.ac-cur{font-variant-numeric:tabular-nums;font-weight:600}',
  '.ac-hint{color:#7f8fb5;font-size:10.5px;line-height:1.4;margin-top:5px}',
  '.ac-state{color:#7f8fb5;font-size:10.5px;margin-top:2px;font-variant-numeric:tabular-nums}',
  '.ac-select{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:11.5px;color:#203170;background:#fff;box-sizing:border-box}',
  '.ac-banner{position:fixed;top:64px;right:16px;z-index:2147483000;max-width:330px;padding:10px 12px;border-radius:10px;background:#fff4e5;border:1px solid #e8a33d;box-shadow:0 6px 20px rgba(0,0,0,.18);color:#7a4a06;font-size:12.5px;line-height:1.5;color-scheme:light}',
  '.ac-banner-title{font-weight:700;margin-bottom:4px;font-size:13px}',
  '.ac-banner-body{font-variant-numeric:tabular-nums}',
  '.ac-banner-btn{margin-top:8px;padding:3px 10px;border-radius:6px;border:1px solid #e8a33d;background:#fff;color:#7a4a06;cursor:pointer;font-size:12px}'
].join('\\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

function currentSessionId() {
  try {
    var raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    return raw && typeof raw.sessionId === 'string' ? raw.sessionId : null
  } catch (e) { return null }
}
function fmtK(v) {
  var n = Number(v)
  if (!isFinite(n)) return '--'
  return n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : (n / 1000).toFixed(0) + 'k'
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

/* ---- panel DOM ---- */
function ensurePanel(menuBox) {
  if (menuBox.querySelector('.ac-panel')) return menuBox.querySelector('.ac-panel')
  var panel = document.createElement('div')
  panel.className = 'ac-panel'

  var title = document.createElement('div')
  title.className = 'ac-title'
  title.textContent = '自动检查点'
  panel.appendChild(title)

  var row1 = document.createElement('div')
  row1.className = 'ac-row'
  var l1 = document.createElement('span')
  l1.className = 'ac-label'
  l1.textContent = '阈值'
  var range = document.createElement('input')
  range.type = 'range'
  range.className = 'ac-range'
  range.min = String(RANGE_MIN)
  range.max = String(RANGE_MAX)
  range.step = String(RANGE_STEP)
  var num = document.createElement('input')
  num.type = 'number'
  num.className = 'ac-num'
  num.min = '1000'
  num.step = String(RANGE_STEP)
  row1.appendChild(l1)
  row1.appendChild(range)
  row1.appendChild(num)
  panel.appendChild(row1)

  var row2 = document.createElement('div')
  row2.className = 'ac-row'
  var l2 = document.createElement('span')
  l2.className = 'ac-label'
  l2.textContent = '当前'
  var cur = document.createElement('span')
  cur.className = 'ac-cur'
  cur.textContent = '--'
  var sep = document.createElement('span')
  sep.className = 'ac-label'
  sep.textContent = '/'
  var thr = document.createElement('span')
  // ⚠️ 原来这里是 ac-cur，但查询用的是 querySelector('.ac-panel .ac-thr')
  //    → els.thr 恒为 null → render 在 els.thr.textContent = … 抛异常
  //    → **那一行之后的所有代码全都不执行**（包括边界滑块的回填）。
  //    实测复现（真实 Chromium）：
  //      TypeError: Cannot set properties of null (setting 'textContent')
  //    后果：改动前是"当前/阈值显示与进度条不更新"（看着像没读到数据，不易察觉）；
  //          加了边界滑块后，滑块恰好排在崩溃点之后 → 刷新永远显示 0。
  //    修法：类名与查询对齐（保留 ac-cur 的样式，追加 ac-thr）。
  thr.className = 'ac-cur ac-thr'
  thr.textContent = '--'
  row2.appendChild(l2)
  row2.appendChild(cur)
  row2.appendChild(sep)
  row2.appendChild(thr)
  panel.appendChild(row2)

  var barBox = document.createElement('div')
  barBox.className = 'ac-bar'
  var barFill = document.createElement('div')
  barFill.className = 'ac-bar-fill'
  barBox.appendChild(barFill)
  panel.appendChild(barBox)

  // ── 任务边界水位（2026-09-21 加）──
  // 与「阈值」并列的第二个滑块：完成一个 todo 任务后，只要压力过了这条线
  // 就交接（比等压力阈值更早，把交接点放到任务接缝上）。
  // 拖到 0 = 关闭该行为，退回"只看阈值"。
  var rowB = document.createElement('div')
  rowB.className = 'ac-row'
  var lB = document.createElement('span')
  lB.className = 'ac-label'
  lB.textContent = '边界'
  var bRange = document.createElement('input')
  bRange.type = 'range'
  bRange.className = 'ac-range ac-brange'
  bRange.min = '0'
  bRange.max = String(RANGE_MAX)
  bRange.step = String(RANGE_STEP)
  var bNum = document.createElement('input')
  bNum.type = 'number'
  bNum.className = 'ac-num ac-bnum'
  bNum.min = '0'
  bNum.step = String(RANGE_STEP)
  rowB.appendChild(lB)
  rowB.appendChild(bRange)
  rowB.appendChild(bNum)
  panel.appendChild(rowB)

  var bHint = document.createElement('div')
  bHint.className = 'ac-hint'
  bHint.textContent = '边界=完成一个任务就交接的水位；0 = 关闭（只看上面阈值）。'
  panel.appendChild(bHint)

  // ── 压缩提醒阈值（2026-10-07 加，用户点名）──
  // ⚠️ 与最上面那个「阈值」**不是一回事**：那条是 auto-checkpoint 自己的动作阈值
  //    （写检查点 → 换会话）；这条**只提醒用户**"该手动压缩了"，不做任何自动动作。
  var rowR = document.createElement('div')
  rowR.className = 'ac-row'
  var lR = document.createElement('span')
  lR.className = 'ac-label'
  lR.textContent = '压缩提醒'
  var rRange = document.createElement('input')
  rRange.type = 'range'
  rRange.className = 'ac-range ac-rrange'
  rRange.min = '0'
  rRange.max = String(RANGE_MAX)
  rRange.step = String(RANGE_STEP)
  var rNum = document.createElement('input')
  rNum.type = 'number'
  rNum.className = 'ac-num ac-rnum'
  rNum.min = '0'
  rNum.step = String(RANGE_STEP)
  rowR.appendChild(lR)
  rowR.appendChild(rRange)
  rowR.appendChild(rNum)
  panel.appendChild(rowR)

  var rHint = document.createElement('div')
  rHint.className = 'ac-hint'
  rHint.textContent = '这条线是"到点动作"的水位 —— 本会话选「提醒」就到线弹提醒，选「自动压缩」就到线压；0 = 两者都关。'
  panel.appendChild(rHint)

  // ── 本会话的处理方式（2026-10-07 第二次改，用户拍板：默认全关）──
  // 第一版是"全局阈值 + 每个会话都弹"，用户当场否掉（切到别的会话也弹，很吵）。
  // 现在：只有在这里标记过的会话才有行为，默认「不处理」= 什么都不做。
  var rowM = document.createElement('div')
  rowM.className = 'ac-row'
  var lM = document.createElement('span')
  lM.className = 'ac-label'
  lM.textContent = '本会话'
  var sel = document.createElement('select')
  sel.className = 'ac-select ac-mode'
  var modeOpts = [['', '不处理（默认）'], ['remind', '到点提醒我'], ['auto', '到点自动压缩']]
  for (var mi = 0; mi < modeOpts.length; mi++) {
    var opt = document.createElement('option')
    opt.value = modeOpts[mi][0]
    opt.textContent = modeOpts[mi][1]
    sel.appendChild(opt)
  }
  rowM.appendChild(lM)
  rowM.appendChild(sel)
  panel.appendChild(rowM)

  var mHint = document.createElement('div')
  mHint.className = 'ac-hint'
  mHint.textContent = '只对**当前正在看的这个会话**生效。「到点自动压缩」会直接替你按 /compact，压完自动接棒。'
  panel.appendChild(mHint)

  var row3 = document.createElement('div')
  row3.className = 'ac-row'
  var c3 = document.createElement('input')
  c3.type = 'checkbox'
  c3.className = 'ac-check'
  var t3 = document.createElement('span')
  t3.className = 'ac-txt'
  t3.textContent = '写完后自动开新会话'
  row3.appendChild(c3)
  row3.appendChild(t3)
  panel.appendChild(row3)

  var row4 = document.createElement('div')
  row4.className = 'ac-row'
  var c4 = document.createElement('input')
  c4.type = 'checkbox'
  c4.className = 'ac-check'
  var t4 = document.createElement('span')
  t4.className = 'ac-txt'
  t4.textContent = '启用自动检查点'
  row4.appendChild(c4)
  row4.appendChild(t4)
  panel.appendChild(row4)

  // 🆕 2026-10-14：图片水位总开关（水位**内置 16 MB**，只给这一个开关 —— 用户要求不要配数字）。
  // ⚠️ 它是**第三个** .ac-check ⇒ start() 里按顺序取的是 checks[2]（别改成 :nth-of-type）。
  var row5 = document.createElement('div')
  row5.className = 'ac-row'
  var c5 = document.createElement('input')
  c5.type = 'checkbox'
  c5.className = 'ac-check'
  var t5 = document.createElement('span')
  t5.className = 'ac-txt'
  t5.textContent = '图片到 16 MB 自动处置'
  row5.appendChild(c5)
  row5.appendChild(t5)
  panel.appendChild(row5)

  var stateEl = document.createElement('div')
  stateEl.className = 'ac-state'
  stateEl.textContent = '…'
  panel.appendChild(stateEl)

  var hintEl = document.createElement('div')
  hintEl.className = 'ac-hint'
  hintEl.textContent = 'token 为估算值，建议留 20% 余量。'
  panel.appendChild(hintEl)

  menuBox.appendChild(panel)
  return panel
}

/* ---- wiring ---- */
var debounce = null
function postConfig(patch) {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(function () {
    debounce = null
    try {
      fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      }).catch(function () {})
    } catch (e) {}
  }, 250)
}

function render(state, els) {
  if (!state || state.ok !== true) return
  // ⚠️ 每个可空元素都用 set() 包一层（2026-09-21）。
  //    起因：els.thr 曾因类名不匹配恒为 null，导致 render 在该行抛异常，
  //    **其后所有回填全部静默失效**（.catch(function(){}) 把错误吞了）。
  //    现在单个控件缺失只会跳过它自己，不会再连累后面的控件。
  function set(el, fn) { if (el) { try { fn(el) } catch (e) {} } }
  var t = Number(state.triggerTokens)
  if (isFinite(t)) {
    set(els.range, function (el) { el.value = String(clamp(t, RANGE_MIN, RANGE_MAX)) })
    set(els.num, function (el) { el.value = String(t) })
    set(els.thr, function (el) { el.textContent = fmtK(t) })
  }
  // 任务边界滑块：回填时同样要 clamp 到 [0, RANGE_MAX]
  var bt = Number(state.taskBoundaryTokens)
  if (isFinite(bt)) {
    set(els.bRange, function (el) { el.value = String(clamp(bt, 0, RANGE_MAX)) })
    set(els.bNum, function (el) { el.value = String(bt) })
  }
  // 压缩提醒阈值：同样 clamp 到 [0, RANGE_MAX]
  var rt = Number(state.remindTokens)
  if (isFinite(rt)) {
    set(els.rRange, function (el) { el.value = String(clamp(rt, 0, RANGE_MAX)) })
    set(els.rNum, function (el) { el.value = String(rt) })
  }
  // 本会话处理方式：null ⇒ 显示「不处理」
  set(els.mode, function (el) { el.value = state.sessionMode || '' })
  set(els.c3, function (el) { el.checked = state.autoNewSession === true })
  set(els.c4, function (el) { el.checked = state.enabled !== false })
  // 缺字段（老 state）⇒ 按默认 true 显示：与后端 config.imageWatermark !== false 同口径。
  set(els.c5, function (el) { el.checked = state.imageWatermark !== false })
  var p = state.pressure
  if (p && isFinite(p.totalTokens) && isFinite(t) && t > 0) {
    set(els.cur, function (el) { el.textContent = fmtK(p.totalTokens) })
    set(els.barFill, function (el) { el.style.width = clamp(p.totalTokens / t * 100, 0, 100).toFixed(1) + '%' })
  } else {
    set(els.cur, function (el) { el.textContent = '--' })
    set(els.barFill, function (el) { el.style.width = '0' })
  }
  // 🆕 图片体积也显示出来（2026-10-14）：用户要能一眼看到"到没到 16 MB"，
  //    否则开关打开了也无从判断它到底在不在工作（可观测性纪律）。
  var imgTxt = ''
  if (typeof state.imageMb === 'number' && state.imageMb > 0) {
    imgTxt = ' · 图 ' + state.imageMb.toFixed(1) + '/' + (Number(state.imageWatermarkMb) || 16) + ' MB'
  }
  var st = state.pressure === null
    ? '当前会话未知（无压力读数）'
    : '检查点文件 ' + (state.checkpointPath || 'checkpoint.md') + ' · ' + (state.enabled === false ? '已停用' : '生效中') + imgTxt
  set(els.stateEl, function (el) { el.textContent = st })
}

function start(menuBox) {
  // 复选框按顺序取，不用 :nth-of-type —— 面板里 .ac-row / .ac-bar 等 div 交错，
  // 按 div 序号定位既脆弱又正是「c4 = null → addEventListener 报错」的根因。
  var checks = menuBox.querySelectorAll('.ac-panel .ac-check')
  var els = {
    range: menuBox.querySelector('.ac-panel .ac-range'),
    num: menuBox.querySelector('.ac-panel .ac-num'),
    bRange: menuBox.querySelector('.ac-panel .ac-brange'),
    bNum: menuBox.querySelector('.ac-panel .ac-bnum'),
    rRange: menuBox.querySelector('.ac-panel .ac-rrange'),
    rNum: menuBox.querySelector('.ac-panel .ac-rnum'),
    mode: menuBox.querySelector('.ac-panel .ac-mode'),
    barFill: menuBox.querySelector('.ac-panel .ac-bar-fill'),
    cur: menuBox.querySelector('.ac-panel .ac-cur'),
    thr: menuBox.querySelector('.ac-panel .ac-thr'),
    c3: checks[0] || null,
    c4: checks[1] || null,
    c5: checks[2] || null,
    stateEl: menuBox.querySelector('.ac-panel .ac-state')
  }
  // 面板被其他插件改动 / 某个控件缺失时，缺一个不该让整个挂件脚本崩掉。
  function on(el, type, fn) { if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn) }
  on(els.range, 'input', function () {
    els.num.value = els.range.value
    postConfig({ triggerTokens: Number(els.range.value) })
  })
  on(els.num, 'change', function () {
    var v = Number(els.num.value)
    if (isFinite(v) && v >= 1000) {
      els.range.value = String(clamp(v, RANGE_MIN, RANGE_MAX))
      postConfig({ triggerTokens: Math.round(v) })
    }
  })
  // 任务边界滑块：min 是 0（0 = 关闭），所以不做 >= 1000 的校验
  on(els.bRange, 'input', function () {
    els.bNum.value = els.bRange.value
    postConfig({ taskBoundaryTokens: Number(els.bRange.value) })
  })
  on(els.bNum, 'change', function () {
    var v = Number(els.bNum.value)
    if (isFinite(v) && v >= 0) {
      els.bRange.value = String(clamp(v, 0, RANGE_MAX))
      postConfig({ taskBoundaryTokens: Math.round(v) })
    }
  })
  // 压缩提醒阈值：min 也是 0（0 = 关闭提醒）
  on(els.rRange, 'input', function () {
    els.rNum.value = els.rRange.value
    postConfig({ remindTokens: Number(els.rRange.value) })
  })
  on(els.rNum, 'change', function () {
    var v = Number(els.rNum.value)
    if (isFinite(v) && v >= 0) {
      els.rRange.value = String(clamp(v, 0, RANGE_MAX))
      postConfig({ remindTokens: Math.round(v) })
    }
  })
  // 本会话处理方式：把"当前正在看的会话"与模式一起提交（空串 = 清除标记）
  on(els.mode, 'change', function () {
    var sid = currentSessionId()
    if (!sid) return
    postConfig({ sessionId: sid, sessionMode: els.mode.value ? els.mode.value : null })
  })
  on(els.c3, 'change', function () {
    postConfig({ autoNewSession: els.c3.checked })
  })
  on(els.c4, 'change', function () {
    postConfig({ enabled: els.c4.checked })
  })
  on(els.c5, 'change', function () {
    postConfig({ imageWatermark: els.c5.checked })
  })
  function poll() {
    try {
      fetch(STATE_URL + '?sessionId=' + encodeURIComponent(currentSessionId() || ''))
        .then(function (r) { return r.json() })
        .then(function (state) { render(state, els) })
        .catch(function () {})
    } catch (e) {}
  }
  poll()
  setInterval(poll, POLL_MS)
}

/* ---- 压缩提醒横幅（2026-10-07 加，用户点名）----
   到阈值只做一件事：在页面右上角显示一张醒目卡片，提醒用户"该手动压缩了"。
   **不做任何自动动作** —— 不压缩、不写检查点、不换会话（用户原话：
   "只提醒我，剩下的我自己按"）。
   刻意独立于 .dshwv-menu 启动：横幅不能依赖 cost-whale 菜单存在，
   否则用户不展开那个菜单就永远看不到提醒。 */
var DISMISS_KEY = 'dsh.ac.remind.dismissed'
var bannerEl = null
var bannerThr = 0
// 关闭按钮要写的那个 key 后缀。2026-10-09 抽出：提示条现在有**两种**用途，
// 不能再用"阈值"当唯一身份 —— 否则关掉一种会把另一种也一起关掉。
var bannerKey = ''

function ensureBanner() {
  if (bannerEl && bannerEl.parentNode) return bannerEl
  bannerEl = document.createElement('div')
  bannerEl.className = 'ac-banner'
  bannerEl.style.display = 'none'
  var t = document.createElement('div')
  t.className = 'ac-banner-title'
  t.textContent = '上下文快满了，建议压缩'
  var b = document.createElement('div')
  b.className = 'ac-banner-body'
  var btn = document.createElement('button')
  btn.className = 'ac-banner-btn'
  btn.textContent = '知道了'
  btn.addEventListener('click', function () {
    try { localStorage.setItem(DISMISS_KEY, (currentSessionId() || 'unknown') + ':' + bannerKey) } catch (e) {}
    if (bannerEl) bannerEl.style.display = 'none'
  })
  bannerEl.appendChild(t)
  bannerEl.appendChild(b)
  bannerEl.appendChild(btn)
  if (document.body) document.body.appendChild(bannerEl)
  return bannerEl
}

function hideBanner() { if (bannerEl) bannerEl.style.display = 'none' }

/* 统一的显示入口（两种用途共用一条提示条，不新增 DOM）。 */
function showBanner(title, bodyText, key) {
  bannerKey = key
  var el = ensureBanner()
  var t = el.querySelector('.ac-banner-title')
  var b = el.querySelector('.ac-banner-body')
  if (t) t.textContent = title
  if (b) b.textContent = bodyText
  var dismissed = false
  try { dismissed = localStorage.getItem(DISMISS_KEY) === (currentSessionId() || 'unknown') + ':' + key } catch (e) {}
  el.style.display = dismissed ? 'none' : 'block'
}

/* 阀开火的 stage → 给人看的一句话（"插件做了什么 / 为什么没做"）。
   🛑 这张表就是"可见性"的兑现处：在这些分支加它之前，它们**全是光秃秃的 return**，
      用户什么都看不到 —— 于是同一个月里被问了三次"到底生效没有"。 */
var VALVE_STAGE_TEXT = {
  requested: '已请求顺带压缩一次，正在等空闲窗口',
  // 2026-10-09 补：note('preflight') 是新增的 stage，漏了这条会让横幅把英文键名
  // 直接端给用户（状态：preflight）。由 loop-lab/guard-test/test-valve-banner.mjs 的
  // 【E】段动态抓出（它从源码抠出所有 note 调用的 stage 与这张表的键做双向差集）。
  // 🛑 写这类注释时**不要照抄调用形状**（引号包一个假 stage 名）——
  //    那条判据扫的是源码全文，会把注释里的例子当成真的 stage
  //    （2026-10-09 我写了个假的，结果测试报"缺一个叫 x 的 stage"）。
  // 🛑 这段在 widget 的模板字符串里 —— 注释里**不许出现反引号或美元加花括号**，
  //    否则会当场截断那份脚本（2026-10-09 我自己踩过一次）。
  preflight: '已要求先落档：写完压缩前现状总结再压',
  done: '已顺带压缩一次',
  error: '压缩没有成功',
  busy: '没压：被本地准入连续拒绝',
  cooldown: '没压：冷却中（距上次自动压缩不足 10 分钟）',
  'no-idle-window': '没压：会话一直在自动续跑，等不到空闲窗口',
  'no-agent': '没压：插件进程里没有这条会话的引用',
  'no-pressure': '没压：量不出上下文大小',
  'no-threshold': '没压：remindTokens 配置不合法',
  quarantined: '没压：该会话处于隔离态',
  pending: '没压：已有一次压缩在飞',
  disabled: '没压：插件已停用'
}

function refreshBanner(state) {
  // ① 最高优先：**阀开火之后插件做了什么**（2026-10-09 加）。
  //    后端已按 sessionId 过滤过 ⇒ 这里看到的必定是当前会话的事，不会串台。
  var va = state && state.lastValveAbort
  if (va && typeof va.stage === 'string') {
    var when = ''
    if (isFinite(Number(va.at))) {
      var d = new Date(Number(va.at))
      when = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' '
    }
    var head = VALVE_STAGE_TEXT[va.stage] || ('状态：' + va.stage)
    showBanner(
      '急停阀掐断了这一回合',
      when + (va.reason || 'loop-valve') + '　→　' + head + (va.detail ? '（' + va.detail + '）' : ''),
      'valve:' + va.at + ':' + va.stage
    )
    return
  }
  // ② 其次：到阈值提醒（2026-10-07 的原逻辑，一字未改）。
  var thr = Number(state && state.remindTokens)
  if (!isFinite(thr) || thr <= 0) { hideBanner(); return }
  if (state.sessionMode !== 'remind') { hideBanner(); return }
  var p = state.pressure
  var total = p && isFinite(Number(p.totalTokens)) ? Number(p.totalTokens) : NaN
  if (!isFinite(total) || total < thr) { hideBanner(); return }
  bannerThr = thr
  showBanner(
    '上下文快满了，建议压缩',
    '当前 ' + fmtK(total) + ' / 阈值 ' + fmtK(thr) + ' —— 建议现在按 /compact。我不会替你做任何事。',
    String(thr)
  )
}

function bannerPoll() {
  try {
    fetch(STATE_URL + '?sessionId=' + encodeURIComponent(currentSessionId() || ''))
      .then(function (r) { return r.json() })
      .then(function (state) { refreshBanner(state) })
      .catch(function () {})
  } catch (e) {}
}

function bootBanner() {
  if (!document.body) { setTimeout(bootBanner, 200); return }
  bannerPoll()
  setInterval(bannerPoll, POLL_MS)
}

bootBanner()

/* 自带浮动面板（2026-10-15 加）：
   面板原本只挂在桌宠插件（dsh-cost-whale）的菜单 .dshwv-menu 里，
   没有那个插件的人就**完全没法手动调阈值**。这里给它一个自己的家：
   右下角一个可折叠的小按钮，点开就是同一套面板（ensurePanel / start 都与容器无关）。
   显式入口：URL 带 ?acfloat=1 或 #acfloat 时直接用浮动面板（自查用）。 */
function mountFloat() {
  if (window.__dshAcFloat) return
  window.__dshAcFloat = true
  // ⚠️ 定位与折叠**全部走 inline style**，不进上面那个 css 数组 ——
  //    实测过：往那个数组里加规则会被 join 出来的分隔符吃掉（最后一条规则的
  //    selectorText 会多出一个字符，整条 .ac-float 被浏览器丢弃）。
  var host = document.createElement('div')
  host.className = 'ac-float'
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147482990;width:320px;text-align:left'
  var body = document.createElement('div')
  body.className = 'ac-float-body'
  body.style.cssText = 'display:none;margin-top:6px;max-height:62vh;overflow:auto;padding:2px;background:#fff;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18)'
  var btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'ac-float-btn'
  btn.style.cssText = 'display:block;margin-left:auto;padding:5px 11px;border-radius:15px;border:1px solid rgba(32,49,112,.35);background:#fff;color:#203170;font-size:11.5px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.15)'
  btn.textContent = '检查点 ⚙'
  btn.addEventListener('click', function () {
    body.style.display = (body.style.display === 'block') ? 'none' : 'block'
  })
  host.appendChild(btn)
  host.appendChild(body)
  document.body.appendChild(host)
  ensurePanel(body)
  start(body)
}

function boot() {
  try {
    if (/[?&#]acfloat/.test(location.href)) { mountFloat(); return }
  } catch (e) {}
  var menuBox = document.querySelector('.dshwv-menu')
  if (menuBox) {
    var panel = ensurePanel(menuBox)
    start(menuBox)
    return
  }
  // The whale menu mounts after its widget script runs; wait for it.
  var tries = 0
  var timer = setInterval(function () {
    menuBox = document.querySelector('.dshwv-menu')
    if (menuBox) {
      clearInterval(timer)
      ensurePanel(menuBox)
      start(menuBox)
    } else if (++tries > 40) {
      clearInterval(timer)
      // 等不到桌宠菜单 ⇒ 用自己的浮动面板（否则没人能调阈值）
      mountFloat()
    }
  }, 250)
}
boot()
})()
`
}
