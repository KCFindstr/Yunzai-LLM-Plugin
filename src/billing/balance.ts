import { resolveKeys } from '../core/config.ts'
import type { ProviderConfig } from '../core/configTypes.ts'
import { joinUrl } from '../llm/http.ts'

async function getJson(url: string, key: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function guessKind(p: ProviderConfig): ProviderConfig['balance'] {
  if (p.balance) return p.balance
  const u = p.baseUrl ?? ''
  if (/deepseek\.com/i.test(u)) return 'deepseek'
  if (/openrouter\.ai/i.test(u)) return 'openrouter'
  if (/moonshot\.(cn|ai)/i.test(u)) return 'moonshot'
  if (/siliconflow\.(cn|com)/i.test(u)) return 'siliconflow'
  return 'none'
}

/** Query the provider's balance/credit API. Returns a one-line summary or undefined if unsupported. */
export async function queryBalance(p: ProviderConfig): Promise<string | undefined> {
  const key = resolveKeys(p.apiKey)[0]
  if (!key) return '未配置 Key'
  const kind = guessKind(p)
  const origin = (() => {
    try {
      return new URL(p.baseUrl ?? '').origin
    } catch {
      return ''
    }
  })()
  switch (kind) {
    case 'deepseek': {
      const j = await getJson(joinUrl(origin || 'https://api.deepseek.com', 'user/balance'), key)
      const infos = (j?.balance_infos ?? []).map((b: any) => `${b.total_balance} ${b.currency}`)
      return `${j?.is_available ? '可用' : '不可用'} 余额 ${infos.join(' / ') || '-'}`
    }
    case 'openrouter': {
      const j = await getJson('https://openrouter.ai/api/v1/key', key)
      const d = j?.data ?? {}
      const lim = d.limit != null ? ` / 限额 $${d.limit}（剩余 $${d.limit_remaining ?? '-'}）` : ''
      return `已用 $${Number(d.usage ?? 0).toFixed(4)}${lim}`
    }
    case 'moonshot': {
      const j = await getJson(joinUrl(p.baseUrl || 'https://api.moonshot.cn/v1', 'users/me/balance'), key)
      const d = j?.data ?? {}
      return `可用余额 ¥${d.available_balance ?? '-'}（现金 ¥${d.cash_balance ?? '-'}，代金券 ¥${d.voucher_balance ?? '-'}）`
    }
    case 'siliconflow': {
      const j = await getJson(joinUrl(origin || 'https://api.siliconflow.cn', 'v1/user/info'), key)
      const d = j?.data ?? {}
      return `余额 ¥${d.totalBalance ?? d.balance ?? '-'}`
    }
    default:
      return undefined
  }
}
