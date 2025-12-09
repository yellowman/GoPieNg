import { api, auth } from './api.js'
import { store } from './store.js'
import { $, $$, el, notify, pushToast } from './util.js'

// Track expanded nodes
const expanded = new Set()

export function mountApp(root){
  const un = store.on(() => render(root))
  
  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    if (e.state) {
      store.set({ currentPage: e.state.page || 'browse' })
    }
  })
  
  render(root)
  return () => un()
}

// Navigate with history
function navigate(page) {
  history.pushState({ page }, '', `#${page}`)
  store.set({ currentPage: page })
}

function render(root){
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
}

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
  
  // Load root networks
  const roots = store.networks.filter(n => !n.parent)
  if (roots.length === 0) {
    tree.appendChild(el('div', { class:'sub' }, 'No networks found'))
  } else {
    roots.sort((a, b) => (a.address_range || '').localeCompare(b.address_range || ''))
    for (const net of roots) {
      tree.appendChild(TreeNode(net, 0))
    }
  }
  
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
  
  // Expand/collapse toggle - works for both subdivide and leaf networks
  const toggle = el('button', { class: 'tree-toggle' }, isExpanded ? '▼' : '▶')
  toggle.onclick = async (e) => {
    e.stopPropagation()
    if (expanded.has(net.id)) {
      expanded.delete(net.id)
    } else {
      expanded.add(net.id)
    }
    store.set({}) // Re-render
  }
  row.appendChild(toggle)
  
  // CIDR
  row.appendChild(el('span', { class: 'tree-cidr' }, net.address_range || '?'))
  
  // Editable description
  const descWrap = el('span', { class: 'tree-desc' })
  const descSpan = el('span', { class: 'desc-text' }, net.description || '—')
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
  row.appendChild(descWrap)
  
  // Editable owner
  const ownerWrap = el('span', { class: 'tree-owner' })
  const ownerSpan = el('span', { class: 'owner-text' }, net.owner || '')
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
  row.appendChild(ownerWrap)
  
  // Meta info (account only now, owner is editable separately)
  const meta = []
  if (net.account) meta.push(net.account)
  if (meta.length) {
    row.appendChild(el('span', { class: 'tree-meta' }, meta.join(' · ')))
  }
  
  // Actions - flush right
  const actions = el('div', { class: 'tree-actions' })
  
  // Settings button for admins (subdivide networks only)
  const isAdmin = (store.user?.roles || []).includes('admin')
  if (isSubdivide && isAdmin) {
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
      if (expanded.has(net.id)) {
        expanded.delete(net.id)
      } else {
        expanded.add(net.id)
        // Scroll into view after render
        setTimeout(() => {
          wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 50)
      }
      store.set({})
    }
    actions.appendChild(openBtn)
  } else {
    const hostsBtn = el('button', { class: 'btn-action btn-hosts' }, isExpanded ? 'close' : 'hosts')
    hostsBtn.onclick = (e) => {
      e.stopPropagation()
      if (expanded.has(net.id)) {
        expanded.delete(net.id)
      } else {
        expanded.add(net.id)
        // Scroll into view after render
        setTimeout(() => {
          wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 50)
      }
      store.set({})
    }
    actions.appendChild(hostsBtn)
  }
  
  row.appendChild(actions)
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
    if (isExpanded) {
      loadHostPanel(panel, net)
    }
    wrapper.appendChild(panel)
  }
  
  return wrapper
}

async function loadTreeChildren(container, parent, depth){
  container.innerHTML = '<div class="loading">Loading...</div>'
  
  try {
    const kids = await api.networks(parent.id)
    const children = Array.isArray(kids) ? kids : []
    container.innerHTML = ''
    
    // Allocation bar at top
    const allocBar = createAllocBar(parent, container)
    if (allocBar) container.appendChild(allocBar)
    
    if (children.length === 0) {
      container.appendChild(el('div', { class: 'tree-empty', style: `padding-left:${depth * 20 + 28}px` }, 
        'No subnets allocated yet'))
    } else {
      children.sort((a, b) => (a.address_range || '').localeCompare(b.address_range || ''))
      for (const kid of children) {
        container.appendChild(TreeNode(kid, depth))
      }
    }
  } catch(e) {
    container.innerHTML = ''
    container.appendChild(el('div', { class: 'sub' }, 'Failed to load: ' + e.message))
  }
}

function createAllocBar(parent, container){
  if (!parent.subdivide) return null
  
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
  
  // Add form
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
      loadHostPanel(panel, network, allocatedAddr)
      
      // Ping check in background (if enabled on server)
      if (allocatedAddr) {
        api.pingCheck(allocatedAddr).then(result => {
          if (result && result.responds) {
            pushToast(`⚠️ Warning: ${allocatedAddr} already responds to ping!`, 'warning')
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
  const tr = el('tr', { class: host.used ? 'used' : 'free' })
  
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
        }
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
  const tr = el('tr')
  // Strip /32 suffix if present, just show IP
  const displayAddr = host.address.replace(/\/32$/, '')
  tr.appendChild(el('td', { class: 'host-addr' }, displayAddr))
  
  // Editable description
  const descTd = el('td', { class: 'host-desc-cell' })
  const descSpan = el('span', { class: 'desc-text' }, host.description || '—')
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
  tr.appendChild(descTd)
  
  // Delete
  const actTd = el('td', { class: 'host-actions' })
  const delBtn = el('button', { class: 'btn-del' }, '×')
  delBtn.onclick = async () => {
    if (!confirm('Delete ' + host.address + '?')) return
    try {
      await api.delHost(host.address)
      loadHostPanel(panel, network)
      pushToast('Deleted', 'info')
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }
  actTd.appendChild(delBtn)
  tr.appendChild(actTd)
  
  return tr
}

function UsersPage(){
  const card = el('div', { class: 'card' })
  card.appendChild(el('h2', {}, 'User Management'))
  
  const st = store
  const isAdmin = (st.user?.roles || []).includes('admin')
  
  if (!isAdmin) {
    card.appendChild(el('div', { class: 'sub' }, 'Admin access required'))
    return card
  }
  
  // Add user form
  const addForm = el('div', { class: 'user-form' })
  const userInput = el('input', { type: 'text', placeholder: 'Username' })
  const passInput = el('input', { type: 'password', placeholder: 'Password' })
  const roleSelect = el('select')
  roleSelect.appendChild(el('option', { value: '' }, 'user'))
  roleSelect.appendChild(el('option', { value: 'admin' }, 'admin'))
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
      tr.appendChild(el('td', {}, (user.roles || []).join(', ') || 'user'))
      tr.appendChild(el('td', {}, user.status === 1 ? 'active' : 'disabled'))
      
      const actTd = el('td', { class: 'user-actions' })
      
      const adminBtn = el('button', { class: 'btn-sm' }, 
        (user.roles || []).includes('admin') ? '−admin' : '+admin')
      adminBtn.onclick = async () => {
        const hasAdmin = (user.roles || []).includes('admin')
        try {
          await api.updateUser(user.id, { roles: hasAdmin ? [] : ['admin'] })
          pushToast('Updated', 'info')
          store.set({})
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }
      actTd.appendChild(adminBtn)
      
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
      
      const delBtn = el('button', { class: 'btn-sm btn-del' }, '×')
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
