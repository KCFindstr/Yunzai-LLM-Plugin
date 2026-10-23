import { config } from '../core/config.ts'
import { JsonStore } from '../core/store.ts'
import { truncate } from '../core/util.ts'
import { isSensitive } from '../memory/store.ts'

interface Profile {
  id: string
  name?: string
  seen: number
  /** last few things they said here, so an admin can tell who an opaque ID is */
  recent?: { t: number; text: string }[]
}
const RECENT_LINES = 5
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

/** Keep the sender's latest message (after observeUsers has recorded them). */
export function rememberMessage(event: any, text: string) {
  if (event?.self_id == null || event?.user_id == null || !text.trim() || isSensitive(text)) return
  const profile = store.data[scopeKey(event)]?.find(p => p.id === String(event.user_id))
  if (!profile) return
  profile.recent = [...(profile.recent ?? []), { t: Date.now(), text: truncate(text, 150) }].slice(-RECENT_LINES)
  store.save()
}

/** What someone said recently in one group or private chat (newest last). */
export function recentMessages(scope: string, id: string): { t: number; text: string }[] {
  return store.data[scope]?.find(p => p.id === id)?.recent ?? []
}

/** Name set in config: this group's `groups.<id>.names` first, then the global `names`. */
export function configuredName(id: string, groupId?: string | number): string | undefined {
  const c = config.get()
  return (groupId != null ? c.groups[String(groupId)]?.names?.[id] : undefined) || c.names[id] || undefined
}

/** Configured name, else the adapter's member/friend cache, else the last name seen in messages. */
export function knownName(event: any, id = String(event?.user_id)): string | undefined {
  return configuredName(id, event?.group_id) ?? cachedName(event, id) ?? store.data[scopeKey(event)]?.find(profile => profile.id === id)?.name
}

/** Everyone seen per group / private chat, for the web UI's name editor. */
export function rosterSnapshot() {
  return Object.entries(store.data).map(([key, profiles]) => {
    const [selfId, scope] = key.split(':')
    const groupId = scope.startsWith('g') ? scope.slice(1) : undefined
    const event = { self_id: selfId, group_id: groupId, user_id: groupId ? undefined : scope.slice(1) }
    return {
      key,
      selfId,
      groupId,
      people: profiles.map(p => ({
        id: p.id,
        seen: p.seen,
        observed: cachedName(event, p.id) ?? p.name,
        messages: p.recent?.length ?? 0,
        group: groupId ? config.get().groups[groupId]?.names?.[p.id] : undefined,
        global: config.get().names[p.id],
      })),
    }
  })
}

export function rosterLines(event: any, max: number): string[] {
  return (store.data[scopeKey(event)] ?? []).filter(profile => Date.now() - profile.seen < 30 * 86400_000).slice(0, max).map(profile => {
    const name = knownName(event, profile.id)
    return `${name || '称呼未知'} [at:${profile.id}]`
  })
}

/** Groups (on this bot account) where the user was seen in the last 30 days, with names when cached. */
export function groupsWithUser(selfId: string | number, userId: string | number): { id: string; name?: string }[] {
  const prefix = `${selfId}:g`
  const bot = (globalThis as any).Bot?.[selfId]
  return Object.entries(store.data)
    .filter(([key, profiles]) => key.startsWith(prefix) && profiles.some(p => p.id === String(userId) && Date.now() - p.seen < 30 * 86400_000))
    .map(([key]) => {
      const id = key.slice(prefix.length)
      const g = bot?.gl?.get?.(Number(id)) ?? bot?.gl?.get?.(id)
      return { id, name: g?.group_name ? String(g.group_name) : undefined }
    })
}
