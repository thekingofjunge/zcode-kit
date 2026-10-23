"use strict";
/**
 * ZCode 客户端共享凭据的读取与解密。
 *
 * 机制（对拍 ZCode 3.16.x 内置 CLI zcode.cjs）：
 *   存储：<dataDir>/credentials.json，值为字符串，形如
 *         enc:v1:<iv b64url>.<authTag b64url>.<ciphertext b64url>
 *   算法：AES-256-GCM，IV 12 字节，tag 16 字节
 *   密钥：sha256(secret)
 *         secret = env.ZCODE_CREDENTIAL_SECRET
 *                  ?? `zcode-credential-fallback:${platform}:${homedir}:${username}`
 *
 * 已知键名：
 *   oauth:active_provider          当前服务商（zai | bigmodel）
 *   oauth:<provider>:access_token  OAuth 访问令牌
 *   oauth:<provider>:refresh_token 刷新令牌（部分账号不写入）
 *   oauth:<provider>:user_info     账号信息
 *   zcodejwttoken                  Plan JWT（start-plan / 闲时等通道使用）
 *
 * 用法：
 *   node src/credential-store.cjs              # 读取并打印（值默认脱敏）
 *   node src/credential-store.cjs --plain      # 打印明文（谨慎）
 *   node src/credential-store.cjs --out FILE   # 写入明文 JSON
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("./lib/config.cjs");

const ENC_PREFIX = "enc:v1:";
const ENV_SECRET = "ZCODE_CREDENTIAL_SECRET";
const SECRET_PREFIX = "zcode-credential-fallback";

/**
 * 复刻 bundle 的 resolveCredentialSecret：环境变量优先，否则由
 * 平台 + 主目录 + 用户名拼出的兜底串（因此本地文件天然机器绑定）。
 */
function resolveSecret(env = process.env) {
  const fromEnv = env[ENV_SECRET];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    /* 容器等环境可能取不到，保持 unknown */
  }
  return `${SECRET_PREFIX}:${os.platform()}:${os.homedir()}:${username}`;
}

/** 密钥派生：sha256(secret) → 32 字节 AES-256 key。 */
function deriveKey(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function isEncryptedValue(v) {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
}

/** 解密单个 enc:v1 值；非加密值原样返回。 */
function decryptValue(key, value) {
  if (!isEncryptedValue(value)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("密文格式错误：应为 enc:v1:<iv>.<tag>.<ct>");
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== 12) throw new Error(`IV 长度应为 12，实际 ${iv.length}`);
  if (tag.length !== 16) throw new Error(`AuthTag 长度应为 16，实际 ${tag.length}`);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** 加密（AES-256-GCM），与客户端同格式 —— 仅用于需要写回的场景。 */
function encryptValue(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return ENC_PREFIX + [iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

function credentialPath(cfg = loadConfig()) {
  return path.join(cfg.zcodeDataDir, "credentials.json");
}

/** 读取并解密整份凭据记录。 */
function readCredentialRecord({ cfg = loadConfig(), env = process.env, file } = {}) {
  const target = file || credentialPath(cfg);
  if (!fs.existsSync(target)) {
    throw new Error(`找不到凭据文件：${target}\n请确认 ZCode 客户端已安装且至少登录过一次。`);
  }
  const raw = JSON.parse(fs.readFileSync(target, "utf8"));
  const key = deriveKey(resolveSecret(env));
  const out = {};
  const failures = [];
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    try {
      out[k] = decryptValue(key, v);
    } catch (e) {
      failures.push({ key: k, error: e.message });
    }
  }
  return { path: target, values: out, failures };
}

/** 从记录中挑出我们关心的字段（缺省即 undefined）。 */
function pickPlanFields(values) {
  const provider = values["oauth:active_provider"] || "";
  const pick = (name) => values[`oauth:${provider}:${name}`] ?? values[`oauth:zai:${name}`] ?? values[`oauth:bigmodel:${name}`];
  return {
    provider,
    accessToken: pick("access_token"),
    refreshToken: pick("refresh_token"),
    userInfo: (() => {
      try {
        return JSON.parse(pick("user_info") || "null");
      } catch {
        return null;
      }
    })(),
    planJwt: values["zcodejwttoken"],
  };
}

/** 解析 JWT payload（不验签，仅读取）。 */
function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function mask(v) {
  if (typeof v !== "string") return v;
  if (v.length <= 16) return "<redacted>";
  return `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const wantPlain = args.includes("--plain");
  const outIdx = args.indexOf("--out");
  try {
    const rec = readCredentialRecord();
    console.log(`凭据文件: ${rec.path}`);
    console.log(`解密成功: ${Object.keys(rec.values).length} 个键`);
    if (rec.failures.length) {
      console.log(`解密失败: ${rec.failures.length} 个`);
      for (const f of rec.failures) console.log(`  - ${f.key}: ${f.error}`);
    }
    console.log("");
    for (const [k, v] of Object.entries(rec.values)) {
      console.log(`  ${k} = ${wantPlain ? v : mask(v)}`);
    }
    const fields = pickPlanFields(rec.values);
    console.log("");
    console.log(`服务商      : ${fields.provider || "(未知)"}`);
    console.log(`Plan JWT    : ${fields.planJwt ? mask(fields.planJwt) : "(无)"}`);
    if (fields.planJwt) {
      const p = decodeJwt(fields.planJwt);
      if (p) console.log(`  payload   : ${JSON.stringify(p)}`);
    }
    console.log(`refresh_token: ${fields.refreshToken ? "存在" : "不存在"}`);
    if (outIdx >= 0) {
      const dest = args[outIdx + 1];
      fs.writeFileSync(dest, JSON.stringify(rec.values, null, 2));
      console.log(`\n明文已写入: ${dest}  ← 敏感文件，勿提交版本库`);
    }
  } catch (e) {
    console.error(`[失败] ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  resolveSecret,
  deriveKey,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  readCredentialRecord,
  pickPlanFields,
  decodeJwt,
  credentialPath,
  ENC_PREFIX,
  ENV_SECRET,
};
