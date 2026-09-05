import test from 'node:test'
import assert from 'node:assert/strict'
import { ChangeTracker, withoutDescendants, compareAddresses } from './refresh.js'

test('deferred or failed refreshes are not acknowledged', () => {
  const changes = new ChangeTracker()
  assert.equal(changes.needsRefresh(0), true)
  changes.acknowledge(0)
  assert.equal(changes.needsRefresh(0), false)
  assert.equal(changes.needsRefresh(1), true)
  // Editing or a failed fetch causes no acknowledgment.
  assert.equal(changes.needsRefresh(1), true)
  changes.acknowledge(1)
  assert.equal(changes.needsRefresh(1), false)
  assert.equal(changes.needsRefresh(0), true) // a restored/empty database
})

test('allocation invalidates cached descendants without losing other branches', () => {
  const original = [{ id: 1, parent: 0 }, { id: 2, parent: 1 }, { id: 3, parent: 2 }, { id: 4, parent: 0 }]
  assert.deepEqual(withoutDescendants(original, 1).map(n => n.id), [1, 4])
  assert.equal(original.length, 4)
})

test('numeric address ordering handles IPv4, IPv6 and embedded IPv4', () => {
  const values = ['2001:db8::10/64', '10.0.0.10/24', '2001:db8::2/64', '10.0.0.2/24']
  assert.deepEqual(values.sort(compareAddresses), ['10.0.0.2/24', '10.0.0.10/24', '2001:db8::2/64', '2001:db8::10/64'])
  assert.equal(compareAddresses('::ffff:192.0.2.1', '::ffff:c000:201'), 0)
})
