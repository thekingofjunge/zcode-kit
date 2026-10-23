"use strict";
/**
 * 配置加载与路径解析。
 *
 * 所有用户相关的路径都从 config.json 读，代码里不硬编码任何绝对路径。
 * 支持 %VAR% 形式的环境变量展开与 ~ 前缀。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "..");
const CFG_PATH = path.join(ROOT, "config.json");

function expandEnv(p) {
  if (typeof p !== "string") return p;
  const out = p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`);
  return out.startsWith("~") ? path.join(os.homedir(), out.slice(1)) : out;
}

const DEFAULTS = {
  zcodeDataDir: path.join(os.homedir(), ".zcode", "v2"),
  proxyStoreDir: path.join(os.homedir(), ".zcode-proxy"),
  provider: "bigmodel",
  plan: "start-plan",
  router: { host: "127.0.0.1", port: 8788, apiKey: "" },
  upstream: {
    startPlanBase: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    codingPlanAnthropicBase: "https://open.bigmodel.cn/api/anthropic",
    codingPlanOpenAIBase: "https://open.bigmodel.cn/api/coding/paas/v4",
    routingOrigin: "https://zcode.z.ai",
    signingOrigin: "https://open.bigmodel.cn",
  },
  identity: {
    appVersion: "3.16.3",
    sourceTitle: "cli",
    refererOrigin: "https://zcode.z.ai",
    releaseChannel: "production",
  },
  models: [
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxTokens: 128000, vision: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 128000, vision: true },
  ],
};

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== "object" || Array.isArray(base) || typeof over !== "object" || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function loadConfig() {
  let user = {};
  if (fs.existsSync(CFG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    } catch (e) {
      throw new Error(`config.json 不是合法 JSON: ${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.zcodeDataDir = expandEnv(cfg.zcodeDataDir);
  cfg.proxyStoreDir = expandEnv(cfg.proxyStoreDir);
  return cfg;
}

module.exports = { loadConfig, expandEnv, DEFAULTS, ROOT, CFG_PATH };
