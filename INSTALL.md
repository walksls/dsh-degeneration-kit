# 安装（照着敲就行）

## 0. 先确认你的 dsh 有 `plugin` 子命令

```bash
dsh plugin --help
```

报错的话说明你的版本较老，走**手工挂载**（两个插件各自的 README 里都写了）。

## 1. 装（一条命令）

```bash
cd /你放它的绝对路径/dsh-degeneration-kit
bash install.sh
```

`install.sh` 就干一件事：替你调 `dsh` 自己的安装命令，把两个插件都装上。开关：

| 开关 | 作用 |
|---|---|
| （不带） | 两个都装 |
| `--only guard` | 只装 `thinking-guard`（折叠） |
| `--only checkpoint` | 只装 `dsh-auto-checkpoint`（压缩 / 换会话） |
| `--profile <名字>` | 换 profile（默认 `web`） |

它找不到 `dsh` 命令时会自己去常见位置找 `bin.js`，都找不到就把你要手敲的命令打印出来，不会瞎猜。

想手敲也行，等价于这两条：

```bash
# ① 折叠（推荐至少装这个）
dsh plugin --profile web add /你放它的绝对路径/dsh-degeneration-kit/thinking-guard

# ② 压缩 / 换会话（想要"彻底一点"就再装这个）
dsh plugin --profile web add /你放它的绝对路径/dsh-degeneration-kit/auto-checkpoint
```

⚠️ 路径写**绝对路径**，指向**子目录**（不是仓库根目录）。

**这两条命令会做什么**（本机实测过，468ms 装完）：

- 把包加进 profile 的依赖 —— 本地路径走 `link:`，**不复制文件**，所以你改源码立刻生效；
- **自动把包名加进 profile 的 `bundles` 列表**（因为包里声明了 `dsh.bundle.patch`）。

## 2. 重启 dsh web

插件是**启动时**加载的，`.mjs` 改完刷新页面没用。

## 3. 验证（30 秒，不用猜）

```bash
dsh --profile web --dump-config | grep -A8 'dsh-thinking-guard'
dsh --profile web --dump-config | grep -A8 'auto-checkpoint'
```

第一条应该能看到：

```
- id: thinking-guard
  name: dsh-thinking-guard
  inject:
    - agents
  config:
    enabled: true
```

看到了就是进了插件树 —— 这是"装上了"和"真的加载了"的分界线。

## 4. 改配置 = 改包里的 `cordis.patch.yml`

比如想**先观察、不真动手**：把 `thinking-guard/cordis.patch.yml` 里的

```yaml
        # dryRun: true
```

那行注释去掉，**重启**。已实测这行会进插件树（`--dump-config` 里能看到 `dryRun: true`）。

阈值同理，那个文件里每一项都有注释。

### 阈值也可以直接在界面上拖（不用重启）

`dsh-auto-checkpoint` 的面板有两个入口，**看到哪个用哪个**：

- 装了桌宠插件 `dsh-cost-whale` ⇒ 面板在桌宠的菜单里；
- 没装 ⇒ 插件自带**右下角浮动面板**（默认收成一个小按钮，点开就是滑块）。

浮动面板没自动冒出来的话，在地址后面加 `?acfloat=1` 强制打开，例如 `http://127.0.0.1:3081/?acfloat=1`。
（地址里已经带着 `?token=...` 时**别再加问号**，直接在最末尾加 `#acfloat`。）

拖动是**运行时生效**的（面板往运行时接口发一次 POST，内存和磁盘一起更新），**不用重启**。

## 5. 只装一个行不行？

行。但**建议至少装 `thinking-guard`**：它零宿主服务依赖、只挂一个钩子、不改你的会话结构，装上就没有副作用面。
`dsh-auto-checkpoint` 会**改你的会话**（压缩 / 换新会话），建议先把阈值按自己的窗口配好再开（见它 README 的「配置」一节）。

⚠️ **别在同一个 profile 里重复挂同一条**（比如既装了包、又在 preset 里手写了一份），启动会报 `duplicate loader entry id`。挂之前先 `--dump-config` 看一眼。

## 6. 卸载

把 profile 的 `bundles` 和 `dependencies` 里对应的那两行删掉，重启。
（`dsh plugin --profile web remove <包名>` 应该也行，但我们没实测，所以不写成"一定可以"。）

## 常见问题

| 症状 | 原因 / 怎么办 |
|---|---|
| 装完没反应 | 没重启。插件启动时加载 |
| 面板 / 滑块找不到 | 没装桌宠 ⇒ 地址后加 `?acfloat=1`；装了 ⇒ 点桌宠菜单 |
| 启动报 `duplicate loader entry id` | 之前挂过同名条目，先删旧的 |
| 想看它到底干了什么 | 在 `cordis.patch.yml` 里给 `debugFile` 一个路径，重启后看那个文件 |
| `dsh plugin` 不存在 | 版本较老 ⇒ 手工挂载（各插件 README 的「安装」一节） |
| 想确认它真的在跑 | 配了 `debugFile` 后，日志里会出现 `apply 被调用` 和 `sweep 首次：surface N 节点` |
