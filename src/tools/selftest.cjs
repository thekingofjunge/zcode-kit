"use strict";
/**
 * 端到端自检：健康检查 → 模型列表 → 真实对话。
 *
 * 注意：这里用 Node 的 fetch 直接调用本地 router，**不经过 shell**，
 * 因此不会遇到「shell 剥掉 JSON 引号」那类问题（那是手工用 curl 时最常见的坑）。
 *
 * 用法：
 *   node src/tools/selftest.cjs
 *   node src/tools/selftest.cjs --model glm-5.3-flash --stream
 */
const { loadConfig } = require("../lib/config.cjs");

const cfg = loadConfig();
const base = `http://${cfg.router.host}:${cfg.router.port}`;
const key = cfg.router.apiKey;
const modelArg = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : cfg.models[0]?.id;
const stream = process.argv.includes("--stream");

const H = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) };

(async () => {
  console.log(`目标: ${base}   模型: ${modelArg}   流式: ${stream}\n`);

  console.log("[1] /health");
  const h = await fetch(`${base}/health`).then((r) => r.json());
  console.log("   ", JSON.stringify(h));

  console.log("\n[2] /v1/models");
  const m = await fetch(`${base}/v1/models`, { headers: H }).then((r) => r.json());
  console.log("   ", (m.data ?? m.models ?? []).map((x) => x.id ?? x.slug).join(", "));

  console.log("\n[3] /v1/messages");
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: modelArg,
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "用一句话回答：你是什么模型？" }],
    }),
  });
  console.log(`    HTTP ${r.status}  ${r.headers.get("content-type") ?? ""}`);

  if (!stream) {
    const j = await r.json();
    if (j.error) return console.log("    ", JSON.stringify(j).slice(0, 400));
    const text = (j.content ?? []).map((b) => b.text ?? (b.thinking ? `[thinking] ${b.thinking.slice(0, 60)}…` : "")).filter(Boolean).join(" ");
    console.log("    模型:", j.model);
    console.log("    回复:", text.slice(0, 200));
    console.log("    用量:", JSON.stringify(j.usage));
  } else {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "content_block_delta") process.stdout.write(ev.delta?.text ?? "");
          if (ev.type === "message_delta") console.log(`\n    用量: ${JSON.stringify(ev.usage)}`);
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }
    console.log();
  }

  console.log("\n若上面是 401/403 → 凭据过期，跑 npm run cred:refresh");
  console.log("若上面是 405 + unusual activity → 传输层被风控拦，见 README「已知限制」");
})().catch((e) => {
  console.error(`\n[失败] ${e.message}`);
  console.error("若连接被拒绝：本地路由没在跑，先执行 npm start");
  process.exit(1);
});
