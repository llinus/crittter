// A stand-in for the service, for tests that must not touch the network. It checks what the real one
// checks that matters to a client: the signature, the id, the per-record chain (seq and prev). It
// answers 409 with the head when a record moved on, like the real one.
import { createHash, createPublicKey, sign, verify } from 'node:crypto'

const RECORDS = ['self', 'queue', 'lineage', 'craft', 'runs', 'interface']
const sha = (text) => createHash('sha256').update(text).digest('hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function check(publicKey, text, signature) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' })
  return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64'))
}

// With a serviceKey (an Ed25519 private key) the checkpoints are really signed, as the real service signs them;
// without one the signature is a placeholder.
export function createFake({ pageSize = 1000, serviceKey = null } = {}) {
  const chains = new Map() // id -> { record -> [{ payload, signature, hash }] }
  const parents = new Map() // child id -> parent id, from a spawn the parent signed
  const requests = [] // everything that arrived, in order
  const injected = [] // [{ match(path, body), status, json }], each used once

  const chain = (id, record) => chains.get(id)?.[record] ?? []
  const heads = (id) => Object.fromEntries(Object.entries(chains.get(id) ?? {}).map(([r, list]) => [r, { seq: list.length, hash: list.at(-1).hash }]))
  const checkpoint = (id, record, at) => {
    const seq = chain(id, record).length
    const hash = chain(id, record).at(-1)?.hash ?? null
    const signature = serviceKey ? sign(null, Buffer.from(`crittter.ai checkpoint v1:${id}:${record}:${seq}:${hash ?? 'none'}:${at}`), serviceKey).toString('base64') : 'AAAA'
    return { id, record, seq, hash, at, signature }
  }

  function pullView(id, body) {
    const h = heads(id)
    const view = {
      id, notice: 'fake', parent: parents.get(id) ?? null, records: h, head: h.self ?? null,
      positions: [], awaiting_outcome: [], recent: [], craft: [], interface: [], last_run: null,
      checkpoint: checkpoint(id, 'self', body.ts), pulled_at: body.ts,
    }
    if (body.query) view.matches = []
    if (body.family) view.children = []
    if (body.export) {
      const record = body.record ?? 'self'
      const list = chain(id, record).slice(body.after ?? 0)
      const page = list.slice(0, pageSize)
      return { id, public_key: body.public_key, record, records: h, entries: page.map((e, i) => ({ seq: (body.after ?? 0) + i + 1, ...e, at: '2026-10-11T12:00:00.000Z', removed: null })),
        adopted: record === 'v0' ? [] : undefined, more: list.length > page.length, checkpoint: checkpoint(id, record, body.ts), pulled_at: body.ts }
    }
    return view
  }

  function handle(path, body) {
    requests.push({ path, body })
    const hit = injected.findIndex((x) => x.match(path, body))
    if (hit >= 0) { const { status, json } = injected.splice(hit, 1)[0]; return { status, json } }
    const id = createHash('sha256').update(Buffer.from(body.public_key, 'base64')).digest('hex')
    if (path === '/api/v0/pull') {
      if (!check(body.public_key, `crittter.ai pull v0:${id}:${body.ts}`, body.signature)) return { status: 401, json: { error: 'bad signature' } }
      return { status: 200, json: pullView(id, body) }
    }
    if (path !== '/api/v0/push') return { status: 404, json: { error: 'no such route' } }
    if (!check(body.public_key, 'crittter.ai entry v0:' + body.payload, body.signature)) return { status: 400, json: { error: 'bad signature' } }
    const p = JSON.parse(body.payload)
    if (p.v !== 1 || p.id !== id || !RECORDS.includes(p.record)) return { status: 400, json: { error: 'payload.v must be 1 and payload.record one of: ' + RECORDS.join(', ') } }
    if (!/^[A-Za-z0-9_-]{22,44}$/.test(p.salt ?? '')) return { status: 400, json: { error: 'payload.salt is required' } }
    if (JSON.stringify(p).includes('REFUSE')) return { status: 400, json: { error: 'payload.text looks like it contains a name.' } }
    const list = chain(id, p.record)
    const head = list.at(-1)
    if (p.seq !== list.length + 1 || p.prev !== (head?.hash ?? null)) return { status: 409, json: { error: 'That record has moved on.', head: head ? { seq: list.length, hash: head.hash } : null } }
    if (p.kind === 'born' && parents.get(id) !== p.parent) return { status: 400, json: { error: 'payload.parent has not named this child.' } }
    const hash = sha(body.payload)
    chains.set(id, { ...chains.get(id), [p.record]: [...list, { payload: body.payload, signature: body.signature, hash }] })
    if (p.kind === 'spawn') parents.set(p.child, id)
    return { status: 201, json: { status: 'recorded', record: p.record, seq: p.seq, hash } }
  }

  return {
    handle, requests, chain, heads,
    // The entries a record holds, parsed, oldest first.
    entries: (id, record) => chain(id, record).map((e) => JSON.parse(e.payload)),
    // The next request that matches gets this answer instead of the real one.
    inject: (match, status, json) => injected.push({ match, status, json }),
    pushes: () => requests.filter((r) => r.path === '/api/v0/push').map((r) => JSON.parse(r.body.payload)),
  }
}
