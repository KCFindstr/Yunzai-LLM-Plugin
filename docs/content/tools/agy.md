---
id: agy
title: AGY 宿主机异步代理
sidebar_label: AGY 异步代理
---

# AGY 宿主机异步代理

:::warning 运行环境要求
本工具直接调用 Windows 本机 Antigravity 宿主机 CLI，**当前仅支持 Windows 操作系统**。
:::

**AGY** 是面向管理员的高权限代理工具。不同于隔离运行的 `run_code` 和 `computer_task` 沙盒，AGY 拥有**宿主机的真实运行环境与全盘读写权限**。

---

## 核心设计与安全防护

- **异步任务模式**：
  大模型触发复杂任务时（例如：“在宿主机上编译最新的 WebUI 代码并打包”），先回复确认，系统在后台启动 AGY 执行。任务完成后由聊天模型以原会话的口吻总结结果。
- **权限门禁 (`admins`)**：
  默认情况下，AGY 工具**仅限机器人管理员**触发。在 Web 面板中若尝试将其开放给全员，系统会弹出高危警告，提示等同于将这台电脑的完整 Shell 权限公开展露。
- **免 WSL 依赖**：
  AGY 使用原生 Antigravity CLI（`--sandbox` 加 turbo 模式，自动批准所有工具请求），继承运行机器人的 Windows 账号的环境与登录，不需要 WSL2。插件不额外限制它的文件、命令或网络访问。

---

## 部署与安装 (Windows)

在插件目录运行：

```bash
cd plugins/Yunzai-LLM-Plugin
npm run agy-setup
```

脚本会把 CLI 安装到 `Yunzai/resources/Yunzai-LLM-Plugin/agy-setup/agy.exe`（已存在时跳过，并校验 SHA-512）。然后用运行机器人的同一个 Windows 账号登录 Antigravity，在配置中开启 `tools.agy.enable`。
