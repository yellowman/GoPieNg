import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// Every internal import and the entry assets share one version. A mismatch
// would load the same module twice (separate state), and a missing version
// lets a browser reuse modules cached from an older release.
test('module graph carries one asset version', () => {
  const dir = new URL('.', import.meta.url)
  const html = readFileSync(new URL('../index.html', dir), 'utf8')
  const entry = [...html.matchAll(/(?:css\/styles\.css|js\/app\.js)\?v=(\d+)/g)].map(m => m[1])
  assert.equal(entry.length, 2, 'index.html versions styles.css and app.js')
  const version = entry[0]
  assert.equal(entry[1], version, 'entry assets share a version')
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8')
    for (const [, spec] of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      assert.match(spec, new RegExp(`\\.js\\?v=${version}$`), `${file} imports ${spec} without ?v=${version}`)
    }
  }
})
