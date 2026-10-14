# dsh-auto-checkpoint

**[English](README.en.md) | 中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
监控会话上下文 token 压力，到达阈值时自动要求模型把项目状态写成检查点文件，
随后（可选）自动创建新会话、把「继续干」的指令喂进去，旧会话不再消耗上下文。

## 它解决什么问题

上下文越长，模型对最开头信息的召回越差、单次请求越贵。与其让一个会话无限
堆到窗口边缘（并反复犯早期已经修好的 bug），不如在阈值处留一个检查点，换
新会话继续。

## 工作机制

| 阶段 | 发生什么 |
|---|---|
| watching | 每轮第一步前量 `ctx.tokenMeter.measure(session).totalTokens`；低于阈值不动作 |
| requested | 超过阈值：注入一条插件署名 user 消息，要求模型用 `write` 工具把项目状态写入 `checkpointPath` |
| handoff | 确认文件已落盘（非空）后：先 `goals.pause()` 停掉旧会话的活跃 goal，再 `whenIdle` → `sessionController.create()` 建新会话（同 cwd、同 agent preset）→ 把父会话的**权限预设**和**模型选择**交给子会话 → `prompt()` 喂入继续指令，旧会话转为 parked |
| parked | 旧会话的后续步骤一律被 `agent/pre-step` 拒绝，收敛到 idle，不再产生 token 消耗 |
| checkpoint-only | `autoNewSession: false` 时只写文件，会话继续跑 |

- 提醒兜底：模型迟迟不写检查点文件时，每 `remindEverySteps` 步注入一次
  简短提醒，避免静默膨胀到窗口边缘。
- 停旧会话用的是 pre-step **拒接**，不是强杀：当前进行中的一步会执行完，
  之后自然停下来。
- **只有真人消息能唤醒 parked 会话**。goal 轮（`<goal_round>`）、后台任务通知、
  子代理回报都是自动注入，一律拒绝——否则旧会话会被"当成用户回来了"而解除
  parked，和自己的后继在同一个工作区里并发干活（2026-09-17 实测踩到，后来补了回归测试覆盖这条）。真人回到旧窗口发消息则恢复正常聊天（不再自动
  检查点）。
- 交棒时暂停的是**旧会话**的 goal；goal 不跨会话，新会话按检查点文件自己重新
  立目标。
- **权限预设会继承**：子会话刚建出来时用的是 profile 默认旋钮
  （`workspace-write` + `ask`），插件随后把父会话的预设交给它（`ctx.permissionPresets.set`），
  所以你在界面上切到「完全权限」的会话，交棒后子会话仍是完全权限。否则子会话会
  悄悄变弱、在工作区外的写入上卡住（2026-09-17 实测：`095fb27a` 是完全权限，
  它的子会话 `27175d59` 却回到 `workspace-write`）。父会话若是 `custom`
  （旋钮不匹配任何预设），插件只记录一条 warn，不猜测。
- **模型选择也会继承**：`sessionController.create()` 建子会话时取的是部署默认
  模型，所以你在会话里换过模型（或换过推理档位）的话，交棒后会掉回默认模型。
  插件从 `modelSelection` 投影读父会话当前选择（`pending ?? lastUsed`），在继续
  指令之前用 `sessionController.selectModel` 装到子会话上——就是界面切模型用的
  同一个接口，因此不可用的模型装不上。父会话本来就在默认模型上时跳过：子会话
  天生就在那儿，再调一次只会把同一个默认值重存一遍。

## 安装

```bash
dsh plugin --profile web add /绝对/路径/dsh-auto-checkpoint
```

包声明了 `dsh.bundle.patch`，安装时自动加入 profile 的 bundle 层栈。

## 配置

在 profile 的 `cordis.patch.yml` 中配置（默认值即上面文件里的示例）：

```yaml
- id: auto-checkpoint
  config:
    triggerTokens: 300000     # token 触发阈值
    checkpointPath: 'checkpoint-{{session}}.md'  # 每个会话写自己的文件
    autoNewSession: true      # true: 写完后自动开新会话并停旧会话
    continuePrompt: '这是新会话。请先读取工作区中的 {{path}} …'  # 喂给新会话的首条消息
    remindEverySteps: 3       # 检查点迟迟未写入时的提醒间隔
```

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `triggerTokens` | number | `300000` | 到达该 token 压力后触发检查点。留足余量：token 计量是估算（4 字符≈1 token，中文会低估） |
| `checkpointPath` | string | `checkpoint-{{session}}.md` | 检查点文件路径，相对会话 cwd 或绝对路径。**`{{session}}` 会替换成会话短 id**（如 `checkpoint-9b1a8732.md`），接力链上每一棒写自己的文件、互不覆盖；写成不带占位符的固定名（如 `checkpoint.md`）则退回单文件行为 |
| `autoNewSession` | boolean | `true` | `false` 时只写检查点，不换会话（面板上就是「写完后自动开新会话」开关） |
| `continuePrompt` | string | 见 README | 新会话的第一条消息；`{{path}}` 替换成**该会话自己的**检查点路径 |
| `remindEverySteps` | number | `3` | requested 阶段每隔几步提醒一次写入 |

### 长任务接力

配置是**全局的**（存 `~/.dsh/auto-checkpoint.json`），跨会话、跨 web 重启都保留。
`autoNewSession: true` 时，接力链自动进行：会话 A 越阈值 → 写 `checkpoint-A.md`
→ 自动创建会话 B 并喂「读 `checkpoint-A.md` 继续」→ B 越阈值 → 写
`checkpoint-B.md` → 创建 C……因为每棒的文件名带自己的会话 id，**检查点不会
互相覆盖**，理论上可一直接力到任务完成。

### 阈值怎么定（三个数，必须有序）

它有三个水位，管的事完全不同：

| 键 | 代码默认 | 作用 | 本机在用的 |
|---|---|---|---|
| `taskBoundaryTokens` | 150,000 | 任务边界：完成一个 todo 就提醒落档 | **250,000** |
| `triggerTokens` | 300,000 | 压力阈值：到点写检查点 → **接棒换会话** | **350,000** |
| `remindTokens` | 400,000 | **只提醒你**「该手动压缩了」，不做任何动作 | **350,000** |

**0. 先查出你的窗口（这一步不能跳）。** 三个数都是**绝对 token 数**，插件**不会按窗口自适应**（代码里没有这层逻辑）。
- **DSH 官方默认是 256K**：适配器的回退值是 `262144`，设置页的提示就写作 `256K`
  （`dsh-client-ui-settings-models/lib/client.js:559-561`）。
- 本机是**自己把窗口调到 1M 的**（profile 里 `contextWindow: 1048576`）——**这不是默认值**。
- ⇒ 下面的 250k/350k 是**配 ≥512K 窗口**的；你若用 256K，必须按表往下缩。

**1. 必须有序**：`taskBoundaryTokens < triggerTokens`。

**2. 「自动压缩」和「自动接棒」是二选一，不是两个独立开关**（2026-10-11 起，代码在 `index.js:2899-2911`）：
- 给某个会话勾上「自动压缩」⇒ 该会话**交棒整条路不走**（不催写检查点、不开新会话、不冻结旧会话）——它靠压缩一直活着；
- 不勾 ⇒ 交棒照常运行（到 `triggerTokens` 就写检查点、换会话）。

⇒ 这也是为什么本机的 `remindTokens` 敢和 `triggerTokens` **相等**：勾了压缩的会话根本不走接棒那条路，两条路不会打架。

**3. 推荐档位**：

| 你的窗口 | 任务边界 | 落档/接棒 `triggerTokens` | 提醒 `remindTokens` |
|---|---|---|---|
| **256K（官方默认）** | 150k | 180k | 180k |
| **512K** | **250k** | **350k** | **350k** |
| **1M（本机是自己调的）** | **250k** | **350k** | **350k** |

- **512K 和 1M 是同一组数** ⇒ **350k 是"绝对值舒适上限"，不是比例**：窗口再大也别往上加
  （更贵、更慢、退化风险更高），**到 350k 就该接棒**。
- **只有窗口小于 512K 才需要往下缩**：256K 用 180k 落档（≈ 窗口 69%）、150k 边界。
- 出处：512K/1M 两行是**本机正在跑的实测档**；256K 那一行是**按比例推的建议，没在小窗口实测过**。
- 🛑 **直接把本机的数抄给 256K 会出两种毛病**：`triggerTokens=350k` **永远不触发**（看起来像插件坏了）；
  `taskBoundaryTokens=250k` 贴着窗口顶（250k/262k ≈ 95%），会在几乎溢出的位置才落档。

**4. 为什么 1M 窗口也只用到 350k（33%）**：到这个量级，**窗口再大也不会让接棒点更划算** ——
单轮请求更贵更慢、上下文越长退化（复读）风险越高 ⇒ **350k 左右接棒反而最稳**。

### 老会话（600K+）可能压不动 —— 别死磕

**实测（2026-10-07）**：一个已经长到 **684K** 的老会话，两次手动压缩全部失败，界面上只看到
`Compaction could not produce a useful summary`。

真因记在会话日志的 `compaction/end.data.error` 里，是**上游拒绝**：

```
503: {"code":11133,"msg":"Invalid request parameters"}
extError: model_param_invalid
外层 code: no_healthy_account
```

⇒ **不一定是你的会话坏了** —— 那次是渠道拒绝（DSH 自己 `llm/retry` 两次后放弃），
同一账号下、当时别的会话压缩是**成功的**。至于"超长上下文是不是撑出了参数超限"，
日志区分不了，先别急着归因给"会话太老"。

**要救这个老会话**：别反复压。**开一个新会话**，让它去读老会话的**思考 + 用户回答**，
**把工具调用当噪音跳过**（那些动辄几万字符，读它们纯属烧钱）。

### 它和 `thinking-guard` 是一对，建议一起用

| | 干什么 | 时机 |
|---|---|---|
| `thinking-guard` | 把退化的思考块从**模型可见的历史**里折叠掉 | **当场**（下一次 pre-step，趁它还没被反复回传） |
| 本插件（压缩 / 接棒） | 把**已经累积**的污染整体清掉，或干脆换一个新会话 | **事后**（水位到了之后） |

两者的关系**不是重复**：

- 折叠**管不到一次生成内部** —— 一条复读正在生成时它拦不住，只能等下一步再剪；
- 而**累积**起来的多块污染，只有压缩能一次性清掉（本机实测：一个会话 12 次压缩，
  凡有累积污染时压缩后都下降，最强一次 **43 → 0**，且此后零复发）。

⇒ **只用其中一个都不完整**：光折叠，会以"漏检 + 累积"的方式留下污染；
光压缩，两次压缩之间的每一步仍在被污染重放。

## 可视化调节（Web 界面）

装进 web profile 后，插件会在**两个位置之一**渲染一个「自动检查点」区块（哪个存在就用哪个）：

- **装了桌宠插件 `dsh-cost-whale`** ⇒ 在**小鲸鱼菜单**里（右下角鲸鱼娘 → 右上角三条杠
  打开的「小鲸鱼设置」）；
- **没装桌宠** ⇒ 插件自建一个**右下角浮动面板**（默认收成一个小按钮，点一下展开）；
  随时可以用 `?acfloat=1` 强制打开（地址里已经有 `?token=...` 时改用 `#acfloat`）。

两种面板改的是**同一份配置**。

- **阈值滑轨** 50k–1000k + **数字输入框**（≥1000 无上限），改完立即持久化
  到 `~/.dsh/auto-checkpoint.json`（不碰 `settings.yaml`），插件下个 step
  就按新阈值走，**无需重启**；
- **当前压力**：实时显示当前会话 token 压力 / 阈值，带进度条；
- **开关**：`写完后自动开新会话`、`启用自动检查点`；
- 关闭时配置保留，重新打开恢复。

运行时配置文件的优先级高于 `cordis.patch.yml` 里的静态默认值；文件缺失或
字段缺失时回落到静态配置。

## 依赖

- 需要 `ctx.tokenMeter`（`dsh-base` 自带）与 `ctx.sessionController`
  （`dsh-web-app` 自带）。无 sessionController 时自动降级为只写检查点并打日志。
- DeepSeek Harness `>= 0.1.x`（在 `0.1.5-rc.2` 上开发与实测）。
- Node `>= 22.19`。零运行时依赖。

## 卸载

```bash
dsh plugin --profile web remove dsh-auto-checkpoint
```

## 许可证

MIT
