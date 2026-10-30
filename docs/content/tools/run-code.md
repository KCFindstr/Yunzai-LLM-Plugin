---
id: run-code
title: 代码沙盒执行 (run_code)
sidebar_label: 代码沙盒
---

# 安全代码执行沙盒 (`run_code`)

:::warning 运行环境要求
本功能基于 Windows + WSL2 容器沙盒技术，**当前仅支持 Windows 操作系统**。Linux 环境下此工具默认隐藏不可用。
:::

大模型经常遇到复杂的数学运算、数据分析、图表绘制、或者解方程任务。大模型心算容易算错，编写并执行真实代码则可靠得多。

Yunzai-LLM-Plugin 为大模型配备了安全隔离的 `run_code` 工具。

---

## 安全隔离机制

- **专属 WSL 发行版**：运行在独立的专用 Linux 子系统内，不要使用个人开发用的发行版。
- **Bubblewrap 沙盒**：
  - 时间（`timeout`）、内存（`memoryMB`）与磁盘（`diskMB`）上限。
  - **看不到 Windows 磁盘**：沙盒内部看不到 Windows 的 `C:\`、`D:\` 盘，也看不到 Yunzai 机器人源码和敏感的 API Key。
  - **禁止访问内网**：只允许访问公网，阻断对局域网与本机私有端口的访问。
- **只读图片库**：代码可以直接读取本对话的图片（只读挂载）。代码只返回 stdout / stderr 与退出状态；生成的文件需由代码打印路径，模型再用 `send_image` 或 `read_file` 使用。

---

## 安装与启用步骤 (Windows)

1. 确保系统已启用 WSL2：
   ```powershell
   wsl --version
   ```
2. 进入插件目录并执行安装脚本：
   ```bash
   cd plugins/Yunzai-LLM-Plugin
   npm run exec-setup -- --install
   ```
   脚本将下载 Ubuntu 并导入为专用 WSL 发行版（默认 `yunzai-llm-sandbox`）。已有专用发行版时省略 `--install`。
3. 在 Web 管理面板或 `config.yaml` 中启用：
   ```yaml
   tools:
     exec:
       enable: true
       access: admin   # admin (仅管理员可用) 或 all (允许所有群友调用)
       languages: [python, node, bash]
   ```
