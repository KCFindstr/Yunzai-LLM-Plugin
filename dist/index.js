// src/lib/config.ts
import fs from "fs";
import path from "path";
import YAML from "yaml";
var PLUGIN_PATH = path.resolve("plugins/Yunzai-LLM-Plugin");
var CONFIG_PATH = path.join(PLUGIN_PATH, "config", "config.yaml");
var DEFAULT_CONFIG_PATH = path.join(PLUGIN_PATH, "config", "default_config.yaml");
var DEFAULT_FALLBACK = {
  apiUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  systemPrompt: "\u4F60\u662F\u4E00\u4E2A\u53CB\u597D\u3001\u5E7D\u9ED8\u4E14\u5BCC\u6709\u667A\u6167\u7684 QQ \u804A\u5929\u52A9\u624B\u3002\u8BF7\u7528\u81EA\u7136\u3001\u4EB2\u5207\u7684\u4E2D\u6587\u4E0E\u7528\u6237\u4EA4\u6D41\uFF0C\u56DE\u7B54\u8981\u7CBE\u70BC\u51C6\u786E\uFF0C\u6392\u7248\u6E05\u6670\u3002",
  temperature: 0.7,
  maxTokens: 2048,
  timeout: 60,
  prefix: ["#chat", "#ai", "chat", "ai"],
  atReply: true,
  replyQuote: true,
  historyLimit: 10,
  historyTimeout: 30,
  isolateUserInGroup: true
};
var ConfigManager = class {
  config = { ...DEFAULT_FALLBACK };
  constructor() {
    this.init();
  }
  init() {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
      try {
        fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
      } catch {
      }
    }
    this.load();
    this.watch();
  }
  load() {
    try {
      let defaultConfig = {};
      if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
        const defaultContent = fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8");
        defaultConfig = YAML.parse(defaultContent) || {};
      }
      let userConfig = {};
      if (fs.existsSync(CONFIG_PATH)) {
        const userContent = fs.readFileSync(CONFIG_PATH, "utf8");
        userConfig = YAML.parse(userContent) || {};
      }
      this.config = {
        ...DEFAULT_FALLBACK,
        ...defaultConfig,
        ...userConfig
      };
    } catch (err) {
      if (typeof logger !== "undefined") {
        logger.error(`[Yunzai-LLM-Plugin] \u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6\u5931\u8D25: ${err.message}`);
      }
    }
  }
  watch() {
    if (!fs.existsSync(CONFIG_PATH)) return;
    try {
      fs.watch(CONFIG_PATH, (event) => {
        if (event === "change") {
          setTimeout(() => {
            this.load();
            if (typeof logger !== "undefined") {
              logger.info("[Yunzai-LLM-Plugin] \u914D\u7F6E\u6587\u4EF6\u5DF2\u70ED\u91CD\u8F7D");
            }
          }, 200);
        }
      });
    } catch (err) {
      if (typeof logger !== "undefined") {
        logger.warn(`[Yunzai-LLM-Plugin] \u76D1\u542C\u914D\u7F6E\u6587\u4EF6\u5931\u8D25: ${err.message}`);
      }
    }
  }
  get() {
    return this.config;
  }
  set(key, value) {
    this.config[key] = value;
    try {
      let current = {};
      if (fs.existsSync(CONFIG_PATH)) {
        current = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
      }
      current[key] = value;
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(current), "utf8");
      return true;
    } catch (err) {
      if (typeof logger !== "undefined") {
        logger.error(`[Yunzai-LLM-Plugin] \u4FDD\u5B58\u914D\u7F6E\u6587\u4EF6\u5931\u8D25: ${err.message}`);
      }
      return false;
    }
  }
};
var config_default = new ConfigManager();

// src/lib/memory.ts
var MemoryManager = class {
  sessions = /* @__PURE__ */ new Map();
  getSessionKey(e) {
    const cfg = config_default.get();
    const isGroup = Boolean(e.group_id || e.isGroup);
    const userId = String(e.user_id || e.sender?.user_id);
    const groupId = String(e.group_id);
    if (isGroup) {
      if (cfg.isolateUserInGroup) {
        return `group:${groupId}:user:${userId}`;
      }
      return `group:${groupId}:common`;
    }
    return `private:${userId}`;
  }
  getMessages(e) {
    const cfg = config_default.get();
    if (!cfg.historyLimit || cfg.historyLimit <= 0) {
      return [];
    }
    const key = this.getSessionKey(e);
    const session = this.sessions.get(key);
    if (!session) return [];
    const timeoutMs = (cfg.historyTimeout || 30) * 60 * 1e3;
    if (Date.now() - session.lastTime > timeoutMs) {
      this.sessions.delete(key);
      return [];
    }
    return session.messages;
  }
  addMessage(e, role, content) {
    const cfg = config_default.get();
    if (!cfg.historyLimit || cfg.historyLimit <= 0) return;
    const key = this.getSessionKey(e);
    let session = this.sessions.get(key);
    if (!session) {
      session = { lastTime: Date.now(), messages: [] };
      this.sessions.set(key, session);
    }
    session.lastTime = Date.now();
    session.messages.push({ role, content });
    const maxMessages = cfg.historyLimit * 2;
    if (session.messages.length > maxMessages) {
      session.messages = session.messages.slice(-maxMessages);
    }
  }
  clearSession(e) {
    const key = this.getSessionKey(e);
    return this.sessions.delete(key);
  }
  clearAll() {
    this.sessions.clear();
  }
};
var memory_default = new MemoryManager();

// src/lib/llm.ts
async function askLLM(e, query) {
  const cfg = config_default.get();
  if (!cfg.apiKey || cfg.apiKey.includes("your-api-key")) {
    return "\u3010\u63D0\u793A\u3011\u672A\u914D\u7F6E\u6709\u6548 API Key\uFF01\u8BF7\u7BA1\u7406\u5458\u524D\u5F80 plugins/Yunzai-LLM-Plugin/config/config.yaml \u4E2D\u914D\u7F6E apiKey\u3002";
  }
  const endpoint = (cfg.apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${endpoint}/chat/completions`;
  const history = memory_default.getMessages(e);
  const messages = [];
  if (cfg.systemPrompt) {
    messages.push({
      role: "system",
      content: cfg.systemPrompt
    });
  }
  messages.push(...history);
  messages.push({
    role: "user",
    content: query
  });
  const payload = {
    model: cfg.model || "deepseek-chat",
    messages,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0.7,
    max_tokens: cfg.maxTokens || 2048
  };
  const timeoutMs = (cfg.timeout || 60) * 1e3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const errText = await response.text();
      if (typeof logger !== "undefined") {
        logger.error(`[Yunzai-LLM-Plugin] API \u8BF7\u6C42\u5931\u8D25 [HTTP ${response.status}]: ${errText}`);
      }
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
      }
      return `\u3010LLM \u8BF7\u6C42\u51FA\u9519\u3011HTTP ${response.status}: ${detail}`;
    }
    const data = await response.json();
    const replyContent = data.choices?.[0]?.message?.content?.trim();
    if (!replyContent) {
      return "\u3010LLM \u63D0\u793A\u3011\u5927\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u56DE\u590D\uFF0C\u8BF7\u91CD\u8BD5\u3002";
    }
    memory_default.addMessage(e, "user", query);
    memory_default.addMessage(e, "assistant", replyContent);
    return replyContent;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return `\u3010LLM \u8BF7\u6C42\u8D85\u65F6\u3011\u8BF7\u6C42\u8D85\u8FC7\u4E86 ${cfg.timeout || 60} \u79D2\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u6216\u7A0D\u540E\u91CD\u8BD5\u3002`;
    }
    if (typeof logger !== "undefined") {
      logger.error(`[Yunzai-LLM-Plugin] \u8C03\u7528\u5F02\u5E38: ${err.message}`);
    }
    return `\u3010LLM \u53D1\u751F\u5F02\u5E38\u3011${err.message}`;
  }
}

// src/apps/chat.ts
var BasePlugin = typeof plugin !== "undefined" ? plugin : class {
  constructor(init) {
    this.init = init;
  }
  init;
  e;
  reply(msg, quote, data) {
    return this.e?.reply(msg, quote, data);
  }
};
var LLMChat = class extends BasePlugin {
  constructor() {
    super({
      name: "LLM\u667A\u80FD\u5BF9\u8BDD",
      dsc: "\u4E0E\u5927\u8BED\u8A00\u6A21\u578B\u8FDB\u884C\u5355\u8F6E\u4E0E\u591A\u8F6E\u667A\u80FD\u5BF9\u8BDD",
      event: "message",
      priority: 600,
      rule: [
        {
          reg: "^#?(chat|ai)\\s*([\\s\\S]*)$",
          fnc: "onChatCommand"
        },
        {
          reg: ".*",
          fnc: "onAtMessage"
        }
      ]
    });
  }
  /**
   * 通过 #chat 或 #ai 指令触发
   */
  async onChatCommand() {
    const e = this.e;
    const rawMsg = (e.msg || "").trim();
    const match = rawMsg.match(/^#?(chat|ai)\s*([\s\S]*)$/i);
    if (!match) return false;
    const query = match[2]?.trim();
    if (!query) {
      await e.reply("\u4F60\u60F3\u548C\u6211\u804A\u4E9B\u4EC0\u4E48\u5462\uFF1F\n\u4F7F\u7528\u793A\u4F8B\uFF1A#chat \u5E2E\u6211\u5199\u4E00\u6BB5 Python \u5FEB\u901F\u6392\u5E8F\u4EE3\u7801", true);
      return true;
    }
    return await this.replyLLM(e, query);
  }
  /**
   * 群聊中 @机器人 时自动触发
   */
  async onAtMessage() {
    const e = this.e;
    const cfg = config_default.get();
    if (!cfg.atReply) return false;
    const isAtBot = Boolean(e.atBot || e.atme || e.at && String(e.at) === String(e.self_id));
    if (!isAtBot) return false;
    const rawMsg = (e.msg || "").trim();
    if (/^#?(chat|ai|llm)/i.test(rawMsg)) {
      return false;
    }
    if (!rawMsg) {
      await e.reply("\u4F60\u597D\uFF01\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", true);
      return true;
    }
    return await this.replyLLM(e, rawMsg);
  }
  /**
   * 请求 LLM 并回复
   */
  async replyLLM(e, query) {
    const cfg = config_default.get();
    const reply = await askLLM(e, query);
    await e.reply(reply, cfg.replyQuote);
    return true;
  }
};

// src/apps/manage.ts
var BasePlugin2 = typeof plugin !== "undefined" ? plugin : class {
  constructor(init) {
    this.init = init;
  }
  init;
  e;
  reply(msg, quote, data) {
    return this.e?.reply(msg, quote, data);
  }
};
var LLMManage = class extends BasePlugin2 {
  constructor() {
    super({
      name: "LLM\u63D2\u4EF6\u7BA1\u7406",
      dsc: "LLM \u63D2\u4EF6\u53C2\u6570\u7BA1\u7406\u4E0E\u72B6\u6001\u67E5\u8BE2",
      event: "message",
      priority: 500,
      rule: [
        {
          reg: "^#(llm|ai|chat)(\u5E2E\u52A9|help)$",
          fnc: "help"
        },
        {
          reg: "^#(llm|ai|chat)(\u72B6\u6001|status|info)$",
          fnc: "status"
        },
        {
          reg: "^#(llm|chat|ai)(\u91CD\u7F6E|\u6E05\u9664\u8BB0\u5FC6|\u6E05\u7A7A\u8BB0\u5FC6|reset)$",
          fnc: "clearMemory"
        },
        {
          reg: "^#llm\u5207\u6362\u6A21\u578B\\s*(.+)$",
          fnc: "switchModel",
          permission: "master"
        },
        {
          reg: "^#llm\u8BBE\u7F6E\u63D0\u793A\u8BCD\\s*([\\s\\S]+)$",
          fnc: "setSystemPrompt",
          permission: "master"
        }
      ]
    });
  }
  async help() {
    const e = this.e;
    const msg = [
      "\u{1F916} === Yunzai-LLM-Plugin \u5E2E\u52A9\u6307\u5357 (TS\u7248) === \u{1F916}",
      "",
      "\u3010\u5E38\u7528\u6307\u4EE4\u3011",
      "\u2022 #chat <\u95EE\u9898>  : \u4E0E AI \u8FDB\u884C\u5BF9\u8BDD (\u652F\u6301\u591A\u8F6E\u8BB0\u5FC6)",
      "\u2022 #ai <\u95EE\u9898>    : \u7B80\u5199\u6307\u4EE4",
      "\u2022 @\u673A\u5668\u4EBA <\u5185\u5BB9> : \u7FA4\u804A\u4E2D\u76F4\u63A5\u827E\u7279\u63D0\u95EE",
      "\u2022 #\u6E05\u9664\u8BB0\u5FC6     : \u6E05\u9664\u5F53\u524D\u4F1A\u8BDD\u7684\u4E0A\u4E0B\u6587\u8BB0\u5FC6",
      "\u2022 #llm\u72B6\u6001      : \u67E5\u770B\u5F53\u524D\u6A21\u578B\u4E0E\u63D2\u4EF6\u914D\u7F6E",
      "",
      "\u3010\u4E3B\u4EBA\u7BA1\u7406\u6307\u4EE4\u3011",
      "\u2022 #llm\u5207\u6362\u6A21\u578B <\u6A21\u578B\u540D> : \u5B9E\u65F6\u5207\u6362\u4F7F\u7528\u7684\u6A21\u578B",
      "\u2022 #llm\u8BBE\u7F6E\u63D0\u793A\u8BCD <\u4EBA\u8BBE> : \u5B9E\u65F6\u4FEE\u6539 AI \u4EBA\u8BBE\u63D0\u793A\u8BCD",
      "",
      "\u914D\u7F6E\u6587\u4EF6\u8DEF\u5F84: plugins/Yunzai-LLM-Plugin/config/config.yaml"
    ].join("\n");
    await e.reply(msg, true);
    return true;
  }
  async status() {
    const e = this.e;
    const cfg = config_default.get();
    const history = memory_default.getMessages(e);
    const key = memory_default.getSessionKey(e);
    const maskedKey = cfg.apiKey ? cfg.apiKey.slice(0, 7) + "****" + cfg.apiKey.slice(-4) : "\u672A\u914D\u7F6E";
    const msg = [
      "\u{1F4CA} === Yunzai-LLM-Plugin \u8FD0\u884C\u72B6\u6001 === \u{1F4CA}",
      `\u2022 \u5F53\u524D\u6A21\u578B: ${cfg.model || "\u672A\u8BBE\u5B9A"}`,
      `\u2022 API \u7AEF\u70B9: ${cfg.apiUrl || "\u672A\u8BBE\u5B9A"}`,
      `\u2022 API \u5BC6\u94A5: ${maskedKey}`,
      `\u2022 \u751F\u6210\u6E29\u5EA6: ${cfg.temperature ?? 0.7}`,
      `\u2022 \u6700\u5927Token: ${cfg.maxTokens ?? 2048}`,
      `\u2022 \u4F1A\u8BDD\u6807\u8BC6: ${key}`,
      `\u2022 \u5F53\u524D\u4F1A\u8BDD\u8BB0\u5FC6: \u5DF2\u7F13\u5B58 ${history.length} \u6761\u5BF9\u8BDD`,
      `\u2022 \u4E0A\u4E0B\u6587\u8F6E\u6570\u4E0A\u9650: ${cfg.historyLimit} \u8F6E`
    ].join("\n");
    await e.reply(msg, true);
    return true;
  }
  async clearMemory() {
    const e = this.e;
    const cleared = memory_default.clearSession(e);
    if (cleared) {
      await e.reply("\u2728 \u5F53\u524D\u4F1A\u8BDD\u7684\u4E0A\u4E0B\u6587\u8BB0\u5FC6\u5DF2\u6E05\u7A7A\uFF0C\u5F00\u542F\u5168\u65B0\u7684\u5BF9\u8BDD\u5427\uFF01", true);
    } else {
      await e.reply("\u5F53\u524D\u4F1A\u8BDD\u6682\u65E0\u4E0A\u4E0B\u6587\u8BB0\u5FC6\uFF0C\u65E0\u9700\u6E05\u7A7A\u3002", true);
    }
    return true;
  }
  async switchModel() {
    const e = this.e;
    const match = (e.msg || "").match(/^#llm切换模型\s*(.+)$/);
    const newModel = match?.[1]?.trim();
    if (!newModel) {
      await e.reply("\u8BF7\u6307\u5B9A\u6A21\u578B\u540D\u79F0\uFF0C\u4F8B\u5982\uFF1A#llm\u5207\u6362\u6A21\u578B deepseek-chat", true);
      return true;
    }
    config_default.set("model", newModel);
    await e.reply(`\u2705 \u5DF2\u6210\u529F\u5207\u6362\u5F53\u524D\u6A21\u578B\u4E3A\uFF1A${newModel}`, true);
    return true;
  }
  async setSystemPrompt() {
    const e = this.e;
    const match = (e.msg || "").match(/^#llm设置提示词\s*([\s\S]+)$/);
    const prompt = match?.[1]?.trim();
    if (!prompt) {
      await e.reply("\u8BF7\u63D0\u4F9B\u63D0\u793A\u8BCD\u5185\u5BB9", true);
      return true;
    }
    config_default.set("systemPrompt", prompt);
    memory_default.clearSession(e);
    await e.reply("\u2705 \u7CFB\u7EDF\u63D0\u793A\u8BCD\u5DF2\u66F4\u65B0\uFF0C\u5E76\u5DF2\u91CD\u7F6E\u5F53\u524D\u5BF9\u8BDD\u8BB0\u5FC6\uFF01", true);
    return true;
  }
};

// src/index.ts
if (typeof logger !== "undefined") {
  logger.info("-----------------");
  logger.info("[Yunzai-LLM-Plugin] (TypeScript) v1.0.0 \u521D\u59CB\u5316\u6210\u529F\uFF01");
  logger.info("-----------------");
}
var apps = {
  chat: LLMChat,
  manage: LLMManage
};
export {
  LLMChat,
  LLMManage,
  apps
};
//# sourceMappingURL=index.js.map