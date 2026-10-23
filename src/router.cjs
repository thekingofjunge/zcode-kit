"use strict";
/**
 * 本地路由：把套餐额度暴露成标准 Anthropic / OpenAI 接口。
 *
 *   DSH / Claude Code / Cline / 任意 OpenAI 兼容客户端
 *        │  http://127.0.0.1:8788
 *        ▼
 *   本进程：身份伪装 + 通道选择 + (coding-plan 才需要的) V4 签名
 *        ▼
 *   upstream（start-plan 直连 zcode.z.ai；coding-plan 走 open.bigmodel.cn 并重映射到 ultra）
 *
 * 两条通道的差异（这是最容易走错的地方）：
 *   start-plan  端点 zcode.z.ai/api/v1/zcode-plan/anthropic
 *               鉴权 Authorization: Bearer {Plan JWT}
 *               **不签名**，但需要 identity 头 + metadata.user_id
 *   coding-plan 端点 open.bigmodel.cn/api/anthropic（服务端会重映射到 zcode.z.ai/api/v1/ultra/...）
 *               鉴权 x-api-key 与 Authorization 双头，值均为 `${apiKeyId}.${secretKey}`
 *               必须携带 V4 签名 + PoW
 *
 * 用法：
 *   node src/router.cjs
 *   node src/router.cjs --plan coding-plan
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, ROOT } = require("./lib/config.cjs");
const { ClientSigner } = require("./sign-v4.cjs");

const cfg = loadConfig();
const plan = process.argv.includes("--plan")
  ? process.argv[process.argv.indexOf("--plan") + 1]
  : cfg.plan || "start-plan";

const CRED_PATH = path.join(ROOT, "cred.resolved.json");
if (!fs.existsSync(CRED_PATH)) {
  console.error(`找不到 ${CRED_PATH}\n请先运行: npm run cred:refresh`);
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
if (!cred.apiKey) {
  console.error("cred.resolved.json 缺少 apiKey");
  process.exit(1);
}

const { appVersion, sourceTitle, refererOrigin, releaseChannel } = cfg.identity;
const startedAt = Date.now();
const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);

function deviceMid() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(cfg.zcodeDataDir, "telemetry-state.json"), "utf8"));
    return t.deviceMid ?? t.device_mid ?? undefined;
  } catch {
    return undefined;
  }
}
const DEVICE_MID = deviceMid();

/** LLM 请求的身份头（注意：该面**不带** X-Device-Mid，带了反而更容易被风控拦）。 */
function identityHeaders() {
  return {
    "HTTP-Referer": refererOrigin,
    "User-Agent": `ZCode/${appVersion} ai-sdk/anthropic/3.0.81`,
    "X-ZCode-App-Version": appVersion,
    "X-Title": `Z Code@${sourceTitle}`,
    "X-Release-Channel": releaseChannel,
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    "X-ZCode-Agent": "glm",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": process.platform === "win32" ? "windows" : process.platform,
    "X-Os-Version": os.release(),
  };
}

function traceHeaders(sessionId) {
  return {
    "x-request-id": crypto.randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
    "x-query-id": crypto.randomUUID(),
    "x-session-id": sessionId,
  };
}

/** 客户端对所有 anthropic 请求都会注入的 metadata.user_id（device/session blob）。 */
function buildMetadataUserId(sessionId) {
  return JSON.stringify({ device_id: DEVICE_MID, account_uuid: "", session_id: sessionId || "" });
}

const signer = new ClientSigner({
  credential: cred.apiKey,
  oauthAccessToken: cred.oauthAccessToken,
  provider: cred.provider,
  signingOrigin: cfg.upstream.signingOrigin,
  appVersion,
  onEvent: (m) => log("signer", m),
});

// ── coding-plan 的服务端端点重映射 ─────────────────────────────────────────
let routing = { expiresAt: 0, map: new Map() };

async function refreshRouting(force = false) {
  if (plan !== "coding-plan") return;
  if (!force && routing.expiresAt > Date.now()) return;
  try {
    const r = await fetch(`${cfg.upstream.routingOrigin}/api/v1/agent/configs`, {
      headers: { ...identityHeaders(), Accept: "application/json", "x-api-key": cred.apiKey },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const list = j?.data?.proxyEndpoint?.mapping ?? [];
    const map = new Map();
    for (const e of list) if (e?.from && e?.to) map.set(e.from.replace(/\/+$/, ""), e.to);
    routing = { expiresAt: Date.now() + 300000, map };
    log("routing", `拿到 ${map.size} 条端点映射`);
  } catch (e) {
    routing = { expiresAt: Date.now() + 30000, map: routing.map };
    log("routing", `刷新失败（fail-open）：${e.message}`);
  }
}

const applyRouting = (url) => routing.map.get(url.replace(/\/+$/, "")) ?? url;

// ── 转发 ───────────────────────────────────────────────────────────────────
async function forward({ bodyText, clientHeaders, res }) {
  const sessionId = crypto.randomUUID();
  const base = plan === "start-plan" ? cfg.upstream.startPlanBase : cfg.upstream.codingPlanAnthropicBase;
  const target = applyRouting(`${base}/v1/messages`);

  // start-plan：只带 Bearer JWT；coding-plan：双头同值
  const auth = plan === "start-plan"
    ? { authorization: `Bearer ${cred.jwt}` }
    : { "x-api-key": cred.apiKey, authorization: `Bearer ${cred.apiKey}` };

  let headers = {
    "content-type": "application/json",
    "accept-encoding": "identity",
    "anthropic-version": "2023-06-01",
    ...identityHeaders(),
    ...traceHeaders(sessionId),
    ...auth,
  };
  if (clientHeaders["anthropic-beta"]) headers["anthropic-beta"] = clientHeaders["anthropic-beta"];

  // 注入 metadata.user_id（两条通道都需要，缺失可能被判为参数错误）
  let outBody = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    const meta = buildMetadataUserId(sessionId);
    parsed.metadata = { ...(parsed.metadata ?? {}), user_id: meta };
    outBody = JSON.stringify(parsed);
  } catch {
    log("warn", "请求体不是合法 JSON，原样转发");
  }

  let finalHeaders = headers;
  if (plan === "coding-plan") {
    const signed = await signer.sign(target, headers);
    finalHeaders = signed.headers;
    log("req", `${plan} → ${target}（signed=${signed.signed}）`);
  } else {
    log("req", `${plan} → ${target}`);
  }

  const upstream = await fetch(target, { method: "POST", headers: finalHeaders, body: outBody });
  log("res", `${upstream.status} ${upstream.headers.get("content-type") ?? ""}`);

  const out = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
  for (const h of ["request-id", "x-request-id"]) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

function authOk(req) {
  const expect = cfg.router.apiKey;
  if (!expect) return true; // 未设 key 则不校验（仅本机监听时可用）
  const xk = req.headers["x-api-key"];
  const auth = req.headers["authorization"] ?? "";
  return xk === expect || (auth.startsWith("Bearer ") && auth.slice(7) === expect);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/health") {
      return void res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          {
            status: "ok",
            plan,
            provider: cred.provider,
            signedReady: signer.keys.size > 0 || !!signer.projectJwt,
            routing: { entries: routing.map.size, fresh: routing.expiresAt > Date.now() },
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            models: cfg.models.map((m) => m.id),
          },
          null,
          2,
        ),
      );
    }

    if (!authOk(req)) {
      return void res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid or missing API key" } }),
      );
    }

    if (p === "/v1/models" && req.method === "GET") {
      if (url.searchParams.get("client_version") === "pi") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            models: cfg.models.map((m) => ({
              slug: m.id,
              display_name: m.name,
              description: m.name,
              context_window: m.contextWindow,
              max_context_window: m.contextWindow,
              max_tokens: m.maxTokens,
              input_modalities: m.vision ? ["text", "image"] : ["text"],
              supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
              visibility: "list",
            })),
          }),
        );
      }
      return void res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data: cfg.models.map((m) => ({ id: m.id, object: "model", owned_by: "zcode-kit", display_name: m.name })),
        }),
      );
    }

    if (p === "/v1/quota" && req.method === "GET") {
      const r = await fetch(`${cfg.upstream.signingOrigin}/api/monitor/usage/quota/limit`, {
        headers: { authorization: cred.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      return void res.writeHead(r.status, { "content-type": "application/json" }).end(t);
    }

    if (p === "/v1/messages/count_tokens" && req.method === "POST") {
      const b = await readBody(req);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: Math.ceil(b.length / 4) }));
    }

    if (p === "/v1/messages" && req.method === "POST") {
      await refreshRouting();
      const body = await readBody(req);
      return void (await forward({ bodyText: body, clientHeaders: req.headers, res }));
    }

    res.writeHead(404, { "content-type": "application/json" }).end(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route for ${req.method} ${p}` } }),
    );
  } catch (e) {
    log("error", e.stack ?? String(e));
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" }).end(
        JSON.stringify({ type: "error", error: { type: "upstream_error", message: String(e.message ?? e) } }),
      );
    } else res.end();
  }
});

server.listen(cfg.router.port, cfg.router.host, async () => {
  log("boot", `zcode-kit router 监听 http://${cfg.router.host}:${cfg.router.port}`);
  log("boot", `通道=${plan}  服务商=${cred.provider}  deviceMid=${DEVICE_MID ? "已读取" : "缺失"}`);
  log("boot", `访问密钥=${cfg.router.apiKey || "(未设置，不校验)"}`);
  await refreshRouting(true);
  if (plan === "coding-plan") {
    try {
      await signer.resolveParsed();
      log("boot", "签名凭据就绪");
    } catch (e) {
      log("boot", `签名凭据解析失败：${e.message}`);
    }
  }
});

process.on("SIGINT", () => {
  log("exit", "关闭");
  server.close(() => process.exit(0));
});
