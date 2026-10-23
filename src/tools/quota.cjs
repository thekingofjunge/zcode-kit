"use strict";
/**
 * 查询套餐用量。
 *
 *   编码套餐用量窗口： GET {providerOrigin}/api/monitor/usage/quota/limit
 *                      Authorization: `${apiKeyId}.${secretKey}`（注意：不带 Bearer）
 *                      —— 与客户端「今日余额」面板同源
 *   积分制 / 体验套餐： GET {routingOrigin}/api/v1/zcode-plan/billing/balance
 *                      Authorization: Bearer {Plan JWT}
 *
 * 判读要点：
 *   code=500 "当前用户不存在coding plan" → 该账号没有 coding-plan 订阅。
 *   如果你买的是 Start Plan（体验套餐），走的是另一条通道（见 README 通道对照表），
 *   这类账号查 coding-plan 用量本来就会报这个错，不代表额度不可用。
 *
 * 用法：node src/tools/quota.cjs
 */
const fs = require("fs");
const path = require("path");
const { loadConfig, ROOT } = require("../lib/config.cjs");

const cfg = loadConfig();
const credPath = path.join(ROOT, "cred.resolved.json");
if (!fs.existsSync(credPath)) {
  console.error("找不到 cred.resolved.json，请先运行: npm run cred:refresh");
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));

async function show(label, url, headers) {
  console.log(`\n[${label}]\n  GET ${url}`);
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    console.log(`  HTTP ${r.status}`);
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      return console.log(`  ${t.slice(0, 300)}`);
    }
    if (j.code !== undefined) console.log(`  code=${j.code} msg=${j.msg ?? ""}`);
    const limits = j.data?.limits;
    if (Array.isArray(limits) && limits.length) {
      console.log(`  订阅等级: ${j.data.level ?? "(未报告)"}`);
      for (const l of limits) {
        const pct = l.percentage !== undefined ? `${l.percentage}%` : "";
        const remain = l.remaining !== undefined ? `剩余 ${l.remaining}` : "";
        const total = l.number !== undefined ? `/ ${l.number}` : "";
        const reset = l.next_reset_time ? ` 重置 ${new Date(l.next_reset_time * 1000).toLocaleString()}` : "";
        console.log(`   - ${l.type}: ${remain} ${total} ${pct}${reset}`);
      }
    } else {
      console.log(`  data: ${JSON.stringify(j.data).slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  请求失败: ${e.message}`);
  }
}

(async () => {
  const origin = new URL(cfg.upstream.codingPlanAnthropicBase).origin;
  await show("编码套餐用量（面板同源）", `${origin}/api/monitor/usage/quota/limit`, {
    authorization: cred.apiKey,
    accept: "application/json",
  });

  if (cred.jwt) {
    const platform = `${process.platform}-${process.arch}`;
    await show(
      "积分 / 体验套餐余额",
      `${cfg.upstream.routingOrigin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(cfg.identity.appVersion)}&platform=${encodeURIComponent(platform)}`,
      { authorization: `Bearer ${cred.jwt}`, accept: "application/json" },
    );
  }
})();
