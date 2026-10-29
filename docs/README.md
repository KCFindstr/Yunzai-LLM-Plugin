# Yunzai-LLM-Plugin 文档网站 (Docusaurus)

本项目文档网站完全封装在 `docs/` 目录中，与 Yunzai 机器人本体的运行依赖完全隔离。

## 本地启动与预览文档

若您需要本地编辑、预览或构建静态文档网站：

```bash
# 1. 进入 docs 目录
cd docs

# 2. 安装文档专属依赖
npm install
# 或者
pnpm install

# 3. 启动本地开发实时预览服务器
npm run start
# 浏览器将自动打开 http://localhost:3000

# 4. 构建静态 HTML 网站文件
npm run build
```

静态编译后的网页产物将生成在 `docs/build/` 目录中，可直接部署至 GitHub Pages、Cloudflare Pages 或 Vercel。
