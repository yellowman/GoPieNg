export const store = {
  message:null,
  error:null,
  roots: [],
  parentMap: {},
  childrenMap: {},
  browseParent: null,
  user: null,
  networks: [],
  selected: null,
  hosts: [],
  childrenCache: {},    // id -> [children]
  searchResults: [],
  currentPage: 'browse', // browse, allocs, logs
  listeners: new Set(),
  set(p){ Object.assign(this, p); this.emit() },
  on(fn){ this.listeners.add(fn); return ()=>this.listeners.delete(fn) },
  emit(){ this.listeners.forEach(fn=>fn(this)) }
}
