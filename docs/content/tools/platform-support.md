---
id: platform-support
title: 平台兼容性与系统支持说明
sidebar_label: 平台支持矩阵
---

# 平台兼容性与系统支持说明

在规划您的机器人运行环境之前，请先了解不同功能模块对操作系统和运行环境的依赖情况。

---

## 平台支持矩阵

| 功能模块 | 对应工具 / 脚本 | Windows (10/11) | Linux (Ubuntu/Debian 等) | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| **基础大模型对话** | OpenAI / Anthropic / Gemini | ✅ 完全支持 | ✅ 完全支持 | 核心纯 Node.js 实现 |
| **Web 管理面板** | `http://127.0.0.1:6190` | ✅ 完全支持 | ✅ 完全支持 | 零外部二进制依赖 |
| **命令行配置** | `npm run config` | ✅ 完全支持 | ✅ 完全支持 | 纯终端交互式界面 |
| **额度控制与计费** | 5h/week 多维额度 | ✅ 完全支持 | ✅ 完全支持 | 纯 Node.js 实现 |
| **分层记忆与 3D 向量** | 摘要、Voyage 嵌入 | ✅ 完全支持 | ✅ 完全支持 | 纯 Node.js 与浏览器绘制 |
| **表情包与自然语言指令** | 视觉识别打标、分发 | ✅ 完全支持 | ✅ 完全支持 | 跨平台 |
| **联网搜索与网页抓取** | `web_search` / `web_fetch` | ✅ 完全支持 | ✅ 完全支持 | 纯网络协议请求 |
| **HTML 紧凑图片渲染** | `render_html` | ✅ 完全支持 | ✅ 完全支持 | 复用机器人内置 Chromium |
| **代码执行沙盒** ⚠️ | `run_code` (`exec-setup`) | ✅ 支持 (需 WSL2) | ❌ 暂不支持自动化安装 | 依赖 WSL2 容器与 bubblewrap |
| **持久桌面电脑使用** ⚠️ | `computer_task` (`computer-setup`) | ✅ 支持 (需 WSL2) | ❌ 暂不支持自动化安装 | 依赖 WSL2 专用发行版中的持久桌面 |
| **Google Lens 视觉搜索** ⚠️ | `google_lens` (`lens-setup`) | ✅ 支持 (需 WSL2) | ❌ 暂不支持自动化安装 | 复用持久桌面中的浏览器 |
| **RustDesk 远程桌面** ⚠️ | `rustdesk-setup` | ✅ 支持 (需 WSL2) | ❌ 暂不支持 | 在持久桌面中安装 RustDesk 客户端 |
| **AGY 宿主机代理** ⚠️ | `agy-setup` | ✅ 支持 (Windows) | ❌ 暂不支持 | 依赖 Windows 本机 CLI 与路径映射 |

---

## 为什么许多高级系统工具目前仅支持 Windows？

### 1. 依赖 Windows + WSL2
- 为了让大模型在与宿主机隔离的 Linux 环境中运行 Python/Node/Bash 脚本（接触不到宿主机的 Windows 文件），同时能操作桌面程序，高级工具采用 **Windows 宿主机 + WSL2 专用发行版** 的方案。
- 初始化脚本（如 `cli/exec-setup.mjs`、`cli/computer-setup.mjs`）依赖 Windows 的 `wsl.exe` 创建和配置专用发行版，并把 Windows 上的图片库以只读方式挂载进去。

### 2. 隔离与安全考量
- 在 Windows 环境下，大模型的代码沙盒运行在独立命名空间的 WSL 发行版中，通过 Bubblewrap 阻断对 Windows 各盘符（C盘、D盘）以及局域网端口的访问。标准 Linux VPS 的发行版差异较大，目前没有提供这种嵌套沙盒的自动安装。

---

## 建议与最佳实践

- **如果您是普通群聊运维者**：
  在 Linux 服务器（如 Ubuntu/Debian/CentOS）上部署机器人，**可以使用对话、Web 面板、表情包、多模态附件阅读、联网搜索以及全部管理功能**，只是没有上述高级工具。
- **如果您希望使用代码执行、电脑操作、Google Lens 或 AGY**：
  请将 Yunzai 部署在 **Windows 10/11** 上，并开启 WSL2（AGY 不需要 WSL2）。
