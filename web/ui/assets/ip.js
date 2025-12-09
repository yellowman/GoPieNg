export function maskFromCIDR(c){ 
  if (!c || typeof c !== 'string') return 0
  const parts = c.split('/')
  return parts.length > 1 ? Number(parts[1]) : 0 
}

function parseIP(ip){
  if (ip.includes(':')){ // ipv6
    let parts = ip.split('::')
    let head = parts[0] ? parts[0].split(':').map(x=>parseInt(x||'0',16)) : []
    let tail = parts[1] ? parts[1].split(':').map(x=>parseInt(x||'0',16)) : []
    let fill = new Array(8 - head.length - tail.length).fill(0)
    let arr = [...head, ...fill, ...tail]
    let bytes = []
    for (let i=0;i<8;i++){ bytes.push((arr[i]>>8)&0xff, arr[i]&0xff) }
    return { bytes, kind:'ipv6' }
  } else { // ipv4
    let oct = ip.split('.').map(x=>parseInt(x,10))
    return { bytes: oct, kind:'ipv4' }
  }
}

function bytesToBigInt(bytes){ let x=0n; for(const b of bytes){ x=(x<<8n)|BigInt(b&0xff) } return x }
function bigIntToBytes(x, n){ const out = new Array(n).fill(0); for(let i=n-1;i>=0;i--){ out[i]=Number(x&0xffn); x>>=8n } return out }
function bytesToIP(bytes, kind){
  if (kind==='ipv4'){ return bytes.join('.') }
  let arr=[]; for(let i=0;i<16;i+=2){ arr.push(((bytes[i]<<8)|bytes[i+1]).toString(16)) }
  // simple compress
  let s = arr.join(':').replace(/:?(?:0:){2,}/, '::')
  return s
}

export function cidrToRange(cidr){
  if (!cidr || typeof cidr !== 'string' || !cidr.includes('/')) {
    return { first: {bytes: [0,0,0,0], kind: 'ipv4'}, last: {bytes: [0,0,0,0], kind: 'ipv4'}, kind: 'ipv4' }
  }
  const [ip, mstr] = cidr.split('/'); const mask = Number(mstr)
  const {bytes, kind} = parseIP(ip)
  if (kind==='ipv4'){
    const base = bytes.reduce((n,b)=> (n<<8)|(b&0xff), 0) >>> 0
    const maskBits = mask===0?0:(~0 << (32-mask))>>>0
    const first = base & maskBits
    const last  = (first | (~maskBits>>>0))>>>0
    const f = [(first>>>24)&255,(first>>>16)&255,(first>>>8)&255,first&255]
    const l = [(last>>>24)&255,(last>>>16)&255,(last>>>8)&255,last&255]
    return { first:{bytes:f,kind}, last:{bytes:l,kind}, kind }
  } else {
    const base = bytesToBigInt(bytes)
    const hostBits = 128 - mask
    const netmask = ((1n<<128n)-1n) ^ ((1n<<BigInt(hostBits))-1n)
    const first = base & netmask
    const last  = first | (~netmask & ((1n<<128n)-1n))
    return { first:{bytes:bigIntToBytes(first,16),kind}, last:{bytes:bigIntToBytes(last,16),kind}, kind }
  }
}

export function cmpIP(a,b){
  const al=a.bytes, bl=b.bytes
  for (let i=0;i<al.length;i++){ if (al[i]!==bl[i]) return al[i]<bl[i]?-1:1 }
  return 0
}

export function contains(parent, child){
  if (!parent || !child) return false
  try {
    const pr = cidrToRange(parent); const cr = cidrToRange(child)
    return cmpIP(cr.first, pr.first) >= 0 && cmpIP(cr.last, pr.last) <= 0
  } catch(e) {
    return false
  }
}

export function overlaps(a,b){
  const ar = cidrToRange(a), br = cidrToRange(b)
  return !(cmpIP(ar.last, br.first) < 0 || cmpIP(br.last, ar.first) < 0)
}

export function cidrSize(c){
  if (!c || typeof c !== 'string') return 1n
  const bits = c.includes(':')?128n:32n
  const mask = BigInt(maskFromCIDR(c))
  return 1n << (bits - mask)
}

export function splitInto(parent, newMask){
  if (!parent || typeof parent !== 'string') return []
  const pm = maskFromCIDR(parent)
  if (newMask < pm) return [parent]
  const pr = cidrToRange(parent)
  const kind = pr.kind
  const out = []
  if (kind==='ipv4'){
    const f = pr.first.bytes
    const first = (f[0]<<24)|(f[1]<<16)|(f[2]<<8)|f[3]
    const n = 1 << (newMask - pm)
    const size = 1 << (32 - newMask)
    for (let i=0;i<n;i++){
      const base = (first + i*size)>>>0
      out.push([ (base>>>24)&255,(base>>>16)&255,(base>>>8)&255,base&255 ].join('.') + '/' + newMask)
    }
    return out
  } else {
    // cap to 256 tiles
    const delta = newMask - pm
    if (delta <= 8){
      const step = 1n << BigInt(128 - newMask)
      let cur = bytesToBigInt(pr.first.bytes)
      for (let i=0;i<(1<<delta); i++){
        const ip = bytesToIP(bigIntToBytes(cur,16),'ipv6')
        out.push(ip + '/' + newMask)
        cur += step
      }
    } else {
      const eff = pm + 8
      const step = 1n << BigInt(128 - eff)
      let cur = bytesToBigInt(pr.first.bytes)
      for (let i=0;i<256; i++){
        const ip = bytesToIP(bigIntToBytes(cur,16),'ipv6')
        out.push(ip + '/' + eff)
        cur += step
      }
    }
    return out
  }
}
