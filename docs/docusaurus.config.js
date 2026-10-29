// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Yunzai-LLM-Plugin 文档',
  tagline: '为 TRSS-Yunzai / Miao-Yunzai 打造的高性能大模型对话插件',
  favicon: 'img/favicon.png',

  // 部署时的网站基础 URL
  url: 'https://yunzai-llm-plugin.js.org',
  baseUrl: '/',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: 'content',
          routeBasePath: '/', // 直接以根路径作为文档主页
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: undefined,
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/webui-overview.png',
      navbar: {
        title: 'Yunzai-LLM-Plugin',
        logo: {
          alt: 'Yunzai LLM Logo',
          src: 'img/favicon.png',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: '文档中心',
          },
          {
            to: '/getting-started/quickstart',
            position: 'left',
            label: '快速安装',
          },
          {
            to: '/models/providers',
            position: 'left',
            label: '模型配置',
          },
          {
            to: '/management/webui',
            position: 'left',
            label: 'Web 面板',
          },
          {
            to: '/tools/platform-support',
            position: 'left',
            label: '平台支持',
          },
          {
            href: 'https://github.com/KCFindstr/Yunzai-LLM-Plugin',
            label: 'GitHub 仓库',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: '入门与核心',
            items: [
              {
                label: '快速开始',
                to: '/getting-started/quickstart',
              },
              {
                label: '配置与密钥',
                to: '/getting-started/first-configuration',
              },
              {
                label: '指令列表',
                to: '/getting-started/commands',
              },
            ],
          },
          {
            title: '功能与进阶',
            items: [
              {
                label: '多协议模型支持',
                to: '/models/providers',
              },
              {
                label: '额度与计费控制',
                to: '/models/quota-billing',
              },
              {
                label: 'Web 管理面板',
                to: '/management/webui',
              },
              {
                label: '进阶工具环境 (WSL2/Windows)',
                to: '/tools/platform-support',
              },
            ],
          },
          {
            title: '生态与社区',
            items: [
              {
                label: 'TRSS-Yunzai',
                href: 'https://github.com/TimeRainStarSky/Yunzai',
              },
              {
                label: 'Miao-Yunzai',
                href: 'https://gitee.com/yoimiya-kokomi/Miao-Yunzai',
              },
              {
                label: 'GitHub 源码',
                href: 'https://github.com/KCFindstr/Yunzai-LLM-Plugin',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Yunzai-LLM-Plugin. Built with Docusaurus.`,
      },
      prism: {
        theme: require('prism-react-renderer').themes.github,
        darkTheme: require('prism-react-renderer').themes.dracula,
        additionalLanguages: ['bash', 'yaml', 'json', 'powershell', 'markdown'],
      },
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
    }),
};

module.exports = config;
