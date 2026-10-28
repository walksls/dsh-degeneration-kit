# 测试说明（dev-only）

`checkpoint-driver.js` 替换 headless runner，用**真实模型**跑一个任务：

1. 阈值 `triggerTokens: 1`（任何真实步骤都会立即越过）；
2. 插件在 pre-step 注入「写 checkpoint.md」的用户消息；
3. 模型用 write 工具把项目状态写进 `checkpoint.md`；
4. 插件在后续 pre-step / turn-stopping 检测到文件已落盘；
5. handoff：fake `sessionController` 记录 `create`、`prompt` 调用，driver 打印 REPORT。

## 复现

```bash
# 1. 把插件装进 headless profile（一次）
cd /root/dsh-linux
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile headless add /root/4/dsh-auto-checkpoint

# 2. 测试驱动依赖 dsh 内部包，需要符号链接（因为包目录不在 node_modules 树内）
mkdir -p test/node_modules/@deepseek-ai
ln -sfn /root/dsh-linux/node_modules/@deepseek-ai/dsh-agent test/node_modules/@deepseek-ai/dsh-agent
ln -sfn /root/dsh-linux/node_modules/@deepseek-ai/dsh-llm   test/node_modules/@deepseek-ai/dsh-llm

# 3. 在空目录里跑（检查点文件会写进 cwd）
mkdir -p /tmp/cp-test && cd /tmp/cp-test && rm -f checkpoint.md hello.txt
CHECKPOINT_PATH=$PWD/checkpoint.md timeout 280 \
  node /root/dsh-linux/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch /root/4/dsh-auto-checkpoint/test/cp.patch.yml \
  "任务：把一句话 checkpoint driver ok 写入 hello.txt 文件，然后结束。"
```

预期：REPORT 里 `checkpointSize > 0`、`creates` 1 条、`prompts` 1 条（内容含
"checkpoint.md" 的继续指令）。跑完清理 `test/node_modules` 符号链接。

## 注意

- 假 `sessionController` 只验证插件**调用**了 create/prompt，不验证真会话
  生命周期（headless 没有该服务）；web profile 里装的是真的。
- 需要真实模型 + 中转 API key（走 `~/.dsh/.credentials.yaml`）。

## 回归测试：park 门（含跨重启）+ 交棒暂停 goal + 权限预设/模型继承

背景（2026-09-17 实战踩到两件事）：

1. 会话带**活跃 goal** 时，goal-round-driver 会在每次静默期注入 `<goal_round>`。
   旧版 park 门只看 `step`，把这个自动注入当成"用户回来了"，于是交棒后的旧会话
   被放回 `resumed`，和自己的后继在同一个工作区里继续干活（实测 20 分钟并发改
   文件，用户手动才停住）。
2. 子会话刚建出来时用的是 profile **默认**权限旋钮（`workspace-write` + `ask`），
   父会话被用户切到「完全权限」也不会传下去（实测：`095fb27a` 完全权限 → 它的
   子会话 `27175d59` 变回 `workspace-write`）。交棒后子会话要做同一件事，却悄悄
   变弱，工作区外的写入就会卡住。
3. 同一类盲区还有**模型选择**：`sessionController.create()` 一律用部署默认模型建
   子会话，父会话被切到别的模型（或别的推理档位）也不会传下去 —— `index.js` 的
   `inheritModelSelection()` 修的就是它（父会话本来就在默认模型上时故意跳过）。
4. 相位机原先只在内存里（`states` 是个纯 `Map`），**重启 web 就把 park 标志丢光**：
   实测 22:38 重启后插件对那个已交棒的会话一无所知（`/state?sessionId=…101697f2`
   返回 `pressure:null`，连会话都没被加载），它一旦被自动注入唤醒（goal 轮 / 后台
   任务通知 / 子代理汇报）就会和后继会话并排干活 —— 正是 park 门要拦的那件事。
   修法：`parked` / `handoff-pending` 落盘到 `$DSH_HOME/auto-checkpoint-state.json`，
   模块加载时（注册任何钩子**之前**）恢复；只落这两种相位，因为丢 `resumed` /
   `checkpoint-only` 只是把自动检查点重新武装，而重启本来就是"重新武装"。

### 一、确定性测试（不用模型，秒级，可对任意版本跑）

```bash
cd /root/4/dsh-auto-checkpoint
node test/park-gate.test.mjs                                   # 期望 26/26 passed
node test/park-gate.test.mjs /root/4/.dsh-scratch/before-park-persist/index.js  # park 落盘修复前：23/26（红的 3 条正是跨重启那一组）
node test/park-gate.test.mjs /root/4/.dsh-scratch/before-model/index.js         # 无模型继承的上一版：21/26
node test/park-gate.test.mjs /root/4/.dsh-scratch/before/index.js               # 最老的改前快照：13/26
node test/workspace-attach.test.mjs                            # 期望 11/11 passed
# 判别力：把旧版本 cp 成 .mjs 再跑（Node 不认 `.bak-中文` 扩展名）
cp index.js.bak-20261015-修派活会话进未分组前 /tmp/before-ws.mjs
node test/workspace-attach.test.mjs /tmp/before-ws.mjs         # 派活进工作区修复前：5/11
```

`workspace-attach.test.mjs`（2026-10-15，用户实报「派出去的会话全掉进侧边栏『未分组』」）用同一个假 ctx
驱动**真实交接路径**，但判据是 `sessionController.create()` 的**实参**：cwd 命中已注册工作区时必须换成
`workspaceId`（且**不许**同时带 `cwd`，上游会 `bad-request`）；带**尾斜杠**或**软链接**的写法也要命中
（工作区里存的是 realpath）；未注册的路径原样 `{ cwd }`；拿不到 registry / `list()` 抛异常时原样 `{ cwd }`
且**不抛**；会话自己的 `agentPreset` 必须跟着传下去。判别力：修复前 **5/11**，
「只按字面比」的中间版 **9/11**（正好红在尾斜杠/软链接两条）。
⚠️ 写这类场景的坑：检查点文件必须**比 `askedAtMs` 新**才被确认（`setPhase('requested')` 时盖戳），
⇒ 要先过阈值、**再把文件写新鲜**，否则 `create()` 永远不会被调用（第一版测试 11 条全红就是这么来的）。

它用假 ctx 直接驱动 `agent/pre-step`：先走完 `watching → requested →
handoff-pending → parked`，再分别喂 goal 轮 / 后台任务通知 / 插件自己的继续提示 /
真人消息。断言这些事：交棒时**先** `goals.pause` 再 `create`；权限预设在
`prompt` 之前交给子会话；模型选择同样在 `prompt` 之前交给子会话（父会话在默认
模型上时不写、模型不可用不影响交棒）；parked 状态只放行真人消息；父预设是
`custom` 时只记录、不猜测、也不影响交棒；以及**交棒把 park 标志写进磁盘，换一个
模块实例（= 重启 web，同一个 `$DSH_HOME`）后照样拦得住注入的 goal 轮、真人消息
仍能唤醒它、唤醒后磁盘上的条目被清掉**。

最后那一组共 4 条断言，其中 3 条对 `before-park-persist` 快照是红的（第 4 条
"清掉条目"在旧代码上因为压根没有文件而空过）——判别力就是这么验的。

注意假投影必须返回**投影状态** `{lastUsed, pending}`，不是 wire 视图
`{lastUsed, next}`——写错过一次，插件读到的 `pending ?? lastUsed` 全是
`undefined`，测试会以"插件没继承"的形式失败（`index.js` 的读法与
session controller 的 `selectionFor()` 一致）。

### 二、端到端测试（真实模型 + 真实 goal driver）

`goal-park-driver.js` 复现整个场景：源会话先 `goals.create(...)` 装上目标、再用
`permissionPresets.set(..., 'danger-full-access')` 把自己加宽成完全权限，然后跑
任务 → 越阈值 → 模型写检查点 → 交棒建子会话 → **看旧会话还会不会自己续跑，以及
子会话有没有继承权限**。

报告里判定字段：

| 字段 | 修复后 | 修复前 |
|---|---|---|
| `source.goalPhaseAfter` | `paused` | `complete` / `active` |
| `source.goalRounds` | `0` | ≥ 1 |
| `source.turns.length` | `1` | ≥ 2 |
| `source.stepsAfterTurn1` | `0` | > 0（真在干活） |
| `children.length` | `1` | `1`（接力本身必须仍然可用） |

跑法（`DSH_HOME` 必须指向**没有** `auto-checkpoint.json` 的目录，否则运行时文件会
覆盖 patch 里的 `triggerTokens: 1`；`~/.dsh` 本身在工具沙箱里是只读的）：

```bash
# 镜像 DSH_HOME：settings/credentials/presets 用符号链接，sessions/storages 用空目录，
# profiles/headless 是拷贝（node_modules/dsh-auto-checkpoint 指向真实插件目录）
DSH_HOME=/root/4/.dsh-scratch/home \
CP_PLUGIN=/root/4/dsh-auto-checkpoint/index.js \
  timeout 280 node /root/dsh-linux/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch test/goal-park.patch.yml "goal-park run"
```

A/B 对照：把 patch 里的 `name:` 换成改前的 `index.js` 快照路径（见
`/root/4/.dsh-scratch/goal-park-before.patch.yml`），其余完全不变。

### 三、真机自然交棒验收（2026-09-17 22:10 / 22:30 实测）

上面两种测试都在隔离环境里跑。**真机**（web 里真跑出来的交棒）用
`test/handoff-acceptance.mjs` 判：它只读持久会话日志
（`$DSH_HOME/sessions/*/session-*/session.v3.jsonl.zstd`），不依赖插件日志
（插件日志根本不落 `web.log`），所以结论不经过任何自定义通道。

```bash
cd /root/4/dsh-auto-checkpoint
node test/handoff-acceptance.mjs                    # 盘上所有交棒（含历史）
node test/handoff-acceptance.mjs 14ff938d 101697f2  # 只判这一对（短 id 即可）
```

判据（每条都是日志事实）：交棒后旧会话 `turn/start` 与 `step/start` 是否都为 0；
交棒时若 goal 还 armed，±5s 内有没有 `goal/change(operation=pause)`；
交棒后有没有被喂过 goal 轮；子会话在 create 后 10s 内的 `permission/preset`
是否等于父会话交棒时的预设（**只看交棒那一刻继承到的值**——用户事后手动加宽
子会话不算继承，`14ff938d` 就是这种，读"当前值"会假通过）；子会话**第一个**
`request/header` 的 `header.config`（provider/model/reasoningEffort）是否等于父会话
交棒时的模型选择——父会话的模型优先读 `model/selection` 事件（插件交下去的正是
这个投影值），没有该事件时退回它最后一个 `request/header`。

模型那条的已知口径限制：日志里分不出 `pending` 与 `lastUsed`，所以"父会话刚切了
模型、但还没在会话里用过一次就交棒"这种情况，可能被读成切换前的旧模型。真遇到
不匹配，先确认是不是这个情形，再怀疑插件。

goal 那条有个坑（2026-09-17 22:30 踩到）：插件是**先 pause、后 `create()` 子会话**，
pause 事件的时间戳因此**早于**子会话的 `createdAt`（实测早 13ms）。所以"armed"必须看
**暂停事件之前**那个 `goal/change` 的 phase，而不能看"交棒时刻及之前最后一个"——
后者对正确实现恒为 `paused`，会让这条断言永远不生效（原实现就是这样，见下）。

模型那条也自己验过（真的跑过，不是"应该"）：用合成会话日志喂给脚本（`DSH_HOME`
指向临时目录即可，脚本只认 `$DSH_HOME/sessions/*/session-*/session.v3.jsonl.zstd`），
父会话"切到 `[Cloud]DeepSeek-V4.1-Flash` 但最后一次请求还跑在默认模型"这一情形：
子会话跟着用 Cloud → **PASS**；子会话掉回默认 → **FAIL，且只挂模型那一条**。
（合成日志见 `/root/4/.dsh-scratch/accept2/model-fixture.mjs`。）

**2026-09-17 22:10:52 的真机交棒 `14ff938d → 101697f2`：PASS**

```
parent: 14 turn(s); after the handoff: 0 turn / 0 step / 0 tool call
PASS  old session stopped after the handoff
note: handoff turn ended 'blocked'
goal: no armed goal at handoff (phase none) — pause path not applicable
PASS  no goal round served after the handoff — 0 round(s)
preset: parent danger-full-access → child workspace-write (published)
        → danger-full-access (inherited, +5ms) → danger-full-access (current now)
PASS  child inherited the parent permission preset
model: parent api2/deepseek-v4.1-flash (effort max) → child api2/deepseek-v4.1-flash (effort max) (first request)
PASS  child inherited the parent model selection
child: cwd /root/4 preset loli-mom seeded false
```

同一把尺子量修复前的交棒（`9073b0c0 → 7d3cea93`，02:47:21）是 **FAIL**，
失败项正好是当年的现场症状——交棒后旧会话又开了 **3 个 turn / 114 step /
114 次工具调用**、goal 没被暂停、还被喂了 **2 个 goal 轮**：

```bash
node test/handoff-acceptance.mjs 9073b0c0 7d3cea93   # 期望 exit 1
```

**2026-09-17 22:30:27 的真机交棒 `101697f2 → c717abb2`：PASS（第一次带活跃 goal）**

这一棒是用户特意造出来补"活跃 goal"那一格的：父会话 22:29:53 建了个
`maxGoalRounds: 1` 的 goal（phase=active），22:30:27 交棒。

```
parent: 1 turn(s); after the handoff: 0 turn / 0 step / 0 tool call
PASS  old session stopped after the handoff
note: handoff turn ended 'blocked'
PASS  armed goal paused at the handoff — 09-17 22:30:27.704 (-13ms vs the child; armed until then)
PASS  no goal round served after the handoff — 0 round(s)
PASS  child inherited the parent permission preset — danger-full-access vs danger-full-access
model: parent api2/deepseek-v4.1-flash (effort max) → child api2/deepseek-v4.1-flash (effort max) (first request)
PASS  child inherited the parent model selection
child: cwd /root/4 preset loli-mom seeded false created 09-17 22:30:27.717
```

原始日志：`22:29:53.692 op=create phase=active` → `22:30:27.704 op=pause phase=paused`，
子会话 `createdAt` 是 `22:30:27.717`（暂停早 13ms）。**上面那条"先暂停后创建"的坑就是
这一棒暴露的**：脚本原先对这一棒打印 `pause path not applicable`，等于什么都没验；
补丁 `.dsh-scratch/accept2/goal-pause-check.patch` 修好后才是 PASS，而 02:47 那个
修复前的交棒改后仍然 FAIL（判别力没丢）。

注意 `--all`（无参数）会把历史交棒一起判：**修复上线（09-17 22:09）之前的
FAIL 是正常的历史记录，正是这个工具判别力的证明**（现存 4 个 FAIL 全在 22:09 之前：
02:07 / 02:14 / 02:47 / 05:02），只有 22:09 之后新产生的交棒 FAIL 才需要处理。
**已无"活跃 goal"残余空缺**——22:10 与 22:30 两次真机交棒都 PASS。

原始输出留档：`/root/4/.dsh-scratch/accept2/acceptance-2026-09-17.txt`。
