---
id: google-lens
title: Google Lens 视觉搜索
sidebar_label: 视觉搜图 (Lens)
---

# Google Lens 视觉反向搜索

:::warning 运行环境要求
本工具复用 WSL2 持久桌面中的浏览器，**当前仅支持 Windows 操作系统**。
:::

当群友发送一张动漫截图、商品照片、植物图片并询问“这是哪部番？”、“这是什么商品？”时，纯文本大模型往往只能根据局部特征猜测。

Yunzai-LLM-Plugin 为大模型封装了 **Google Lens 反向以图搜图工具**。

---

## 工作机制

1. **直接关联附件库**：
   群友发送的图片自动进入 `/work/attachments/<会话>/` 只读图库。大模型调用 `google_lens` 工具时传入图片标注中的路径，只能使用当前对话的图片，无需上传至公开图床。
2. **桌面浏览器上传**：
   在持久桌面的浏览器中把图片上传到 Google 图片 / Lens，使用通过 RustDesk 登录的 Google 账号。
3. **结果提取与过滤**：
   返回 Google 的 AI 概览（如有）、完全匹配链接（最多 3 个）与视觉匹配链接（最多 20 个），经过隐私过滤后交给大模型；Cookie、账号信息与截图不会进入结果。
4. **最终综合解答**：
   大模型核对搜图线索后，以自己的口吻回答来源作品或商品型号。每次回复最多搜索两次；遇到 Google 验证时返回失败，需在桌面中手动完成验证。

---

## 安装命令 (Windows)

先按 [电脑使用](/tools/computer-use) 安装持久桌面（不需要开启 `tools.computer`），再安装 Lens 浏览器依赖：

```bash
cd plugins/Yunzai-LLM-Plugin
npm run lens-setup -- --distro yunzai-llm-sandbox
```

在配置中将 `tools.googleLens.enable` 设为 `true` 即可启用（`access` 默认仅管理员）。
