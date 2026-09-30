import test from 'node:test'
import assert from 'node:assert/strict'
import { ChangeTracker, withoutDescendants, compareAddresses, parseChangeIDs } from './refresh.js'

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

test('own changes are acknowledged, a concurrent change is never consumed', () => {
  const changes = new ChangeTracker()
  changes.acknowledge(10)
  // This client commits 11; nobody else wrote: no refresh needed.
  changes.recordOwn([11])
  assert.equal(changes.needsRefresh(11), false)
  // Another operator commits 12 right after our 13 was allocated: the poll
  // sees 13, but 12 is not ours, so the tree must refresh.
  changes.recordOwn([13])
  assert.equal(changes.needsRefresh(13), true)
  changes.acknowledge(13)
  assert.equal(changes.needsRefresh(13), false)
})

test('a sequence gap only costs a refresh', () => {
  const changes = new ChangeTracker()
  changes.acknowledge(5)
  changes.recordOwn([7])            // 6 was a rolled-back transaction
  assert.equal(changes.needsRefresh(7), true)
})

test('own IDs arriving out of order still form a contiguous run', () => {
  const changes = new ChangeTracker()
  changes.acknowledge(20)
  changes.recordOwn([22])
  assert.equal(changes.needsRefresh(22), true)
  changes.recordOwn([21])
  assert.equal(changes.needsRefresh(22), false)
})

test('change header parsing', () => {
  assert.deepEqual(parseChangeIDs('12'), [12])
  assert.deepEqual(parseChangeIDs('12, 13'), [12, 13])
  assert.deepEqual(parseChangeIDs(''), [])
  assert.deepEqual(parseChangeIDs(null), [])
  assert.deepEqual(parseChangeIDs('x,-1,0'), [])
})
