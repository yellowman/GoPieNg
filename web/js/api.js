// web/ui/assets/api.js
import { parseChangeIDs } from './refresh.js?v=17'
export const API = '/api/pieng'

export const auth = {
  async login(username, password){
    const r = await fetch(API+'/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    })
    if (!r.ok) throw new Error(await r.text() || r.statusText)
    return r.json()
  },
  token(){ return localStorage.getItem('pieng_token') || '' },
  setToken(t){ localStorage.setItem('pieng_token', t) }
}

function authed(opts = {}){
  const h = new Headers(opts.headers || {})
  h.set('Content-Type', 'application/json')
  const t = auth.token()
  if (t) h.set('Authorization', 'Bearer ' + t)
  return { ...opts, headers: h }
}

// Errors carry the HTTP status (0 when the request never reached the
// server), so callers can tell an expired session (401) from an outage.
async function _fetch(url, opts = {}, withHeaders = false){
  // Prevent browser caching of API responses
  opts.cache = 'no-store'
  let r
  try {
    r = await fetch(url, opts)
  } catch (e) {
    const err = new Error(e.message || 'network error')
    err.status = 0
    throw err
  }
  if (!r.ok) {
    const msg = await r.text().catch(()=> '')
    if (r.status === 401) {
      try { localStorage.removeItem('pieng_token') } catch {}
      window.dispatchEvent(new Event('pieng:unauthorized'))
    }
    const err = new Error(msg || r.statusText)
    err.status = r.status
    throw err
  }
  // Report the changelog IDs this mutation committed (see ChangeTracker)
  const own = parseChangeIDs(r.headers.get('X-Pieng-Change'))
  if (own.length) window.dispatchEvent(new CustomEvent('pieng:own-changes', { detail: own }))
  // Always try to parse as JSON first
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return withHeaders ? { data, headers: r.headers } : data
}

export const api = {
  me: () => _fetch(API+'/me', authed()),
  networks: (parent_id, q) => {
    const p = new URLSearchParams()
    if (parent_id !== undefined && parent_id !== null) p.set('parent_id', String(parent_id))
    if (q) p.set('q', q)
    return _fetch(API+'/networks?'+p.toString(), authed())
  },
  createNetwork: (cidr, description, subdivide) => _fetch(API+'/networks', authed({ method:'POST', body: JSON.stringify({ cidr, description: description || '', subdivide }) })),
  network: (id) => _fetch(API+'/networks/'+id, authed()),
  updateNetwork: (id, patch) => _fetch(API+'/networks/'+id, authed({ method:'PATCH', body: JSON.stringify(patch) })),
  deleteNetwork: (id) => _fetch(API+'/networks/'+id, authed({ method:'DELETE' })),
  hosts: (nid) => _fetch(API+`/networks/${nid}/hosts`, authed()),
  allHosts: (nid) => _fetch(API+`/networks/${nid}/hosts/all`, authed()),
  addHost: (nid, address, description, update = false) => _fetch(API+`/networks/${nid}/hosts`, authed({ method:'POST', body: JSON.stringify({ address, description, update }) })),
  delHost: (ip) => _fetch(API+`/hosts/${encodeURIComponent(ip)}`, authed({ method:'DELETE' })),
  allocHost: (nid, description) => _fetch(API+`/networks/${nid}/allocate-host`, authed({ method:'POST', body: JSON.stringify({ description: description || '' }) })),
  // Legacy auto-allocate (finds next available)
  allocSubnet: (nid, mask, description) => _fetch(API+`/networks/${nid}/allocate-subnet`, authed({ method:'POST', body: JSON.stringify({ mask, description: description || '' }) })),
  // New: get available subnets at specific mask
  // One page of free blocks: { items, total, next } (next is the cursor for
  // the following page, or null on the last page)
  availableSubnetsPage: async (nid, mask, after = null) => {
    const p = new URLSearchParams({ mask: String(mask) })
    if (after) p.set('after', after)
    const { data, headers } = await _fetch(API+`/networks/${nid}/available-subnets?`+p.toString(), authed(), true)
    return { items: Array.isArray(data) ? data : [], total: headers.get('X-Pieng-Total'), next: headers.get('X-Pieng-Next') }
  },
  // New: allocate specific subnet with subdivide option
  allocSubnetAt: (nid, cidr, description, subdivide) => _fetch(API+`/networks/${nid}/allocate-subnet`, authed({ method:'POST', body: JSON.stringify({ cidr, description: description || '', subdivide }) })),
  pingCheck: (ip) => {
    return _fetch(API+`/check-ip/${encodeURIComponent(ip)}`, authed())
      .then(result => {
        console.log('Ping check for', ip, ':', result)
        return result
      })
      .catch(e => {
        // 404 means server doesn't have -ping-check enabled
        console.log('Ping check not available:', e.message)
        return null
      })
  },
  search: (q, mode = 'hosts') => _fetch(API+`/search?q=${encodeURIComponent(q)}&mode=${mode}`, authed()),
  logs: (limit=50) => _fetch(API+`/logs?limit=${limit}`, authed()),
  // User management
  users: () => _fetch(API+'/users', authed()),
  createUser: (username, password, roles) => _fetch(API+'/users', authed({ method:'POST', body: JSON.stringify({ username, password, roles }) })),
  updateUser: (id, patch) => _fetch(API+`/users/${id}`, authed({ method:'PATCH', body: JSON.stringify(patch) })),
  deleteUser: (id) => _fetch(API+`/users/${id}`, authed({ method:'DELETE' })),
  roles: () => _fetch(API+'/roles', authed())
}
