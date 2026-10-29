---
id: quickstart
title: 快速安装
sidebar_label: 快速安装
---

# 快速安装与启动

本文档为普通机器人运维者和用户提供安装步骤。插件预编译产物已包含在仓库中，无需开发者编译环境。

## 环境要求

| 依赖项 | 推荐版本 | 说明 |
| :--- | :--- | :--- |
| **Node.js** | **≥ 22.13** | **必备**。插件底层依赖 Node 内置的 `node:sqlite` 原生数据库支持，低于 22.13 版本将无法运行。 |
| **包管理器** | **pnpm** (推荐) 或 npm | 用于安装运行依赖。 |
| **机器人框架** | **TRSS-Yunzai** / **Miao-Yunzai** | 兼容各种主流适配器（NapCat、QQBot、OneBot 等）。 |
| **操作系统** | **Windows 10/11** 或 **Linux** | 基础聊天与 Web 面板跨平台支持；若需要代码沙盒与电脑使用等工具，需使用 **Windows + WSL2**。 |

---

## 安装步骤

### 第一步：克隆插件到 Yunzai 插件目录

打开命令行终端，进入你的 Yunzai-Bot 根目录：

```bash
# 进入 Yunzai 的 plugins 目录
cd plugins

# 克隆插件仓库
git clone https://github.com/KCFindstr/Yunzai-LLM-Plugin.git Yunzai-LLM-Plugin

# 返回机器人根目录
cd ..
```

### 第二步：安装必要运行依赖

在 Yunzai-Bot 根目录下执行：

```bash
pnpm install
```

:::note 为什么在根目录运行？
Yunzai-Bot 会自动扫描所有 `plugins/**` 插件并安装基础依赖。由于插件内已携带预编译的 JavaScript 文件（位于 `dist/index.js`），因此**不需要**运行任何 TypeScript 编译命令，直接启动即可生效。
:::

### 第三步：启动或重启机器人

启动你的 Yunzai-Bot：

```bash
# 使用常规 node 启动
node .

# 或使用 pm2 守护进程
pnpm start
```

机器人启动时，你会在日志中看到类似如下输出（首次启动会附带自动生成的密码，同时保存在 `Yunzai/data/Yunzai-LLM-Plugin/web-auth.json`）：

```text
网页管理面板：http://<地址>:6190  初始密码：xxxxxxxx（可在 web.password 修改）
```

恭喜！插件已成功安装并启动！接下来请前往 [首次配置与密钥设置](/getting-started/first-configuration) 完成你的第一个大模型接入。
