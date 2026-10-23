# 协议细节

本文记录 zcode-kit 复刻的全部上游协议。所有实现均在 `src/` 下，注释与本文件一一对应。

---

## 1. 客户端凭据存储

**位置**：`<zcodeDataDir>/credentials.json`（默认 `~/.zcode/v2/credentials.json`）

**结构**：一个扁平字符串字典

| 键 | 含义 |
|---|---|
| `oauth:active_provider` | 当前服务商：`zai` 或 `bigmodel` |
| `oauth:<provider>:access_token` | OAuth 访问令牌（JWT 形态） |
| `oauth:<provider>:refresh_token` | 刷新令牌 —— **实际经常不写入** |
| `oauth:<provider>:user_info` | 账号信息 JSON |
| `zcodejwttoken` | Plan JWT，start-plan / 闲时等通道使用 |
| `project-key-location:v1:<urlenc>` | 项目 API key 定位信息（org / project / apiKeyId） |
| `builtin:<provider>-coding-plan` | 部分版本里的 provider 配置项 |

**加密**：值形如

```
enc:v1:<iv base64url>.<authTag base64url>.<ciphertext base64url>
```

- 算法 AES-256-GCM，IV 固定 12 字节，AuthTag 固定 16 字节
- 密钥 `sha256(secret)`
- `secret = env.ZCODE_CREDENTIAL_SECRET`
  `      ?? "zcode-credential-fallback:${platform}:${homedir}:${username}"`

> 实现：`src/credential-store.cjs`。兜底串里含主目录与用户名，所以凭据文件天然机器绑定，跨机复制后无法解密。

---

## 2. OAuth 令牌 → 项目凭据

登录拿到的是 OAuth 令牌，但 LLM 端点认的是项目级 API key（`${apiKeyId}.${secretKey}`）。
转换链路（对拍客户端 `resolveCodingPlanCredential`）：

```http
GET  {host}/api/biz/customer/getCustomerInfo
     Authorization: <oauth token>          # bigmodel 直接透传，不加 Bearer
     → 取 name 含「默认机构」的组织、含「默认项目」的项目
       （找不到就取第一个；projectType == "2" 的排除）

GET  {host}/api/biz/v1/organization/{org}/projects/{proj}/api_keys
     → 找 name == "zcode-api-key" 的条目
POST 同上，body {"name":"zcode-api-key"}   # 不存在则创建

GET  .../api_keys/copy/{apiKey}
     → { secretKey }
```

最终凭据 `apiKey = "${apiKeyId}.${secretKey}"`。

`host`：bigmodel → `https://bigmodel.cn`；zai → `https://api.z.ai`（zai 需先 `POST /api/auth/z/login` 换一次 biz token）。

> 实现：`src/resolve-plan-cred.cjs`

---

## 3. 请求签名 V4（仅 coding-plan）

**豁免路径**（永不签名）：

```
/api/v1/zcode-plan/anthropic/v1/messages
/api/v1/zcode-plan/chat/completions
/api/v1/off-peak/anthropic/v1/messages
```

即 start-plan / off-peak 通道不签名；coding-plan（个人 / 团队）**总是签名**。

### 3.1 握手

```http
POST {origin}/api/paas/c1f3a7e2/v2/client
Authorization: Bearer <project-access JWT>      # JWT 形态
             | <apiKeyId>.<secret>              # apiKey 形态
Content-Type: application/json

{ "accessToken": "<JWT>", "nonce": "<32 hex>", "sig": "<base64>", "ts": "<ms>" }
   # apiKey 形态时字段名为 "apiKey"，值为 "<apiKeyId>.<secret>"
```

`sig` 计算：

```
mac  = HMAC-SHA256( HKDF(secret, "getSignKey_hmac"), `get_sign_key\n{apiKeyId}\n{ts}\n{nonce}` )
sig  = base64(mac)
```

HKDF 参数（两条链路共用）：`hash=SHA-256`，`salt="WD_CLIENT_SIGN_KDF_SALT"`，输出 32 字节。

响应：

```json
{ "code": 200, "data": { "privateCipher": "<base64>" } }
```

### 3.2 解出 Ed25519 私钥

```
aesKey   = HKDF(secret, "ed25519_priv")           # 32 字节
cipher   = base64decode(privateCipher)
iv       = cipher[0:12]
body     = cipher[12:]                            # 密文 || AuthTag(16)
plain    = AES-256-GCM-decrypt(aesKey, iv, body, AAD = apiKeyId)
pkcs8    = base64decode(utf8(plain))
privKey  = import("pkcs8", pkcs8, Ed25519)
```

### 3.3 逐请求签名

```
ts     = Date.now()
nonce  = 32 hex（16 字节随机）
sig    = base64( Ed25519( `{apiKeyId}\n{ts}\n{appVersion}\n{sessionId}\n{nonce}` ) )
```

Proof of Work：

```
seed   = hex(sha256(`{apiKeyId}\nzcode\n{sessionId}\n{ts}`))[0:32]
nonce  = 24 hex（12 字节随机）
反复试 counter = 0,1,2,…
  candidate = nonce + hex(counter).padStart(8,"0")
  直到 sha256(`{seed}\n{candidate}`) 的首字节 == 0     # 8 bit 难度
pow = candidate
```

携带的头：

```
X-Client-Ts: <ts>
X-Client-Version: <appVersion>
X-Client-Sig: <sig>
X-Session-Id: <sessionId>
X-Client-Nonce: <nonce>
X-App-Id: zcode
X-Client-Pow: <pow>
```

> 实现：`src/sign-v4.cjs`。全程 fail-open —— 握手失败就不签名直发，与官方客户端行为一致。

---

## 4. 身份头

LLM 请求（finish 与 coding-plan 通用，**不带 `X-Device-Mid`**）：

```
HTTP-Referer        : https://zcode.z.ai
User-Agent          : ZCode/{appVersion} ai-sdk/anthropic/3.0.81
X-ZCode-App-Version : {appVersion}
X-Title             : Z Code@cli
X-Release-Channel   : production
X-Client-Language   : zh-CN
X-Client-Timezone   : {IANA 时区}
X-ZCode-Agent       : glm
X-Platform          : {platform}-{arch}
X-Os-Category       : windows | macos | linux
X-Os-Version        : {os.release()}
```

控制面请求（如 `agent/configs`）另有一套，会带 `X-Device-Mid`（取自 `telemetry-state.json`）且不带 `X-ZCode-Agent`。

> ⚠️ 实测教训：给 LLM 请求加上 `X-Device-Mid` 会**提高**被风控拦截的概率。别加。

---

## 5. 端点与重映射

| 通道 | 客户端配置端点 | 实际落地 |
|---|---|---|
| coding-plan（bigmodel） | `https://open.bigmodel.cn/api/anthropic` | 经重映射 → `https://zcode.z.ai/api/v1/ultra/anthropic` |
| coding-plan（zai） | `https://api.z.ai/api/anthropic` | → `https://zcode.z.ai/api/v1/ultra-zai/anthropic` |
| start-plan | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | 不重映射 |
| 闲时 | `https://zcode.z.ai/api/v1/off-peak/anthropic` | 不重映射 |
| 加速卡 | `https://zcode.z.ai/api/v1/highspeed/anthropic` | 不重映射 |

重映射表来自服务端下发：

```http
GET https://zcode.z.ai/api/v1/agent/configs
Headers: <控制面身份头> + Accept: application/json + x-api-key: <项目凭据>
→ data.proxyEndpoint.mapping[] = [{ from, to, zcodeAuthorizationHeader? }]
```

匹配规则：`from` 去尾斜杠后与请求 URL **精确**相等。

部分条目标记 `zcodeAuthorizationHeader` 时，重写后的请求还需带
`X-ZCode-Authorization: Bearer <Plan JWT>`（3.16.2 起）。该字段值必须等于头名本身（`x-zcode-authorization`），
且目标必须落在 `/api/v1/ultra` 或 `/api/v1/ultra-zai` 之下，否则整份配置被拒。

---

## 6. 请求体注入

所有 anthropic 请求都会带上 `metadata.user_id`，值是一个 JSON 字符串：

```json
{
  "device_id":    "<telemetry-state.json 里的 deviceMid>",
  "account_uuid": "",
  "session_id":   "<会话 id，去掉 sess_ / subagent_agent_ 前缀>"
}
```

注意 `account_uuid` **恒为空字符串** —— 真实客户端从不在此放账号 ID。

start-plan 通道还会在 system 中前置一段网关注入块（`system-prompt.ts`）。

---

## 7. 通道对照表（最容易踩的坑）

| 你的套餐 | 面板特征 | 端点 | 鉴权 | 签名 |
|---|---|---|---|---|
| **Start Plan**（体验套餐） | 模型页签显示 `Start Plan` | `zcode.z.ai/api/v1/zcode-plan/anthropic` | `Authorization: Bearer {Plan JWT}` | ❌ 不需要 |
| coding-plan 个人 / 团队 | 显示 `BigModel` / `Z.AI` + 套餐名 | `open.bigmodel.cn/api/anthropic` → ultra | `x-api-key` + `Authorization` 双头，同为 `{id}.{secret}` | ✅ 必须 |
| 闲时（off-peak） | 每日 23:59 重置的独立额度 | `zcode.z.ai/api/v1/off-peak/anthropic` | 同上 | ❌ |

**用错通道的典型症状**：

- 拿 coding-plan 的签名去打 start-plan 的端点 → `405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`
- 拿 start-plan 的 JWT 去打 coding-plan 的 ultra 端点 → `401 令牌已过期或验证不正确`
- 拿普通 API key 打任意一条 → `429 {"code":"1113","message":"余额不足或无可用资源包"}`

---

## 8. 用量查询

```http
GET {providerOrigin}/api/monitor/usage/quota/limit
Authorization: <apiKeyId>.<secretKey>        # 注意：不是 Bearer
```

返回 `data.level` 与 `data.limits[]`（`type/number/usage/remaining/percentage/next_reset_time`），
与客户端「今日余额」面板同源。

没有 coding-plan 订阅时返回 `{"code":500,"msg":"当前用户不存在coding plan"}` ——
如果你买的是 Start Plan，这条报错是**正常**的，用 `credentials.json` 里的额度面板看即可。
