"use strict";
/**
 * 一键刷新：客户端凭据 → 项目凭据 → 前端可读凭据。
 *
 * 什么时候需要跑：
 *   - 上游开始返回 401 / 鉴权失败
 *   - 换了账号，或客户端重新登录过
 *   - token 本身没有 exp 声明、也不会自动续期，所以「过期」只能靠 401 发现
 *
 * 用法：
 *   node src/refresh-all.cjs
 */
const { readCredentialRecord, pickPlanFields } = require("./credential-store.cjs");
const { resolvePlanCredential } = require("./resolve-plan-cred.cjs");
const { installCredential } = require("./install-credential.cjs");
const { loadConfig } = require("./lib/config.cjs");
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./lib/config.cjs");

(async () => {
  const cfg = loadConfig();

  console.log("=== [1/3] 读取并解密客户端凭据 ===");
  const rec = readCredentialRecord({ cfg });
  const fields = pickPlanFields(rec.values);
  if (!fields.accessToken) throw new Error("客户端凭据里没有 OAuth 访问令牌 —— 请先在 ZCode 客户端登录");
  console.log(`来源: ${rec.path}`);
  console.log(`账号: ${fields.userInfo?.username ?? "(未知)"}   服务商: ${fields.provider || cfg.provider}`);

  console.log("\n=== [2/3] 换取项目凭据 ===");
  const cred = await resolvePlanCredential({
    provider: cfg.provider || fields.provider || "bigmodel",
    accessToken: fields.accessToken,
    planJwt: fields.planJwt,
    userInfo: fields.userInfo,
  });
  fs.writeFileSync(path.join(ROOT, "cred.resolved.json"), JSON.stringify(cred, null, 2));
  console.log(`two-part key: ${cred.apiKey.includes(".") ? "是" : "否"}   Plan JWT: ${cred.jwt ? "有" : "无"}`);

  console.log("\n=== [3/3] 安装到前端凭据存储 ===");
  const r = installCredential({ cfg, verify: true });
  console.log(`写入: ${r.dest}`);
  console.log(`校验: ${r.verified ? "通过" : "未通过"}`);

  console.log("\n完成。若前端是常驻进程，请重启它以加载新凭据。");
})().catch((e) => {
  console.error(`\n[失败] ${e.message}`);
  console.error("排查：确认 ZCode 客户端处于已登录状态（凭据是机器绑定的，换机/重装后需要重新登录）。");
  process.exit(1);
});
