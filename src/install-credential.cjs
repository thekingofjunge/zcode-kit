"use strict";
/**
 * 把 cred.resolved.json 装成 zcode-proxy（或任何实现了同一存储格式的前端）能直接读取的凭据文件。
 *
 * 目标格式（对拍 zcode-api src/auth/store.ts）：
 *   文件：<proxyStoreDir>/credentials.json
 *   内容：{"encrypted": "<base64(iv || ciphertext || authTag)>"}
 *   算法：AES-256-GCM，IV 12 字节
 *   密钥：sha256(`${homedir()}-${platform}-${arch}`)
 *         （可用环境变量 ZCODE_PROXY_CREDENTIAL_SECRET 覆盖，跨机迁移时需要一致）
 *
 * 用法：
 *   node src/install-credential.cjs
 *   node src/install-credential.cjs --verify   # 写完后立即回读校验
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, ROOT } = require("./lib/config.cjs");

const CRED_FILE = path.join(ROOT, "cred.resolved.json");
const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

function deriveProxyKey(env = process.env) {
  const seed = env[ENV_SECRET] ?? `${os.homedir()}-${os.platform()}-${os.arch()}`;
  return { key: crypto.createHash("sha256").update(seed, "utf8").digest(), seed };
}

function encryptForProxy(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}

function decryptForProxy(key, b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8");
}

function installCredential({ cfg = loadConfig(), verify = false } = {}) {
  if (!fs.existsSync(CRED_FILE)) {
    throw new Error(`找不到 ${CRED_FILE}，请先运行: node src/resolve-plan-cred.cjs`);
  }
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  const payload = {
    apiKey: cred.apiKey,
    provider: cred.provider,
    userId: cred.userId,
    jwt: cred.jwt,
    oauthAccessToken: cred.oauthAccessToken,
  };

  const { key, seed } = deriveProxyKey();
  const dir = cfg.proxyStoreDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, "credentials.json");
  fs.writeFileSync(dest, JSON.stringify({ encrypted: encryptForProxy(key, payload) }), { mode: 0o600 });

  const result = { dest, seed, hasJwt: !!payload.jwt, hasOauth: !!payload.oauthAccessToken };
  if (verify) {
    const back = JSON.parse(decryptForProxy(key, JSON.parse(fs.readFileSync(dest, "utf8")).encrypted));
    result.verified = back.apiKey === payload.apiKey && back.jwt === payload.jwt;
  }
  return result;
}

if (require.main === module) {
  try {
    const verify = process.argv.includes("--verify");
    const r = installCredential({ verify });
    console.log(`已写入  : ${r.dest}`);
    console.log(`密钥种子: ${r.seed}`);
    console.log(`含 JWT  : ${r.hasJwt ? "是" : "否"}`);
    console.log(`含 OAuth: ${r.hasOauth ? "是" : "否"}`);
    if (verify) console.log(`回读校验: ${r.verified ? "通过" : "不通过（请检查是否设置了 ZCODE_PROXY_CREDENTIAL_SECRET）"}`);
  } catch (e) {
    console.error(`[失败] ${e.message}`);
    process.exit(1);
  }
}

module.exports = { installCredential, deriveProxyKey, encryptForProxy, decryptForProxy, CRED_FILE };
