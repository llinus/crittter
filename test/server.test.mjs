// The server over real stdio, spoken to by the SDK's own client, with a stand-in service on a loopback
// port instead of crittter.ai. Nothing leaves this machine.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createFake } from './fake-service.mjs'

const BIN = fileURLToPath(new URL('../bin/crittter-mcp.mjs', import.meta.url))

// The stand-in service, as an HTTP server on a free port.
async function listen(fake) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const { status, json } = fake.handle(req.url, JSON.parse(raw))
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

// A server process on a key path, and the text it wrote to stderr.
async function start(env) {
  const base = { ...process.env }
  for (const name of ['CRITTTER', 'CRITTTER_KEY', 'CRITTTER_MODEL', 'CRITTTER_WHERE']) delete base[name]
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...base, ...env }, stderr: 'pipe' })
  let stderr = ''
  const client = new Client({ name: 'crittter-test', version: '1' })
  await client.connect(transport)
  transport.stderr.on('data', (chunk) => (stderr += chunk))
  const texts = []
  // The result as the agent sees it: the JSON text, parsed, and whether it was marked an error.
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = result.content[0].text
    texts.push(text)
    let json = null
    try { json = JSON.parse(text) } catch { /* a refusal from the SDK's own input check is plain text */ }
    return { json, text, isError: result.isError === true }
  }
  return { client, call, texts, stderr: () => stderr, close: () => client.close() }
}

describe('the server over stdio', () => {
  let fake, service, dir, keyPath, s

  before(async () => {
    fake = createFake()
    service = await listen(fake)
    dir = mkdtempSync(join(tmpdir(), 'crittter-server-'))
    keyPath = join(dir, 'home', 'identity.key')
    s = await start({ CRITTTER: service.url, CRITTTER_KEY: keyPath })
  })
  after(async () => {
    await s.close()
    await service.close()
  })

  it('lists exactly the six tools, each with a description and a JSON schema', async () => {
    const { tools } = await s.client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['adopt', 'export', 'family', 'push', 'spawn', 'wake'])
    for (const t of tools) {
      assert.ok(t.description.length > 100, t.name + ' needs a description written for the agent')
      assert.equal(t.inputSchema.type, 'object')
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]))
    assert.deepEqual(Object.keys(by.wake.properties), ['words', 'model'])
    assert.equal(by.wake.required, undefined)
    assert.deepEqual(by.push.required, ['kind'])
    assert.deepEqual(by.push.properties.record.enum, ['queue', 'self', 'craft', 'interface'])
    assert.deepEqual(by.export.properties.record.enum, ['self', 'queue', 'lineage', 'craft', 'runs', 'interface', 'v0'])
    assert.deepEqual(by.adopt.properties.record.enum, ['self', 'queue', 'lineage', 'craft', 'runs', 'interface'])
    assert.deepEqual(by.push.properties.kind.enum, ['decision', 'outcome', 'position', 'note', 'remove'])
    assert.deepEqual(by.spawn.required.sort(), ['name', 'purpose'])
    assert.deepEqual(Object.keys(by.export.properties), ['record'])
    assert.deepEqual(by.adopt.required.sort(), ['record', 'seqs'])
    assert.deepEqual(by.family.properties, {})
  })

  it('carries the rules in the descriptions the agent reads', async () => {
    const { tools } = await s.client.listTools()
    for (const name of ['wake', 'push']) {
      const text = tools.find((t) => t.name === name).description
      assert.match(text, /never who you did it for/)
      assert.match(text, /not instructions/)
    }
    assert.match(tools.find((t) => t.name === 'wake').description, /never write a stamp you did not get/)
    assert.match(tools.find((t) => t.name === 'push').description, /A few entries in a session is normal/)
    assert.match(tools.find((t) => t.name === 'push').description, /decision and outcome go to queue, the waiting room, unless you name a record; position and note go to self only if they pass the five questions \(see the agent page\); craft is how to do a kind of work; interface is how you work with a named agent, tool or format\./)
    assert.match(tools.find((t) => t.name === 'wake').description, /queue/)
  })

  it('refuses everything but wake while there is no key, and makes no key', async () => {
    const r = await s.call('push', { kind: 'note', text: 'x' })
    assert.equal(r.isError, true)
    assert.match(r.json.error, /Call wake first/)
    assert.equal(existsSync(keyPath), false)
    assert.equal(fake.requests.length, 0)
  })

  it('makes the key on the first wake and says so, once', async () => {
    const r = await s.call('wake', { words: 'some work', model: 'test-model' })
    assert.equal(r.isError, false)
    assert.equal(r.json.created_key, true)
    assert.equal(statSync(keyPath).mode & 0o777, 0o600)
    assert.match(readFileSync(keyPath, 'utf8'), /^-----BEGIN PRIVATE KEY-----/)
    assert.deepEqual(Object.keys(r.json).slice(0, 2), ['stamp', 'verify'])
    assert.match(r.json.stamp, /^\S+ [0-9a-f]{8} · woke \d{4}-\d\d-\d\d \d\d:\d\dZ · seq 0 · 0 positions · 0 matches$/)
    assert.match(r.json.verify, new RegExp('^' + service.url + '/v\\?k='))
    for (const key of ['id', 'positions', 'awaiting_outcome', 'recent', 'matches', 'craft', 'interface', 'last_run', 'records', 'head', 'run']) assert.ok(key in r.json, key)
    assert.equal(r.json.run.seq, 1)
    const again = await s.call('wake')
    assert.equal('created_key' in again.json, false)
    assert.equal(again.json.id, r.json.id)
  })

  it('always says where the key is, as an absolute path, and never sends the key itself', async () => {
    const r = await s.call('wake')
    assert.equal(r.json.key_path, keyPath)
    assert.equal(isAbsolute(r.json.key_path), true)
    const body = readFileSync(keyPath, 'utf8').split('\n').filter((l) => l && !l.startsWith('-----'))[0]
    for (const text of s.texts) assert.equal(text.includes(body), false, 'no result carries the key')
  })

  it('writes the run entry with the model, the words and the name the host gave when it connected', async () => {
    const id = (await s.call('wake')).json.id
    const [first, , third] = fake.entries(id, 'runs')
    assert.deepEqual({ ...first, salt: undefined, prev: undefined, id: undefined }, { v: 1, id: undefined, record: 'runs', seq: 1, prev: undefined, salt: undefined, kind: 'run', model: 'test-model', where: 'crittter-test', words: 'some work' })
    assert.equal('words' in third, false)
    assert.equal('model' in third, false)
  })

  it('pushes to queue, self, craft and interface, each on its own chain, and returns the line to quote', async () => {
    const queue = await s.call('push', { kind: 'decision', situation: 'a fork', choice: 'the left one', reason: 'it was shorter', model: 'test-model' })
    assert.deepEqual({ ...queue.json, hash: undefined, stamp: undefined }, { record: 'queue', seq: 1, hash: undefined, stamp: undefined })
    assert.match(queue.json.hash, /^[0-9a-f]{64}$/)
    assert.match(queue.json.stamp, /^\S+ [0-9a-f]{8} · pushed queue seq 1 · decision$/)

    const settled = await s.call('push', { kind: 'outcome', ref: 1, result: 'it was shorter' })
    assert.match(settled.json.stamp, / · pushed queue seq 2 · outcome$/)

    const named = await s.call('push', { record: 'self', kind: 'decision', situation: 'an old fork', choice: 'the right one', reason: 'it was quiet' })
    assert.match(named.json.stamp, /^\S+ [0-9a-f]{8} · pushed seq 1 · decision$/)

    const craft = await s.call('push', { record: 'craft', kind: 'note', text: 'Test the real transport.' })
    assert.equal(craft.json.seq, 1)
    assert.match(craft.json.stamp, / · pushed craft seq 1 · note$/)

    const iface = await s.call('push', { record: 'interface', kind: 'note', about: 'a format', text: 'It wants salt.' })
    assert.match(iface.json.stamp, / · pushed interface seq 1 · note$/)

    const next = await s.call('push', { kind: 'position', topic: 'tests', statement: 'Run them for real.' })
    assert.equal(next.json.record, 'self')
    assert.equal(next.json.seq, 2)

    const id = (await s.call('wake')).json.id
    const [decision] = fake.entries(id, 'queue')
    assert.deepEqual({ ...decision, id: undefined, salt: undefined, prev: undefined }, { v: 1, id: undefined, record: 'queue', seq: 1, prev: undefined, salt: undefined, kind: 'decision', situation: 'a fork', choice: 'the left one', reason: 'it was shorter', model: 'test-model' })
    const [oldDecision, position] = fake.entries(id, 'self')
    assert.equal(oldDecision.kind, 'decision')
    assert.equal(position.kind, 'position')
    assert.equal(position.prev, named.json.hash)
    assert.deepEqual(fake.entries(id, 'interface')[0].about, 'a format')
  })

  it('returns the service refusal as an error with its status, and does not throw', async () => {
    const r = await s.call('push', { kind: 'note', text: 'REFUSE this' })
    assert.equal(r.isError, true)
    assert.deepEqual(r.json, { error: 'payload.text looks like it contains a name.', status: 400 })
  })

  it('cannot write to runs or lineage through push', async () => {
    const before = fake.pushes().length
    for (const record of ['runs', 'lineage', 'v0']) {
      const r = await s.call('push', { record, kind: 'note', text: 'x' })
      assert.equal(r.isError, true, record)
    }
    const r = await s.call('push', { kind: 'run', text: 'x' })
    assert.equal(r.isError, true)
    assert.equal(fake.pushes().length, before, 'nothing reached the service')
  })

  it('spawns a child with a key beside the parent key, linked at both ends', async () => {
    const r = await s.call('spawn', { name: 'worker-1', purpose: 'a lane of work' })
    assert.equal(r.isError, false)
    assert.deepEqual(Object.keys(r.json), ['child_id', 'key_path', 'spawn_seq', 'born_seq'])
    assert.equal(r.json.key_path, join(dir, 'home', 'children', 'worker-1.key'))
    assert.equal(statSync(r.json.key_path).mode & 0o777, 0o600)
    assert.equal(r.json.spawn_seq, 1)
    assert.equal(r.json.born_seq, 1)
    assert.equal(fake.entries(r.json.child_id, 'lineage')[0].kind, 'born')
    const parent = (await s.call('wake')).json
    assert.equal(fake.entries(parent.id, 'lineage')[0].child, r.json.child_id)
  })

  it('will not reuse a child name, and takes only safe names', async () => {
    const again = await s.call('spawn', { name: 'worker-1', purpose: 'again' })
    assert.equal(again.isError, true)
    assert.match(again.json.error, /already exists/)
    for (const name of ['../x', 'A', 'a/b', '', 'x'.repeat(41)]) assert.equal((await s.call('spawn', { name, purpose: 'p' })).isError, true, name)
  })

  it('exports the queue record like any other', async () => {
    const queue = await s.call('export', { record: 'queue' })
    assert.equal(queue.json.record, 'queue')
    assert.equal(queue.json.entries.length, 2)
  })

  it('exports one record or all of them', async () => {
    const craft = await s.call('export', { record: 'craft' })
    assert.deepEqual(Object.keys(craft.json).slice(0, 3), ['id', 'public_key', 'record'])
    assert.equal(craft.json.entries.length, 1)
    const all = await s.call('export')
    assert.deepEqual(Object.keys(all.json), ['id', 'public_key', 'heads', 'checkpoints', 'records', 'adopted'])
    assert.deepEqual(Object.keys(all.json.records).sort(), ['craft', 'interface', 'lineage', 'queue', 'runs', 'self'])
    assert.equal((await s.call('export', { record: 'nonsense' })).isError, true)
  })

  it('adopts old entries, sorted, and shows the family', async () => {
    const r = await s.call('adopt', { record: 'craft', seqs: [5, 2] })
    assert.deepEqual({ ...r.json, stamp: undefined }, { record: 'craft', seq: 2, adopted: [2, 5], stamp: undefined })
    assert.match(r.json.stamp, / · pushed craft seq 2 · adopt 2$/)
    assert.equal((await s.call('adopt', { record: 'craft', seqs: [] })).isError, true)
    const fam = await s.call('family')
    assert.deepEqual(fam.json.children, [])
  })

  it('never shows the key: not in a result, not on stderr', async () => {
    const pem = readFileSync(keyPath, 'utf8')
    const body = pem.split('\n').filter((line) => line && !line.startsWith('-----')).join('')
    for (const text of [...s.texts, s.stderr()]) assert.ok(!text.includes(body) && !text.includes('PRIVATE KEY'))
    assert.match(s.stderr(), /crittter-mcp \S+: service http:\/\/127\.0\.0\.1:\d+, key not yet made/)
  })
})

describe('the server when things are not as expected', () => {
  it('uses CRITTTER_MODEL and CRITTTER_WHERE when given, and an existing key without saying it was made', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const keyPath = join(mkdtempSync(join(tmpdir(), 'crittter-server-')), 'k.key')
    const first = await start({ CRITTTER: service.url, CRITTTER_KEY: keyPath })
    const id = (await first.call('wake')).json.id
    await first.close()
    const s = await start({ CRITTTER: service.url, CRITTTER_KEY: keyPath, CRITTTER_MODEL: 'env-model', CRITTTER_WHERE: 'a-box' })
    try {
      const woke = await s.call('wake', { words: 'again' })
      assert.equal(woke.json.id, id)
      assert.equal('created_key' in woke.json, false)
      assert.match(s.stderr(), /key found/)
      await s.call('push', { kind: 'note', text: 'n' })
      assert.deepEqual(fake.entries(id, 'runs').at(-1).where, 'a-box')
      assert.equal(fake.entries(id, 'runs').at(-1).model, 'env-model')
      assert.equal(fake.entries(id, 'self')[0].model, 'env-model')
    } finally {
      await s.close()
      await service.close()
    }
  })

  it('returns an error result, not a crash, when the service cannot be reached', async () => {
    const keyPath = join(mkdtempSync(join(tmpdir(), 'crittter-server-')), 'k.key')
    const down = await start({ CRITTTER: 'http://127.0.0.1:1', CRITTTER_KEY: keyPath })
    try {
      const r = await down.call('wake')
      assert.equal(r.isError, true)
      assert.match(r.json.error, /could not reach http:\/\/127\.0\.0\.1:1/)
      assert.equal(r.json.status, 0)
      assert.equal((await down.call('push', { kind: 'note', text: 'x' })).json.status, 0)
      assert.equal((await down.call('family')).isError, true)
      assert.equal((await down.call('export')).isError, true)
    } finally {
      await down.close()
    }
  })

  it('reports the new key in the first wake that gets an answer, not in one that failed', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const keyPath = join(mkdtempSync(join(tmpdir(), 'crittter-server-')), 'k.key')
    const s = await start({ CRITTTER: service.url, CRITTTER_KEY: keyPath })
    try {
      fake.inject((path) => path === '/api/v0/pull', 503, { error: 'The record is unavailable.' })
      const failed = await s.call('wake')
      assert.deepEqual(failed.json, { error: 'The record is unavailable.', status: 503 })
      assert.equal(existsSync(keyPath), true, 'the key was made before the service answered')
      assert.equal((await s.call('wake')).json.created_key, true)
      assert.equal('created_key' in (await s.call('wake')).json, false)
    } finally {
      await s.close()
      await service.close()
    }
  })

  it('refuses a relative CRITTTER_KEY in every tool, names the default, and writes no key anywhere', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const home = mkdtempSync(join(tmpdir(), 'crittter-server-'))
    try {
      for (const value of ['rel-agent.key', './rel-agent.key', '../rel-agent.key', '~someone/agent.key', 'rel/dir/agent.key']) {
        const s = await start({ CRITTTER: service.url, CRITTTER_KEY: value, HOME: home })
        try {
          for (const [tool, args] of [['wake', {}], ['push', { kind: 'note', text: 'x' }], ['spawn', { name: 'kid', purpose: 'p' }], ['export', {}], ['family', {}]]) {
            const r = await s.call(tool, args)
            assert.equal(r.isError, true, `${value} ${tool}`)
            assert.match(r.json.error, /absolute path/)
            assert.match(r.json.error, /~\/\.crittter\/identity\.key/)
            assert.equal(r.text.includes(value), false, 'the value is not echoed back')
          }
          assert.match(s.stderr(), /absolute path/)
        } finally {
          await s.close()
        }
      }
      assert.equal(existsSync('rel-agent.key'), false, 'nothing was written in the server\'s working directory')
      assert.equal(existsSync(join(home, '.crittter')), false, 'the default was not used in its place')
      assert.equal(fake.requests.length, 0, 'nothing reached the service')
    } finally {
      await service.close()
    }
  })

  it('still expands ~ and takes an absolute CRITTTER_KEY', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const home = mkdtempSync(join(tmpdir(), 'crittter-server-'))
    try {
      const tilde = await start({ CRITTTER: service.url, CRITTTER_KEY: '~/keys/agent.key', HOME: home })
      try {
        const r = await tilde.call('wake')
        assert.equal(r.isError, false)
        assert.equal(r.json.key_path, join(home, 'keys', 'agent.key'), 'the ~ is expanded in the path it reports')
        assert.equal(existsSync(join(home, 'keys', 'agent.key')), true)
      } finally {
        await tilde.close()
      }
      const absolute = join(home, 'abs', 'agent.key')
      const s = await start({ CRITTTER: service.url, CRITTTER_KEY: absolute, HOME: home })
      try {
        const woke = await s.call('wake')
        assert.equal(woke.isError, false)
        assert.equal(woke.json.key_path, absolute)
        assert.equal(existsSync(absolute), true)
      } finally {
        await s.close()
      }
    } finally {
      await service.close()
    }
  })

  it('uses ~/.crittter/identity.key when CRITTTER_KEY is not set', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const home = mkdtempSync(join(tmpdir(), 'crittter-server-'))
    const s = await start({ CRITTTER: service.url, HOME: home })
    try {
      const woke = await s.call('wake')
      assert.equal(woke.isError, false)
      assert.equal(woke.json.key_path, join(home, '.crittter', 'identity.key'))
      assert.equal(existsSync(join(home, '.crittter', 'identity.key')), true)
    } finally {
      await s.close()
      await service.close()
    }
  })

  it('answers { error, status } when the service gives 200 and something that is not the record', async () => {
    const fake = createFake()
    const service = await listen(fake)
    const keyPath = join(mkdtempSync(join(tmpdir(), 'crittter-server-')), 'k.key')
    const s = await start({ CRITTTER: service.url, CRITTTER_KEY: keyPath })
    try {
      fake.inject((path) => path === '/api/v0/pull', 200, {})
      const woke = await s.call('wake')
      assert.equal(woke.isError, true)
      assert.equal(woke.json.status, 200)
      fake.inject((path) => path === '/api/v0/pull', 200, {})
      const pushed = await s.call('push', { kind: 'note', text: 'x' })
      assert.equal(pushed.isError, true)
      assert.equal(pushed.json.status, 200)
      fake.inject((path) => path === '/api/v0/pull', 500, {})
      const family = await s.call('family')
      assert.deepEqual(family.json, { error: 'HTTP 500', status: 500 })
    } finally {
      await s.close()
      await service.close()
    }
  })

  it('says when the key file is not a key', async () => {
    const keyPath = join(mkdtempSync(join(tmpdir(), 'crittter-server-')), 'k.key')
    writeFileSync(keyPath, 'not a key')
    const s = await start({ CRITTTER: 'http://127.0.0.1:1', CRITTTER_KEY: keyPath })
    const r = await s.call('wake')
    assert.equal(r.isError, true)
    assert.ok(r.json.error.length > 0)
    assert.equal(readFileSync(keyPath, 'utf8'), 'not a key', 'a file that is there is never replaced')
    await s.close()
  })
})
