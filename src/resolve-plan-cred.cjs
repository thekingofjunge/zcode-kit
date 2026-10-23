"use strict";
/**
 * 把 OAuth 令牌换成真正能用的编码套餐凭据。
 *
 * 为什么需要这一步：客户端登录后拿到的是 OAuth 访问令牌，但上游 LLM 端点
 * 认的是「项目级 API key」，形如 `${apiKeyId}.${secretKey}`。
 * 这一步复刻客户端的下述链路（对拍 bundle 的 resolveCodingPlanCredential）：
 *
 *   1. GET  {host}/api/biz/customer/getCustomerInfo      （Authorization: <oauth token>）
 *          → 选「默认机构」/「默认项目」（找不到则取第一个，projectType=2 排除）
 *   2. GET  {host}/api/biz/v1/organization/{org}/projects/{proj}/api_keys
 *          → 找名为 zcode-api-key 的条目；没有就 POST 创建
 *   3. GET  .../api_keys/copy/{apiKey}
 *          → 拿 secretKey，拼成 `${apiKey}.${secretKey}`
 *
 * 用法：
 *   node src/resolve-plan-cred.cjs            # 生成 cred.resolved.json
 *   node src/resolve-plan-cred.cjs --show     # 同时打印摘要
 */
const fs = require("fs");
const path = require("path");
const { loadConfig, ROOT } = require("./lib/config.cjs");
const { readCredentialRecord, pickPlanFields } = require("./credential-store.cjs");

const API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "默认机构";
const DEFAULT_PROJECT_MARKER = "默认项目";
const OUT_FILE = path.join(ROOT, "cred.resolved.json");

const HOSTS = {
  bigmodel: "https://bigmodel.cn",
  zai: "https://api.z.ai",
};

async function bizApi(url, authorization, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: { Authorization: authorization, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  const code = body.code ?? body.status;
  if (code != null && ![0, 200, "0", "200"].includes(code)) {
    throw new Error(`业务错误 code=${code} msg=${body.msg ?? ""} ${url}`);
  }
  return body.data ?? body;
}

/** bigmodel 直接透传 OAuth 令牌；zai 需先换一次 biz token。 */
async function resolveAuthorization(provider, accessToken) {
  if (provider === "zai") {
    const resp = await fetch("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`z/login 失败: ${resp.status}`);
    const data = await resp.json();
    const token = data.access_token ?? data.accessToken ?? data.data?.access_token;
    if (!token) throw new Error("z/login 响应缺少 access_token");
    return `Bearer ${token}`;
  }
  return accessToken;
}

async function resolvePlanCredential({ provider, accessToken, planJwt, userInfo, log = console.log }) {
  const host = HOSTS[provider];
  if (!host) throw new Error(`不支持的服务商: ${provider}`);
  if (!accessToken) throw new Error("凭据里没有 OAuth 访问令牌，请先在客户端登录");

  const authorization = await resolveAuthorization(provider, accessToken);

  log("[1/3] 解析组织与项目 ...");
  const info = await bizApi(`${host}/api/biz/customer/getCustomerInfo`, authorization, { method: "GET" });
  const orgs = (info.organizations ?? info.orgs ?? [])
    .map((o) => ({ ...o, projects: (o.projects ?? []).filter((p) => String(p.projectType ?? "").trim() !== "2") }))
    .filter((o) => (o.organizationId ?? o.id) && (o.projects ?? []).length > 0);
  if (!orgs.length) throw new Error("找不到可用的组织/项目");
  const org = orgs.find((o) => (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER)) ?? orgs[0];
  const orgId = org.organizationId ?? org.id ?? org.orgId;
  const project = org.projects.find((p) => (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER)) ?? org.projects[0];
  const projectId = project.projectId ?? project.id;
  log(`      组织=${orgId}  项目=${projectId}`);

  log("[2/3] 查找或创建项目 API key ...");
  const listUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
  let apiKey;
  try {
    const existing = (await bizApi(listUrl, authorization, { method: "GET" })) ?? [];
    if (Array.isArray(existing)) {
      const found = existing.find((k) => k.name === API_KEY_NAME);
      if (found && typeof found.apiKey === "string" && found.apiKey) apiKey = found.apiKey;
    }
  } catch {
    /* 列表失败就走创建 */
  }
  if (!apiKey) {
    const created = await bizApi(listUrl, authorization, { method: "POST", body: JSON.stringify({ name: API_KEY_NAME }) });
    apiKey = created?.apiKey;
  }
  if (!apiKey) throw new Error("未能取得项目 API key");
  log(`      apiKeyId=${apiKey}`);

  log("[3/3] 取 secretKey 并拼接 ...");
  let secret = "";
  try {
    const data = await bizApi(
      `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`,
      authorization,
      { method: "GET" },
    );
    secret = data.secretKey ?? data.secret_key ?? "";
  } catch (e) {
    log(`      secretKey 获取失败（将退化为单段 key）：${e.message}`);
  }

  return {
    apiKey: secret ? `${apiKey}.${secret}` : apiKey,
    provider,
    userId: userInfo?.id ? String(userInfo.id) : undefined,
    jwt: planJwt,
    oauthAccessToken: accessToken,
  };
}

if (require.main === module) {
  (async () => {
    const cfg = loadConfig();
    const rec = readCredentialRecord({ cfg });
    const fields = pickPlanFields(rec.values);
    const provider = cfg.provider || fields.provider || "bigmodel";
    console.log(`凭据来源: ${rec.path}`);
    console.log(`服务商  : ${provider}`);
    console.log(`账号    : ${fields.userInfo?.username ?? "(未知)"}\n`);

    const cred = await resolvePlanCredential({
      provider,
      accessToken: fields.accessToken,
      planJwt: fields.planJwt,
      userInfo: fields.userInfo,
    });
    fs.writeFileSync(OUT_FILE, JSON.stringify(cred, null, 2));
    console.log(`\n已写入: ${OUT_FILE}`);
    console.log(`  two-part key : ${cred.apiKey.includes(".") ? "是" : "否（仅 apiKey）"}`);
    console.log(`  Plan JWT     : ${cred.jwt ? "有" : "无"}`);
    console.log(`  OAuth 令牌   : ${cred.oauthAccessToken ? "有" : "无"}`);
  })().catch((e) => {
    console.error(`[失败] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { resolvePlanCredential, bizApi, OUT_FILE };
