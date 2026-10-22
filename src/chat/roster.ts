import { JsonStore } from '../core/store.ts'
import { truncate } from '../core/util.ts'
import { renderMemory } from '../memory/store.ts'

interface Profile { id: string; name?: string; seen: number }
const store = new JsonStore<Record<string, Profile[]>>('recent-users.json', {})
const scopeKey = (event: any) => `${event.self_id}:${event.group_id != null ? `g${event.group_id}` : `p${event.user_id}`}`

function realName(value: unknown, id: string): string | undefined {
  const text = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim()
  return text && text !== id && !/^\d+$/.test(text) ? truncate(text, 40) : undefined
}

function cachedName(event: any, id: string): string | undefined {
  const bot = event.bot ?? globalThis.Bot?.[event.self_id]
  const members = bot?.gml?.get?.(event.group_id) ?? bot?.gml?.get?.(String(event.group_id))
  const profile = members?.get?.(id) ?? members?.get?.(Number(id)) ?? bot?.fl?.get?.(id) ?? bot?.fl?.get?.(Number(id))
  return realName(profile?.card, id) ?? realName(profile?.nickname, id)
}

export function observeUsers(event: any) {
  if (event?.self_id == null || event?.user_id == null) return
  const key = scopeKey(event)
  const profiles = store.data[key] ??= []
  const observe = (id: string, name?: string) => {
    if (!id || id === 'all' || id === String(event.self_id)) return
    let profile = profiles.find(entry => entry.id === id)
    if (!profile) profiles.push(profile = { id, seen: Date.now() })
    profile.name = realName(name, id) ?? cachedName(event, id) ?? profile.name
    profile.seen = Date.now()
  }
  observe(String(event.user_id), realName(event.sender?.card, String(event.user_id)) ?? event.sender?.nickname)
  for (const segment of event.message ?? []) {
    const data = segment?.data ?? segment
    if (segment?.type === 'at' && data.qq != null) observe(String(data.qq), data.name)
  }
  store.data[key] = profiles.filter(profile => Date.now() - profile.seen < 30 * 86400_000).sort((left, right) => right.seen - left.seen).slice(0, 100)
  const scopes = Object.keys(store.data)
  if (scopes.length > 300) {
    scopes.sort((left, right) => (store.data[right][0]?.seen ?? 0) - (store.data[left][0]?.seen ?? 0))
    for (const old of scopes.slice(300)) delete store.data[old]
  }
  store.save()
}

export function knownName(event: any, id = String(event?.user_id)): string | undefined {
  return cachedName(event, id) ?? store.data[scopeKey(event)]?.find(profile => profile.id === id)?.name
}

export function rosterLines(event: any, max: number, memory = false): string[] {
  return (store.data[scopeKey(event)] ?? []).filter(profile => Date.now() - profile.seen < 30 * 86400_000).slice(0, max).map(profile => {
    const name = knownName(event, profile.id)
    const facts = memory && profile.id === String(event.user_id) ? renderMemory('user', profile.id).slice(-2).map(fact => truncate(fact, 100)).join('；') : ''
    return `${name || '称呼未知'} [at:${profile.id}]${facts ? `：${facts}` : ''}`
  })
}
