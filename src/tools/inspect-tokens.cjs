"use strict";
/**
 * 检查凭据里各个 token 的时效。
 *
 * 背景：ZCode 的两个关键 token（OAuth access_token、Plan JWT）都**不带 exp 声明**，
 * 有效期由服务端控制，且不存在 refresh_token，因此无法自动续期 ——
 * 过期只能通过上游 401 察觉，届时需要重跑一次凭据刷新。
 *
 * 用法：
 *   node src/tools/inspect-tokens.cjs
 *   node src/tools/inspect-tokens.cjs <plain.json>   # 指定已导出的明文凭据
 */
const fs = require("fs");
const path = require("path");
const { loadConfig, ROOT } = require("../lib/config.cjs");
const { readCredentialRecord, decodeJwt } = require("../credential-store.cjs");

const now = Date.now();
let values;

const arg = process.argv[2];
if (arg && fs.existsSync(arg)) {
  values = JSON.parse(fs.readFileSync(arg, "utf8"));
} else {
  values = readCredentialRecord({ cfg: loadConfig() }).values;
}

console.log(`当前时间: ${new Date(now).toISOString()}\n`);

const INTERESTING = ["oauth:bigmodel:access_token", "oauth:zai:access_token", "zcodejwttoken"];
const found = Object.keys(values).filter((k) => /access_token$|zcodejwttoken$/.test(k));
const targets = found.length ? found : INTERESTING;

for (const k of targets) {
  const v = values[k];
  console.log("=".repeat(58));
  console.log(`${k}`);
  if (!v) {
    console.log("  (不存在)");
    continue;
  }
  console.log(`  长度: ${v.length}`);
  const p = decodeJwt(v);
  if (!p) {
    console.log("  不是 JWT（或无法解析 payload）");
    continue;
  }
  console.log(`  payload: ${JSON.stringify(p)}`);
  if (p.exp) {
    const left = Math.round((p.exp * 1000 - now) / 60000);
    console.log(`  exp: ${new Date(p.exp * 1000).toISOString()}  → 剩余 ${left} 分钟`);
  } else {
    console.log("  exp: 无声明（TTL 由服务端控制，过期表现为上游 401）");
  }
  if (p.iat) console.log(`  iat: ${new Date(p.iat * 1000).toISOString()}`);
}

console.log("\n" + "=".repeat(58));
console.log("凭据记录包含的键:");
for (const k of Object.keys(values)) console.log("  -", k);
console.log(`\nrefresh_token: ${Object.keys(values).some((k) => k.includes("refresh")) ? "存在" : "不存在（无法自动续期）"}`);
