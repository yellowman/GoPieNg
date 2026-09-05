// A change is acknowledged only after its snapshot has been applied. Skipping
// a refresh during editing/search must not silently consume that change.
export class ChangeTracker {
  constructor() { this.applied = null }
  needsRefresh(version) { return Number.isSafeInteger(version) && version >= 0 && version !== this.applied }
  acknowledge(version) { if (Number.isSafeInteger(version) && version >= 0) this.applied = version }
}

export function withoutDescendants(networks, parentId) {
  const remove = new Set([parentId])
  let changed = true
  while (changed) {
    changed = false
    for (const n of networks) {
      if (remove.has(n.parent) && !remove.has(n.id)) { remove.add(n.id); changed = true }
    }
  }
  remove.delete(parentId)
  return networks.filter(n => !remove.has(n.id))
}

function addressValue(cidr) {
  const address = String(cidr || '').split('/')[0]
  const v4 = value => {
    const parts = value.split('.')
    if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) throw new Error('invalid IPv4')
    return parts.reduce((v, p) => (v << 8n) | BigInt(p), 0n)
  }
  if (!address.includes(':')) return { family: 4, value: v4(address) }
  let text = address
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':')
    const tail = v4(text.slice(cut + 1))
    text = text.slice(0, cut + 1) + (tail >> 16n).toString(16) + ':' + (tail & 65535n).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) throw new Error('invalid IPv6')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) throw new Error('invalid IPv6')
  const words = [...head, ...Array(missing).fill('0'), ...tail]
  if (words.some(w => !/^[0-9a-fA-F]{1,4}$/.test(w))) throw new Error('invalid IPv6')
  return { family: 6, value: words.reduce((v, w) => (v << 16n) | BigInt('0x' + w), 0n) }
}

export function compareAddresses(a, b) {
  try {
    const left = addressValue(a), right = addressValue(b)
    if (left.family !== right.family) return left.family - right.family
    if (left.value !== right.value) return left.value < right.value ? -1 : 1
    return Number(String(a).split('/')[1] || 0) - Number(String(b).split('/')[1] || 0)
  } catch {
    return String(a || '').localeCompare(String(b || ''))
  }
}
