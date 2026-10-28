/**
 * 面板 render 的真实浏览器回归测试（2026-09-21 新增）。
 *
 * 钉住一个**原有 bug**：`els.thr` 的查询用 `.ac-thr`，但面板创建该元素时
 * 用的是 `ac-cur` 类 → `els.thr` 恒为 null → `render` 在
 * `els.thr.textContent = ...` 抛 TypeError →
 * **那一行之后的所有回填全部静默失效**（`.catch(function(){})` 吞掉了错误）。
 *
 * 症状（用户可见）：
 *   · 原有：面板的"当前 token / 阈值"显示与进度条**从不更新**
 *   · 加边界滑块后：滑块恰好排在崩溃点之后，**刷新永远回到 0**
 *
 * 为什么用真实 Chromium 而不是假 DOM：这个 bug 的本质是
 * **querySelector 选不中**，只有真实 DOM 才能复现。假 DOM 会把这个 bug 藏起来。
 *
 * 用法：node test/widget-render.test.mjs
 */
// 从**当前源文件**重新生成 widget（不依赖运行中的 web，因为还没重启）
import { chromium } from '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs'
import { readFile, writeFile } from 'node:fs/promises'

// 直接 import 插件拿 buildWidgetJs 不方便（它是内部函数），
// 改为：把 index.js 里的 widget 模板抠出来求值。
// 更稳的做法：起一个假 webServer，让插件把 widget 注册进来。
const routes = new Map()
const ctx = {
  logger:{info(){},warn(){},error(){},debug(){}},
  on(){},
  inject(n,cb){ if(n.includes('webServer')) cb({webServer:{register(e){routes.set(e.path,e.handler);return()=>{}},tapIndex(){return()=>{}}}}) },
  effect(f){const d=f();return()=>d?.()},
  tokenMeter:{measure:()=>({totalTokens:1})},
  get(){return undefined},
}
process.env.DSH_HOME = '/tmp/verify-home'
const p = await import('/root/4/dsh-auto-checkpoint/index.js?verify=' + Date.now())
p.apply(ctx, { triggerTokens: 300000 })
const widgetHandler = routes.get('/dsh-auto-checkpoint/widget.js')
let widget = ''
await widgetHandler({ method:'GET', url:'/dsh-auto-checkpoint/widget.js' }, { statusCode:200, setHeader(){}, end(c){ widget = String(c ?? '') } })
console.log('widget 长度:', widget.length, ' 含 ac-thr 类:', widget.includes("'ac-cur ac-thr'"))

const html = `<!doctype html><html><body><div class="dshwv-menu" id="menu"></div>
<script>
window.__state={ok:true,triggerTokens:800000,taskBoundaryTokens:330000,autoNewSession:true,enabled:true,checkpointPath:'x',pressure:{totalTokens:123456}};
window.fetch=function(u){ if(String(u).indexOf('/state')>=0) return Promise.resolve({ok:true,json:()=>Promise.resolve(window.__state)}); return Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true})}); };
</script><script>${widget}</script></body></html>`
const b = await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox']})
const pg = await b.newPage()
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)))
await pg.setContent(html,{waitUntil:'networkidle'})
await pg.waitForTimeout(900)
const r = await pg.evaluate(()=>{
  const q=(s)=>document.querySelector('.ac-panel '+s)
  return {
    range: q('.ac-range')?.value,
    num: q('.ac-num')?.value,
    bRange: q('.ac-brange')?.value,
    bNum: q('.ac-bnum')?.value,
    cur: q('.ac-cur')?.textContent,
    thr: q('.ac-thr')?.textContent,
    barW: q('.ac-bar-fill')?.style.width,
  }
})
// ── 断言（不只看，要判）──
const checks = [
  ['无页面错误', errs.length === 0],
  ['阈值滑块回填 800000', r.range === '800000'],
  ['阈值数字框回填 800000', r.num === '800000'],
  ['⭐ 边界滑块回填 330000', r.bRange === '330000'],
  ['⭐ 边界数字框回填 330000', r.bNum === '330000'],
  ['崩溃点之后的控件也更新了（阈值显示）', r.thr === '800k'],
  ['崩溃点之后的控件也更新了（当前 token）', r.cur === '123k'],
  ['崩溃点之后的控件也更新了（进度条）', r.barW && r.barW !== '0'],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}
if (errs.length) for (const e of errs) console.log('    页面错误: ' + e)
console.log(`\n${checks.length - failed}/${checks.length} passed`)
await b.close()
if (failed > 0) process.exitCode = 1
