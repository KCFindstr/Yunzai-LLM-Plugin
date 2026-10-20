import dns from 'node:dns/promises'
import net from 'node:net'

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip)
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) === (v4ToInt(base) & mask)
    })
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase()
    if (x === '::' || x === '::1') return true
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(x)
    if (mapped) return isPrivateIp(mapped[1])
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return true // hex-form mapped v4: block conservatively
    if (/^f[cd]/.test(x)) return true // fc00::/7 unique local
    if (/^fe[89ab]/.test(x)) return true // fe80::/10 link local
    if (/^ff/.test(x)) return true // multicast
    return false
  }
  return true
}

/** Throws unless the URL is http(s) and every resolved address is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('URL 不合法')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http/https')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || /^localhost$/i.test(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('禁止访问内网地址')
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true })
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('禁止访问内网地址')
  return url
}
