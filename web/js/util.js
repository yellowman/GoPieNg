// deterministic color from owner/service
export function colorFor(owner, service){
  let key = owner || (service ? 'svc-'+service : '')
  if (!key) return ''
  let h = 2166136261
  for (let i=0;i<key.length;i++){ h ^= key.charCodeAt(i); h = (h*16777619)>>>0 }
  return `hsl(${h%360}, 45%, 30%)`
}
export const $ = (sel, root=document)=> root.querySelector(sel)
export const $$ = (sel, root=document)=> Array.from(root.querySelectorAll(sel))
export function el(tag, attrs={}, ...children){
  const e = document.createElement(tag)
  for (const [k,v] of Object.entries(attrs)){
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') {
      e.className = v
    } else if (k === 'style') {
      e.style.cssText = v
    } else if (k.startsWith('on') && typeof v === 'function') {
      e.addEventListener(k.slice(2), v)
    } else if (v === true) {
      e.setAttribute(k, '')
    } else {
      e.setAttribute(k, v)
    }
  }
  for (const c of children){
    if (c==null) continue
    if (typeof c === 'string') e.appendChild(document.createTextNode(c))
    else e.appendChild(c)
  }
  return e
}


export function pushToast(msg, type='info', timeout=null){
  // Default timeouts: errors stay longer
  if (timeout === null) {
    timeout = type === 'error' ? 8000 : type === 'warning' ? 6000 : 3500
  }

  let root = document.getElementById('toastRoot')
  if (!root) {
    root = document.createElement('div')
    root.id = 'toastRoot'
    root.className = 'toast-root'
    document.body.appendChild(root)
  }
  const el = document.createElement('div')
  el.className = 'toast ' + type
  el.setAttribute('role', type === 'error' ? 'alert' : 'status')
  el.textContent = msg
  root.appendChild(el)
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(6px)'; setTimeout(()=> el.remove(), 200) }, timeout)
}

// Addresses and prefixes inside plate copy are set in mono
const ADDRESS_RE = /(\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b|\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?:\/\d{1,3})?)/
function plateBody(id, msg){
  const p = document.createElement('p')
  p.className = 'plate-body'
  p.id = id
  String(msg).split(ADDRESS_RE).forEach((part, i) => {
    if (!part) return
    if (i % 2) {
      const code = document.createElement('span')
      code.className = 'mono'
      code.textContent = part
      p.appendChild(code)
    } else {
      p.appendChild(document.createTextNode(part))
    }
  })
  return p
}

let plateSeq = 0
function openPlate({ heading, msg, role, dismissable }){
  const n = ++plateSeq
  const returnFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'plate-overlay' + (dismissable ? ' dismissable' : '')

  const plate = document.createElement('div')
  plate.className = 'plate'
  plate.tabIndex = -1
  plate.setAttribute('role', role)
  plate.setAttribute('aria-modal', 'true')
  plate.setAttribute('aria-labelledby', `plate-h-${n}`)
  plate.setAttribute('aria-describedby', `plate-b-${n}`)

  const h = document.createElement('h2')
  h.className = 'plate-heading'
  h.id = `plate-h-${n}`
  h.textContent = heading
  plate.appendChild(h)
  plate.appendChild(plateBody(`plate-b-${n}`, msg))
  overlay.appendChild(plate)

  const close = () => {
    overlay.remove()
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus()
  }
  // Keep Tab inside the plate
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const items = [...plate.querySelectorAll('button')]
    if (items.length === 0) { e.preventDefault(); return }
    const i = items.indexOf(document.activeElement)
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
    e.preventDefault()
    items[next].focus()
  })
  return { overlay, plate, close }
}

// Warning plate - click anywhere or Esc to dismiss
export function showWarningModal(msg, heading = 'Warning') {
  const { overlay, plate, close } = openPlate({ heading, msg, role: 'alertdialog', dismissable: true })
  const hint = document.createElement('p')
  hint.className = 'plate-hint'
  hint.textContent = 'Esc or click anywhere to dismiss'
  plate.appendChild(hint)
  overlay.addEventListener('click', close)
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  })
  document.body.appendChild(overlay)
  plate.focus()
}

// Delete confirmation plate - resolves true only for an explicit Delete
export function showConfirmModal(msg, { heading = 'Delete', confirmLabel = 'Delete' } = {}) {
  return new Promise((resolve) => {
    const { overlay, plate, close } = openPlate({ heading, msg, role: 'alertdialog', dismissable: false })
    const finish = (result) => { close(); resolve(result) }

    const buttons = document.createElement('div')
    buttons.className = 'plate-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'plate-cancel'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.onclick = () => finish(false)
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = 'plate-delete'
    okBtn.textContent = confirmLabel
    okBtn.onclick = () => finish(true)
    buttons.append(cancelBtn, okBtn)
    plate.appendChild(buttons)

    // Clicking the scrim cancels
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false) })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    })
    document.body.appendChild(overlay)
    // Focus cancel by default for safety
    cancelBtn.focus()
  })
}

// Motion preference for scrollIntoView
export function scrollBehavior(){
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
