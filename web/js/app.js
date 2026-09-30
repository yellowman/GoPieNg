import { ChangeTracker, compareAddresses } from './refresh.js'
import { api, auth } from './api.js'
import { store } from './store.js'
import { mountApp, setResetScroll } from './components.js'
import { icon, hydrateIcons } from './icons.js'

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


// Shell wiring: sidebar, toolbar, search
;(function(){
  hydrateIcons()

  const shell = document.getElementById('shell')
  const sidebar = document.getElementById('sidebar')
  const scrim = document.getElementById('drawerScrim')
  const menuBtn = document.getElementById('menuBtn')
  const workspace = document.querySelector('.workspace')

  function stored(key){ try { return localStorage.getItem(key) } catch(e) { return null } }
  function storeKey(key, value){ try { localStorage.setItem(key, value) } catch(e) {} }

  // Theme
  const themeBtn = document.getElementById('themeToggle')
  function applyTheme(theme){
    document.documentElement.dataset.theme = theme
    const next = theme === 'dark' ? 'light' : 'dark'
    document.getElementById('themeIcon').replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'))
    document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light'
    themeBtn.setAttribute('aria-label', `Switch to ${next} theme`)
    themeBtn.title = `Switch to ${next} theme`
  }
  applyTheme(stored('theme') || 'dark')
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    storeKey('theme', next)
  })

  // Sidebar: expanded / collapsed (desktop), drawer (mobile)
  const mobile = window.matchMedia('(max-width: 768px)')
  function setCollapsed(collapsed, remember){
    shell.classList.toggle('collapsed', collapsed)
    brandBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Browse networks')
    brandBtn.title = collapsed ? 'Expand sidebar' : ''
    if (remember) storeKey('sidebar', collapsed ? 'collapsed' : 'expanded')
  }
  const brandBtn = document.getElementById('brandBtn')
  const savedSidebar = stored('sidebar')
  setCollapsed(savedSidebar ? savedSidebar === 'collapsed' : (window.innerWidth <= 1024 && !mobile.matches), false)
  document.getElementById('sidebarCollapse').addEventListener('click', () => {
    setCollapsed(true, true)
    brandBtn.focus()
  })
  brandBtn.addEventListener('click', () => {
    if (shell.classList.contains('collapsed') && !mobile.matches) {
      setCollapsed(false, true)
      return
    }
    goTo('browse')
  })

  function setDrawer(open){
    shell.classList.toggle('drawer-open', open)
    scrim.hidden = !open
    menuBtn.setAttribute('aria-expanded', String(open))
    // Overlay drawer: nothing behind the scrim is focusable while it is open
    workspace.inert = open
    if (open) {
      sidebar.querySelector('.nav-row')?.focus()
    } else if (sidebar.contains(document.activeElement)) {
      menuBtn.focus()
    }
  }
  menuBtn.addEventListener('click', () => setDrawer(!shell.classList.contains('drawer-open')))
  scrim.addEventListener('click', () => setDrawer(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell.classList.contains('drawer-open')) setDrawer(false)
  })
  mobile.addEventListener('change', () => setDrawer(false))

  // Server state: 'ok' | 'error' | '' (unknown / signed out)
  const statusEl = document.getElementById('apiStatus')
  const statusText = document.getElementById('apiStatusText')
  function setServerState(state, text){
    statusEl.className = 'sidebar-status' + (state ? ' ' + state : '')
    statusText.textContent = text
    statusEl.title = text
  }

  // Network health monitoring and change detection - poll every 5 seconds
  let networkOk = true
  const changes = new ChangeTracker()
  let checkingNetwork = false
  
  // Call this after a successful user-initiated mutation. Read back the
  // server's change marker and acknowledge that exact version so the normal
  // poll does not rebuild the tree a few seconds later.
  let suppressRefreshUntil = 0
  window.syncLastChange = async () => {
    suppressRefreshUntil = Date.now() + 10000
    try {
      const r = await fetch('/api/pieng/ping', {
        method: 'GET',
        cache: 'no-store'
      })
      if (r.ok) {
        const data = await r.json()
        changes.acknowledge(data.last_change)
      }
    } catch(e) {
      // Leave the normal poll to reconcile the data if synchronization fails.
    } finally {
      suppressRefreshUntil = Date.now() + 1000
    }
  }
  window.addEventListener('pieng:unauthorized', () => {
    store.set({ user: null, networks: [] })
  })

  async function checkNetwork() {
    if (checkingNetwork) return
    checkingNetwork = true
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
          updateStatus()
        }
        
        // Check if data changed or network just came back (refresh if logged in)
        if (store.user) {
          const shouldRefresh = wasOffline || 
            changes.needsRefresh(data.last_change)
          
          // Skip if suppressed (recent user action) or search active
          const searchActive = window.searchState && window.searchState.matches && window.searchState.matches.length > 0
          const editing = document.activeElement?.matches('input, textarea, select') || document.querySelector('.plate-overlay')
          const userChangeSuppressed = Date.now() < suppressRefreshUntil

          if (shouldRefresh && userChangeSuppressed && !searchActive && !editing) {
            // A successful local mutation has already updated the visible UI/store.
            // Consume its change marker instead of rebuilding the entire network tree
            // on the next poll, which can collapse asynchronously loaded branches and
            // disturb the current scroll position.
            changes.acknowledge(data.last_change)
          } else if (shouldRefresh && !searchActive && !editing) {
            try {
              const list = await api.networks()
              const newNetworks = Array.isArray(list) ? list : []
              // Always update when last_change differs - hosts may have changed
              store.set({ networks: newNetworks })
              changes.acknowledge(data.last_change)
            } catch(e) {
              // Ignore refresh errors
            }
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
      // The sidebar agrees with the banner
      setServerState('error', 'server down')
    } finally {
      checkingNetwork = false
    }
  }
  checkNetwork()
  setInterval(checkNetwork, 5000)
  
  // API status indicator (uses authenticated endpoint)
  async function updateStatus() {
    const token = auth.token()
    if (!token) {
      setServerState('', 'server —')
      return
    }
    try {
      const r = await fetch('/api/pieng/me', { 
        headers: { 'Authorization': 'Bearer ' + token } 
      })
      if (token !== auth.token()) return // stale response from another session
      if (!networkOk) return // the banner state wins while the server is unreachable
      setServerState(r.ok ? 'ok' : 'error', r.ok ? 'server ok' : 'auth')
      if (r.status === 401) {
        auth.setToken('')
        window.dispatchEvent(new Event('pieng:unauthorized'))
      } else if (r.ok) {
        const me = await r.json()
        if (token === auth.token() && store.user && JSON.stringify(me.roles) !== JSON.stringify(store.user.roles)) {
          store.set({ user: me })
        }
      }
    } catch(e) {
      setServerState('error', 'err')
    }
  }
  updateStatus()
  setInterval(updateStatus, 30000)

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn')
  logoutBtn.addEventListener('click', () => {
    auth.setToken('')
    setResetScroll()
    setDrawer(false)
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

  const ROLE_ORDER = ['administrator', 'creator', 'editor']
  const PAGE_TITLES = { browse: 'Networks', logs: 'Activity' }
  const usersLink = document.getElementById('usersNavLink')
  let lastUser

  // Reflect identity, role and page in the shell when the store changes
  store.on(() => {
    const u = store.user
    const roles = u?.roles || []
    const isAdmin = roles.includes('administrator')
    const name = u ? (u.username || 'user') : ''
    document.getElementById('userBadge').textContent = name
    document.getElementById('userRole').textContent = u ? (ROLE_ORDER.find(r => roles.includes(r)) || 'reader') : ''
    logoutBtn.title = name ? `Sign out ${name}` : 'Sign out'
    logoutBtn.setAttribute('aria-label', logoutBtn.title)
    document.body.classList.toggle('is-admin', isAdmin)

    // Users for administrators, Account for everyone else (route stays #users)
    const usersLabel = isAdmin ? 'Users' : 'Account'
    document.getElementById('usersNavLabel').textContent = usersLabel
    usersLink.setAttribute('aria-label', usersLabel)
    usersLink.title = usersLabel
    const navIcon = usersLink.querySelector('.icon')
    if (navIcon && !navIcon.classList.contains('icon-' + (isAdmin ? 'users' : 'user'))) {
      navIcon.replaceWith(icon(isAdmin ? 'users' : 'user'))
    }

    if (u !== lastUser) {
      lastUser = u
      updateStatus() // Update status on auth change
    }

    // Page title and nav state
    const currentPage = store.currentPage || 'browse'
    document.body.dataset.page = currentPage
    document.getElementById('pageTitle').textContent = PAGE_TITLES[currentPage] || (currentPage === 'users' ? usersLabel : 'Networks')
    document.querySelectorAll('.sidebar-nav a[data-page]').forEach(a => {
      if (a.dataset.page === currentPage) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    })
  })

  function goTo(page){
    history.pushState({ page }, '', `#${page}`)
    setDrawer(false)
    // Reset scroll for page navigation
    setResetScroll()
    store.set({ currentPage: page, selected: null })
  }

  // Nav link handlers with history
  document.querySelectorAll('.sidebar-nav a[data-page]').forEach(link => {
    link.onclick = (e) => {
      e.preventDefault()
      goTo(link.dataset.page)
    }
  })
  
  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    const page = e.state?.page || 'browse'
    setResetScroll()
    store.set({ currentPage: page })
  })
  
  // Set initial history state
  const initialPage = location.hash.replace('#', '') || 'browse'
  history.replaceState({ page: initialPage }, '', `#${initialPage}`)
  store.set({ currentPage: initialPage })
  
  // Search wiring
  const searchInput = document.getElementById('searchInput')
  const searchInfo = document.getElementById('searchInfo')
  const searchPrev = document.getElementById('searchPrev')
  const searchNext = document.getElementById('searchNext')
  const modeButtons = [document.getElementById('modeHosts'), document.getElementById('modeNetworks')]
  
  // Search state - exposed globally for components.js
  window.searchState = {
    mode: 'hosts',
    matches: [],
    matchIndex: -1,
    lastQuery: '',  // Track what was last searched
    searching: false  // Prevent concurrent searches
  }
  
  let navDebounce = null

  function setInfo(text, error = false){
    searchInfo.textContent = text
    searchInfo.classList.toggle('error', error)
  }
  
  // Sort search results by IP address to match tree order
  function sortResultsByIP(results) {
    return results.sort((a, b) => {
      const ipA = a.type === 'network' ? a.address_range : a.address
      const ipB = b.type === 'network' ? b.address_range : b.address
      return compareAddresses(ipA, ipB)
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
      setInfo(q.length === 1 ? '…' : '')
      return
    }
    
    setInfo('…')
    st.searching = true
    
    try {
      const result = await api.search(q, st.mode)
      st.matches = sortResultsByIP(result.results || [])
      
      if (st.matches.length === 0) {
        setInfo('0')
      } else {
        st.matchIndex = 0
        setInfo(`1/${st.matches.length}`)
        if (window.goToSearchMatch) window.goToSearchMatch()
      }
    } catch(e) {
      setInfo('err', true)
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
    setInfo(`${st.matchIndex + 1}/${st.matches.length}`)
    
    // Debounce the actual navigation (which makes API calls)
    clearTimeout(navDebounce)
    navDebounce = setTimeout(() => {
      if (window.goToSearchMatch) window.goToSearchMatch()
    }, 200)
  }
  
  // Explicit Hosts | Networks mode selector
  function setMode(mode){
    const st = window.searchState
    if (st.mode === mode) return
    clearTimeout(navDebounce)
    st.mode = mode
    modeButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
    searchInput.placeholder = `search ${mode}…`
    searchInput.setAttribute('aria-label', `Search ${mode}`)
    // Clear current results when mode changes
    st.matches = []
    st.matchIndex = -1
    st.lastQuery = ''
    st.searching = false
    setInfo('')
  }
  modeButtons.forEach(b => { b.onclick = () => setMode(b.dataset.mode) })
  
  searchPrev.onclick = () => navigateSearch(-1)
  searchNext.onclick = () => navigateSearch(1)
  
  searchInput.onkeydown = (e) => {
    if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
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
      setInfo('')
      // Clear highlights
      document.querySelectorAll('.search-match, .search-match-host').forEach(el => {
        el.classList.remove('search-match', 'search-match-host')
      })
    }
  }
})();
