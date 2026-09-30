import { compareAddresses } from './refresh.js?v=11'
import { api, auth } from './api.js?v=11'
import { store } from './store.js?v=11'
import { el, pushToast, showWarningModal, showConfirmModal, scrollBehavior } from './util.js?v=11'
import { icon } from './icons.js?v=11'

// Track expanded nodes
const expanded = new Set()

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

// Flag to explicitly reset scroll (for navigation)
let resetScrollOnRender = false

function render(root){
  const savedScroll = resetScrollOnRender ? 0 : window.scrollY
  resetScrollOnRender = false

  // Prevent height collapse by setting min-height before clearing
  const currentHeight = root.offsetHeight
  if (currentHeight > 0) {
    root.style.minHeight = currentHeight + 'px'
  }

  try {
    root.innerHTML = ''
    const st = store
    if (!st.user) {
      document.body.classList.add('not-authed')
      root.appendChild(Login())
    } else {
      document.body.classList.remove('not-authed')
      for (const node of App()) root.appendChild(node)
    }
  } catch(e){
    console.error('Render error:', e)
    root.replaceChildren(el('div', { class: 'band band-danger', role: 'alert' }, 'Error: ' + e.message))
  }

  // Restore scroll and clear min-height after layout
  requestAnimationFrame(() => {
    window.scrollTo(0, savedScroll)
    root.style.minHeight = ''
  })
}

// Call this before store.set when navigation should reset scroll
export function setResetScroll() { resetScrollOnRender = true }

function App(){
  const st = store
  if (st.currentPage === 'logs') return [LogsPage()]
  if (st.currentPage === 'users') return UsersPage()
  return [NetworkTree()]
}

// ============================================
// Shared pieces
// ============================================

function iconButton(name, label, attrs = {}){
  const btn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, ...attrs })
  btn.appendChild(icon(name))
  return btn
}

function bandHeader(labelNodes, onClose){
  const header = el('div', { class: 'band-header' })
  const label = el('span', { class: 'band-label' })
  for (const n of labelNodes) label.appendChild(typeof n === 'string' ? document.createTextNode(n) : n)
  header.appendChild(label)
  if (onClose) {
    const closeBtn = iconButton('close', 'Close')
    closeBtn.onclick = onClose
    header.appendChild(closeBtn)
  }
  return header
}

// Inline-editable text: plain at rest, focusable, Enter/F2 to edit,
// Enter saves, Esc cancels.
function editableText({ value, empty = '', hint = '', label, canEdit, onSave }){
  const wrap = el('span', { class: 'edit-wrap' })
  let current = value || ''
  const text = el('span', { class: 'edit-text' + (current ? '' : ' empty'), 'data-hint': hint }, current || empty)
  if (current) text.title = current
  wrap.appendChild(text)
  if (!canEdit) return wrap

  text.classList.add('editable')
  text.tabIndex = 0
  text.setAttribute('role', 'button')
  text.setAttribute('aria-label', `Edit ${label}${current ? ': ' + current : ''}`)

  const input = el('input', { type: 'text', class: 'edit-input hidden', value: current, placeholder: hint, 'aria-label': label })
  wrap.appendChild(input)

  let cancelled = false
  let refocus = false
  const open = (e) => {
    e?.stopPropagation()
    input.value = current
    text.classList.add('hidden')
    input.classList.remove('hidden')
    input.focus()
    input.select()
  }
  text.onclick = open
  text.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); open(e) }
  }

  input.onblur = async () => {
    const next = input.value.trim()
    if (!cancelled && next !== current) {
      try {
        await onSave(next)
        current = next
        text.textContent = next || empty
        text.title = next
        text.classList.toggle('empty', !next)
        text.setAttribute('aria-label', `Edit ${label}${next ? ': ' + next : ''}`)
      } catch(e) {
        pushToast('Failed: ' + e.message, 'error')
      }
    }
    cancelled = false
    input.classList.add('hidden')
    text.classList.remove('hidden')
    if (refocus) { refocus = false; text.focus() }
  }
  input.onkeydown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') { refocus = true; input.blur() }
    if (e.key === 'Escape') { cancelled = true; refocus = true; input.blur() }
  }
  return wrap
}

// Keep disclosure + primary action in sync for a tree node
function setNodeExpanded(wrapper, open){
  const row = wrapper.querySelector(':scope > .tree-row')
  if (!row) return
  const toggle = row.querySelector('.tree-toggle')
  const action = row.querySelector('.row-action.primary')
  if (toggle) toggle.setAttribute('aria-expanded', String(open))
  if (action) {
    action.setAttribute('aria-expanded', String(open))
    action.textContent = open ? 'close' : action.dataset.label
  }
}

// ============================================
// Network tree
// ============================================

function NetworkTree(){
  const tree = el('div', { class: 'net-tree' })

  function renderTree() {
    tree.innerHTML = ''
    const roots = store.networks.filter(n => !n.parent)
    if (roots.length === 0) {
      tree.appendChild(el('div', { class: 'tree-empty' }, 'No networks found'))
    } else {
      roots.sort((a, b) => compareAddresses(a.address_range, b.address_range))
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
        setNodeExpanded(node, true)

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
    document.querySelectorAll('.search-match').forEach(n => n.classList.remove('search-match'))
    document.querySelectorAll('.search-match-host').forEach(n => n.classList.remove('search-match-host'))

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
        ;(row || node).scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
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

      const panel = node.querySelector(':scope > .host-panel')

      // Show panel
      if (panel && panel.classList.contains('hidden')) {
        panel.classList.remove('hidden')
        expanded.add(match.network_id)
        setNodeExpanded(node, true)
      }

      // Load hosts with the regular host band (add form, table styles)
      if (panel && panel.children.length === 0) {
        const net = store.networks.find(n => n.id === match.network_id)
        if (net) await loadHostPanel(panel, net)
      }

      // Find and scroll to host
      await new Promise(resolve => setTimeout(resolve, 50))
      const hostRow = node.querySelector(`.host-row[data-addr="${CSS.escape(match.address)}"]`)
      if (hostRow) {
        hostRow.classList.add('search-match-host')
        hostRow.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      } else {
        const row = node.querySelector('.tree-row')
        ;(row || node).scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      }
    }
  }

  // Initial render
  renderTree()
  watchAddressColumn(tree)

  return tree
}

// The address column is one fixed track shared by every row, so description,
// owner and account stay aligned at any depth. It starts at --col-address
// (248px) and grows, never shrinks, to fit the widest visible address cell
// (indent + disclosure + full prefix); addresses are never truncated.
function watchAddressColumn(tree){
  const narrow = window.matchMedia('(max-width: 768px)')
  let width = 0
  let queued = false
  const fit = () => {
    queued = false
    if (!tree.isConnected || narrow.matches) return
    if (!width) width = parseFloat(getComputedStyle(tree).getPropertyValue('--col-address')) || 248
    let need = 0
    // Measure content (to the end of the prefix), not the cell, which is
    // already as wide as the track
    for (const cell of tree.querySelectorAll('.tree-address')) {
      const cidr = cell.querySelector('.tree-cidr')
      if (!cell.offsetParent || !cidr) continue
      need = Math.max(need, cidr.getBoundingClientRect().right - cell.getBoundingClientRect().left)
    }
    // Keep the 8px slack that gives a 16px visual gap, on the 4px grid
    const next = Math.ceil((need + 8) / 4) * 4
    if (next > width) {
      width = next
      tree.style.setProperty('--col-address-tree', width + 'px')
    }
  }
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(fit)
  }
  new MutationObserver(schedule).observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  narrow.addEventListener('change', schedule)
  if (document.fonts) document.fonts.ready.then(schedule)
  schedule()
}

function TreeNode(net, depth){
  const isExpanded = expanded.has(net.id)
  const isSubdivide = net.subdivide
  const regionId = `net-${net.id}-${isSubdivide ? 'children' : 'hosts'}`

  const wrapper = el('div', { class: 'tree-node', 'data-id': net.id })

  // Main row: address | description | owner | account | actions
  const row = el('div', {
    class: 'tree-row' + (isSubdivide ? ' subdivide' : ' leaf'),
    style: `--depth: ${depth}`
  })

  const address = el('div', { class: 'tree-address' })
  const toggle = iconButton('chevron-right', (isSubdivide ? 'Toggle subnets of ' : 'Toggle hosts of ') + net.address_range, {
    class: 'icon-btn tree-toggle',
    'aria-expanded': String(isExpanded),
    'aria-controls': regionId
  })
  toggle.querySelector('.icon').replaceWith(icon('chevron-right', 12))
  address.appendChild(toggle)
  address.appendChild(el('span', { class: 'tree-cidr' }, net.address_range || '?'))
  row.appendChild(address)

  const canEdit = isEditor()
  const saveField = (field, toast) => async (value) => {
    await api.updateNetwork(net.id, { [field]: value })
    net[field] = value
    if (window.syncLastChange) window.syncLastChange()
    pushToast(toast, 'info')
  }

  const desc = el('div', { class: 'tree-desc' })
  desc.appendChild(editableText({ value: net.description, empty: '—', label: 'description', canEdit, onSave: saveField('description', 'Updated') }))
  row.appendChild(desc)

  const owner = el('div', { class: 'tree-owner' })
  owner.appendChild(editableText({ value: net.owner, hint: 'owner', label: 'owner', canEdit, onSave: saveField('owner', 'Owner updated') }))
  row.appendChild(owner)

  const account = el('div', { class: 'tree-account' })
  account.appendChild(editableText({ value: net.account, hint: 'account', label: 'account', canEdit, onSave: saveField('account', 'Account updated') }))
  row.appendChild(account)

  // Actions - fixed width: settings slot (reserved) + primary slot
  const actions = el('div', { class: 'tree-actions' })

  if (isSubdivide && isAdmin()) {
    const settingsBtn = el('button', {
      type: 'button',
      class: 'row-action settings',
      'aria-label': 'Allocation sizes for ' + net.address_range,
      title: 'Edit allocation sizes',
      'aria-expanded': 'false'
    })
    settingsBtn.appendChild(icon('settings'))
    settingsBtn.onclick = (e) => {
      e.stopPropagation()
      showNetworkSettings(net, wrapper, depth, settingsBtn)
    }
    actions.appendChild(settingsBtn)
  } else {
    actions.appendChild(el('span', { class: 'row-slot', 'aria-hidden': 'true' }))
  }

  const primaryLabel = isSubdivide ? 'open' : 'hosts'
  const primary = el('button', {
    type: 'button',
    class: 'row-action primary ' + primaryLabel,
    'data-label': primaryLabel,
    'aria-expanded': String(isExpanded),
    'aria-controls': regionId
  }, isExpanded ? 'close' : primaryLabel)

  primary.onclick = (e) => {
    e.stopPropagation()
    const region = wrapper.querySelector(':scope > ' + (isSubdivide ? '.tree-children' : '.host-panel'))
    if (expanded.has(net.id)) {
      expanded.delete(net.id)
      setNodeExpanded(wrapper, false)
      if (region) region.classList.add('hidden')
      return
    }
    expanded.add(net.id)
    setNodeExpanded(wrapper, true)
    if (!region) return
    region.classList.remove('hidden')
    if (isSubdivide) {
      // Load children if empty
      if (region.children.length === 0 || region.querySelector('.loading')) {
        loadTreeChildren(region, net, depth + 1)
      }
    } else if (region.children.length === 0) {
      loadHostPanel(region, net)
    }
    // Scroll row into view to show expanded content
    setTimeout(() => {
      row.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
    }, 50)
  }
  actions.appendChild(primary)
  row.appendChild(actions)

  // Disclosure delegates to the primary action
  toggle.onclick = (e) => {
    e.stopPropagation()
    primary.click()
  }

  wrapper.appendChild(row)

  if (isSubdivide) {
    // Children container (for subdivide networks)
    const children = el('div', { class: 'tree-children' + (isExpanded ? '' : ' hidden'), id: regionId })
    if (isExpanded) {
      loadTreeChildren(children, net, depth + 1)
    }
    wrapper.appendChild(children)
  } else {
    // Host band for leaf networks - use expanded state
    const panel = el('div', { class: 'band host-panel' + (isExpanded ? '' : ' hidden'), id: regionId, style: `--depth: ${depth + 1}` })
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
    container.innerHTML = ''
    container.appendChild(el('div', { class: 'loading', style: `--depth: ${depth}` }, 'Loading…'))

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
      container.appendChild(el('div', { class: 'band band-danger', style: `--depth: ${depth}` }, 'Failed to load: ' + e.message))
      return
    }
  }

  container.innerHTML = ''

  // Allocation band at top
  const allocBar = createAllocBar(parent, container, depth)
  if (allocBar) container.appendChild(allocBar)

  if (children.length === 0) {
    container.appendChild(el('div', { class: 'tree-empty', style: `--depth: ${depth}` }, 'No subnets allocated yet'))
  } else {
    children.sort((a, b) => compareAddresses(a.address_range, b.address_range))
    for (const kid of children) {
      container.appendChild(TreeNode(kid, depth))
    }
  }
}

// ============================================
// Allocation band
// ============================================

function createAllocBar(parent, container, depth){
  if (!parent.subdivide) return null

  // Only creators can allocate networks
  if (!isCreator()) return null

  // Calculate available masks based on parent CIDR
  const match = (parent.address_range || '').match(/\/(\d+)$/)
  if (!match) return null
  const parentMask = parseInt(match[1], 10)

  // Generate reasonable mask options
  const isIPv6 = parent.address_range.includes(':')
  const maxMask = isIPv6 ? 128 : 32
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

  const bar = el('div', { class: 'band alloc-bar', style: `--depth: ${depth}` })
  const line = el('div', { class: 'band-row' })

  const descInput = el('input', {
    type: 'text',
    placeholder: 'Description for new subnet',
    class: 'alloc-desc',
    'aria-label': 'Description for new subnet'
  })
  line.appendChild(descInput)

  const sizeGroup = el('div', { class: 'band-row' })
  sizeGroup.appendChild(el('span', { class: 'field-label', id: `size-${parent.id}` }, 'Size'))
  const btnGroup = el('div', { class: 'btn-group', role: 'group', 'aria-labelledby': `size-${parent.id}` })

  // Track selected mask
  let selectedMask = preferredMasks[0] || otherMasks[0]
  const maskBtns = []

  let availBtn = null
  const updateSelection = (mask) => {
    selectedMask = mask
    maskBtns.forEach(b => {
      b.setAttribute('aria-pressed', String(parseInt(b.dataset.mask) === mask))
    })
    // Refresh available subnets band if it's open
    const existingPanel = container.querySelector(':scope > .avail-subnets')
    if (existingPanel) {
      existingPanel.remove()
      showAvailableSubnets(parent, container, descInput, () => selectedMask, availBtn, depth)
    }
  }

  // Preferred masks (green labels - larger blocks), others muted
  for (const [masks, kind] of [[preferredMasks, 'preferred'], [otherMasks, 'other']]) {
    for (const m of masks) {
      const btn = el('button', { type: 'button', class: 'chip ' + kind, 'data-mask': m, 'aria-pressed': String(m === selectedMask) }, '/' + m)
      btn.onclick = () => updateSelection(m)
      maskBtns.push(btn)
      btnGroup.appendChild(btn)
    }
  }
  sizeGroup.appendChild(btnGroup)
  line.appendChild(sizeGroup)

  const nextBtn = el('button', { type: 'button', class: 'btn-alloc', title: 'Assign the next free subnet without listing the whole pool' }, 'Assign next')
  nextBtn.onclick = async () => {
    nextBtn.disabled = true
    try { await allocateSubnet(parent, selectedMask, descInput.value, descInput) }
    finally { nextBtn.disabled = false }
  }
  line.appendChild(nextBtn)

  // Toggle to list available subnets
  availBtn = el('button', { type: 'button', class: 'btn-sm btn-toggle push', title: 'Show available subnets', 'aria-expanded': 'false' })
  availBtn.append(icon('list'), 'Available')
  availBtn.onclick = () => showAvailableSubnets(parent, container, descInput, () => selectedMask, availBtn, depth)
  line.appendChild(availBtn)

  bar.appendChild(line)
  return bar
}

// Available subnets band
async function showAvailableSubnets(parent, container, descInput, getMask, toggleBtn, depth){
  const mask = getMask()

  // Check if already showing - toggle off
  const existing = container.querySelector(':scope > .avail-subnets')
  if (existing) {
    existing.remove()
    toggleBtn?.setAttribute('aria-expanded', 'false')
    return
  }

  const panel = el('div', { class: 'band avail-subnets', style: `--depth: ${depth}` })
  panel.appendChild(el('div', { class: 'loading' }, 'Loading available subnets…'))
  toggleBtn?.setAttribute('aria-expanded', 'true')
  const close = () => { panel.remove(); toggleBtn?.setAttribute('aria-expanded', 'false') }

  // Insert after alloc bar
  const bar = container.querySelector(':scope > .alloc-bar')
  if (bar) bar.after(panel)
  else container.prepend(panel)

  try {
    const available = await api.availableSubnetsAt(parent.id, mask)
    panel.innerHTML = ''

    if (!available || available.length === 0) {
      panel.appendChild(bandHeader([`No available /${mask} subnets`], close))
      return
    }

    panel.appendChild(bandHeader([`Available /${mask} · ${available.length}`], close))

    const list = el('div', { class: 'avail-list' })
    for (const sub of available) {
      const item = el('div', { class: 'avail-row' })
      item.appendChild(el('span', { class: 'avail-cidr' }, sub.address_range))

      const btns = el('div', { class: 'btn-group' })
      const allocate = async (subdivide) => {
        const desc = descInput?.value?.trim() || 'auto'
        try {
          await api.allocSubnetAt(parent.id, sub.address_range, desc, subdivide)
          if (descInput) descInput.value = ''
          store.invalidateChildren(parent.id)
          pushToast(subdivide ? `Allocated ${sub.address_range} for subdivision` : `Assigned ${sub.address_range}`, 'info')
          if (window.syncLastChange) window.syncLastChange()
          store.set({}) // Re-render
        } catch(e) {
          pushToast('Failed: ' + e.message, 'error')
        }
      }

      // Assign (subdivide=false) - endpoint/leaf allocation
      const assignBtn = el('button', { type: 'button', class: 'btn-sm btn-outline-alloc', title: 'Assign (no further subdivision)' }, 'Assign')
      assignBtn.onclick = () => allocate(false)
      btns.appendChild(assignBtn)

      // Subdivide (subdivide=true) - can be further split
      const subdivBtn = el('button', { type: 'button', class: 'btn-sm btn-outline-subdivide', title: 'Allocate for further subdivision' }, 'Subdivide')
      subdivBtn.onclick = () => allocate(true)
      btns.appendChild(subdivBtn)

      item.appendChild(btns)
      list.appendChild(item)
    }
    panel.appendChild(list)
  } catch(e) {
    panel.innerHTML = ''
    panel.appendChild(bandHeader([el('span', { class: 'band-danger' }, 'Failed: ' + e.message)], close))
  }
}

async function allocateSubnet(parent, mask, description, descInput){
  // Allocate directly without requiring an exhaustive list of free prefixes.
  const desc = description?.trim() || 'auto'
  try {
    const res = await api.allocSubnet(parent.id, mask, desc)
    if (descInput) descInput.value = ''
    store.invalidateChildren(parent.id)
    pushToast(`Allocated /${mask} → ${res.address_range}`, 'info')
    if (window.syncLastChange) window.syncLastChange()
    store.set({}) // Re-render
  } catch(e) {
    pushToast('Failed: ' + e.message, 'error')
  }
}

// ============================================
// Network settings band
// ============================================

function showNetworkSettings(net, wrapper, depth, toggleBtn){
  // Remove existing settings band if any
  const existing = wrapper.querySelector(':scope > .settings-panel')
  if (existing) {
    existing.remove()
    toggleBtn?.setAttribute('aria-expanded', 'false')
    return
  }

  const match = (net.address_range || '').match(/\/(\d+)$/)
  if (!match) return
  const parentMask = parseInt(match[1], 10)
  const isIPv6 = net.address_range.includes(':')
  const maxMask = isIPv6 ? 128 : 32

  const panel = el('div', { class: 'band settings-panel', style: `--depth: ${depth + 1}` })
  const close = () => { panel.remove(); toggleBtn?.setAttribute('aria-expanded', 'false') }
  toggleBtn?.setAttribute('aria-expanded', 'true')

  panel.appendChild(bandHeader(['Allowed sizes · ', el('span', { class: 'mono' }, net.address_range)], close))
  panel.appendChild(el('p', { class: 'band-help' }, 'Select which subnet sizes can be allocated. Checked = allowed.'))

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

  const actions = el('div', { class: 'band-row' })
  const helpers = el('div', { class: 'btn-group' })

  const selectAll = el('button', { type: 'button', class: 'btn-sm' }, 'All')
  selectAll.onclick = () => checkboxes.forEach(cb => cb.checked = true)
  helpers.appendChild(selectAll)

  const selectNone = el('button', { type: 'button', class: 'btn-sm' }, 'None')
  selectNone.onclick = () => checkboxes.forEach(cb => cb.checked = false)
  helpers.appendChild(selectNone)

  const selectCommon = el('button', { type: 'button', class: 'btn-sm' }, 'Common')
  selectCommon.onclick = () => {
    checkboxes.forEach(cb => {
      const m = parseInt(cb.value)
      cb.checked = m <= parentMask + 4
    })
  }
  helpers.appendChild(selectCommon)
  actions.appendChild(helpers)

  const saveBtn = el('button', { type: 'button', class: 'btn-primary push' }, 'Save')
  saveBtn.onclick = async () => {
    const selected = checkboxes.filter(cb => cb.checked).map(cb => parseInt(cb.value))
    try {
      await api.updateNetwork(net.id, { valid_masks: selected })
      net.valid_masks = selected
      if (window.syncLastChange) window.syncLastChange()
      pushToast('Saved allocation sizes', 'info')
      close()
      store.set({}) // Refresh to show new options
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }
  actions.appendChild(saveBtn)
  actions.style.marginTop = 'var(--space-3)'

  panel.appendChild(actions)

  // Insert after the row
  const row = wrapper.querySelector(':scope > .tree-row')
  row.after(panel)
}

// ============================================
// Host band
// ============================================

async function loadHostPanel(panel, network, highlightAddr = null){
  panel.dataset.loaded = 'true'
  panel.innerHTML = ''

  // Add form and view toggle - editors and above only
  if (isEditor()) {
    const header = el('div', { class: 'band-row host-header' })
    const ipInput = el('input', { type: 'text', placeholder: 'IP (empty = auto)', class: 'host-ip mono', 'aria-label': 'IP address (empty for next free)' })
    const descInput = el('input', { type: 'text', placeholder: 'Description', class: 'host-desc-input', 'aria-label': 'Host description' })
    const addBtn = el('button', { type: 'button', class: 'btn-alloc' }, 'Add')

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
              showWarningModal(`${allocatedAddr} already responds`)
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

    const allBtn = el('button', { type: 'button', class: 'btn-sm btn-toggle push', title: 'Show all addresses', 'aria-pressed': 'false' })
    allBtn.append(icon('grid'), 'All addresses')
    allBtn.onclick = () => loadHostPanelEditMode(panel, network)

    header.append(ipInput, descInput, addBtn, allBtn)
    panel.appendChild(header)
  }

  // Load hosts
  try {
    const hosts = await api.hosts(network.id)

    if (!hosts || hosts.length === 0) {
      panel.appendChild(el('p', { class: 'band-empty', style: 'margin: var(--space-2) 0 0' }, 'No hosts allocated'))
      return
    }

    const table = el('table', { class: 'host-table' })
    const tbody = el('tbody')

    let highlightRow = null
    for (const h of hosts) {
      const row = HostRow(h, network)
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
        highlightRow.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
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
    panel.appendChild(el('p', { class: 'band-danger', style: 'margin: var(--space-2) 0 0' }, 'Failed to load hosts'))
  }
}

// All addresses: show every possible host in the network
async function loadHostPanelEditMode(panel, network){
  panel.innerHTML = ''

  const header = el('div', { class: 'band-row host-header' })
  header.appendChild(el('span', { class: 'band-label' }, 'All addresses · ', el('span', { class: 'mono' }, network.address_range)))

  const backBtn = el('button', { type: 'button', class: 'btn-sm btn-toggle push', title: 'Back to allocated hosts', 'aria-pressed': 'true' })
  backBtn.append(icon('grid'), 'All addresses')
  backBtn.onclick = () => {
    panel.dataset.loaded = ''
    loadHostPanel(panel, network)
  }
  header.appendChild(backBtn)
  panel.appendChild(header)

  const loading = el('div', { class: 'loading' }, 'Loading all addresses…')
  panel.appendChild(loading)

  try {
    const allHosts = await api.allHosts(network.id)
    loading.remove()

    if (!allHosts || allHosts.length === 0) {
      panel.appendChild(el('p', { class: 'band-empty' }, 'Network too large to display all addresses'))
      return
    }

    const table = el('table', { class: 'host-table edit-mode' })
    const tbody = el('tbody')

    for (const h of allHosts) {
      tbody.appendChild(HostRowEditMode(h, network))
    }

    table.appendChild(tbody)
    panel.appendChild(table)
  } catch(e) {
    loading.remove()
    panel.appendChild(el('p', { class: 'band-danger' }, 'Failed: ' + e.message))
  }
}

function HostRowEditMode(host, network){
  const tr = el('tr', { class: 'host-row ' + (host.used ? 'used' : 'free'), 'data-addr': host.address })

  // Just IP, no /32
  tr.appendChild(el('td', { class: 'host-addr' }, host.address))

  // Editable description
  const descTd = el('td', { class: 'host-desc-cell ctl' })
  const descInput = el('input', {
    type: 'text',
    class: 'desc-input-inline',
    value: host.description || '',
    placeholder: host.used ? '' : 'available',
    'aria-label': 'Description for ' + host.address
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
          tr.className = 'host-row free'
          pushToast('Removed ' + host.address, 'info')
        } else if (newDesc !== '') {
          // Add or update
          await api.addHost(network.id, host.address, newDesc, wasUsed)
          host.used = true
          host.description = newDesc
          tr.className = 'host-row used'
          pushToast(wasUsed ? 'Updated' : 'Added ' + host.address, 'info')

          // Ping check for new allocations only
          if (!wasUsed) {
            api.pingCheck(host.address).then(result => {
              if (result && result.responds) {
                showWarningModal(`${host.address} already responds`)
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

function HostRow(host, network){
  const tr = el('tr', { class: 'host-row', 'data-addr': host.address })
  // Strip /32 suffix if present, just show IP
  const displayAddr = host.address.replace(/\/32$/, '')
  tr.appendChild(el('td', { class: 'host-addr' }, displayAddr))

  // Description cell - only editors can edit inline
  const descTd = el('td', { class: 'host-desc-cell ctl' })
  descTd.appendChild(editableText({
    value: host.description,
    empty: '—',
    label: 'description of ' + displayAddr,
    canEdit: isEditor(),
    onSave: async (value) => {
      await api.addHost(network.id, host.address, value, true) // update: true
      host.description = value
      if (window.syncLastChange) window.syncLastChange()
      pushToast('Updated', 'info')
    }
  }))
  tr.appendChild(descTd)

  // Delete - editors only
  const actTd = el('td', { class: 'host-actions ctl' })
  if (isEditor()) {
    const delBtn = el('button', { type: 'button', class: 'btn-sm btn-danger', 'aria-label': 'Delete host ' + displayAddr }, 'del')
    delBtn.onclick = async () => {
      const desc = host.description ? ` "${host.description}"` : ''
      const confirmed = await showConfirmModal(`Delete host ${displayAddr}${desc}?`)
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

// ============================================
// Users / Account
// ============================================

const ROLE_OPTIONS = [['', 'reader'], ['editor', 'editor'], ['creator', 'creator'], ['administrator', 'administrator']]

function roleSelect(attrs = {}){
  const select = el('select', attrs)
  for (const [value, label] of ROLE_OPTIONS) select.appendChild(el('option', { value }, label))
  return select
}

function UsersPage(){
  // Make sure we have user info
  if (!store.user) {
    return [el('p', { class: 'sub' }, 'Not logged in')]
  }

  if (!isAdmin()) {
    // Account: change own password only
    const section = el('section')
    section.appendChild(el('div', { class: 'section-band' }, el('h2', { class: 'label', style: 'margin:0' }, 'Password')))
    section.appendChild(el('div', { class: 'band' }, PasswordChangeForm()))

    // Show current role (read-only)
    const roles = store.user?.roles || []
    const roleText = roles.length > 0 ? roles.join(', ') : 'reader'
    section.appendChild(el('p', { class: 'role-line', style: 'margin:0' }, `Role: ${roleText}`))
    return [section]
  }

  // Users: add user, list, own password
  const list = el('section')

  const addBand = el('div', { class: 'band' })
  const addForm = el('div', { class: 'form-row' })
  const userInput = el('input', { type: 'text', placeholder: 'Username', 'aria-label': 'New username', autocomplete: 'off' })
  const passInput = el('input', { type: 'password', placeholder: 'Password', 'aria-label': 'New user password', autocomplete: 'new-password' })
  const newRole = roleSelect({ 'aria-label': 'New user role' })
  const addBtn = el('button', { type: 'button', class: 'btn-primary' }, 'Add user')

  addBtn.onclick = async () => {
    if (!userInput.value.trim() || !passInput.value.trim()) {
      pushToast('Username and password required', 'error')
      return
    }
    try {
      const roles = newRole.value ? [newRole.value] : []
      await api.createUser(userInput.value.trim(), passInput.value, roles)
      userInput.value = ''
      passInput.value = ''
      newRole.value = ''
      pushToast('User created', 'info')
      store.set({})
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }

  addForm.append(userInput, passInput, newRole, addBtn)
  addBand.appendChild(addForm)
  list.appendChild(addBand)

  const container = el('div', { class: 'users-list' })
  list.appendChild(container)

  api.users().then(users => {
    if (!users || users.length === 0) {
      container.appendChild(el('p', { class: 'role-line', style: 'margin:0' }, 'No users'))
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
      tr.appendChild(el('td', { class: 'sub' }, (user.roles || []).join(', ') || 'reader'))
      tr.appendChild(el('td', { class: 'sub' }, user.status === 1 ? 'active' : 'disabled'))

      const actTd = el('td', { class: 'user-actions ctl' })

      // Role dropdown
      const currentRole = (user.roles || [])[0] || ''
      const roleDropdown = roleSelect({ class: 'role-select', 'aria-label': 'Role for ' + user.username })
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

      const statusBtn = el('button', { type: 'button', class: 'btn-sm' },
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

      const delBtn = el('button', { type: 'button', class: 'btn-sm btn-danger', 'aria-label': 'Delete user ' + user.username }, 'del')
      delBtn.onclick = async () => {
        const confirmed = await showConfirmModal('Delete user ' + user.username + '?')
        if (!confirmed) return
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
    container.appendChild(el('p', { class: 'band-danger' }, 'Failed: ' + e.message))
  })

  // Administrator's own password: collapsible section band after the list
  const selfPassword = el('details', { class: 'section' })
  const summary = el('summary', { class: 'section-band' })
  summary.append(icon('chevron-right', 12), el('span', { class: 'label' }, 'Your password'))
  selfPassword.appendChild(summary)
  selfPassword.appendChild(el('div', { class: 'band' }, PasswordChangeForm()))

  return [list, selfPassword]
}

function PasswordChangeForm(){
  const form = el('div', { class: 'form-row' })
  const currentPass = el('input', { type: 'password', placeholder: 'Current password', 'aria-label': 'Current password', autocomplete: 'current-password' })
  const newPass = el('input', { type: 'password', placeholder: 'New password', 'aria-label': 'New password', autocomplete: 'new-password' })
  const confirmPass = el('input', { type: 'password', placeholder: 'Confirm new password', 'aria-label': 'Confirm new password', autocomplete: 'new-password' })
  const saveBtn = el('button', { type: 'button', class: 'btn-primary' }, 'Change password')

  saveBtn.onclick = async () => {
    if (!newPass.value.trim()) {
      pushToast('New password required', 'error')
      return
    }
    if (newPass.value !== confirmPass.value) {
      pushToast('Passwords do not match', 'error')
      return
    }
    if (!store.user?.id) {
      pushToast('User ID not available', 'error')
      return
    }
    try {
      const result = await api.updateUser(store.user.id, { password: newPass.value, current_password: currentPass.value })
      if (result.reauthenticate) { auth.setToken(''); store.set({ user: null, networks: [] }) }
      currentPass.value = ''
      newPass.value = ''
      confirmPass.value = ''
      pushToast('Password changed. Sign in again.', 'info')
    } catch(e) {
      pushToast('Failed: ' + e.message, 'error')
    }
  }

  form.append(currentPass, newPass, confirmPass, saveBtn)
  return form
}

// ============================================
// Activity
// ============================================

function LogsPage(){
  const container = el('section', { 'aria-label': 'Activity' })
  container.appendChild(el('div', { class: 'loading' }, 'Loading…'))

  api.logs(100).then(logs => {
    container.innerHTML = ''
    if (!logs || logs.length === 0) {
      container.appendChild(el('p', { class: 'role-line', style: 'margin:0' }, 'No activity yet'))
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
    container.innerHTML = ''
    container.appendChild(el('p', { class: 'band-danger' }, 'Failed to load activity'))
  })

  return container
}

// ============================================
// Sign in
// ============================================

function Login(){
  const wrap = el('div', { class: 'login' })
  wrap.appendChild(el('h1', { class: 'login-title' }, 'GoPieNg'))
  wrap.appendChild(el('p', { class: 'login-subtitle' }, 'IP Address Management'))

  const form = el('div', { class: 'login-form' })
  const userInput = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', 'aria-label': 'Username' })
  const passInput = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' })
  const btn = el('button', { type: 'button', class: 'btn-primary' }, 'Sign in')
  const err = el('div', { class: 'login-error hidden', role: 'alert' })

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

  form.append(userInput, passInput, btn, err)
  wrap.appendChild(form)

  return wrap
}
