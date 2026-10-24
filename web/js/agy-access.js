import { h } from './ui.js'

export const AGY_ACCESS_WARNING = 'AGY 在宿主机以 sandbox + turbo 模式运行，所有工具请求自动批准。开放给所有人意味着任何可调用机器人的用户都能通过 AGY 完整访问这台机器的文件、命令、网络和登录账号。此模式不提供机器人 VM 隔离。'

/** Keep the warning visible as soon as all-user access is selected, before it is saved. */
export function agyAccessWarning() {
  return h('div', { class: 'notice warn', role: 'alert', 'data-agy-access-warning': '', style: { whiteSpace: 'normal' } }, AGY_ACCESS_WARNING)
}
