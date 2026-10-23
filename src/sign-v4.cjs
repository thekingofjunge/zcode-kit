"use strict";
/**
 * ZCode 客户端请求签名 V4 —— 零依赖实现。
 *
 * 适用：coding-plan（个人 / 团队）流量。start-plan、off-peak、highspeed 通道**不签名**。
 *
 * 协议（对拍 ZCode 3.15.x / 3.16.x）：
 *
 *   [握手]  POST {origin}/api/paas/c1f3a7e2/v2/client
 *           body  { apiKey | accessToken, nonce, sig, ts }
 *           sig   = base64( HMAC-SHA256( HKDF(secret, "getSignKey_hmac"),
 *                                       `get_sign_key\n{apiKeyId}\n{ts}\n{nonce}` ) )
 *           其中 HMAC 的密钥由 HKDF 派生：
 *              salt = "WD_CLIENT_SIGN_KDF_SALT"
 *              info = "getSignKey_hmac"
 *           返回  { code:200, data:{ privateCipher } }
 *
 *   [私钥]  AES-256-GCM 解密 privateCipher
 *           密钥 = HKDF(secret, "ed25519_priv")，IV = 前 12 字节，
 *           AAD = apiKeyId，得到 PKCS8 的 Ed25519 私钥
 *
 *   [业务]  每个请求
 *           sig = base64( Ed25519( `{apiKeyId}\n{ts}\n{appVersion}\n{sessionId}\n{nonce}` ) )
 *           pow = 迭代 12 字节随机 nonce + 计数器，直到
 *                 sha256(`{seed}\n{nonce}{counter:08x}`) 首字节为 0
 *                 seed = hex( sha256(`{apiKeyId}\nzcode\n{sessionId}\n{ts}`) ).slice(0,32)
 *           头： X-Client-Ts / X-Client-Version / X-Client-Sig /
 *                X-Session-Id / X-Client-Nonce / X-App-Id / X-Client-Pow
 *
 * 凭据两种形态：
 *   `${apiKeyId}.${secret}`                  → 握手用 apiKey 字段，Authorization 裸值
 *   project_access JWT(HS256, sign_type=SIGN) → 握手用 accessToken 字段，Authorization: Bearer
 *
 * 失败语义：与官方客户端一致，全程 fail-open —— 握手失败就不签名直发，不阻断请求。
 */
const crypto = require("crypto");

const APP_ID = "zcode";
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const KDF_INFO_HMAC = "getSignKey_hmac";
const KDF_INFO_ED25519 = "ed25519_priv";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const HANDSHAKE_METHOD = "get_sign_key";
const HANDSHAKE_TIMEOUT_MS = 10000;
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_NONCE_BYTES = 12;

/** 客户端永不签名的路径（解码后比对，去尾斜杠）。 */
const UNSIGNED_PATHS = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",
  "/api/v1/zcode-plan/chat/completions",
  "/api/v1/off-peak/anthropic/v1/messages",
]);

const rand = (n) => crypto.randomBytes(n).toString("hex");

function hkdf(secret, info, len = 32) {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(KDF_SALT, "utf8"), Buffer.from(info, "utf8"), len),
  );
}

function handshakeSignature(secret, message) {
  const bits = hkdf(secret, KDF_INFO_HMAC);
  return crypto.createHmac("sha256", bits).update(message, "utf8").digest("base64");
}

function decryptSigningPrivateKey(apiKeyId, secret, privateCipher) {
  const cipher = Buffer.from(privateCipher, "base64");
  if (cipher.length <= 12 + 16) throw new Error("privateCipher 长度不足");
  const iv = cipher.subarray(0, 12);
  const tag = cipher.subarray(cipher.length - 16);
  const data = cipher.subarray(12, cipher.length - 16);
  const aesKey = hkdf(secret, KDF_INFO_ED25519);
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  d.setAAD(Buffer.from(apiKeyId, "utf8"));
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(data), d.final()]);
  const pkcs8 = Buffer.from(plain.toString("utf8"), "base64");
  return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function signBusinessMessage(privateKey, message) {
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}

function createProofOfWork(apiKeyId, sessionId, ts, bits = POW_BITS) {
  const seed = crypto
    .createHash("sha256")
    .update(`${apiKeyId}\n${APP_ID}\n${sessionId}\n${ts}`, "utf8")
    .digest()
    .toString("hex")
    .slice(0, 32);
  const nonce = rand(POW_NONCE_BYTES);
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const candidate = `${nonce}${counter.toString(16).padStart(8, "0")}`;
    const digest = crypto.createHash("sha256").update(`${seed}\n${candidate}`, "utf8").digest();
    if (bits === 8 ? digest[0] === 0 : digest[0] < 1 << (8 - bits)) return candidate;
  }
  throw new Error("PoW 求解失败");
}

/** 判定凭据形态；无法识别返回 undefined。 */
function parseSigningCredentialForm(credential) {
  if (typeof credential !== "string" || !credential) return undefined;
  const segs = credential.split(".");
  if (segs.length === 3 && segs[2]) {
    try {
      const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      const header = dec(segs[0]);
      if (header.alg !== "HS256" || header.sign_type !== "SIGN") return undefined;
      const payload = dec(segs[1]);
      if (payload.token_use !== "project_access" || typeof payload.api_key !== "string" || !payload.api_key.trim()) {
        return undefined;
      }
      return { apiKeyId: payload.api_key, secret: credential, handshakeField: "accessToken", exp: payload.exp };
    } catch {
      return undefined;
    }
  }
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot !== credential.lastIndexOf(".")) return undefined;
  const apiKeyId = credential.slice(0, dot);
  const secret = credential.slice(dot + 1);
  if (!apiKeyId.trim() || !secret.trim()) return undefined;
  return { apiKeyId, secret, handshakeField: "apiKey" };
}

function isUnsignedPath(pathname) {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    /* 保持原样 */
  }
  return UNSIGNED_PATHS.has(p.replace(/\/+$/, ""));
}

class ClientSigner {
  /**
   * @param {object} o
   * @param {string} o.credential      两段式 key 或 project_access JWT
   * @param {string} [o.oauthAccessToken] 原始 OAuth 令牌（bigmodel 用于铸造 project JWT）
   * @param {string} [o.provider]      "bigmodel" | "zai"
   * @param {string} [o.signingOrigin] 握手 origin，通常是 provider 的 API 根
   * @param {string} [o.appVersion]
   * @param {(msg:string)=>void} [o.onEvent]
   */
  constructor({ credential, oauthAccessToken, provider, signingOrigin, appVersion = "3.16.3", onEvent = () => {} }) {
    this.credential = credential;
    this.oauthAccessToken = oauthAccessToken;
    this.provider = provider;
    this.signingOrigin = signingOrigin;
    this.appVersion = appVersion;
    this.onEvent = onEvent;
    this.keys = new Map();
    this.projectJwt = null;
  }

  async resolveParsed() {
    const direct = parseSigningCredentialForm(this.credential);
    if (direct?.handshakeField === "accessToken") return direct;
    if (!this.oauthAccessToken || this.provider !== "bigmodel") return direct;
    if (this.projectJwt && this.projectJwt.expMs - 300000 > Date.now()) {
      const cached = parseSigningCredentialForm(this.projectJwt.jwt);
      if (cached) return cached;
    }
    const minted = await this.mintProjectJwt(this.oauthAccessToken, direct?.apiKeyId);
    if (!minted) return direct;
    this.projectJwt = minted;
    this.keys.clear();
    this.onEvent(`已铸造 project-access JWT（剩余 ${Math.round((minted.expMs - Date.now()) / 60000)} 分钟）`);
    return parseSigningCredentialForm(minted.jwt) ?? direct;
  }

  /**
   * bigmodel 的 apiKey 形态握手虽然返回 200，但其 privateCipher 无法解密；
   * 必须用 OAuth 令牌换 project_access JWT 后再握手。
   */
  async mintProjectJwt(oauthAccessToken, apiKeyId) {
    if (!apiKeyId) return null;
    const bare = oauthAccessToken.startsWith("Bearer ") ? oauthAccessToken.slice(7).trim() : oauthAccessToken;
    const infoResp = await fetch("https://bigmodel.cn/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: bare, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const info = await infoResp.json();
    const orgs = (info.data?.organizations ?? [])
      .map((o) => ({ ...o, projects: (o.projects ?? []).filter((p) => String(p.projectType ?? "").trim() !== "2") }))
      .filter((o) => o.organizationId && o.projects.length > 0);
    const org = orgs.find((o) => o.organizationName?.includes("默认机构")) ?? orgs[0];
    const project = org?.projects.find((p) => p.projectName?.includes("默认项目")) ?? org?.projects[0];
    if (!org?.organizationId || !project?.projectId) return null;

    const resp = await fetch(
      `https://bigmodel.cn/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}` +
        `/projects/${encodeURIComponent(project.projectId)}/api_keys/${encodeURIComponent(apiKeyId)}/access_tokens`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bare}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientType: "zcode", clientVersion: this.appVersion }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const j = await resp.json();
    const jwt = j.data?.accessToken;
    if (!jwt) throw new Error(`project token 铸造被拒: code=${j.code ?? resp.status} ${j.msg ?? ""}`);
    let expMs = Date.now() + 3600000;
    try {
      const p = JSON.parse(Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      if (typeof p.exp === "number") expMs = p.exp * 1000;
    } catch {
      /* 保留兜底有效期 */
    }
    return { jwt, expMs };
  }

  async ensureKey(origin, parsed) {
    const hit = this.keys.get(origin);
    if (hit) return hit;
    const ts = String(Date.now());
    const nonce = rand(NONCE_BYTES);
    const sig = handshakeSignature(parsed.secret, `${HANDSHAKE_METHOD}\n${parsed.apiKeyId}\n${ts}\n${nonce}`);
    const isJwt = parsed.handshakeField === "accessToken";
    const authHeader = isJwt ? `Bearer ${parsed.secret}` : `${parsed.apiKeyId}.${parsed.secret}`;
    const authValue = isJwt ? parsed.secret : `${parsed.apiKeyId}.${parsed.secret}`;
    const bodyKey = isJwt ? "accessToken" : "apiKey";

    const resp = await fetch(`${origin}${HANDSHAKE_PATH}`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ [bodyKey]: authValue, nonce, sig, ts }),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    const envelope = await resp.json().catch(() => ({}));
    if (resp.status !== 200 || envelope.code !== 200) {
      throw new Error(`握手失败 http=${resp.status} code=${envelope.code} msg=${envelope.msg ?? ""}`);
    }
    const cipher = envelope.data?.privateCipher;
    if (!cipher) throw new Error("握手响应缺少 privateCipher");
    const privateKey = decryptSigningPrivateKey(parsed.apiKeyId, parsed.secret, cipher);
    const entry = { privateKey, parsed };
    this.keys.set(origin, entry);
    this.onEvent(`握手成功 ${origin}（${isJwt ? "accessToken/JWT" : "apiKey"} 形态）`);
    return entry;
  }

  /** 给请求头补上 V4 签名；任何异常都 fail-open 返回原头。 */
  async sign(url, headers) {
    try {
      const parsedUrl = new URL(url);
      if (isUnsignedPath(parsedUrl.pathname)) return { headers, signed: false, reason: "unsigned-path" };
      const parsed = await this.resolveParsed();
      if (!parsed) return { headers, signed: false, reason: "unsupported-credential-form" };
      const sessionId = headers["x-session-id"] || headers["X-Session-Id"];
      if (!sessionId) return { headers, signed: false, reason: "missing-session-id" };
      const keyOrigin = this.signingOrigin || parsedUrl.origin;
      const { privateKey } = await this.ensureKey(keyOrigin, parsed);
      const ts = String(Date.now());
      const nonce = rand(NONCE_BYTES);
      const pow = createProofOfWork(parsed.apiKeyId, sessionId, ts);
      const sig = signBusinessMessage(privateKey, `${parsed.apiKeyId}\n${ts}\n${this.appVersion}\n${sessionId}\n${nonce}`);
      const out = { ...headers };
      for (const k of Object.keys(out)) {
        if (["x-client-ts", "x-client-version", "x-client-sig", "x-client-nonce", "x-app-id", "x-client-pow", "x-session-id"].includes(k.toLowerCase())) delete out[k];
      }
      Object.assign(out, {
        "X-Client-Ts": ts,
        "X-Client-Version": this.appVersion,
        "X-Client-Sig": sig,
        "X-Session-Id": sessionId,
        "X-Client-Nonce": nonce,
        "X-App-Id": APP_ID,
        "X-Client-Pow": pow,
      });
      return { headers: out, signed: true };
    } catch (e) {
      this.onEvent(`签名跳过（fail-open）：${e.message}`);
      return { headers, signed: false, reason: e.message };
    }
  }
}

module.exports = {
  ClientSigner,
  parseSigningCredentialForm,
  handshakeSignature,
  decryptSigningPrivateKey,
  createProofOfWork,
  isUnsignedPath,
  UNSIGNED_PATHS,
  APP_ID,
  KDF_SALT,
};
