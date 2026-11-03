# FreeBridge — DSH 一体化插件

**装完即用。不用登录、不用注册、不用填 API Key，模型直接出现在选择器里。**

一个插件把六件事全包了：匿名免费模型桥接、Token 用量统计、按需网络分流、桌面操作编排、操作边界守门、插件级故障隔离。

不需要改 `cordis.yml`，重启不会被覆盖。所有配置项都有默认值，小白一行都不用动。

---

## 装完即用

```bash
dsh plugin --profile desktop add dsh-freebridge
```

重启 DSH，模型选择器里出现 **FreeBridge** 分组。选 `kilo-auto/free` 就能开始对话。

**首次启动自动完成**：匿名上游探测 → 分流规则初始化 → 守门开启 → 统计账本就绪。不需要你填任何东西。

引导只问两个问题，而且都有默认答案（不回答也照常走）：

1. 是否自动配置免费模型？（默认：是）
2. 是否开启操作边界守门？（默认：是）

---

## 为什么之前那些方法都失败了

| 流传的方法 | 现在真实状态 |
|---|---|
| LLM7.io 的 `Bearer unused` 万能 key | 返回 `401 invalid`，已强制真 key |
| Pollinations 老端点 | 返回 `403 Missing Turnstile token`，要过人机验证 |
| OpenCode 免费池（`xxx-free` 模型） | 全部 `throttled` / `region-blocked`，共享池已枯竭 |
| **Kilo Gateway** | **匿名直接 200，无需任何 key** |
| OVHcloud AI 匿名端点 | 可用但限制 2 RPM，模型 ID 大小写敏感 |

**本插件主通道就是 Kilo Gateway。** 实测拉到 408 个可用模型。

---

## 六个模块

### 模块一 · Token 用量统计

**双计数，防止重试把总量算虚：**

- **尝试级**：记每次真实发出的请求（重试会记多次）
- **逻辑级**：只记最终成功的那个渠道（默认显示这个）

设置页默认看逻辑级，展开看尝试级。

**记账规则（严格实现计划书）：**

| 规则 | 实现 |
|---|---|
| 历史消耗不回溯扣减 | 账本按请求事件**追加写**，编辑/撤回只改标记位，数值永不变 |
| 编辑后重发 | 之前那轮消耗仍计入全局和会话总量 |
| 撤回 | 同上，只打 `retracted` 标记 |
| 旁支提问 | 单独记 `branch=true`，归属同会话，默认折叠 |
| 失败请求 | 记 attempt 但 `billable=unknown`，**不算进渠道消耗** |
| 归档会话 | 用独立账本持久化聚合结果，不依赖原始会话文件还在 |
| 数据源 | 上游 `usage` 优先；缺失时本地 tokenizer 估算并标 `estimated=true` |
| 隐私 | **只存计数和元数据，绝不存 prompt/completion 原文** |

**会话统计三层下钻：**

```
会话总 Token（逻辑级，旁标尝试级）
  └─ 按供应商分组
       └─ 供应商展开后按模型细分
```

段边界按 `upstream + model` 变化自动切分：中途换供应商会归属到对应段。

### 模块二 · 按需网络分流

- **直连优先**，超时或失败自动走代理，成功则记住域名下次直连
- **规则自己学习**，不需要用户维护域名列表
- **本机已有代理客户端就跟随**，不强制自建内核
- **节点健康只标记不删除**：失效节点保留配置，恢复后自动重新启用
- **模型请求与网页抓取分开路由**：两条独立策略互不干扰，避免模型 API 被代理拖慢
- **分流决策记进账本**，统计页能看到「本次会话多少请求走了代理」

自我修正机制：连续失败 **2 次**才改判代理，避免一次抖动就永久改道。

### 模块三 · 桌面操作编排

- 插件只做**编排层**，不重复实现桌面自动化底层
- 需要操作窗口/点击按钮时，调用宿主已有桌面控制插件注册进来的能力
- **判断任务是否需要启动应用**，需要才拉起，不需要不动
- **启动失败回退到提示手动操作**，绝不静默失败
- 每次调用记入账本（操作类型、目标应用、成功/失败）

没注册底层能力时不会假装成功，直接给「请手动打开「XXX」」的提示。

### 模块四 · 操作边界守门（默认开启）

每个子操作（桌面操作、网络请求、文件写入）发出前先过范围检查。

**三层判定：**

| 层 | 作用 |
|---|---|
| 硬禁区 | 凭据文件、系统目录、提权、递归删根 → 直接 `deny` |
| 意图匹配 | 操作是否落在用户原话覆盖范围内 → 不在就 `ask` |
| AI 审查（可选） | 规则说不清的灰色地带交给小模型 |

判决三态：`allow` / `ask`（暂停询问）/ `deny`（直接拒绝）。

**AI 审查自己挂了会降级为 `ask`**，绝不静默放行越界操作。

### 模块五 · 零配置体验

- 全部配置项有合理默认值
- 引导只问 2 个问题，都有默认答案
- 探测失败不阻塞启动，只把该通道标成不可用
- 首次启动自动完成：上游探测 → 补配置 → 守门开启

### 模块六 · 插件级故障隔离

**小白体验的底线：一个功能坏了，不能整个插件跟着坏。**

- 任一模块出错**不阻断 DSH 启动**，其他模块照常可用
- 出错模块降级运行，设置页显示状态
- 可**单独重启**某个模块，不影响其他模块

实测：账本和分流同时挂掉时，对话照样能正常进行。

---

## 接口

宿主 webServer 上暴露以下只读接口（`exposeHealth: true` 时）：

| 路径 | 说明 |
|---|---|
| `/freebridge/health` | 模块健康状态、配置、上游状态 |
| `/freebridge/stats` | 全局统计（`?level=attempt`、`?branch=1`） |
| `/freebridge/sessions` | 会话列表 |
| `/freebridge/session?id=` | 单会话三层明细 + 旁支 |
| `/freebridge/routes` | 分流状态与节点健康 |
| `/freebridge/guard` | 守门状态与规则表 |
| `/freebridge/desktop` | 桌面编排状态 |
| `/freebridge/onboarding` | 引导状态与问题 |
| `/freebridge/restart?module=` | 单独重启某个模块 |

---

## 文件结构

```
freebridge/
├── index.js              # 插件入口：name / inject / apply / Config
├── src/
│   ├── adapter.js        # provider 适配器（harness 契约）+ 记账/分流串联
│   ├── upstream.js       # 上游调用、模型目录缓存、冷却
│   ├── parse.js          # SSE 解析 -> chunk 事件
│   ├── ledger.js         # 模块一：Token 账本
│   ├── router.js         # 模块二：网络分流
│   ├── desktop.js        # 模块三：桌面编排
│   ├── guard.js          # 模块四：操作守门
│   ├── bootstrap.js      # 模块五：零配置
│   └── supervisor.js     # 模块六：故障隔离
├── test/                 # 209 项断言，8 个套件
├── cordis.patch.yml
├── package.json
└── README.md
```

零运行时依赖，只需 Node `^22.19.0 || >=24.0.0`。

---

## 跑测试

```bash
node test/all.mjs
```

8 个套件、209 项断言：

| 套件 | 覆盖 |
|---|---|
| `ledger.test.mjs` | 双计数、编辑不回溯、旁支、持久化、不存原文 |
| `router.test.mjs` | 直连学习、节点只标记不删、两种策略独立 |
| `guard.test.mjs` | 三层判定、AI 降级、规则可枚举 |
| `desktop.test.mjs` | 需要才拉起、无能力回退、守门串联 |
| `bootstrap.test.mjs` | 默认值、引导、探测失败不阻塞 |
| `supervisor.test.mjs` | 降级隔离、单独重启、use 兜底 |
| `integration.test.mjs` | 六模块端到端协同 |
| `host.test.mjs` | 假宿主跑 apply()，真实上游 408 模型 |

---

## 事件协议

插件按 harness 的 chunk 协议产出：

| 事件 | 说明 |
|---|---|
| `block-start` | `blockType`: `text` / `reasoning` |
| `text-delta` | 正文增量 |
| `reasoning-delta` | 思考链增量 |
| `block-end` | 完整块 |
| `usage` | token 用量 |
| `finish` | `reason.kind`: `stop` / `length` / `error` / `aborted` |

事件顺序经实测验证：`block-start(reasoning)` → `reasoning-delta`×N → `block-start(text)` → `text-delta`×N → `block-end`×2 → `usage` → `finish`

---

## 排查

**装上了但选择器里没有 FreeBridge**
→ 确认重启了 DSH；看启动日志里有没有 `[freebridge] ready`。没有就把报错贴出来。

**某个模块坏了**
→ 访问 `/freebridge/health` 看哪个降级了，然后 `/freebridge/restart?module=xxx` 单独重启。

**对话报「额度已用尽」**
→ 你在用 OpenCode 免费池那批 `-free` 模型。切到 FreeBridge 分组的 Kilo 模型。

**回复是空的**
→ 模型开了 thinking，把输出上限调大。

**OVH 报 404 但模型确实存在**
→ OVH 模型 ID **大小写敏感**，必须 `Meta-Llama-3_3-70B-Instruct`。

---

## 注意

- 免费上游随时可能变（收紧鉴权、下架模型、限流）。发现失效欢迎 PR 更新。
- 免费池通常会记录 prompt 用于改进服务，**不要发送敏感内容**。
- 插件只做协议转换、转发与本地统计，不绕过任何鉴权。
- 仅供个人学习与测试，请遵守各上游的服务条款。

## License

MIT
