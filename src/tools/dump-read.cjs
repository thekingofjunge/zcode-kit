"use strict";
/**
 * 解析前端产生的上游流量 dump（JSONL）。
 *
 * 若使用 zcode-api 系列前端，设置环境变量 ZCODE_DUMP_UPSTREAM=<path> 即可开启，
 * 每个请求会写出若干阶段记录：client_in / upstream_out / wire_out / upstream_in。
 * 敏感头会被前端自动脱敏。
 *
 * 用法：
 *   node src/tools/dump-read.cjs <dump.jsonl>
 *   node src/tools/dump-read.cjs <dump.jsonl> --bodies   # 连 body 一起打印
 */
const fs = require("fs");

const file = process.argv[2];
const withBodies = process.argv.includes("--bodies");
if (!file || !fs.existsSync(file)) {
  console.error("用法: node src/tools/dump-read.cjs <dump.jsonl> [--bodies]");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

function body(o) {
  const b = o.body;
  if (b === undefined || b === null) return "";
  const s = typeof b === "string" ? b : JSON.stringify(b);
  return withBodies ? s : s.slice(0, 160) + (s.length > 160 ? ` …(${s.length}B)` : "");
}

for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  switch (o.phase) {
    case "client_in":
      console.log(`\n=== client_in ${o.reqId ?? ""} ===`);
      console.log("  headers:", JSON.stringify(o.headers));
      console.log("  body   :", body(o));
      break;
    case "upstream_out":
      console.log(`\n=== upstream_out ${o.reqId ?? ""} ===`);
      console.log("  url:", o.url);
      for (const [k, v] of Object.entries(o.headers ?? {})) console.log(`   ${k}: ${v}`);
      console.log("  body:", body(o));
      break;
    case "upstream_in":
      console.log(`\n=== upstream_in ${o.reqId ?? ""} ===`);
      console.log("  status:", o.status);
      console.log("  body  :", body(o));
      break;
    default: {
      const { ts, reqId, phase, ...rest } = o;
      console.log(`\n=== ${phase} ${reqId ?? ""} ===`);
      console.log(" ", JSON.stringify(rest).slice(0, 400));
    }
  }
}
