---
id: webui
title: Web 可视化管理面板
sidebar_label: Web 管理面板
---

# Web 可视化管理面板

Yunzai-LLM-Plugin 自带 Web 管理面板，不用手写 YAML 或记指令，在浏览器中就能完成大部分配置和管理。

访问地址：默认监听 **`http://<服务器IP或127.0.0.1>:6190`**（默认开启 `0.0.0.0` 监听，支持远程直接访问）

---

## 📸 工作区概览

<div className="screenshot-card">
  <img src="/img/webui-overview.png" alt="仪表盘概览" />
</div>

- **核心指标卡片**：展示今日总对话轮次、今日 API 消费总额（美元）、当前默认生效模型、插件运行时间与内存占用。
- **插件总开关**：可随时暂停对话处理。
- **快捷管理入口**：直达执行记录、模型、用量与额度、异步代理、人设与配置。
- **机器人账号与维护**：查看在线账号，重载配置、刷新价格表、扫描指令。

---

## 🗂️ 核心功能模块

### 1. 模型与提供商管理 (`#/models`)
- **多提供商集中管理**：查看 OpenAI、Anthropic、Gemini、DeepSeek、Voyage 等各渠道连接状态、Base URL 与 API Key。
- **余额查询**：显示上游账户余额或 API Key 是否有效。
- **模型列表**：聊天模型、向量模型与 System One 模型分别列出，显示价格与能力标签（视觉、工具、自带搜索），可设为默认并单独测试。

### 2. 可视化配置中心 (`#/config`)
- **表单与 YAML 双模式**：
  - **表单模式**：分为「设置向导、基础、提供商、模型、人设、分群设置、群友称呼、触发方式、对话与上下文、自动思考强度、主动发言、额度、回复与风控、表情包、工具、长期记忆、技能、价格表、网页管理」，选项提供类型约束、范围检查与中文说明；相关提示直接显示在对应设置旁。
  - **config.yaml 模式**：内置代码编辑器直接修改原始 YAML，保存前按 Schema 校验，格式错误的内容不会写入。
- **热重载**：保存后立即生效，无需重启 Yunzai 机器人。

<div className="screenshot-card">
  <img src="/img/webui-setup.png" alt="设置向导（演示数据）" />
</div>

### 3. 用量与多维额度统计 (`#/usage`)
- **时间与范围筛选**：支持按今日、最近 7 天、14 天、30 天、本月或自定义时间段筛选 Token 消耗与美元支出。
- **模型消耗细分**：分模型展示未缓存输入、输出与缓存的 token 与费用。
- **额度使用进度条**：展示各模型 5 小时与 7 天额度的使用情况，以及本周花费最多的用户。

<div className="screenshot-card">
  <img src="/img/webui-usage.png" alt="用量与额度（演示数据）" />
</div>

### 4. 3D 向量空间与记忆聚类 (`#/vectors`)
- **3D PCA 投影降维视图**：将聊天历史片段的 Embedding 向量投射至可三维旋转、缩放的交互空间中。
- **语义相似度测试**：在输入框中键入任意语句，查看它在向量空间中的落点，以及语义最接近的聊天档案。

<div className="screenshot-card">
  <img src="/img/webui-vectors.png" alt="向量空间（演示数据）" />
</div>

### 5. 会话审查与记忆编辑 (`#/conversations`、`#/memory`)
- **对话**：查看群聊或私聊会话的最近对话、滚动摘要与旧聊天档案，可手动编辑、删除或重新生成摘要。
- **长期记忆**：查看与编辑机器人记住的关于群友和群的事实。
- **群友称呼 (`#/roster`)**：为平台 ID 指定称呼。

### 6. 表情包管理与工具技能
- **人设 (`#/personas`)**：编辑与切换人设。
- **表情包管理 (`#/stickers`)**：支持从电脑拖拽图片批量上传，后台由视觉模型自动识别命名并打标签，支持搜索与批量删除。
- **工具与技能目录 (`#/tools`)**：查看已注册的工具与技能。
- **定时任务 (`#/schedules`)**：分页查看进行中与已结束的定时任务，可编辑时间、重复方式和任务内容，或取消任务。
- **电脑任务 / 异步代理 (`#/computer`、`#/agy`)**：查看后台任务的状态与结果。
- **执行记录 (`#/rollouts`)**：逐轮查看大模型调用时的思考过程、工具参数输入与工具返回结果时间线。
- **实时日志 (`#/logs`)**：每 2 秒更新机器人后台日志，支持日志级别筛选与内容搜索。

<div className="screenshot-card">
  <img src="/img/webui-stickers.png" alt="表情包管理" />
</div>

<div className="screenshot-card">
  <img src="/img/webui-schedules.png" alt="定时任务列表（演示数据）" />
</div>

<div className="screenshot-card">
  <img src="/img/webui-computer-detail.png" alt="电脑任务详情（演示数据）" />
</div>

<div className="screenshot-card">
  <img src="/img/webui-rollout.png" alt="执行记录（演示数据）" />
</div>

除表情包外，本页截图均使用演示数据。

---

## 🔒 远程安全访问建议

Web 面板默认监听 `0.0.0.0:6190`，便于用户在局域网内或通过云服务器公网 IP 直接管理机器人：

1. **务必设置强密码**：建议在配置文件中设置复杂的 `web.password`，初次未设置时系统会自动随机生成并保存在 `Yunzai/data/Yunzai-LLM-Plugin/web-auth.json`。
2. **防火墙保护**：如无需外网访问，可随时将 `web.host` 改回 `127.0.0.1`，或在云服务器安全组中仅对可信 IP 开放 6190 端口。
3. **推荐使用反向代理**：公网访问建议通过 Nginx / Caddy 配置 HTTPS 证书，确保 API Key 与敏感数据在网络传输过程中的安全。
