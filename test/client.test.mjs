// The library with no network: fetch is replaced by a stand-in service that checks signatures and chains.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { BASE, adopt, createIdentity, exportAll, exportRecord, family, loadIdentity, mark, push, pushedLine, pull, spawn, stats, stampLine, verifyLink, wake } from '../lib/client.mjs'
import { createFake } from './fake-service.mjs'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ok = (publicKey, text, signature) =>
  verify(null, Buffer.from(text), createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'))

let dir
let fake
let me

// Point fetch at the fake. A function can replace the whole answer for a test that needs one.
function useFake(f = fake) {
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(url.startsWith(BASE + '/api/v0/'), 'the client only talks to the base URL: ' + url)
    const { status, json } = f.handle(url.slice(BASE.length), JSON.parse(init.body))
    return new Response(JSON.stringify(json), { status })
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crittter-client-'))
  fake = createFake()
  useFake()
  me = createIdentity(join(dir, 'identity.key'))
})
afterEach(() => mock.restoreAll())

describe('identity', () => {
  it('writes a PEM key readable only by its owner, and derives the id from the raw public key', () => {
    const file = join(dir, 'deep', 'er', 'k.key')
    const made = createIdentity(file)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.match(readFileSync(file, 'utf8'), /^-----BEGIN PRIVATE KEY-----/)
    assert.equal(made.id, createHash('sha256').update(Buffer.from(made.public_key, 'base64')).digest('hex'))
    assert.equal(Buffer.from(made.public_key, 'base64').length, 32)
    assert.equal(loadIdentity(file).id, made.id)
  })

  it('never overwrites a key', () => {
    const file = join(dir, 'identity.key')
    const before = readFileSync(file, 'utf8')
    assert.throws(() => createIdentity(file), { code: 'EEXIST' })
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

describe('marks and the stamp line', () => {
  it('picks the critter from the first byte of the id, as the client and the service do', () => {
    assert.equal(mark('12682e23' + '0'.repeat(56)), '🦈 12682e23')
    assert.equal(mark('fdd68796' + '0'.repeat(56)), '🐀 fdd68796')
  })

  it('joins the parts with a middle dot', () => {
    assert.equal(stampLine('12682e23' + '0'.repeat(56), ['pushed seq 43', 'decision']), '🦈 12682e23 · pushed seq 43 · decision')
    assert.equal(pushedLine(me, { record: 'craft', seq: 4 }, 'note'), `${mark(me.id)} · pushed craft seq 4 · note`)
  })
})

describe('pull', () => {
  it('signs "crittter.ai pull v0:<id>:<ts>" with the key', async () => {
    await pull(me, { family: true })
    const { body } = fake.requests[0]
    assert.equal(body.public_key, me.public_key)
    assert.ok(Math.abs(body.ts - Date.now() / 1000) < 5)
    assert.ok(ok(me.public_key, `crittter.ai pull v0:${me.id}:${body.ts}`, body.signature))
    assert.equal(body.family, true)
  })

  it('returns the service error with its status instead of throwing', async () => {
    fake.inject(() => true, 403, { error: 'Not open yet.' })
    assert.deepEqual(await pull(me), { error: 'Not open yet.', status: 403 })
  })

  it('says so when nothing answers, or the answer is not JSON', async () => {
    mock.method(globalThis, 'fetch', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
    const down = await pull(me)
    assert.equal(down.status, 0)
    assert.match(down.error, /could not reach .*ENOTFOUND/)
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }))
    const bad = await pull(me)
    assert.equal(bad.status, 502)
    assert.match(bad.error, /not JSON/)
  })

  it('answers { error, status } for any status with a body that is not an object, never {} or a throw', async () => {
    const cases = [
      [500, '"oops"', { error: 'HTTP 500', status: 500 }],
      [500, 'null', { error: 'HTTP 500', status: 500 }],
      [502, '[1,2]', { error: 'HTTP 502', status: 502 }],
      [500, '{}', { error: 'HTTP 500', status: 500 }],
      [500, '{"error":{"nested":1}}', { error: 'HTTP 500', status: 500 }],
      [429, '{"error":"Too many requests."}', { error: 'Too many requests.', status: 429 }],
    ]
    for (const [status, body, want] of cases) {
      mock.restoreAll()
      mock.method(globalThis, 'fetch', async () => new Response(body, { status }))
      assert.deepEqual(await pull(me), want, `${status} ${body}`)
    }
    for (const body of ['null', '"text"', '7', '[]']) {
      mock.restoreAll()
      mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }))
      const got = await pull(me)
      assert.equal(got.status, 200, body)
      assert.match(got.error, /not an object/, body)
    }
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response('<html></html>', { status: 200 }))
    assert.equal((await pull(me)).status, 200, 'a 200 that is not JSON carries its status too')
  })

  it('treats a 200 with an error field as a failure that carries a status', async () => {
    fake.inject(() => true, 200, { error: 'Not today.' })
    assert.deepEqual(await pull(me), { error: 'Not today.', status: 200 })
  })
})

describe('push', () => {
  it('signs the payload text it sends, under the entry prefix, with a v1 payload that chains from nothing', async () => {
    const result = await push(me, { kind: 'decision', situation: 's', choice: 'c', reason: 'r', model: 'm' })
    assert.equal(result.ok, true)
    assert.equal(result.record, 'self')
    assert.equal(result.seq, 1)
    const { body } = fake.requests.find((r) => r.path === '/api/v0/push')
    assert.ok(ok(me.public_key, 'crittter.ai entry v0:' + body.payload, body.signature))
    const p = JSON.parse(body.payload)
    assert.deepEqual({ ...p, salt: undefined }, { v: 1, id: me.id, record: 'self', seq: 1, prev: null, salt: undefined, kind: 'decision', situation: 's', choice: 'c', reason: 'r', model: 'm' })
    assert.match(p.salt, /^[A-Za-z0-9_-]{22}$/)
    assert.equal(result.hash, createHash('sha256').update(body.payload).digest('hex'))
  })

  it('uses a fresh salt every time and chains each entry to the one before it', async () => {
    const a = await push(me, { kind: 'note', text: 'one' })
    const b = await push(me, { kind: 'note', text: 'two' })
    const [first, second] = fake.entries(me.id, 'self')
    assert.notEqual(first.salt, second.salt)
    assert.equal(second.seq, 2)
    assert.equal(second.prev, a.hash)
    assert.equal(b.seq, 2)
  })

  it('chains within each record: the head of craft is not the head of self', async () => {
    await push(me, { kind: 'note', text: 'a' })
    await push(me, { kind: 'note', text: 'b' })
    const c = await push(me, { record: 'craft', kind: 'note', text: 'c' })
    assert.equal(c.record, 'craft')
    assert.equal(c.seq, 1)
    assert.equal(fake.entries(me.id, 'craft')[0].prev, null)
    assert.deepEqual(Object.keys(fake.heads(me.id)).sort(), ['craft', 'self'])
  })

  it('takes the head it is given and does not pull again', async () => {
    const result = await push(me, { kind: 'note', text: 'x' }, null)
    assert.equal(result.seq, 1)
    assert.equal(fake.requests.filter((r) => r.path === '/api/v0/pull').length, 0)
  })

  it('rebuilds on the head a 409 carries, and tries again', async () => {
    const first = await push(me, { kind: 'note', text: 'first' })
    // Another run holding this key wrote since: this client's view of the head is stale.
    fake.inject((path) => path === '/api/v0/pull', 200, { records: {} })
    const result = await push(me, { kind: 'note', text: 'second' })
    assert.equal(result.ok, true)
    assert.equal(result.seq, 2)
    assert.equal(fake.entries(me.id, 'self')[1].prev, first.hash)
    assert.deepEqual(fake.pushes().map((p) => p.seq), [1, 1, 2], 'the second try was refused with the head, the third built on it')
  })

  it('gives up after three tries and reports the 409', async () => {
    for (let i = 0; i < 5; i++) fake.inject((path) => path === '/api/v0/push', 409, { error: 'moved', head: { seq: 1, hash: 'b'.repeat(64) } })
    const result = await push(me, { kind: 'note', text: 'x' }, null)
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.equal(fake.pushes().length, 3)
  })

  it('reports a refusal with the service sentence and writes nothing', async () => {
    const result = await push(me, { kind: 'note', text: 'REFUSE this' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.match(result.error, /looks like it contains a name/)
    assert.deepEqual(fake.heads(me.id), {})
  })

  it('lets a caller set nothing that is fixed: v, id, record, seq, prev and salt come last', async () => {
    const fixed = 'AAAAAAAAAAAAAAAAAAAAAA'
    const a = await push(me, { kind: 'note', text: 'one', salt: fixed, seq: 99, prev: 'f'.repeat(64), id: 'someone-else', v: 7 })
    const b = await push(me, { kind: 'note', text: 'two', salt: fixed })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const [first, second] = fake.entries(me.id, 'self')
    assert.equal(first.v, 1)
    assert.equal(first.id, me.id)
    assert.equal(first.record, 'self')
    assert.equal(first.seq, 1)
    assert.equal(first.prev, null)
    assert.notEqual(first.salt, fixed)
    assert.notEqual(second.salt, fixed)
    assert.notEqual(first.salt, second.salt)
    assert.equal(second.prev, a.hash)
  })

  it('refuses the runs and lineage records and the run, spawn and born kinds with one error, and sends nothing', async () => {
    const tries = [
      { record: 'runs', kind: 'note', text: 'x' },
      { record: 'lineage', kind: 'note', text: 'x' },
      { kind: 'run', where: 'forged' },
      { kind: 'spawn', child: 'a'.repeat(64), purpose: 'p' },
      { record: 'craft', kind: 'born', parent: 'a'.repeat(64) },
    ]
    const errors = new Set()
    for (const fields of tries) {
      const got = await push(me, fields)
      assert.equal(got.ok, false, JSON.stringify(fields))
      assert.equal(got.status, 0)
      errors.add(got.error)
    }
    assert.equal(errors.size, 1, 'one clear error')
    assert.match([...errors][0], /wake and spawn write those/)
    assert.equal(fake.requests.length, 0)
    // The ordinary records are still open.
    assert.equal((await push(me, { record: 'interface', kind: 'note', text: 'n', about: 'a format' })).ok, true)
  })

  it('does not take a 200 or a body without seq and hash for a recorded entry', async () => {
    fake.inject((path) => path === '/api/v0/push', 200, {})
    const odd = await push(me, { kind: 'note', text: 'x' }, null)
    assert.deepEqual({ ok: odd.ok, error: odd.error, status: odd.status }, { ok: false, error: 'HTTP 200', status: 200 })
    fake.inject((path) => path === '/api/v0/push', 201, { status: 'recorded' })
    const bare = await push(me, { kind: 'note', text: 'x' }, null)
    assert.equal(bare.ok, false)
    assert.equal(bare.status, 201)
    assert.match(bare.error, /no seq and hash/)
  })

  it('does not push on a pull that gave no record heads, and says so', async () => {
    fake.inject((path) => path === '/api/v0/pull', 200, {})
    const result = await push(me, { kind: 'note', text: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 200)
    assert.match(result.error, /no list of record heads/)
    assert.equal(fake.pushes().length, 0)
  })

  it('does not push when the head cannot be read', async () => {
    fake.inject((path) => path === '/api/v0/pull', 403, { error: 'Not open yet.' })
    const result = await push(me, { kind: 'note', text: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Not open yet.')
    assert.equal(fake.pushes().length, 0)
  })
})

describe('wake', () => {
  it('pulls with the words as the query, then writes one run entry on the runs head it was given', async () => {
    await wake(me, { where: 'before' })
    fake.requests.length = 0
    const woke = await wake(me, { words: 'some general words', model: 'a-model', where: 'a-place' })
    assert.equal(fake.requests.length, 2, 'one pull and one push, no second read of the head')
    assert.equal(fake.requests[0].body.query, 'some general words')
    const run = fake.entries(me.id, 'runs').at(-1)
    assert.deepEqual({ ...run, salt: undefined, prev: undefined }, { v: 1, id: me.id, record: 'runs', seq: 2, prev: undefined, salt: undefined, kind: 'run', model: 'a-model', where: 'a-place', words: 'some general words' })
    assert.deepEqual(woke.run, { record: 'runs', seq: 2, hash: fake.heads(me.id).runs.hash })
  })

  it('leaves out words and model when none are given, and says where as "mcp" by default', async () => {
    await wake(me)
    assert.equal('query' in fake.requests[0].body, false)
    const run = fake.entries(me.id, 'runs')[0]
    assert.equal(run.where, 'mcp')
    assert.equal('words' in run, false)
    assert.equal('model' in run, false)
  })

  it('builds the stamp line the client prints, from the pull', async () => {
    mock.method(Date, 'now', () => Date.UTC(2026, 8, 23, 9, 14, 30))
    await push(me, { kind: 'note', text: 'one' })
    const woke = await wake(me, { words: 'w' })
    assert.equal(woke.stamp, `${mark(me.id)} · woke 2026-09-23 09:14Z · seq 1 · 0 positions · 0 matches`)
  })

  it('counts positions, matches, awaiting outcome and the parent in the stamp', async () => {
    fake.inject((path) => path === '/api/v0/pull', 200, {
      id: me.id, parent: '12682e23' + '0'.repeat(56), records: {}, head: { seq: 42, hash: 'c'.repeat(64) },
      positions: [1, 2, 3, 4, 5, 6, 7], awaiting_outcome: [1], matches: [1, 2], checkpoint: null, pulled_at: 1,
    })
    const woke = await wake(me, { words: 'w' })
    assert.match(woke.stamp, / · seq 42 · 7 positions · 2 matches · 1 awaiting outcome · child of 🦈 12682e23$/)
    assert.equal(woke.verify, null, 'no checkpoint, no link')
  })

  it('returns the pull as it came, with stamp and verify first', async () => {
    const woke = await wake(me, { words: 'w' })
    assert.deepEqual(Object.keys(woke).slice(0, 3), ['stamp', 'verify', 'id'])
    for (const key of ['positions', 'awaiting_outcome', 'recent', 'matches', 'craft', 'interface', 'last_run', 'records', 'head', 'run']) assert.ok(key in woke, key)
  })

  it('returns the service error and writes nothing when the pull fails', async () => {
    fake.inject((path) => path === '/api/v0/pull', 403, { error: 'Not open yet.' })
    assert.deepEqual(await wake(me), { error: 'Not open yet.', status: 403 })
    assert.equal(fake.pushes().length, 0)
  })

  it('still wakes when the run entry is refused, and says the entry was not written', async () => {
    fake.inject((path) => path === '/api/v0/push', 403, { error: 'This identity is not admitted yet.' })
    const woke = await wake(me, { words: 'w' })
    assert.ok(woke.stamp)
    assert.deepEqual(woke.run, { error: 'This identity is not admitted yet.', status: 403 })
  })
})

describe('wake on answers that are not the record', () => {
  it('returns { error, status } for a 200 without the lists it reads, and writes no run', async () => {
    for (const body of [{}, { positions: [] }, { awaiting_outcome: 'x', positions: [] }]) {
      fake.inject((path) => path === '/api/v0/pull', 200, body)
      const got = await wake(me, { words: 'w' })
      assert.equal(got.status, 200)
      assert.match(got.error, /positions list and awaiting_outcome list/)
    }
    assert.equal(fake.pushes().length, 0)
  })

  it('returns { error, status } for a 200 that is null or a string', async () => {
    for (const body of ['null', '"nope"']) {
      mock.restoreAll()
      mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }))
      const got = await wake(me)
      assert.equal(got.status, 200)
      assert.equal(typeof got.error, 'string')
    }
  })

  it('does not trip on matches, parent or a checkpoint of the wrong shape', async () => {
    fake.inject((path) => path === '/api/v0/pull', 200, { positions: [], awaiting_outcome: [], matches: 'x', parent: 5, checkpoint: { seq: 1, signature: 5 }, records: 'x' })
    const got = await wake(me)
    assert.equal(got.error, undefined)
    assert.equal(got.verify, null)
    assert.equal(got.stamp.includes('matches'), false)
    assert.equal(got.stamp.includes('child of'), false)
  })
})

describe('verifyLink', () => {
  const checkpoint = { id: 'x', record: 'self', seq: 5, hash: 'd'.repeat(64), at: 1790000000, signature: 'ab+/cd==' }

  it('carries the stamp signature, never the pull signature, and the checkpoint as the service signed it', () => {
    const url = new URL(verifyLink(me, checkpoint, 1790000000))
    assert.equal(url.origin + url.pathname, BASE + '/v')
    const q = Object.fromEntries(url.searchParams)
    assert.deepEqual(Object.keys(q), ['k', 't', 'p', 'r', 's', 'h', 'a', 'c'])
    assert.equal(Buffer.from(q.k, 'base64url').toString('base64'), me.public_key)
    assert.deepEqual({ t: q.t, r: q.r, s: q.s, h: q.h, a: q.a, c: q.c }, { t: '1790000000', r: 'self', s: '5', h: 'd'.repeat(64), a: '1790000000', c: 'ab-_cd' })
    assert.ok(ok(me.public_key, `crittter.ai stamp v0:${me.id}:1790000000`, Buffer.from(q.p, 'base64url').toString('base64')))
    assert.ok(!ok(me.public_key, `crittter.ai pull v0:${me.id}:1790000000`, Buffer.from(q.p, 'base64url').toString('base64')))
    for (const value of url.searchParams.values()) assert.doesNotMatch(value, /[+/=]/, 'one spelling only: base64url without padding')
  })

  it('writes "none" for an empty record, and gives no link without a checkpoint', () => {
    assert.equal(new URL(verifyLink(me, { ...checkpoint, seq: 0, hash: null }, 1)).searchParams.get('h'), 'none')
    assert.equal(verifyLink(me, null, 1), null)
  })
})

describe('spawn', () => {
  it('names the child in the parent lineage, then writes its key, then signs born with the child key', async () => {
    const file = join(dir, 'children', 'kid.key')
    const result = await spawn(me, file, 'a purpose in general terms')
    assert.deepEqual(Object.keys(result), ['child_id', 'key_path', 'spawn_seq', 'born_seq'])
    assert.deepEqual({ ...result, child_id: undefined }, { child_id: undefined, key_path: file, spawn_seq: 1, born_seq: 1 })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const child = loadIdentity(file)
    assert.equal(child.id, result.child_id)
    const [spawned] = fake.entries(me.id, 'lineage')
    assert.deepEqual({ ...spawned, salt: undefined }, { v: 1, id: me.id, record: 'lineage', seq: 1, prev: null, salt: undefined, kind: 'spawn', child: child.id, purpose: 'a purpose in general terms' })
    const [born] = fake.entries(child.id, 'lineage')
    assert.deepEqual({ ...born, salt: undefined }, { v: 1, id: child.id, record: 'lineage', seq: 1, prev: null, salt: undefined, kind: 'born', parent: me.id })
  })

  it('leaves no key behind when the purpose is refused', async () => {
    const file = join(dir, 'children', 'kid.key')
    const result = await spawn(me, file, 'REFUSE')
    assert.equal(result.status, 400)
    assert.match(result.error, /name/)
    assert.equal(existsSync(file), false)
  })

  it('keeps the key and says so when only born is refused', async () => {
    const file = join(dir, 'kid.key')
    fake.inject((path, body) => path === '/api/v0/push' && JSON.parse(body.payload).kind === 'born', 503, { error: 'unavailable' })
    const result = await spawn(me, file, 'p')
    assert.match(result.error, /born entry was refused: unavailable/)
    assert.equal(result.status, 503)
    assert.equal(result.spawn_seq, 1)
    assert.equal(existsSync(file), true)
  })

  it('refuses to touch a key that exists', async () => {
    await assert.rejects(() => spawn(me, join(dir, 'identity.key'), 'p'), /already exists/)
    assert.equal(fake.pushes().length, 0)
  })

  it('also refuses a name taken by a dangling link, before any push, and creates nothing through it', async () => {
    const file = join(dir, 'children', 'dangling.key')
    await spawn(me, join(dir, 'children', 'other.key'), 'p')
    fake.requests.length = 0
    symlinkSync(join(dir, 'elsewhere'), file)
    await assert.rejects(() => spawn(me, file, 'p'), /already exists/)
    assert.equal(fake.requests.length, 0)
    assert.equal(existsSync(join(dir, 'elsewhere')), false)
  })

  it('reserves the key file before the spawn entry is pushed, and fills it only after the push succeeded', async () => {
    const file = join(dir, 'children', 'kid.key')
    const seen = []
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.endsWith('/push')) seen.push({ kind: JSON.parse(JSON.parse(init.body).payload).kind, exists: existsSync(file), size: existsSync(file) ? statSync(file).size : null })
      const { status, json } = fake.handle(url.slice(BASE.length), JSON.parse(init.body))
      return new Response(JSON.stringify(json), { status })
    })
    await spawn(me, file, 'p')
    assert.deepEqual(seen, [{ kind: 'spawn', exists: true, size: 0 }, { kind: 'born', exists: true, size: statSync(file).size }])
    assert.ok(statSync(file).size > 0)
  })

  it('removes the reserved file when the spawn push fails, whatever the failure', async () => {
    for (const [status, json] of [[400, { error: 'refused' }], [503, {}], [200, {}]]) {
      const file = join(dir, `kid-${status}.key`)
      fake.inject((path) => path === '/api/v0/push', status, json)
      const result = await spawn(me, file, 'p')
      assert.equal(typeof result.error, 'string')
      assert.equal(result.status, status)
      assert.equal(existsSync(file), false, String(status))
    }
  })

  it('lets only one of two spawns of the same name through, and names the child once', async () => {
    const file = join(dir, 'children', 'twin.key')
    const results = await Promise.allSettled([spawn(me, file, 'p'), spawn(me, file, 'p')])
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /already exists/)
    assert.equal(fake.entries(me.id, 'lineage').filter((e) => e.kind === 'spawn').length, 1)
    assert.equal(loadIdentity(file).id, results.find((r) => r.status === 'fulfilled').value.child_id)
  })
})

describe('adopt', () => {
  it('sorts and de-duplicates the seqs, which the service wants ascending, and pushes an adopt entry', async () => {
    const result = await adopt(me, 'craft', [9, 3, 3, 12])
    assert.deepEqual({ ...result, stamp: undefined }, { record: 'craft', seq: 1, adopted: [3, 9, 12], stamp: undefined })
    assert.equal(result.stamp, `${mark(me.id)} · pushed craft seq 1 · adopt 3`)
    assert.deepEqual(fake.entries(me.id, 'craft')[0].seqs, [3, 9, 12])
    assert.equal(fake.entries(me.id, 'craft')[0].kind, 'adopt')
  })

  it('returns the refusal', async () => {
    fake.inject((path) => path === '/api/v0/push', 400, { error: 'payload.seqs must name v0 entries of yours' })
    assert.deepEqual(await adopt(me, 'self', [1]), { error: 'payload.seqs must name v0 entries of yours', status: 400 })
  })
})

describe('export', () => {
  it('reads a record a page at a time, with the cursor, and keeps the last checkpoint', async () => {
    fake = createFake({ pageSize: 2 })
    mock.restoreAll()
    useFake()
    for (const n of [1, 2, 3, 4, 5]) await push(me, { kind: 'note', text: 'n' + n })
    fake.requests.length = 0
    const got = await exportRecord(me, 'self')
    assert.deepEqual(got.entries.map((e) => e.seq), [1, 2, 3, 4, 5])
    assert.deepEqual(fake.requests.map((r) => r.body.after), [0, 2, 4])
    assert.equal(got.checkpoint.seq, 5)
    assert.deepEqual(got.records.self.seq, 5)
  })

  it('exports every record the key holds, with the public key, the heads and a checkpoint per record', async () => {
    await push(me, { kind: 'note', text: 'a' })
    await push(me, { record: 'craft', kind: 'note', text: 'b' })
    const all = await exportAll(me)
    assert.deepEqual(Object.keys(all), ['id', 'public_key', 'heads', 'checkpoints', 'records', 'adopted'])
    assert.equal(all.id, me.id)
    assert.equal(all.public_key, me.public_key)
    assert.deepEqual(Object.keys(all.records).sort(), ['craft', 'self'])
    assert.deepEqual(Object.keys(all.checkpoints).sort(), ['craft', 'self'])
    assert.equal(all.heads.craft.seq, 1)
    // Each entry is exactly as signed: the payload and its signature check out.
    for (const e of [...all.records.self, ...all.records.craft]) assert.ok(ok(me.public_key, 'crittter.ai entry v0:' + e.payload, e.signature))
  })

  it('collects the adopted rows of a v0 export once each', async () => {
    const rows = [{ v0_seq: 1, record: 'self', adopted_seq: 1 }]
    fake.inject(() => true, 200, { entries: [{ seq: 1, payload: '{}' }], more: true, records: { v0: { seq: 1 } }, adopted: rows, checkpoint: null })
    fake.inject(() => true, 200, { entries: [{ seq: 2, payload: '{}' }], more: false, records: { v0: { seq: 2 } }, adopted: rows, checkpoint: { seq: 2 } })
    const got = await exportRecord(me, 'v0')
    assert.deepEqual(got.adopted, rows)
    assert.deepEqual(got.checkpoint, { seq: 2 })
  })

  it('stops with an error when a page does not advance the cursor', async () => {
    // more with nothing new
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ entries: [], records: {}, more: true }), { status: 200 }))
    await assert.rejects(() => exportRecord(me, 'self'), /did not advance/)
    assert.equal(globalThis.fetch.mock.callCount(), 1)
    // the same seq again
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ entries: [{ seq: 1, payload: null }], records: {}, more: true }), { status: 200 }))
    await assert.rejects(() => exportRecord(me, 'self'), /did not advance: after seq 1/)
    assert.equal(globalThis.fetch.mock.callCount(), 2)
    // a seq that goes backwards inside a page
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ entries: [{ seq: 2 }, { seq: 1 }], more: false }), { status: 200 }))
    await assert.rejects(() => exportRecord(me, 'self'), /did not advance/)
    // a last page that is empty and says nothing more is the end, not an error
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ entries: [], records: {}, more: false }), { status: 200 }))
    assert.deepEqual((await exportRecord(me, 'self')).entries, [])
  })

  it('stops after 1000 pages even when every page advances', async () => {
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async (url, init) => {
      const after = JSON.parse(init.body).after
      return new Response(JSON.stringify({ entries: [{ seq: after + 1, payload: null }], records: {}, more: true }), { status: 200 })
    })
    await assert.rejects(() => exportRecord(me, 'self'), /did not end after 1000 pages/)
    assert.equal(globalThis.fetch.mock.callCount(), 1000)
  })

  it('throws with the status when a page has no entries', async () => {
    fake.inject(() => true, 403, { error: 'Not open yet.' })
    await assert.rejects(() => exportRecord(me, 'self'), { message: 'Not open yet.', status: 403 })
  })
})

describe('family and stats on answers that are not the record', () => {
  it('family returns { error, status } for a 200 without children', async () => {
    fake.inject((path) => path === '/api/v0/pull', 200, {})
    assert.equal((await family(me)).status, 200)
    fake.inject((path) => path === '/api/v0/pull', 200, {})
    assert.match((await family(me)).error, /no list of children/)
  })

  it('stats throws with the status instead of a TypeError when family fails', async () => {
    let n = 0
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.family) return new Response('{}', { status: 200 })
      const { status, json } = fake.handle(url.slice(BASE.length), body)
      n++
      return new Response(JSON.stringify(json), { status })
    })
    await assert.rejects(() => stats(me), { status: 200, message: /no list of children/ })
    assert.ok(n > 0)
  })
})

describe('family and stats', () => {
  it('asks for the family view', async () => {
    const view = await family(me)
    assert.deepEqual(view.children, [])
    assert.equal(fake.requests[0].body.family, true)
  })

  it('counts decisions, their outcomes and the models over self', async () => {
    await push(me, { kind: 'decision', situation: 's', choice: 'c', reason: 'r', model: 'one' })
    await push(me, { kind: 'decision', situation: 's2', choice: 'c2', reason: 'r2' })
    await push(me, { kind: 'outcome', ref: 1, result: 'fine', model: 'two' })
    await push(me, { record: 'craft', kind: 'note', text: 'not judgment' })
    const s = await stats(me)
    assert.equal(s.entries, 3)
    assert.equal(s.decisions, 2)
    assert.equal(s.decisions_with_outcome, 1)
    assert.equal(s.outcomes_written_by_a_different_model_than_the_decision, 1)
    assert.deepEqual(s.by_kind, { decision: 2, outcome: 1 })
    assert.deepEqual(s.by_model, { one: 1, two: 1, '(not stated)': 1 })
    assert.deepEqual(s.records, { self: 3, craft: 1 })
    assert.equal(s.children, 0)
  })
})
