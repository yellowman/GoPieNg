import { api, auth } from './api.js'
import { store } from './store.js'
import { mountApp } from './components.js'

const root = document.getElementById('app')

// Update body class based on auth state
function updateAuthClass() {
  if (store.user) {
    document.body.classList.remove('not-authed')
  } else {
    document.body.classList.add('not-authed')
  }
}

// Listen for store changes to update auth class
store.on(updateAuthClass)

// Resume session
const token = auth.token()
if (token) {
  try {
    const me = await api.me()
    const list = await api.networks()
    store.set({ user: me, networks: Array.isArray(list) ? list : [], browseParent: null })
  } catch(e) {
    // Invalid token - clear it
    auth.setToken('')
    store.set({ user: null })
  }
}

// Initial auth class update
updateAuthClass()

mountApp(root)


// Header wiring
;(function(){
  function initTheme(){
    const saved = localStorage.getItem('theme') || 'dark'
    document.documentElement.dataset.theme = saved
  }
  initTheme()
  
  const themeBtn = document.getElementById('themeToggle')
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const html = document.documentElement
      const next = html.dataset.theme === 'dark' ? 'light' : 'dark'
      html.dataset.theme = next
      localStorage.setItem('theme', next)
    })
  }
  
  // Network health monitoring - ping every 5 seconds
  let networkOk = true
  async function checkNetwork() {
    const banner = document.getElementById('networkBanner')
    try {
      const r = await fetch('/api/pieng/ping', { 
        method: 'GET',
        cache: 'no-store'
      })
      if (r.ok) {
        if (!networkOk) {
          networkOk = true
          if (banner) banner.classList.add('hidden')
          // Refresh data when network comes back
          if (store.user) {
            const list = await api.networks()
            store.set({ networks: Array.isArray(list) ? list : [] })
          }
        }
      } else {
        throw new Error('not ok')
      }
    } catch(e) {
      if (networkOk) {
        networkOk = false
        if (banner) banner.classList.remove('hidden')
      }
    }
  }
  checkNetwork()
  setInterval(checkNetwork, 5000)
  
  // API status indicator (uses authenticated endpoint)
  async function updateStatus() {
    const token = localStorage.getItem('pieng_token') || ''
    const s = document.getElementById('apiStatus')
    const t = document.getElementById('apiStatusText')
    if (!s || !t) return
    
    if (!token) {
      s.className = 'status'
      t.textContent = '—'
      return
    }
    try {
      const r = await fetch('/api/pieng/me', { 
        headers: { 'Authorization': 'Bearer ' + token } 
      })
      s.className = 'status ' + (r.ok ? 'ok' : 'error')
      t.textContent = r.ok ? 'ok' : 'auth'
    } catch(e) {
      s.className = 'status error'
      t.textContent = 'err'
    }
  }
  updateStatus()
  setInterval(updateStatus, 30000)
  
  // Auto-refresh data every 30 seconds to pick up changes from other users
  async function autoRefresh() {
    if (!store.user || !networkOk) return
    try {
      const list = await api.networks()
      // Only update if data changed (simple length check to avoid unnecessary re-renders)
      if (Array.isArray(list) && list.length !== store.networks?.length) {
        store.set({ networks: list })
      }
    } catch(e) {
      // Ignore errors - network check will handle connection issues
    }
  }
  setInterval(autoRefresh, 30000)

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn')
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      auth.setToken('')
      store.set({ 
        user: null, 
        networks: [], 
        selected: null, 
        browseParent: null,
        roots: [],
        parentMap: {},
        childrenMap: {},
        hosts: [],
        searchResults: []
      })
    })
  }

  // Reflect username in header when store changes
  store.on(() => {
    const u = store.user
    const badge = document.getElementById('userBadge')
    if (badge) {
      badge.textContent = u ? (u.username || 'user') : 'not signed in'
    }
    
    // Toggle admin class for showing admin-only UI
    const isAdmin = (u?.roles || []).includes('admin')
    document.body.classList.toggle('is-admin', isAdmin)
    
    updateStatus() // Update status on auth change
    
    // Update nav active state
    const currentPage = store.currentPage || 'browse'
    document.querySelectorAll('nav a[data-page]').forEach(a => {
      a.classList.toggle('active', a.dataset.page === currentPage)
    })
  })
  
  // Nav link handlers with history
  document.querySelectorAll('nav a[data-page]').forEach(link => {
    link.onclick = (e) => {
      e.preventDefault()
      const page = link.dataset.page
      // Push to history
      history.pushState({ page }, '', `#${page}`)
      // Update active state
      document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'))
      link.classList.add('active')
      // Update store
      store.set({ currentPage: page, selected: null })
    }
  })
  
  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    const page = e.state?.page || 'browse'
    document.querySelectorAll('nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.page === page)
    })
    store.set({ currentPage: page })
  })
  
  // Set initial history state
  const initialPage = location.hash.replace('#', '') || 'browse'
  history.replaceState({ page: initialPage }, '', `#${initialPage}`)
  store.set({ currentPage: initialPage })
})();
