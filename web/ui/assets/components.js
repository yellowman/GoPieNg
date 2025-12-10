import { api, auth } from './api.js'
import { store } from './store.js'
import { $, $$, el, notify, pushToast, showWarningModal, showConfirmModal } from './util.js'

// Track expanded nodes
const expanded = new Set()

// Numeric IP sort helper
function ipToNum(cidr) {
  if (!cidr) return 0
  const addr = cidr.split('/')[0]
  const parts = addr.split('.')
  if (parts.length !== 4) return 0
  return parseInt(parts[0]) * 16777216 + parseInt(parts[1]) * 65536 + 
         parseInt(parts[2]) * 256 + parseInt(parts[3])
}

// Role permission helpers
function getUserRoles() {
  return store.user?.roles || []
}
function isAdmin() {
  return getUserRoles().includes('administrator')
}
function isCreator() {
  const roles = getUserRoles()
  return roles.includes('administrator') || roles.includes('creator')
}
function isEditor() {
  const roles = getUserRoles()
  return roles.includes('administrator') || roles.includes('creator') || roles.includes('editor')
}

export function mountApp(root){
  const un = store.on(() => render(root))
  
  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    if (e.state) {
      resetScrollOnRender = true
      store.set({ currentPage: e.state.page || 'browse' })
    }
  })
  
  render(root)
  return () => un()
}

// Navigate with history (resets scroll to top)
function navigate(page) {
  history.pushState({ page }, '', `#${page}`)
  resetScrollOnRender = true
  store.set({ currentPage: page })
}

// Flag to explicitly reset scroll (for navigation)
let resetScrollOnRender = false

function render(root){
  const savedScroll = resetScrollOnRender ? 0 : window.scrollY
  resetScrollOnRender = false
  
  try {
    root.innerHTML = ''
    const st = store
    if (!st.user) {
      document.body.classList.add('not-authed')
      root.appendChild(Login())
    } else {
      document.body.classList.remove('not-authed')
      root.appendChild(App())
    }
  } catch(e){
    console.error('Render error:', e)
    root.innerHTML = `<div class="card" style="margin:2rem"><h2>Error</h2><p>${e.message}</p></div>`
  }
  
  // Restore scroll after DOM is built
  window.scrollTo(0, savedScroll)
}

// Call this before store.set when navigation should reset scroll
export function setResetScroll() { resetScrollOnRender = true }

function App(){
  const wrap = el('div', { class:'main-content' })
  
  const st = store
  if (st.currentPage === 'logs') {
    wrap.appendChild(LogsPage())
  } else if (st.currentPage === 'users') {
    wrap.appendChild(UsersPage())
  } else {
    wrap.appendChild(NetworkTree())
  }
  
  return wrap
}

function NetworkTree(){
  const card = el('div', { class:'card tree-card' })
  card.appendChild(el('h2', {}, 'Networks'))
  
  const tree = el('div', { class:'net-tree' })
  card.appendChild(tree)
  
  function renderTree() {
    tree.innerHTML = ''
    const roots = store.networks.filter(n => !n.parent)
    if (roots.length === 0) {
      tree.appendChild(el('div', { class:'sub' }, 'No networks found'))
    } else {
      roots.sort((a, b) => ipToNum(a.address_range) - ipToNum(b.address_range))
      for (const net of roots) {
        tree.appendChild(TreeNode(net, 0))
      }
    }
  }
  
  // Expand a path to a network without rebuilding entire tree
  async function expandPath(ancestry, targetId) {
    // Suppress host panel auto-load during expansion
    window._suppressHostPanelLoad = true
    
    for (let i = 0; i < ancestry.length; i++) {
      const netId = ancestry[i]
      const depth = i + 1  // Root is depth 0, first ancestor is depth 1
      
      expanded.add(netId)
      
      // Find the node in DOM
      const node = document.querySelector(`.tree-node[data-id="${netId}"]`)
      if (!node) continue
      
      // Check if it's a subdivide node with children container
      const childrenContainer = node.querySelector(':scope > .tree-children')
      if (childrenContainer) {
        // Show it if hidden
        childrenContainer.classList.remove('hidden')
        
        // Update button text
        const openBtn = node.querySelector('.btn-open')
        if (openBtn) openBtn.textContent = 'close'
        const toggle = node.querySelector('.tree-toggle')
        if (toggle) toggle.textContent = '▼'
        
        // Load children if empty or just has loading indicator
        if (childrenContainer.children.length === 0 || childrenContainer.querySelector('.loading')) {
          const net = store.networks.find(n => n.id === netId)
          if (net) {
            await loadTreeChildren(childrenContainer, net, depth)
          }
        }
      }
    }
    
    window._suppressHostPanelLoad = false
    
    // Also expand the target if it's a network
    if (targetId) {
      expanded.add(targetId)
    }
  }
  
  // Global search navigation - called from app.js
  window.goToSearchMatch = async function() {
    const st = window.searchState
    if (!st || st.matches.length === 0) return
    
    const match = st.matches[st.matchIndex]
    
    // Clear previous highlights
    document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'))
    document.querySelectorAll('.search-match-host').forEach(el => el.classList.remove('search-match-host'))
    
    if (match.type === 'network') {
      // Expand path without full re-render
      await expandPath(match.ancestry || [], match.id)
      
      // Check if node exists now
      let node = document.querySelector(`.tree-node[data-id="${match.id}"]`)
      
      // If not found, we need a full render (first time or collapsed parent)
      if (!node) {
        window._suppressHostPanelLoad = true
        const scrollY = window.scrollY
        renderTree()
        window.scrollTo(0, scrollY)
        window._suppressHostPanelLoad = false
        
        // Wait for it
        await new Promise(resolve => setTimeout(resolve, 100))
        node = document.querySelector(`.tree-node[data-id="${match.id}"]`)
      }
      
      if (node) {
        node.classList.add('search-match')
        const row = node.querySelector('.tree-row')
        ;(row || node).scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      
    } else if (match.type === 'host') {
      // Expand path to the host's network
      await expandPath(match.ancestry || [], match.network_id)
      
      // Check if network node exists
      let node = document.querySelector(`.tree-node[data-id="${match.network_id}"]`)
      
      // If not found, we need a full render
      if (!node) {
        window._suppressHostPanelLoad = true
        const scrollY = window.scrollY
        renderTree()
        window.scrollTo(0, scrollY)
        window._suppressHostPanelLoad = false
        
        await new Promise(resolve => setTimeout(resolve, 100))
        node = document.querySelector(`.tree-node[data-id="${match.network_id}"]`)
      }
      
      if (!node) return
      
      const hostsBtn = node.querySelector('.btn-hosts')
      const panel = node.querySelector('.host-panel')
      const toggle = node.querySelector('.tree-toggle')
      
      // Show panel
      if (panel && panel.classList.contains('hidden')) {
        panel.classList.remove('hidden')
        expanded.add(match.network_id)
        if (hostsBtn) hostsBtn.textContent = 'close'
        if (toggle) toggle.textContent = '▼'
      }
      
      // Load hosts if needed
      if (panel && panel.children.length === 0) {
        const net = store.networks.find(n => n.id === match.network_id)
        if (net) {
          panel.innerHTML = '<div class="loading">Loading...</div>'
          try {
            const hosts = await api.hosts(net.id)
            panel.innerHTML = ''
            const table = el('table', { class: 'hosts-table' })
            const tbody = el('tbody')
            for (const h of hosts) {
              tbody.appendChild(HostRow(h, net, panel))
            }
            table.appendChild(tbody)
            panel.appendChild(table)
          } catch(e) {
            panel.innerHTML = '<div class="error">Error</div>'
          }
        }
      }
      
      // Find and scroll to host
      await new Promise(resolve => setTimeout(resolve, 50))
      const hostRow = document.querySelector(`.host-row[data-addr="${match.address}"]`)
      if (hostRow) {
        hostRow.classList.add('search-match-host')
        hostRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        const row = node.querySelector('.tree-row')
        ;(row || node).scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }
  
  // Initial render
  renderTree()
  
  return card
}

function TreeNode(net, depth){
  const nodeId = `net-${net.id}`
  const isExpanded = expanded.has(net.id)
  const isSubdivide = net.subdivide
  
  const wrapper = el('div', { class: 'tree-node', 'data-id': net.id })
  
  // Main row
  const row = el('div', { 
    class: 'tree-row' + (isSubdivide ? ' subdivide' : ' leaf'),
    style: `padding-left: ${depth * 20 + 8}px`
  })
  
  // Expand/collapse toggle - delegates to open/hosts button
  const toggle = el('button', { class: 'tree-toggle' }, isExpanded ? '▼' : '▶')
  // Click handler set after actions are created
  row.appendChild(toggle)
  
  // CIDR
  row.appendChild(el('span', { class: 'tree-cidr' }, net.address_range || '?'))
  
  // Description - editable for editors
  const descWrap = el('span', { class: 'tree-desc' })
  const descSpan = el('span', { class: 'desc-text' }, net.description || '—')
  
  if (isEditor()) {
    const descInput = el('input', { type: 'text', class: 'desc-edit hidden', value: net.description || '' })
    
    descSpan.onclick = (e) => {
      e.stopPropagation()
      descSpan.classList.add('hidden')
      descInput.classList.remove('hidden')
      descInput.focus()
      descInput.select()
    }
    
    descInput.onblur = async () => {
      const newDesc = descInput.value.trim()
      if (newDesc !== (net.description || '')) {
        try {
          await api.updateNetwork(net.id, { description: newDesc })
          descSpan.textContent = newDesc || '—'
          net.description = newDesc
          if (window.syncLastChange) window.syncLastChange()
          pushToast('Updated', 'info')
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
          descInput.value = net.description || ''
        }
      }
      descSpan.classList.remove('hidden')
      descInput.classList.add('hidden')
    }
    
    descInput.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') descInput.blur()
      if (e.key === 'Escape') {
        descInput.value = net.description || ''
        descInput.blur()
      }
    }
    
    descWrap.appendChild(descSpan)
    descWrap.appendChild(descInput)
  } else {
    descWrap.appendChild(descSpan)
  }
  row.appendChild(descWrap)
  
  // Owner - editable for editors
  const ownerWrap = el('span', { class: 'tree-owner' })
  const ownerSpan = el('span', { class: 'owner-text' }, net.owner || '')
  
  if (isEditor()) {
    const ownerInput = el('input', { type: 'text', class: 'owner-edit hidden', value: net.owner || '', placeholder: 'owner' })
    
    ownerSpan.onclick = (e) => {
      e.stopPropagation()
      ownerSpan.classList.add('hidden')
      ownerInput.classList.remove('hidden')
      ownerInput.focus()
      ownerInput.select()
    }
    
    ownerInput.onblur = async () => {
      const newOwner = ownerInput.value.trim()
      if (newOwner !== (net.owner || '')) {
        try {
          await api.updateNetwork(net.id, { owner: newOwner })
          ownerSpan.textContent = newOwner || ''
          net.owner = newOwner
          if (window.syncLastChange) window.syncLastChange()
          pushToast('Owner updated', 'info')
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
          ownerInput.value = net.owner || ''
        }
      }
      ownerSpan.classList.remove('hidden')
      ownerInput.classList.add('hidden')
    }
    
    ownerInput.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') ownerInput.blur()
      if (e.key === 'Escape') {
        ownerInput.value = net.owner || ''
        ownerInput.blur()
      }
    }
    
    ownerWrap.appendChild(ownerSpan)
    ownerWrap.appendChild(ownerInput)
  } else {
    ownerWrap.appendChild(ownerSpan)
  }
  row.appendChild(ownerWrap)
  
  // Account - editable for editors
  const accountWrap = el('span', { class: 'tree-account' })
  const accountSpan = el('span', { class: 'account-text' }, net.account || '')
  
  if (isEditor()) {
    const accountInput = el('input', { type: 'text', class: 'account-edit hidden', value: net.account || '', placeholder: 'account' })
    
    accountSpan.onclick = (e) => {
      e.stopPropagation()
      accountSpan.classList.add('hidden')
      accountInput.classList.remove('hidden')
      accountInput.focus()
      accountInput.select()
    }
    
    accountInput.onblur = async () => {
      const newAccount = accountInput.value.trim()
      if (newAccount !== (net.account || '')) {
        try {
          await api.updateNetwork(net.id, { account: newAccount })
          accountSpan.textContent = newAccount || ''
          net.account = newAccount
          if (window.syncLastChange) window.syncLastChange()
          pushToast('Account updated', 'info')
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
          accountInput.value = net.account || ''
        }
      }
      accountSpan.classList.remove('hidden')
      accountInput.classList.add('hidden')
    }
    
    accountInput.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') accountInput.blur()
      if (e.key === 'Escape') {
        accountInput.value = net.account || ''
        accountInput.blur()
      }
    }
    
    accountWrap.appendChild(accountSpan)
    accountWrap.appendChild(accountInput)
  } else {
    accountWrap.appendChild(accountSpan)
  }
  row.appendChild(accountWrap)
  
  // Actions - flush right
  const actions = el('div', { class: 'tree-actions' })
  
  // Settings button for admins (subdivide networks only)
  if (isSubdivide && isAdmin()) {
    const settingsBtn = el('button', { class: 'btn-action btn-settings' }, '⚙')
    settingsBtn.title = 'Edit allocation sizes'
    settingsBtn.onclick = (e) => {
      e.stopPropagation()
      showNetworkSettings(net, wrapper)
    }
    actions.appendChild(settingsBtn)
  }
  
  if (isSubdivide) {
    const openBtn = el('button', { class: 'btn-action btn-open' }, isExpanded ? 'close' : 'open')
    openBtn.onclick = async (e) => {
      e.stopPropagation()
      const children = wrapper.querySelector('.tree-children')
      if (expanded.has(net.id)) {
        expanded.delete(net.id)
        openBtn.textContent = 'open'
        if (children) children.classList.add('hidden')
      } else {
        expanded.add(net.id)
        openBtn.textContent = 'close'
        if (children) {
          children.classList.remove('hidden')
          // Load children if empty
          if (children.children.length === 0 || children.querySelector('.loading')) {
            loadTreeChildren(children, net, depth + 1)
          }
          // Scroll row into view to show expanded content
          setTimeout(() => {
            row.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }, 50)
        }
      }
      // Update toggle arrow
      toggle.textContent = expanded.has(net.id) ? '▼' : '▶'
    }
    actions.appendChild(openBtn)
  } else {
    const hostsBtn = el('button', { class: 'btn-action btn-hosts' }, isExpanded ? 'close' : 'hosts')
    hostsBtn.onclick = (e) => {
      e.stopPropagation()
      const panel = wrapper.querySelector('.host-panel')
      if (expanded.has(net.id)) {
        expanded.delete(net.id)
        hostsBtn.textContent = 'hosts'
        if (panel) panel.classList.add('hidden')
      } else {
        expanded.add(net.id)
        hostsBtn.textContent = 'close'
        if (panel) {
          panel.classList.remove('hidden')
          // Load hosts if empty
          if (panel.children.length === 0) {
            loadHostPanel(panel, net)
          }
          // Scroll row into view to show expanded content
          setTimeout(() => {
            row.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }, 50)
        }
      }
      // Update toggle arrow
      toggle.textContent = expanded.has(net.id) ? '▼' : '▶'
    }
    actions.appendChild(hostsBtn)
  }
  
  row.appendChild(actions)
  
  // Set up toggle to delegate to the open/hosts button
  toggle.onclick = (e) => {
    e.stopPropagation()
    const btn = actions.querySelector('.btn-open, .btn-hosts')
    if (btn) btn.click()
  }
  
  wrapper.appendChild(row)
  
  // Children container (for subdivide networks)
  if (isSubdivide) {
    const children = el('div', { class: 'tree-children' + (isExpanded ? '' : ' hidden') })
    
    if (isExpanded) {
      loadTreeChildren(children, net, depth + 1)
    }
    
    wrapper.appendChild(children)
  } else {
    // Host panel for leaf networks - use expanded state
    const panel = el('div', { class: 'host-panel' + (isExpanded ? '' : ' hidden') })
    // Don't auto-load during search expansion (causes scroll position issues)
    if (isExpanded && !window._suppressHostPanelLoad) {
      loadHostPanel(panel, net)
    }
    wrapper.appendChild(panel)
  }
  
  return wrapper
}

async function loadTreeChildren(container, parent, depth){
  // Check if children already exist in store (e.g., from search)
  let children = store.networks.filter(n => n.parent === parent.id)
  
  if (children.length === 0) {
    container.innerHTML = '<div class="loading">Loading...</div>'
    
    try {
      const kids = await api.networks(parent.id)
      children = Array.isArray(kids) ? kids : []
      // Add to store for future use
      if (children.length > 0) {
        const existingIds = new Set(store.networks.map(n => n.id))
        const newChildren = children.filter(c => !existingIds.has(c.id))
        if (newChildren.length > 0) {
          store.networks = [...store.networks, ...newChildren]
        }
      }
    } catch(e) {
      container.innerHTML = ''
      container.appendChild(el('div', { class: 'sub' }, 'Failed to load: ' + e.message))
      return
    }
  }
  
  container.innerHTML = ''
  
  // Allocation bar at top
  const allocBar = createAllocBar(parent, container)
  if (allocBar) container.appendChild(allocBar)
  
  if (children.length === 0) {
    container.appendChild(el('div', { class: 'tree-empty', style: `padding-left:${depth * 20 + 28}px` }, 
      'No subnets allocated yet'))
  } else {
    children.sort((a, b) => ipToNum(a.address_range) - ipToNum(b.address_range))
    for (const kid of children) {
      container.appendChild(TreeNode(kid, depth))
    }
  }
}

function createAllocBar(parent, container){
  if (!parent.subdivide) return null
  
  // Only creators can allocate networks
  if (!isCreator()) return null
  
  // Calculate available masks based on parent CIDR
  const match = (parent.address_range || '').match(/\/(\d+)$/)
  if (!match) return null
  const parentMask = parseInt(match[1], 10)
  
  // Generate reasonable mask options
  const isIPv6 = parent.address_range.includes(':')
  const maxMask = isIPv6 ? 64 : 30
  const preferredMasks = []
  const otherMasks = []
  
  // Use valid_masks from DB if set, otherwise calculate
  if (parent.valid_masks && parent.valid_masks.length > 0) {
    for (const m of parent.valid_masks) {
      if (m <= parentMask + 4) {
        preferredMasks.push(m)
      } else {
        otherMasks.push(m)
      }
    }
  } else {
    // Auto-generate: prefer larger blocks (smaller mask numbers)
    for (let m = parentMask + 1; m <= Math.min(parentMask + 8, maxMask); m++) {
      if (m <= parentMask + 4) {
        preferredMasks.push(m)
      } else {
        otherMasks.push(m)
      }
    }
  }
  
  if (preferredMasks.length === 0 && otherMasks.length === 0) return null
  
  const bar = el('div', { class: 'alloc-bar' })
  
  const descInput = el('input', { 
    type: 'text', 
    placeholder: 'Description for new subnet',
    class: 'alloc-desc'
  })
  bar.appendChild(descInput)
  
  bar.appendChild(el('span', { class: 'alloc-label' }, 'Size:'))
  
  const btnGroup = el('div', { class: 'alloc-btns' })
  
  // Track selected mask
  let selectedMask = preferredMasks[0] || otherMasks[0]
  const maskBtns = []
  
  const updateSelection = (mask) => {
    selectedMask = mask
    maskBtns.forEach(b => {
      b.classList.toggle('selected', parseInt(b.dataset.mask) === mask)
    })
    // Refresh available subnets panel if it's open
    const existingPanel = container.querySelector('.avail-subnets')
    if (existingPanel) {
      existingPanel.remove()
      showAvailableSubnets(parent, container, descInput, () => selectedMask)
    }
  }
  
  // Preferred masks (highlighted - larger blocks)
  for (const m of preferredMasks) {
    const btn = el('button', { class: 'alloc-btn preferred', 'data-mask': m }, '/' + m)
    btn.onclick = () => updateSelection(m)
    maskBtns.push(btn)
    btnGroup.appendChild(btn)
  }
  
  // Other masks (muted - smaller blocks)
  for (const m of otherMasks) {
    const btn = el('button', { class: 'alloc-btn other', 'data-mask': m }, '/' + m)
    btn.onclick = () => updateSelection(m)
    maskBtns.push(btn)
    btnGroup.appendChild(btn)
  }
  
  // Select first by default
  if (maskBtns.length > 0) {
    maskBtns[0].classList.add('selected')
  }
  
  bar.appendChild(btnGroup)
  
  // Edit mode button to show available subnets
  const editBtn = el('button', { class: 'btn-edit-mode', title: 'Show available subnets' }, 'e')
  editBtn.onclick = () => showAvailableSubnets(parent, container, descInput, () => selectedMask)
  bar.appendChild(editBtn)
  
  return bar
}

// Show available subnets for allocation
async function showAvailableSubnets(parent, container, descInput, getMask){
  const mask = getMask()
  
  // Check if already showing - toggle off
  const existing = container.querySelector('.avail-subnets')
  if (existing) {
    existing.remove()
    return
  }
  
  const panel = el('div', { class: 'avail-subnets' })
  panel.innerHTML = '<div class="loading">Loading available subnets...</div>'
  
  // Insert after alloc bar
  const bar = container.querySelector('.alloc-bar')
  if (bar) bar.after(panel)
  else container.prepend(panel)
  
  try {
    const available = await api.availableSubnetsAt(parent.id, mask)
    panel.innerHTML = ''
    
    if (!available || available.length === 0) {
      panel.appendChild(el('div', { class: 'sub' }, `No available /${mask} subnets`))
      const closeBtn = el('button', { class: 'btn-close' }, '×')
      closeBtn.onclick = () => panel.remove()
      panel.appendChild(closeBtn)
      return
    }
    
    const header = el('div', { class: 'avail-header' })
    header.appendChild(el('span', {}, `Available /${mask} subnets (${available.length}):`))
    const closeBtn = el('button', { class: 'btn-close' }, '×')
    closeBtn.onclick = () => panel.remove()
    header.appendChild(closeBtn)
    panel.appendChild(header)
    
    const grid = el('div', { class: 'avail-grid' })
    for (const sub of available) {
      const item = el('div', { class: 'avail-item' })
      item.appendChild(el('span', { class: 'avail-cidr' }, sub.address_range))
      
      const btns = el('div', { class: 'avail-btns' })
      
      // Assign button (subdivide=false) - endpoint/leaf allocation
      const assignBtn = el('button', { class: 'avail-btn assign', title: 'Assign (no further subdivision)' }, 'Assign')
      assignBtn.onclick = async () => {
        const desc = descInput?.value?.trim() || 'auto'
        try {
          await api.allocSubnetAt(parent.id, sub.address_range, desc, false)
          if (descInput) descInput.value = ''
          pushToast(`Assigned ${sub.address_range}`, 'info')
          if (window.syncLastChange) window.syncLastChange()
          store.set({}) // Re-render
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }
      btns.appendChild(assignBtn)
      
      // Subdivide button (subdivide=true) - can be further split
      const subdivBtn = el('button', { class: 'avail-btn subdiv', title: 'Allocate for further subdivision' }, 'Subdivide')
      subdivBtn.onclick = async () => {
        const desc = descInput?.value?.trim() || 'auto'
        try {
          await api.allocSubnetAt(parent.id, sub.address_range, desc, true)
          if (descInput) descInput.value = ''
          pushToast(`Allocated ${sub.address_range} for subdivision`, 'info')
          if (window.syncLastChange) window.syncLastChange()
          store.set({}) // Re-render
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }
      btns.appendChild(subdivBtn)
      
      item.appendChild(btns)
      grid.appendChild(item)
    }
    panel.appendChild(grid)
  } catch(e) {
    panel.innerHTML = ''
    panel.appendChild(el('div', { class: 'sub' }, 'Failed: ' + e.message))
  }
}

async function allocateSubnet(parent, mask, description, descInput){
  // Legacy function - kept for compatibility but not used in new UI
  const desc = description?.trim() || 'auto'
  try {
    const res = await api.allocSubnet(parent.id, mask, desc)
    if (descInput) descInput.value = ''
    pushToast(`Allocated /${mask} → ${res.address_range}`, 'info')
    if (window.syncLastChange) window.syncLastChange()
    store.set({}) // Re-render
  } catch(e) {
    pushToast('Failed: ' + e.message, 'error')
  }
}

function showNetworkSettings(net, wrapper){
  // Remove existing settings panel if any
  const existing = wrapper.querySelector('.settings-panel')
  if (existing) {
    existing.remove()
    return
  }
  
  const match = (net.address_range || '').match(/\/(\d+)$/)
  if (!match) return
  const parentMask = parseInt(match[1], 10)
  const isIPv6 = net.address_range.includes(':')
  const maxMask = isIPv6 ? 64 : 30
  
  const panel = el('div', { class: 'settings-panel' })
  
  const header = el('div', { class: 'settings-header' })
  header.appendChild(el('span', {}, 'Allowed allocation sizes for ' + net.address_range))
  const closeBtn = el('button', { class: 'btn-close' }, '×')
  closeBtn.onclick = () => panel.remove()
  header.appendChild(closeBtn)
  panel.appendChild(header)
  
  const help = el('div', { class: 'settings-help sub' })
  help.textContent = 'Select which subnet sizes can be allocated. Checked = allowed.'
  panel.appendChild(help)
  
  const grid = el('div', { class: 'mask-grid' })
  
  const currentMasks = new Set(net.valid_masks || [])
  const checkboxes = []
  
  for (let m = parentMask + 1; m <= maxMask; m++) {
    const label = el('label', { class: 'mask-option' })
    const cb = el('input', { type: 'checkbox', value: m })
    cb.checked = currentMasks.size === 0 ? (m <= parentMask + 8) : currentMasks.has(m)
    checkboxes.push(cb)
    
    const size = Math.pow(2, (isIPv6 ? 128 : 32) - m)
    let sizeStr = ''
    if (!isIPv6) {
      if (size >= 256) sizeStr = `(${size} hosts)`
      else sizeStr = `(${Math.max(size - 2, 1)} usable)`
    }
    
    label.appendChild(cb)
    label.appendChild(el('span', { class: 'mask-label' }, `/${m}`))
    if (sizeStr) label.appendChild(el('span', { class: 'mask-size' }, sizeStr))
    grid.appendChild(label)
  }
  
  panel.appendChild(grid)
  
  const actions = el('div', { class: 'settings-actions' })
  
  const selectAll = el('button', { class: 'btn-sm' }, 'All')
  selectAll.onclick = () => checkboxes.forEach(cb => cb.checked = true)
  actions.appendChild(selectAll)
  
  const selectNone = el('button', { class: 'btn-sm' }, 'None')
  selectNone.onclick = () => checkboxes.forEach(cb => cb.checked = false)
  actions.appendChild(selectNone)
  
  const selectCommon = el('button', { class: 'btn-sm' }, 'Common')
  selectCommon.onclick = () => {
    checkboxes.forEach(cb => {
      const m = parseInt(cb.value)
      cb.checked = m <= parentMask + 4
    })
  }
  actions.appendChild(selectCommon)
  
  const saveBtn = el('button', { class: 'primary' }, 'Save')
  saveBtn.onclick = async () => {
    const selected = checkboxes.filter(cb => cb.checked).map(cb => parseInt(cb.value))
    try {
      await api.updateNetwork(net.id, { valid_masks: selected })
      net.valid_masks = selected
      if (window.syncLastChange) window.syncLastChange()
      pushToast('Saved allocation sizes', 'info')
      panel.remove()
      store.set({}) // Refresh to show new options
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }
  actions.appendChild(saveBtn)
  
  panel.appendChild(actions)
  
  // Insert after the row
  const row = wrapper.querySelector('.tree-row')
  row.after(panel)
}

async function loadHostPanel(panel, network, highlightAddr = null){
  panel.dataset.loaded = 'true'
  panel.innerHTML = ''
  
  // Header with mode toggle
  const header = el('div', { class: 'host-header' })
  
  // Add form - editors and above only
  if (isEditor()) {
    const addForm = el('div', { class: 'host-form' })
    const ipInput = el('input', { type: 'text', placeholder: 'IP (empty=auto)', class: 'host-ip' })
    const descInput = el('input', { type: 'text', placeholder: 'Description', class: 'host-desc-input' })
    const addBtn = el('button', { class: 'btn-add' }, 'Add')
    
    addBtn.onclick = async () => {
      const desc = descInput.value.trim() || 'manual'
      try {
        let allocatedAddr = null
        if (ipInput.value.trim()) {
          await api.addHost(network.id, ipInput.value.trim(), desc)
          allocatedAddr = ipInput.value.trim()
          pushToast('Added ' + allocatedAddr, 'info')
        } else {
          const res = await api.allocHost(network.id, desc)
          allocatedAddr = res.address
          pushToast('Allocated ' + allocatedAddr, 'info')
        }
        ipInput.value = ''
        descInput.value = ''
        
        // Sync change tracker so auto-refresh doesn't re-render
        if (window.syncLastChange) window.syncLastChange()
        
        loadHostPanel(panel, network, allocatedAddr)
        
        // Ping check in background (if enabled on server)
        if (allocatedAddr) {
          api.pingCheck(allocatedAddr).then(result => {
            if (result && result.responds) {
              showWarningModal(`Warning: ${allocatedAddr} already responds!`)
            }
          })
        }
      } catch(e) {
        pushToast('Failed: ' + e.message, 'error')
      }
    }
    
    const handleEnter = (e) => { if (e.key === 'Enter') addBtn.click() }
    ipInput.onkeydown = handleEnter
    descInput.onkeydown = handleEnter
    
    addForm.appendChild(ipInput)
    addForm.appendChild(descInput)
    addForm.appendChild(addBtn)
    
    // Edit mode toggle button
    const editBtn = el('button', { class: 'btn-edit-mode', title: 'Show all addresses' }, 'E')
    editBtn.onclick = () => loadHostPanelEditMode(panel, network)
    
    header.appendChild(addForm)
    header.appendChild(editBtn)
  }
  
  panel.appendChild(header)
  
  // Load hosts
  try {
    const hosts = await api.hosts(network.id)
    
    if (!hosts || hosts.length === 0) {
      panel.appendChild(el('div', { class: 'sub host-empty' }, 'No hosts allocated'))
      return
    }
    
    const table = el('table', { class: 'host-table' })
    const tbody = el('tbody')
    
    let highlightRow = null
    for (const h of hosts) {
      const row = HostRow(h, network, panel)
      // Check if this is the newly allocated address
      if (highlightAddr && h.address === highlightAddr) {
        row.classList.add('highlight-new')
        highlightRow = row
      }
      tbody.appendChild(row)
    }
    
    table.appendChild(tbody)
    panel.appendChild(table)
    
    // Scroll to and highlight the new row, remove highlight on click anywhere
    if (highlightRow) {
      setTimeout(() => {
        highlightRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
      
      // Remove highlight when user clicks anywhere
      const removeHighlight = () => {
        highlightRow.classList.remove('highlight-new')
        document.removeEventListener('click', removeHighlight)
      }
      // Delay adding listener so the current click doesn't trigger it
      setTimeout(() => {
        document.addEventListener('click', removeHighlight)
      }, 200)
    }
  } catch(e) {
    panel.appendChild(el('div', { class: 'sub' }, 'Failed to load hosts'))
  }
}

// Edit mode: show all possible hosts in the network
async function loadHostPanelEditMode(panel, network){
  panel.innerHTML = ''
  
  const header = el('div', { class: 'host-header' })
  header.appendChild(el('span', { class: 'edit-mode-label' }, 'All addresses in ' + network.address_range))
  
  const backBtn = el('button', { class: 'btn-edit-mode active' }, 'E')
  backBtn.title = 'Back to normal view'
  backBtn.onclick = () => {
    panel.dataset.loaded = ''
    loadHostPanel(panel, network)
  }
  header.appendChild(backBtn)
  panel.appendChild(header)
  
  const loading = el('div', { class: 'loading' }, 'Loading all addresses...')
  panel.appendChild(loading)
  
  try {
    const allHosts = await api.allHosts(network.id)
    loading.remove()
    
    if (!allHosts || allHosts.length === 0) {
      panel.appendChild(el('div', { class: 'sub' }, 'Network too large to display all addresses'))
      return
    }
    
    const table = el('table', { class: 'host-table edit-mode' })
    const tbody = el('tbody')
    
    for (const h of allHosts) {
      tbody.appendChild(HostRowEditMode(h, network, panel))
    }
    
    table.appendChild(tbody)
    panel.appendChild(table)
  } catch(e) {
    loading.remove()
    panel.appendChild(el('div', { class: 'sub' }, 'Failed: ' + e.message))
  }
}

function HostRowEditMode(host, network, panel){
  const tr = el('tr', { class: 'host-row ' + (host.used ? 'used' : 'free'), 'data-addr': host.address })
  
  // Just IP, no /32
  tr.appendChild(el('td', { class: 'host-addr' }, host.address))
  
  // Editable description
  const descTd = el('td', { class: 'host-desc-cell' })
  const descInput = el('input', { 
    type: 'text', 
    class: 'desc-input-inline', 
    value: host.description || '',
    placeholder: host.used ? '' : 'available'
  })
  
  descInput.onblur = async () => {
    const newDesc = descInput.value.trim()
    const wasUsed = host.used
    const oldDesc = host.description || ''
    
    if (newDesc !== oldDesc) {
      try {
        if (newDesc === '' && wasUsed) {
          // Clear = delete
          await api.delHost(host.address)
          host.used = false
          host.description = ''
          tr.className = 'free'
          pushToast('Removed ' + host.address, 'info')
        } else if (newDesc !== '') {
          // Add or update
          await api.addHost(network.id, host.address, newDesc, wasUsed)
          host.used = true
          host.description = newDesc
          tr.className = 'used'
          pushToast(wasUsed ? 'Updated' : 'Added ' + host.address, 'info')
          
          // Ping check for new allocations only
          if (!wasUsed) {
            api.pingCheck(host.address).then(result => {
              if (result && result.responds) {
                showWarningModal(`Warning: ${host.address} already responds!`)
              }
            })
          }
        }
        // Sync change tracker so auto-refresh doesn't re-render
        if (window.syncLastChange) window.syncLastChange()
      } catch(e) {
        pushToast('Failed: ' + e.message, 'error')
        descInput.value = oldDesc
      }
    }
  }
  
  descInput.onkeydown = (e) => {
    if (e.key === 'Enter') descInput.blur()
    if (e.key === 'Escape') {
      descInput.value = host.description || ''
      descInput.blur()
    }
  }
  
  descTd.appendChild(descInput)
  tr.appendChild(descTd)
  
  return tr
}

function HostRow(host, network, panel){
  const tr = el('tr', { class: 'host-row', 'data-addr': host.address })
  // Strip /32 suffix if present, just show IP
  const displayAddr = host.address.replace(/\/32$/, '')
  tr.appendChild(el('td', { class: 'host-addr' }, displayAddr))
  
  // Description cell
  const descTd = el('td', { class: 'host-desc-cell' })
  const descSpan = el('span', { class: 'desc-text' }, host.description || '—')
  
  // Only editors can edit description inline
  if (isEditor()) {
    const descInput = el('input', { type: 'text', class: 'desc-edit hidden', value: host.description || '' })
    
    descSpan.onclick = () => {
      descSpan.classList.add('hidden')
      descInput.classList.remove('hidden')
      descInput.focus()
      descInput.select()
    }
    
    descInput.onblur = async () => {
      const newDesc = descInput.value.trim()
      if (newDesc !== (host.description || '')) {
        try {
          await api.addHost(network.id, host.address, newDesc, true) // update: true
          descSpan.textContent = newDesc || '—'
          host.description = newDesc
          if (window.syncLastChange) window.syncLastChange()
          pushToast('Updated', 'info')
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
          descInput.value = host.description || ''
        }
      }
      descSpan.classList.remove('hidden')
      descInput.classList.add('hidden')
    }
    
    descInput.onkeydown = (e) => {
      if (e.key === 'Enter') descInput.blur()
      if (e.key === 'Escape') {
        descInput.value = host.description || ''
        descInput.blur()
      }
    }
    
    descTd.appendChild(descSpan)
    descTd.appendChild(descInput)
  } else {
    descTd.appendChild(descSpan)
  }
  tr.appendChild(descTd)
  
  // Delete - editors only
  const actTd = el('td', { class: 'host-actions' })
  if (isEditor()) {
    const delBtn = el('button', { class: 'btn-del' }, 'del')
    delBtn.onclick = async () => {
      const desc = host.description ? ` "${host.description}"` : ''
      const confirmed = await showConfirmModal(`Delete host ${host.address}${desc}?`)
      if (!confirmed) return
      try {
        await api.delHost(host.address)
        if (window.syncLastChange) window.syncLastChange()
        // Remove row directly instead of reloading panel
        tr.remove()
        pushToast('Deleted', 'info')
      } catch(e) {
        pushToast('Failed: ' + e.message, 'error')
      }
    }
    actTd.appendChild(delBtn)
  }
  tr.appendChild(actTd)
  
  return tr
}

function UsersPage(){
  const card = el('div', { class: 'card' })
  card.appendChild(el('h2', {}, 'User Management'))
  
  if (!isAdmin()) {
    card.appendChild(el('div', { class: 'sub' }, 'Admin access required'))
    return card
  }
  
  // Add user form
  const addForm = el('div', { class: 'user-form' })
  const userInput = el('input', { type: 'text', placeholder: 'Username' })
  const passInput = el('input', { type: 'password', placeholder: 'Password' })
  const roleSelect = el('select')
  roleSelect.appendChild(el('option', { value: '' }, 'reader'))
  roleSelect.appendChild(el('option', { value: 'editor' }, 'editor'))
  roleSelect.appendChild(el('option', { value: 'creator' }, 'creator'))
  roleSelect.appendChild(el('option', { value: 'administrator' }, 'administrator'))
  const addBtn = el('button', { class: 'primary' }, 'Add User')
  
  addBtn.onclick = async () => {
    if (!userInput.value.trim() || !passInput.value.trim()) {
      pushToast('Username and password required', 'error')
      return
    }
    try {
      const roles = roleSelect.value ? [roleSelect.value] : []
      await api.createUser(userInput.value.trim(), passInput.value, roles)
      userInput.value = ''
      passInput.value = ''
      roleSelect.value = ''
      pushToast('User created', 'info')
      store.set({})
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }
  
  addForm.appendChild(userInput)
  addForm.appendChild(passInput)
  addForm.appendChild(roleSelect)
  addForm.appendChild(addBtn)
  card.appendChild(addForm)
  
  // Users list
  const container = el('div', { class: 'users-list' })
  card.appendChild(container)
  
  api.users().then(users => {
    if (!users || users.length === 0) {
      container.appendChild(el('div', { class: 'sub' }, 'No users'))
      return
    }
    
    const table = el('table')
    const thead = el('thead')
    thead.appendChild(el('tr', {},
      el('th', {}, 'Username'),
      el('th', {}, 'Roles'),
      el('th', {}, 'Status'),
      el('th', {}, 'Actions')
    ))
    table.appendChild(thead)
    
    const tbody = el('tbody')
    for (const user of users) {
      const tr = el('tr')
      tr.appendChild(el('td', {}, user.username))
      tr.appendChild(el('td', {}, (user.roles || []).join(', ') || 'reader'))
      tr.appendChild(el('td', {}, user.status === 1 ? 'active' : 'disabled'))
      
      const actTd = el('td', { class: 'user-actions' })
      
      // Role dropdown
      const currentRole = (user.roles || [])[0] || ''
      const roleDropdown = el('select', { class: 'role-select' })
      roleDropdown.appendChild(el('option', { value: '' }, 'reader'))
      roleDropdown.appendChild(el('option', { value: 'editor' }, 'editor'))
      roleDropdown.appendChild(el('option', { value: 'creator' }, 'creator'))
      roleDropdown.appendChild(el('option', { value: 'administrator' }, 'administrator'))
      roleDropdown.value = currentRole
      
      roleDropdown.onchange = async () => {
        try {
          const newRoles = roleDropdown.value ? [roleDropdown.value] : []
          await api.updateUser(user.id, { roles: newRoles })
          pushToast('Role updated', 'info')
          store.set({})
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
          roleDropdown.value = currentRole
        }
      }
      actTd.appendChild(roleDropdown)
      
      const statusBtn = el('button', { class: 'btn-sm' }, 
        user.status === 1 ? 'disable' : 'enable')
      statusBtn.onclick = async () => {
        try {
          await api.updateUser(user.id, { status: user.status === 1 ? 0 : 1 })
          pushToast('Updated', 'info')
          store.set({})
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }
      actTd.appendChild(statusBtn)
      
      const delBtn = el('button', { class: 'btn-sm btn-del' }, 'del')
      delBtn.onclick = async () => {
        if (!confirm('Delete user ' + user.username + '?')) return
        try {
          await api.deleteUser(user.id)
          pushToast('Deleted', 'info')
          store.set({})
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }
      actTd.appendChild(delBtn)
      
      tr.appendChild(actTd)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }).catch(e => {
    container.appendChild(el('div', { class: 'sub' }, 'Failed: ' + e.message))
  })
  
  return card
}

function LogsPage(){
  const card = el('div', { class: 'card' })
  card.appendChild(el('h2', {}, 'Activity Log'))
  
  const container = el('div')
  card.appendChild(container)
  
  api.logs(100).then(logs => {
    if (!logs || logs.length === 0) {
      container.appendChild(el('div', { class: 'sub' }, 'No logs available'))
      return
    }
    
    const table = el('table')
    const thead = el('thead')
    thead.appendChild(el('tr', {},
      el('th', {}, 'Time'),
      el('th', {}, 'User'),
      el('th', {}, 'Prefix'),
      el('th', {}, 'Action')
    ))
    table.appendChild(thead)
    
    const tbody = el('tbody')
    for (const log of logs) {
      let timeStr = log.created_at || '—'
      try {
        const d = new Date(log.created_at)
        if (!isNaN(d.getTime())) timeStr = d.toLocaleString()
      } catch(e) {}
      
      tbody.appendChild(el('tr', {},
        el('td', { class: 'log-time' }, timeStr),
        el('td', { class: 'log-user' }, log.user || '—'),
        el('td', { class: 'log-prefix' }, log.prefix || '—'),
        el('td', { class: 'log-action' }, log.action || '—')
      ))
    }
    table.appendChild(tbody)
    container.appendChild(table)
  }).catch(e => {
    container.appendChild(el('div', { class: 'sub' }, 'Failed to load logs'))
  })
  
  return card
}

function Login(){
  const card = el('div', { class: 'card login-card' })
  card.appendChild(el('h2', {}, 'GoPieNg'))
  card.appendChild(el('p', { class: 'sub' }, 'IP Address Management'))
  
  const form = el('div', { class: 'login-form' })
  const userInput = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' })
  const passInput = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' })
  const btn = el('button', { class: 'primary' }, 'Sign In')
  const err = el('div', { class: 'login-error hidden' })
  
  const doLogin = async () => {
    err.classList.add('hidden')
    try {
      const res = await auth.login(userInput.value, passInput.value)
      auth.setToken(res.token)
      const me = await api.me()
      const list = await api.networks()
      resetScrollOnRender = true
      store.set({ user: me, networks: Array.isArray(list) ? list : [], currentPage: 'browse' })
    } catch(e) {
      err.textContent = e.message || 'Login failed'
      err.classList.remove('hidden')
    }
  }
  
  btn.onclick = doLogin
  userInput.onkeydown = (e) => { if (e.key === 'Enter') passInput.focus() }
  passInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin() }
  
  form.appendChild(userInput)
  form.appendChild(passInput)
  form.appendChild(btn)
  form.appendChild(err)
  card.appendChild(form)
  
  return card
}
