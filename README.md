<div align="center">

# zcode-kit

**把 ZCode 客户端里的编码套餐额度，变成任意客户端可用的标准接口。**

零依赖 · 纯 Node · 不修改客户端 · 不上传任何数据

</div>

---

## 这是什么

一套把 **ZCode（智谱 GLM 编码套餐）** 的额度，从「只能在官方客户端里用」变成
「任何支持 Anthropic / OpenAI 接口的工具都能用」的工具链。

包含四层：

| 层 | 作用 | 命令 |
|---|---|---|
| **凭据层** | 解密 ZCode 客户端本地登录态 | `npm run cred:extract` |
| **兑换层** | OAuth 令牌 → 项目级 API key | `npm run cred:resolve` |
| **路由层** | 本地 HTTP 服务，对外暴露标准接口 | `npm start` |
| **诊断层** | 用量查询 / 令牌时效 / 流量 dump 解析 | `npm run quota` 等 |

## 这不是什么

- ❌ 不是官方 API 的封装 —— 官方 API key **调不出**套餐额度，这是两本账
- ❌ 不修改、不注入、不 hook ZCode 客户端 —— 只读取它的本地凭据文件
- ❌ 不经过任何第三方服务器 —— 所有流量只在你本机与官方端点之间

---

## 为什么需要它

智谱的编码套餐额度**不绑定 API key，而绑定账号 + 客户端指纹**，所以你在控制台新建的
key 无论怎么填都会撞 `429 [1113] 余额不足或无可用资源包`。具体门槛有三层：

1. **通道不同** —— 套餐额度只在专属端点上（见下方对照表），公开 API 面根本不含这份额度
2. **请求签名** —— coding-plan 流量强制 Ed25519 签名 + 8-bit PoW，公开 key 过不了
3. **客户端指纹** —— 一整套 `X-ZCode-*` 头 + `ZCode/{ver} ai-sdk/anthropic/...` 的 UA

本项目的做法是：**用你自己客户端里已登录的凭据，在本机复刻这套协议**。

---

## 通道对照表（先看这个，能省你半天）

| 套餐 | 面板特征 | 端点 | 鉴权 | 签名 |
|---|---|---|---|---|
| **Start Plan**（体验） | 模型页签显示 `Start Plan` | `zcode.z.ai/api/v1/zcode-plan/anthropic` | `Authorization: Bearer {Plan JWT}` | ❌ |
| **coding-plan** 个人/团队 | 显示 `BigModel` / `Z.AI` + 套餐名 | `open.bigmodel.cn/api/anthropic` → 重映射到 ultra | `x-api-key` + `Authorization` 双头 | ✅ 必须 |
| **闲时** off-peak | 独立的「今日余额」，23:59 重置 | `zcode.z.ai/api/v1/off-peak/anthropic` | 同上 | ❌ |

**用错通道的三种典型报错**：

| 报错 | 说明 |
|---|---|
| `405 {"code":3012,"msg":"request has been blocked due to unusual activity"}` | 拿签名那套去打不签名的通道，被边缘 WAF 拦 |
| `401 令牌已过期或验证不正确` | 拿 JWT 去打 coding-plan 的 ultra 端点 |
| `429 {"code":"1113","message":"余额不足或无可用资源包"}` | 走错账本，或真的没订阅 —— 先用 `npm run quota` 确认 |

---

## 快速开始

```bash
git clone https://github.com/thekingofjunge/zcode-kit.git
cd zcode-kit
```

### 前置

- Node.js 18+
- 本机装过 ZCode 客户端，且**至少登录过一次**

### 三步

```bash
# 1. 生成配置
cp config.example.json config.json      # 然后编辑端口与密钥

# 2. 一条命令完成凭据链路（解密 → 兑换 → 安装）
node src/refresh-all.cjs

# 3. 启动本地路由
npm start
```

Windows 用户也可以直接双击：

```
scripts\setup.cmd      # 初始化 + 凭据
scripts\start.cmd      # 启动路由
scripts\selftest.cmd   # 端到端自检
```

### 接进你的工具

假设 `config.json` 里端口是 `8788`、密钥是 `sk-xxx`：

**Claude Code / Anthropic 协议**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_AUTH_TOKEN=sk-xxx
export ANTHROPIC_MODEL=glm-5.3
```

**任意 OpenAI 兼容客户端**（Cherry Studio / Cline / LobeChat …）

```
Base URL: http://127.0.0.1:8788/v1     ← OpenAI 风格要带 /v1
API Key : sk-xxx
Model   : glm-5.3
```

> Anthropic 风格填 `http://127.0.0.1:8788`（不带 `/v1`）；OpenAI 风格填 `.../v1`。
> 填错会 404。

---

## 工具

| 命令 | 用途 |
|---|---|
| `node src/credential-store.cjs` | 查看客户端凭据（默认脱敏，`--plain` 看明文） |
| `node src/resolve-plan-cred.cjs` | 只做 OAuth → 项目凭据兑换 |
| `node src/install-credential.cjs --verify` | 安装到前端凭据存储并回读校验 |
| `node src/refresh-all.cjs` | 上面三步串起来 |
| `node src/router.cjs` | 启动本地路由 |
| `node src/tools/selftest.cjs [--stream] [--model X]` | 端到端自检 |
| `node src/tools/quota.cjs` | 查用量窗口与余额 |
| `node src/tools/inspect-tokens.cjs` | 看各 token 时效 |
| `node src/tools/dump-read.cjs <dump.jsonl>` | 解析上游流量 dump |

---

## 方法论：四阶段

```
① 解凭据     <dataDir>/credentials.json
             AES-256-GCM，key = sha256(`zcode-credential-fallback:平台:主目录:用户名`)
             ↓
② 换凭据     OAuth 令牌 ──biz API──▶ `${apiKeyId}.${secretKey}`
             另需用它铸造 project-access JWT（签名只能用这个形态）
             ↓
③ 发请求     通道选择 → 身份头伪装 → (coding-plan 才需) V4 签名 + PoW
             → 端点重映射 → 注入 metadata.user_id
             ↓
④ 暴露接口   本地 HTTP：/v1/messages、/v1/models、/v1/quota
```

完整协议细节见 **[docs/PROTOCOL.md](docs/PROTOCOL.md)**。

---

## 踩坑记录

这一节大概是全文最省时间的部分。

### 1. shell 会吃掉 JSON 里的引号 ⚠️

PowerShell / cmd 向**原生程序**传参时会剥离内层双引号：

```powershell
curl.exe -d '{"model":"GLM-5.3","max_tokens":64}'
# 实际发出去的是： {model:GLM-5.3,max_tokens:64}      ← 非法 JSON
```

上游会回 `{"code":3001,"msg":"parameter error"}`，看起来像鉴权或参数契约不对，
于是你会跑去挖签名、验证码、各种头 —— **全是无效功**。

**正确姿势**：让 JSON 走文件，或者用语言自带的 HTTP 客户端。

```powershell
# 好
[IO.File]::WriteAllText("body.json", $json)
curl.exe --data-binary "@body.json" ...

# 更好（Node / Python / PowerShell 的 Invoke-RestMethod 都没这个问题）
```

自查方法：看 `Content-Length`。`{"model":"GLM-5.3",...}` 这种合法 JSON 一定比去掉引号的长。

### 2. 不要给 LLM 请求加 `X-Device-Mid`

这个头属于**控制面**（`agent/configs` 等）。加到 LLM 请求上会提高被边缘 WAF 判为异常的概率，
直接 `405 unusual activity`。

### 3. 405 与 400 的区别很有信息量

- `405 + code 3012 unusual activity` = 被边缘风控拦（**传输层指纹、请求频率、或请求体特征**），请求没到业务逻辑
- `400 + code 3001 parameter error` = 到了业务层，但 body/参数不对
- `401` = 凭据或通道不匹配
- `429 + code 3009 model concurrency limit exceeded` = 账号**并发超限**（与 405 是两码事，见第 8 条）

用 Node 内置 `fetch` 打 `zcode.z.ai` 时遇到过 405，而换成 curl 就变成 400 —— 同一 IP、同一时刻，
差别只在传输栈指纹。所以**别把 405 当成鉴权问题去查**。

**但 405 不止一个成因**：`code 3012` 也可能是**请求体本身**被判为异常（如 `system` 字段的形状不对），
与传输栈无关。区分方法见第 7 条。

### 4. 两个 token 都不会自动续期

`access_token` 与 `zcodejwttoken` **都不带 `exp`**，凭据里**也没有 refresh_token**。
过期只能靠上游 401 发现，届时跑 `npm run cred:refresh`（需要客户端处于登录态）。

### 5. 传输栈指纹决定成败 ⚠️ 最容易被忽略的一条

同一台机器、同一个 IP、相隔几十秒，用**完全相同的请求体与请求头**发同一个端点：

| 发起方 | TLS / HTTP 栈 | 结果 |
|---|---|---|
| zcode-api 发行版 | Bun（BoringSSL） | ✅ `200 OK`，正常返回 |
| `curl.exe` | Schannel | ❌ `405 unusual activity` |
| Node 内置 `fetch` | OpenSSL / undici | ❌ `405 unusual activity` |

也就是说上游边缘节点（响应头带 `Server: ESA`）在**传输层指纹**上做了判断，
而**不只看请求头和请求体**。这条能解释一大类「协议明明都对，却始终 405」的困惑。

推论（**尚未在本仓库上实测**，因为环境没装 Bun）：

- 用 Node 内置 `fetch` 的实现在这套风控下不稳定
- 若要使用本仓库的 `router.cjs`，建议改用 Bun 运行：`bun src/router.cjs`
  —— 与 zcode-api 发行版同栈
- 或直接采用 zcode-api 的发行版作为前端（见「与其它项目的关系」）

判断方法：`Server: ESA` + `405` + `code 3012` = 传输层被拦；能拿到 `400/401/429` 说明已经穿过风控到达业务层。

### 6. 调试利器：上游流量 dump

前端如果支持（zcode-api 系列），设置环境变量即可拿到完整请求时间线：

```bash
ZCODE_DUMP_UPSTREAM=/path/to/dump.jsonl
```

然后用 `node src/tools/dump-read.cjs <file>` 看。敏感头会自动脱敏。
比起猜，这是定位「我到底发出去了什么」最快的办法。

> ⚠️ dump 里是**完整请求原文**（含全部对话历史、工具定义、图片 base64）。
> 排查完记得删掉，别随手分享。

### 7. 405 `code 3012`：先怀疑 `system` 字段的形状 ⚠️

**症状**：agent 类客户端（Claude Code、DeepSeek Harness 等）全部请求稳定 405，
但**官方客户端正常**、**裸消息请求正常**。

**为什么偏偏是 agent**：agent 每个请求都必须带系统提示词（`system` 字段），
而普通对话可以不带。所以「带 system 必挂、不带 system 必过」是它的特征指纹。

**判断方法**（两步对照）：

```bash
# A. 不带 system —— 应当成功
{"model":"GLM-5.3","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}

# B. 带 system —— 若必挂，就是这个问题
{"model":"GLM-5.3","max_tokens":16,
 "system":[{"type":"text","text":"You are helpful."}],
 "messages":[{"role":"user","content":"hi"}]}
```

同一个代理、同一个 IP、相隔几秒，只改这一个字段。**若 A 过 B 挂，即可确诊。**

**修复**：升级前端到 **v4.8.6+**，其中含
`fix(start-plan): always emit the official 3-block system shape (issue #71)`。
根因是转发时 `system` 的块形状（block shape）不符合服务端预期，被指纹识别命中。

**注意别误判**：这一条很容易被当成「限流」「IP 被封」「凭据过期」去查——
本仓库作者为此绕了几小时。**先做 A/B 对照，再谈其它。**

### 8. `Connection error` 先查端口，别怀疑进程

客户端报 `Connection error` / `TRANSPORT` 时，**第一件事是对端口**：

```powershell
Test-NetConnection 127.0.0.1 -Port 8080 -InformationLevel Quiet   # True = 有服务
```

然后核对客户端的 `baseURL` 与代理实际监听的端口是否一致：

```yaml
baseURL: http://127.0.0.1:8081/v1    # ← 客户端连 8081
# 而代理实际监听 8080                  ← 对不上就是这个问题
```

**最容易踩的变体**：为了测试新版本，在另一个端口（如 8081）起了一个临时实例，
测完关掉，**却忘了客户端配置曾被改到那个端口**。之后所有请求都 `Connection error`，
看起来像「进程崩了」。

**关键鉴别点**：

| 现象 | 含义 |
|---|---|
| `Connection error` + TCP 不通 | 进程真的不在了 |
| `Connection error` + **TCP 通** | **端口对不上，或客户端配置未生效** |
| 日志「停止写入」 | **≠ 进程死亡**，也可能只是没人再发请求了 |

改完 `cordis.patch.yml`（或等价配置）**必须重启客户端**才生效——它是启动时读取的。

### 9. Release notes 不可靠，真实变更看 git log

本仓库涉及的前端项目（zcode-api）**release notes 有时没有任何有效信息**
（见过只写一句无关内容的），但 `git log` 里的提交信息是完整的：

```bash
gh api repos/TriDefender/zcode-api/compare/v4.8.2...v4.8.6 \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      JSON.parse(s).commits.forEach(c=>console.log(c.commit.message.split('\n')[0]))})"
```

或者直接看某个版本区间改了哪些文件：

```bash
gh api repos/TriDefender/zcode-api/compare/v4.8.2...v4.8.6 |
  grep -o '"filename":"[^"]*"' | sort -u
```

**是否值得升级，判断依据是提交内容，不是 release 页的措辞。**

---

## 验证状态

诚实标注每个模块的实测程度：

| 模块 | 状态 | 说明 |
|---|---|---|
| 客户端凭据解密 | ✅ 完整验证 | 真实账号上解出全部字段 |
| OAuth → 项目凭据 | ✅ 完整验证 | 走通 org/project/apiKey/secretKey 全链路 |
| 前端凭据安装 | ✅ 完整验证 | 写入后回读解密一致 |
| 签名 V4 握手 | ✅ 验证 | HTTP 200 + privateCipher，Ed25519 解密成功 |
| PoW 求解 | ✅ 验证 | 8-bit 难度可稳定求解 |
| 端点重映射 | ✅ 验证 | 拿到服务端下发映射表 |
| **Start Plan 直连** | ✅ 完整验证 | 经 zcode-api 前端端到端跑通（流式返回） |
| 本仓库 router：health / models / quota | ✅ 完整验证 | 本地接口全部正常 |
| **本仓库 router 打通 Start Plan** | ❌ 受限于传输栈 | 实测 `405 unusual activity`（Node fetch 指纹）；协议实现完整，改用 Bun 运行预计可通（见踩坑记录 §5） |
| coding-plan 通道 | ⚠️ 仅协议层 | 账号无该套餐，仅验证到握手与签名成功 |

> 结论：**凭据链路 100% 可用，本地接口层可用**；真正发往上游的那一跳受传输栈指纹影响。
> 实用建议 —— 优先用 [zcode-api](https://github.com/TriDefender/zcode-api) 的发行版作为前端，
> 把本仓库当作用法参考、凭据工具与诊断工具集。

---

## 排障

按这个顺序查，覆盖绝大多数情况：

| 现象 | 多半是 | 怎么处理 |
|---|---|---|
| `找不到凭据文件` | ZCode 客户端没装，或从未登录 | 先打开客户端登录一次 |
| 凭据全部解密失败 | 换过机器 / 重装过系统 | 密钥含主目录与用户名，属机器绑定；在客户端重新登录后跑 `npm run cred:refresh` |
| `MISSING_CREDENTIAL` | 前端凭据没装好 | `node src/install-credential.cjs --verify` |
| **`Connection error`** | **连不上本地路由**——端口对不上，或路由没在跑 | **先 `Test-NetConnection 127.0.0.1 -Port 8080`，再核对客户端 `baseURL`**；见「踩坑记录」第 8 条 |
| 连接被拒绝 | 本地路由没在跑 | `npm start`（或 `scripts\start.cmd`） |
| 端口被占用 | `8788` 被别的程序占了 | 改 `config.json` 的 `router.port` |
| `401 令牌已过期或验证不正确` | 凭据过期 | 本项目两个 token 都不会自动续期，跑 `npm run cred:refresh` |
| **`405 unusual activity`（agent 客户端必挂）** | **`system` 字段形状不对，被指纹识别** | 见「踩坑记录」第 7 条——做「带/不带 system」A/B 对照确诊，升级前端到 v4.8.6+ |
| `405 unusual activity`（所有客户端都挂） | 传输层指纹被风控 | 见「踩坑记录」第 5 条，改用 Bun 运行或换官方前端 |
| `3001 parameter error` | 请求体不是合法 JSON | 见「踩坑记录」第 1 条——多半是 shell 把引号剥了 |
| **`429 code 3009 model concurrency limit exceeded`** | **账号并发超限**（开了多个子智能体/后台任务） | 降低并发；重试会加剧拥塞，形成雪崩 |
| `429 [1113] 余额不足或无可用资源包` | 走错通道，或账号确实没这份订阅 | 对照「通道对照表」确认套餐与端点是否匹配 |
| `500 当前用户不存在coding plan` | 你买的是 Start Plan，却去查了 coding-plan 的用量接口 | **正常现象，不是故障** |

**三行命令逐项自检**：

```bash
node src/tools/selftest.cjs         # 本地接口 + 一次真实对话
node src/tools/inspect-tokens.cjs   # 各 token 时效
node src/tools/quota.cjs            # 上游返回的用量
```

---

## 已知限制

- **凭据机器绑定**：兜底密钥含主目录与用户名，换机 / 重装系统后需重新登录客户端再刷新
- **无自动续期**：见踩坑记录 §4
- **风控不确定性**：边缘 WAF 会对传输栈指纹和请求频率做判断，高频或异常流量可能被临时拦
- **未实现**：OpenAI 格式的 `/v1/chat/completions` 转发、闲时通道的领票队列、MCP 反代、加速卡抽卡
- **平台**：主力在 Windows 上验证；代码本身跨平台（`scripts/*.cmd` 是 Windows 批处理，其他平台直接用 `node` 调用）

---

## 与其它项目的关系

- **[zcode-api](https://github.com/TriDefender/zcode-api)**（作者 TriDefender）
  同样是「把套餐变成标准接口」的思路，实现更完整（含验证码池、加速卡、闲时队列、MCP 反代、TUI 面板、Android 版），
  并且已发布编译好的单文件可执行程序。**如果你只想直接用，优先看它。**
  本项目与它的差异：零外部依赖、纯 Node、代码量小、把协议与踩坑写成可查阅的文档，
  更适合作为「读懂这套机制」的参考实现。

- 本项目的 `install-credential.cjs` 生成的凭据文件，格式与 zcode-api 的存储层兼容，
  因此可以配合它的发行版使用（见下文）。

### 配合 zcode-api 发行版使用

```bash
# 用它自己的登录流程
zcode-proxy auth login bigmodel

# 或者：复用本仓库已处理好的凭据
node src/refresh-all.cjs
node src/install-credential.cjs --verify     # 写入 ~/.zcode-proxy/credentials.json
zcode-proxy serve
```

---

## 许可

MIT。

仅供个人学习与自用。请遵守智谱的服务条款；不要用于商业化转售，不要把本机端口暴露到公网。
本项目不附带任何凭据，所有密钥都从你自己的客户端本地读取。
