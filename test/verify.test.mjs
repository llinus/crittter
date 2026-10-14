// crittter-verify, run as a process on files, against an export built from the stand-in service with a
// service key of our own. Nothing touches the network.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BASE, createIdentity, exportAll, push, wake } from '../lib/client.mjs'
import { createFake } from './fake-service.mjs'

const BIN = fileURLToPath(new URL('../bin/crittter-verify.mjs', import.meta.url))
const rawKey = (keyObject) => createPublicKey(keyObject).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
const clone = (x) => JSON.parse(JSON.stringify(x))

let dir
let me
let service // the stand-in service's own key
let good // an export, as the export tool returns it with no record
let status // a saved /.well-known/crittter.json

function statusFor(key) {
  return {
    checkpoint_key: {
      key_type: 'ed25519', public_key: rawKey(key),
      message: 'crittter.ai checkpoint v1:<id>:<record>:<seq>:<hash or none>:<unix seconds>',
      message_v0: 'crittter.ai checkpoint v0:<id>:<seq>:<hash or none>:<unix seconds>',
    },
    checkpoint_keys: [rawKey(key)],
  }
}

// Runs the verifier on two files. Returns the exit code and what it said.
function run(exportData, statusData = status) {
  const exportFile = join(dir, 'export.json')
  const statusFile = join(dir, 'status.json')
  writeFileSync(exportFile, JSON.stringify(exportData))
  writeFileSync(statusFile, JSON.stringify(statusData))
  const r = spawnSync(process.execPath, [BIN, exportFile, statusFile], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crittter-verify-'))
  service = generateKeyPairSync('ed25519').privateKey
  const fake = createFake({ serviceKey: service })
  mock.method(globalThis, 'fetch', async (url, init) => {
    const { status: code, json } = fake.handle(url.slice(BASE.length), JSON.parse(init.body))
    return new Response(JSON.stringify(json), { status: code })
  })
  me = createIdentity(join(dir, 'identity.key'))
  await wake(me, { words: 'testing', model: 'test-model' })
  for (const text of ['one', 'two', 'three']) await push(me, { kind: 'note', text })
  await push(me, { record: 'craft', kind: 'note', text: 'a craft note' })
  good = await exportAll(me)
  status = statusFor(service)
  mock.restoreAll()
})

describe('crittter-verify', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crittter-verify-')) })
  afterEach(() => mock.restoreAll())

  it('has the shape the test relies on', () => {
    assert.deepEqual(Object.keys(good.records).sort(), ['craft', 'runs', 'self'])
    assert.equal(good.records.self.length, 3)
  })

  it('exits 0 on a complete export and says what it checked', () => {
    const r = run(good)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /3 chains, 5 entries, 5 entry signatures, 3 checkpoints verified; 0 redacted entries/)
    assert.match(r.out, /^PASS/m)
    assert.equal(r.err, '')
  })

  it('exits 1 when one payload is changed', () => {
    const bad = clone(good)
    bad.records.self[1].payload = bad.records.self[1].payload.replace('two', 'twp')
    const r = run(bad)
    assert.equal(r.code, 1)
    assert.match(r.err, /self\[2\]: stored hash differs from payload SHA-256/)
    assert.match(r.err, /self\[2\]: entry signature failed/)
    assert.doesNotMatch(r.out, /PASS/)
  })

  it('exits 1 when one signature is changed', () => {
    const bad = clone(good)
    const bytes = Buffer.from(bad.records.self[0].signature, 'base64')
    bytes[0] ^= 1
    bad.records.self[0].signature = bytes.toString('base64')
    const r = run(bad)
    assert.equal(r.code, 1)
    assert.match(r.err, /self\[1\]: entry signature failed/)
  })

  it('exits 1 when one chain link is wrong, even if every entry is signed and hashed correctly', () => {
    // The owner's key re-signs the self chain with entry 2 pointing at the wrong prev, and the later
    // entries, the head and the checkpoint follow from it. Only that one link is wrong.
    const bad = clone(good)
    const rows = bad.records.self
    let previous = rows[0].hash
    for (let i = 1; i < rows.length; i++) {
      const payload = JSON.stringify({ ...JSON.parse(rows[i].payload), prev: i === 1 ? 'f'.repeat(64) : previous })
      rows[i] = { ...rows[i], payload, hash: createHash('sha256').update(payload).digest('hex'), signature: me.sign('crittter.ai entry v0:' + payload) }
      previous = rows[i].hash
    }
    bad.heads.self = { seq: rows.length, hash: previous }
    const at = bad.checkpoints.self.at
    bad.checkpoints.self = { ...bad.checkpoints.self, hash: previous, signature: sign(null, Buffer.from(`crittter.ai checkpoint v1:${bad.id}:self:${rows.length}:${previous}:${at}`), service).toString('base64') }
    const r = run(bad)
    assert.equal(r.code, 1)
    assert.match(r.err, /self\[2\]: previous hash does not link to prior row/)
    assert.deepEqual(r.err.trim().split('\n').filter((l) => l.startsWith('FAIL')), ['FAIL self[2]: previous hash does not link to prior row'], r.err)
  })

  it('exits 1 when a checkpoint is changed, or signed by a key the status file does not publish', () => {
    const bad = clone(good)
    bad.checkpoints.self.at += 1
    const r = run(bad)
    assert.equal(r.code, 1)
    assert.match(r.err, /self\.checkpoint: signature failed against every published checkpoint key/)

    const other = run(good, statusFor(generateKeyPairSync('ed25519').privateKey))
    assert.equal(other.code, 1)
    assert.match(other.err, /signature failed against every published checkpoint key/)
  })

  it('exits 1 when an entry is left out, since the chain no longer reaches the head', () => {
    const bad = clone(good)
    bad.records.self.splice(1, 1)
    const r = run(bad)
    assert.equal(r.code, 1)
  })

  it('exits 2 when a removed entry has no payload: nothing failed, but it could not be checked', () => {
    const redacted = clone(good)
    Object.assign(redacted.records.self[1], { payload: null, signature: null, removed: '2026-10-11T12:00:00.000Z' })
    const r = run(redacted)
    assert.equal(r.code, 2)
    assert.match(r.err, /UNVERIFIABLE self\[2\]/)
    assert.doesNotMatch(r.out, /PASS/)
    assert.match(r.out, /1 redacted entries/)
  })

  it('a failure outranks an incomplete result', () => {
    const bad = clone(good)
    Object.assign(bad.records.self[1], { payload: null, signature: null, removed: 'x' })
    bad.records.self[0].payload += ' '
    assert.equal(run(bad).code, 1)
  })

  it('prints one line of usage and exits 1 without exactly two arguments', () => {
    for (const args of [[], ['export.json'], ['a', 'b', 'c']]) {
      const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^usage: crittter-verify <export file> <status file>/)
      assert.equal(r.stderr.trim().split('\n').length, 1)
    }
  })

  it('exits 1 with a plain message for a missing file or a file that is not JSON', () => {
    const notJson = join(dir, 'not.json')
    writeFileSync(notJson, 'nope')
    const missing = spawnSync(process.execPath, [BIN, join(dir, 'absent.json'), notJson], { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /export file: cannot read the file/)
    const bad = spawnSync(process.execPath, [BIN, notJson, notJson], { encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /export file: not valid JSON/)
  })
})
