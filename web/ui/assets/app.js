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
  
  // Network health monitoring and change detection - poll every 5 seconds
  let networkOk = true
  let lastKnownChange = null
  
  // Call this after user-initiated changes to prevent auto-refresh from re-rendering
  window.syncLastChange = async () => {
    try {
      const r = await fetch('/api/pieng/ping', { cache: 'no-store' })
      if (r.ok) {
        const data = await r.json()
        if (data.last_change) lastKnownChange = data.last_change
      }
    } catch(e) {}
  }
  
  async function checkNetwork() {
    const banner = document.getElementById('networkBanner')
    try {
      const r = await fetch('/api/pieng/ping', { 
        method: 'GET',
        cache: 'no-store'
      })
      if (r.ok) {
        const data = await r.json()
        const wasOffline = !networkOk
        
        // Network is back
        if (!networkOk) {
          networkOk = true
          if (banner) banner.classList.add('hidden')
        }
        
        // Check if data changed or network just came back (refresh if logged in)
        if (store.user) {
          const shouldRefresh = wasOffline || 
            (data.last_change && lastKnownChange !== null && data.last_change !== lastKnownChange)
          
          if (shouldRefresh) {
            try {
              const list = await api.networks()
              const newNetworks = Array.isArray(list) ? list : []
              // Only update if data actually changed AND we're not mid-search
              // (search adds children to store.networks which would differ from root-only fetch)
              const searchActive = window.searchState && window.searchState.matches && window.searchState.matches.length > 0
              if (!searchActive && JSON.stringify(newNetworks) !== JSON.stringify(store.networks || [])) {
                store.set({ networks: newNetworks })
              }
            } catch(e) {
              // Ignore refresh errors
            }
          }
          
          if (data.last_change) {
            lastKnownChange = data.last_change
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
    const roles = u?.roles || []
    const isAdmin = roles.includes('administrator')
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
  
  // Global search wiring
  const searchInput = document.getElementById('searchInput')
  const searchInfo = document.getElementById('searchInfo')
  const searchPrev = document.getElementById('searchPrev')
  const searchNext = document.getElementById('searchNext')
  const searchToggle = document.getElementById('searchToggle')
  
  // Search state - exposed globally for components.js
  window.searchState = {
    mode: 'hosts',
    matches: [],
    matchIndex: -1,
    lastQuery: '',  // Track what was last searched
    searching: false  // Prevent concurrent searches
  }
  
  let navDebounce = null
  
  // Parse IP address to comparable number (supports IPv4)
  function ipToNum(ip) {
    if (!ip) return 0
    // Extract IP from CIDR if present
    const addr = ip.split('/')[0]
    const parts = addr.split('.')
    if (parts.length !== 4) return 0
    // Use multiplication instead of bitwise to avoid signed int issues
    return parseInt(parts[0]) * 16777216 + parseInt(parts[1]) * 65536 + 
           parseInt(parts[2]) * 256 + parseInt(parts[3])
  }
  
  // Sort search results by IP address to match tree order
  function sortResultsByIP(results) {
    return results.sort((a, b) => {
      const ipA = a.type === 'network' ? a.address_range : a.address
      const ipB = b.type === 'network' ? b.address_range : b.address
      return ipToNum(ipA) - ipToNum(ipB)
    })
  }
  
  async function doSearch() {
    const st = window.searchState
    if (st.searching) return  // Already searching
    
    const q = searchInput.value.trim()
    st.matches = []
    st.matchIndex = -1
    st.lastQuery = q
    
    if (!q || q.length < 2) {
      searchInfo.textContent = q.length === 1 ? '...' : ''
      return
    }
    
    searchInfo.textContent = '...'
    st.searching = true
    
    try {
      const result = await api.search(q, st.mode)
      st.matches = sortResultsByIP(result.results || [])
      
      if (st.matches.length === 0) {
        searchInfo.textContent = '0'
      } else {
        st.matchIndex = 0
        searchInfo.textContent = `1/${st.matches.length}`
        if (window.goToSearchMatch) window.goToSearchMatch()
      }
    } catch(e) {
      searchInfo.textContent = 'err'
      console.error('Search error:', e)
    } finally {
      st.searching = false
    }
  }
  
  function navigateSearch(dir) {
    const st = window.searchState
    const currentQuery = searchInput.value.trim()
    
    // If searching, ignore
    if (st.searching) return
    
    // If query changed, do a new search
    if (currentQuery !== st.lastQuery) {
      doSearch()
      return
    }
    
    // No results, trigger search
    if (st.matches.length === 0) {
      doSearch()
      return
    }
    
    // Update index immediately (mash-friendly)
    st.matchIndex = (st.matchIndex + dir + st.matches.length) % st.matches.length
    searchInfo.textContent = `${st.matchIndex + 1}/${st.matches.length}`
    
    // Debounce the actual navigation (which makes API calls)
    clearTimeout(navDebounce)
    navDebounce = setTimeout(() => {
      if (window.goToSearchMatch) window.goToSearchMatch()
    }, 200)
  }
  
  // Toggle between hosts and networks mode
  searchToggle.onclick = () => {
    const st = window.searchState
    clearTimeout(navDebounce)
    if (st.mode === 'hosts') {
      st.mode = 'networks'
      searchToggle.classList.add('networks')
      searchInput.placeholder = 'search networks'
    } else {
      st.mode = 'hosts'
      searchToggle.classList.remove('networks')
      searchInput.placeholder = 'search hosts'
    }
    // Clear current results when mode changes
    st.matches = []
    st.matchIndex = -1
    st.lastQuery = ''
    st.searching = false
    searchInfo.textContent = ''
  }
  
  searchPrev.onclick = () => navigateSearch(-1)
  searchNext.onclick = () => navigateSearch(1)
  
  searchInput.onkeydown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      navigateSearch(-1)
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      navigateSearch(1)
    } else if (e.key === 'Escape') {
      clearTimeout(navDebounce)
      searchInput.value = ''
      window.searchState.matches = []
      window.searchState.matchIndex = -1
      window.searchState.lastQuery = ''
      window.searchState.searching = false
      searchInfo.textContent = ''
      // Clear highlights
      document.querySelectorAll('.search-match, .search-match-host').forEach(el => {
        el.classList.remove('search-match', 'search-match-host')
      })
    }
  }
})();
