// web/ui/assets/api.js
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

async function _fetch(url, opts = {}){
  const r = await fetch(url, opts)
  if (!r.ok) {
    const msg = await r.text().catch(()=> '')
    if (r.status === 401) {
      try { localStorage.removeItem('pieng_token') } catch {}
    }
    throw new Error(msg || r.statusText)
  }
  // Always try to parse as JSON first
  const text = await r.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const api = {
  me: () => _fetch(API+'/me', authed()),
  networks: (parent_id, q) => {
    const p = new URLSearchParams()
    if (parent_id !== undefined && parent_id !== null) p.set('parent_id', String(parent_id))
    if (q) p.set('q', q)
    return _fetch(API+'/networks?'+p.toString(), authed())
  },
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
  availableSubnetsAt: (nid, mask) => _fetch(API+`/networks/${nid}/available-subnets?mask=${mask}`, authed()),
  // New: allocate specific subnet with subdivide option
  allocSubnetAt: (nid, cidr, description, subdivide) => _fetch(API+`/networks/${nid}/allocate-subnet`, authed({ method:'POST', body: JSON.stringify({ cidr, description: description || '', subdivide }) })),
  pingCheck: (ip) => _fetch(API+`/ping/${encodeURIComponent(ip)}`, authed()).catch(() => null),
  logs: (limit=50) => _fetch(API+`/logs?limit=${limit}`, authed()),
  // User management
  users: () => _fetch(API+'/users', authed()),
  createUser: (username, password, roles) => _fetch(API+'/users', authed({ method:'POST', body: JSON.stringify({ username, password, roles }) })),
  updateUser: (id, patch) => _fetch(API+`/users/${id}`, authed({ method:'PATCH', body: JSON.stringify(patch) })),
  deleteUser: (id) => _fetch(API+`/users/${id}`, authed({ method:'DELETE' })),
  roles: () => _fetch(API+'/roles', authed())
}
