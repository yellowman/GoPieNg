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


let _toast;
export function notify(msg, type='info', timeout=3500){
  if (!_toast){
    _toast = document.createElement('div')
    _toast.id = 'toast'
    _toast.style.cssText = 'position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:9999;'
    document.body.appendChild(_toast)
  }
  const el = document.createElement('div')
  el.className = 'toast ' + type
  el.textContent = msg
  el.style.cssText = 'background:#1b1b1b;border:1px solid #333;color:#eee;padding:8px 12px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.35);font-size:13px;'
  _toast.appendChild(el)
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(6px)'; setTimeout(()=> el.remove(), 200) }, timeout)
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
  el.textContent = msg
  root.appendChild(el)
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(6px)'; setTimeout(()=> el.remove(), 200) }, timeout)
}

// Modal warning - centered, click anywhere to dismiss
export function showWarningModal(msg) {
  const overlay = document.createElement('div')
  overlay.className = 'warning-modal-overlay'
  
  const modal = document.createElement('div')
  modal.className = 'warning-modal'
  modal.textContent = msg
  
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  
  const dismiss = () => {
    overlay.remove()
  }
  overlay.addEventListener('click', dismiss)
}
