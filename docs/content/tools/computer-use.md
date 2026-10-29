---
id: computer-use
title: 持久桌面与电脑使用 (Computer Use)
sidebar_label: 电脑使用
---

# 持久桌面与电脑使用 (Computer Use)

:::warning 运行环境要求
本功能运行在 WSL2 专用发行版的持久桌面中，**当前仅支持 Windows 操作系统**。
:::

Yunzai-LLM-Plugin 可以给大模型配备一台**独立的持久虚拟电脑**（不是宿主机的 Windows 桌面）。

用户在 QQ 群里对机器人说一句：
> “截一张你的桌面给我看看”
> “去哔哩哔哩搜索一个原神纳西妲的最新攻略视频”
> “帮我打开计算器算一下这组数据的方差”

机器人会先以人设口吻确认，然后由后台的电脑代理自主移动鼠标、敲击键盘、截图观察；完成后结果交回原来的聊天模型，由它整理回复并附上截图。等待期间正常聊天不受影响。

---

## 架构与核心流程

1. **独立桌面**：
   桌面运行在专用 WSL 发行版中，不影响宿主机用户的日常使用，不会抢夺宿主机的鼠标键盘。
2. **异步后台委派 (Background Delegation)**：
   对话模型先返回确认语，再把任务交给专用电脑代理（可用 `tools.computer.model` 指定独立模型），任务在全局队列中依次执行。
3. **行动观察闭环 (Action-Observation Loop)**：
   桌面代理采取“截图 → 定位坐标 → 点击/键入 → 再次截图校验结果”的循环，直至任务完成或达到 `maxSteps` / `maxMinutes` 等上限。
4. **RustDesk 远程观看与控制**：
   可通过 RustDesk 连接该桌面，围观模型操作，或在需要时接管鼠标键盘（例如登录账号）。

---

## 部署与配置步骤 (Windows)

在 Windows 终端中运行：

```bash
cd plugins/Yunzai-LLM-Plugin

# 1. 创建并配置专用发行版（已有时省略 --install）
npm run exec-setup -- --install --distro yunzai-llm-sandbox

# 2. 安装持久桌面环境与必要组件
npm run computer-setup -- --distro yunzai-llm-sandbox

# 3. (可选) 安装 RustDesk 远程连接支持
npm run rustdesk-setup -- --distro yunzai-llm-sandbox
```

在 Web 面板「配置 → 工具」中开启 `tools.computer` 并设置步数上限，然后重启机器人。
