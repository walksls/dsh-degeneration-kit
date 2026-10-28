/**
 * 「落档里出现交棒意图 → **只提醒、不自动开**」的确定性回归测试（用户拍板 2026-10-11）。
 *
 * 与 `task-boundary.test.mjs` 同一套路：假 cordis 上下文捕获 hook，不启动 DSH、不用模型。
 *
 * 用法：
 *   node test/handoff-intent.test.mjs [pluginIndexPath]
 *
 * 传旧版本路径（例如 `index.js.bak-20261011-handoff-water-gate`）⇒ 三条"正例"全红，
 * 证明它是**回归测试**而不是现状描述。
 *
 * 三个必须锁住的性质：
 *   ① 文件里写着"请开新会话" ⇒ **提醒**（注入一句话），但**决策仍是 enter**（= 没有交棒）；
 *   ② 模板固有词「（下一棒必看）」**不许**触发 —— 否则每份检查点都会吵一次；
 *   ③ `requested` / 已交接的会话**不再多嘴**（那条路走正规交接）。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 运行时配置在 import 时解析路径；指向空目录，避免真实 ~/.dsh/auto-checkpoint.json 干扰。
const home = await mkdtemp(join(tmpdir(), 'cp-intent-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
}

function makeContext({ totalTokens }) {
  const handlers = new Map()
  return {
    handlers,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) { handlers.set(name, handler) },
    inject() {},
    effect(fn) { const d = fn(); return () => d?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get() { return undefined },
  }
}

const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })
const stepEvent = () => ({ type: 'step/start', data: {} })

/** 决策里有没有注入插件消息（v4 形态 `kind: 'plugin:<name>'`）。 */
const asked = (d, pluginName) =>
  (d?.messages ?? []).some((m) => m.source?.kind === `plugin:${pluginName}`)

let seq = 0
/**
 * 一个场景：写指定内容的检查点 → 跑 turn-stopping（触发检测）→ 再跑 pre-step（取提醒）。
 * 返回 `{ reminder, decision, phaseHint }`。
 */
async function scenario({ body, totalTokens = 10_000, config = {}, rounds = 1 }) {
  seq += 1
  const cwd = await mkdtemp(join(tmpdir(), `cp-intent-cwd-${seq}-`))
  const sid = `session-intent${String(seq).padStart(4, '0')}`
  const short = sid.replace(/^session-/, '').slice(0, 8)
  const file = join(cwd, `checkpoint-${short}.md`)
  if (body !== null) await writeFile(file, body, 'utf8')

  const ctx = makeContext({ totalTokens })
  const plugin = await import(`${pluginPath}?intent=${seq}`)
  plugin.apply(ctx, {
    triggerTokens: 300_000,
    checkpointPath: 'checkpoint-{{session}}.md',
    autoNewSession: true,
    ...config,
  })
  const preStep = ctx.handlers.get('agent/pre-step')
  const turnStopping = ctx.handlers.get('agent/turn-stopping')
  const agent = {
    id: `agent-intent${seq}`,
    session: { id: sid, header: { cwd }, seq: 1, eventAt: () => stepEvent() },
  }
  let d = null
  for (let round = 1; round <= rounds; round += 1) {
    if (turnStopping !== undefined) await turnStopping({ agent, turn: round })
    // 检测是 fire-and-forget（`void …`），等它读完文件再问 pre-step 要提醒。
    await new Promise((r) => setTimeout(r, 150))
    d = await preStep({ agent, signal, step: round, turn: round, messages: [] }, enter)
  }
  return { d, plugin, file }
}

async function main() {
  const namePlugin = await import(`${pluginPath}?intentname=1`)
  const N = namePlugin.name

  // ① 正例：明确祈使句 → 提醒，但**不交棒**（决策仍是 enter）
  {
    const { d } = await scenario({
      body: '# 检查点\n\n## 下一步\n👉 请开新会话接着做，这个会话图额度快满了。\n',
    })
    check('写着「请开新会话」→ 提醒用户', asked(d, N), true)
    check('提醒**不等于**交棒（决策仍是 enter）', d?.kind, 'enter')
  }

  // ② 防假阳性（最重要）：模板固有词「（下一棒必看）」不许触发
  {
    const { d } = await scenario({
      body:
        '# 检查点\n\n## 项目知识档案（下一棒必看）\n- /root/4/foo.md\n\n' +
        '## 已读水位线\n已读：…（下一棒会读到这份文件，别重复分析）\n',
    })
    check('模板固有词「下一棒必看」→ 不提醒', asked(d, N), false)
  }

  // ③ 防假阳性：没有文件 / 空文件 → 不提醒、不报错
  {
    const { d } = await scenario({ body: null })
    check('检查点不存在 → 不提醒', asked(d, N), false)
  }

  // ④ 正例：正文里直接点了脚本名 `handoff.sh` → 提醒
  {
    const { d } = await scenario({
      body: '# 落档\n\n要交棒就调 `bash ~/.dsh/tools/handoff.sh "<说明>" --next "<第一件事>"`。\n',
    })
    check('正文提到 handoff.sh → 提醒', asked(d, N), true)
  }

  // ⑥ 防假阳性：**描述性**提到脚本（知识档案 / 工具索引那种）不许触发
  {
    const { d } = await scenario({
      body:
        '# 检查点\n\n## 项目知识档案（下一棒必看）\n' +
        '- 会话自己交棒的工具：`~/.dsh/tools/handoff.sh`（详见 AGENTS §12.1）\n' +
        '- handoff.sh 的调用样例写在插件提示词第 10 条里。\n',
    })
    check('只是描述性地提到 handoff.sh → 不提醒', asked(d, N), false)
  }

  // ⑤ 已交接的会话不再多嘴：高压力 + autoNewSession=false 会把它推过
  //    watching → requested → checkpoint-only（**走的是正规那条路**），
  //    此后文件里就算写着"请开新会话"，也不该再提醒。
  {
    const { d } = await scenario({
      body: '# 检查点\n\n请开新会话接着做。\n',
      totalTokens: 400_000,
      config: { autoNewSession: false },
      rounds: 2,
    })
    check('已进 requested/checkpoint-only → 不再提醒', asked(d, N), false)
  }

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${r.name}`)
    else
      console.log(
        `  FAIL  ${r.name}\n        expected ${JSON.stringify(r.expected)}\n        actual   ${JSON.stringify(r.actual)}`,
      )
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
