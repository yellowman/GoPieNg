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
  
  // API status ping
  async function ping() {
    const token = localStorage.getItem('pieng_token') || ''
    if (!token) {
      const s = document.getElementById('apiStatus')
      const t = document.getElementById('apiStatusText')
      if (s && t) { 
        s.className = 'status' 
        t.textContent = '—' 
      }
      return
    }
    try {
      const r = await fetch('/api/pieng/me', { 
        headers: { 'Authorization': 'Bearer ' + token } 
      })
      const s = document.getElementById('apiStatus')
      const t = document.getElementById('apiStatusText')
      if (s && t) { 
        s.className = 'status ' + (r.ok ? 'ok' : 'error')
        t.textContent = r.ok ? 'ok' : 'auth'
      }
    } catch(e) {
      const s = document.getElementById('apiStatus')
      const t = document.getElementById('apiStatusText')
      if (s && t) { 
        s.className = 'status error'
        t.textContent = 'err'
      }
    }
  }
  ping()
  setInterval(ping, 30000)

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
    
    ping() // Update status on auth change
    
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
