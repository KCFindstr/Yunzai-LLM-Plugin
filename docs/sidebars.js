// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: '项目概览',
    },
    {
      type: 'category',
      label: '🚀 快速入门',
      collapsed: false,
      items: [
        'getting-started/quickstart',
        'getting-started/first-configuration',
        'getting-started/commands',
      ],
    },
    {
      type: 'category',
      label: '🧠 模型与提供商',
      collapsed: false,
      items: [
        'models/providers',
        'models/quota-billing',
        'models/thinking',
      ],
    },
    {
      type: 'category',
      label: '🎛️ 管理与配置',
      collapsed: false,
      items: [
        'management/webui',
        'management/cli-config',
      ],
    },
    {
      type: 'category',
      label: '✨ 核心特色特性',
      collapsed: false,
      items: [
        'features/persona-markdown',
        'features/memory-vectors',
        'features/stickers',
        'features/nl-to-commands',
      ],
    },
    {
      type: 'category',
      label: '🛠️ 工具与高级环境',
      collapsed: false,
      items: [
        'tools/overview',
        'tools/platform-support',
        'tools/run-code',
        'tools/computer-use',
        'tools/google-lens',
        'tools/agy',
      ],
    },
    {
      type: 'category',
      label: '📚 技术参考与说明',
      collapsed: true,
      items: [
        'technical/rollouts',
        'technical/gemini-caching',
        'technical/implementation',
        'technical/faq',
      ],
    },
  ],
};

module.exports = sidebars;
