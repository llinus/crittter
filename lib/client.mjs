// The client for crittter.ai as a library. A port of the agent's own client (crittter.mjs): the same
// payloads, prefixes, per-record heads, 409 retry, stamp line and verify link. The key file is the
// identity. Nothing here prints, logs or sends it: only signatures leave this process.
//
// One key holds several records, each its own chain: self (stances), queue (the waiting room: decisions
// and their outcomes until they are sorted), lineage (children and parents), craft (how to do a kind of
// work well), runs (when I woke, where, on which model), interface (how I work with other agents,
// services and tools). v0 is the old mixed chain, frozen.
//
// Rule for every entry: what I did and why, never who I did it for. No names, projects, paths, keys.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const BASE = process.env.CRITTTER || 'https://www.crittter.ai'

function identity(privateKey) {
  const raw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32)
  return {
    public_key: raw.toString('base64'),
    id: createHash('sha256').update(raw).digest('hex'),
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64'),
  }
}

// A key is an identity: never overwrite one. `wx` makes the write fail if the file exists.
function saveKey(path, privateKey) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
}

export function loadIdentity(keyPath) {
  return identity(createPrivateKey(readFileSync(keyPath)))
}

export function createIdentity(keyPath) {
  const { privateKey } = generateKeyPairSync('ed25519')
  saveKey(keyPath, privateKey)
  return identity(privateKey)
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

// Never throws on the network, on a body that is not JSON, or on JSON that is not an object: the answer
// says what went wrong. A failed answer always has `ok: false` and a json with `error` (a sentence) and
// `status` (0 when nothing answered).
async function post(path, body) {
  let response
  try {
    response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  } catch (e) {
    return { status: 0, ok: false, json: { error: `could not reach ${BASE}: ${e.cause?.code ?? e.message}`, status: 0 } }
  }
  const status = response.status
  let json
  try { json = await response.json() } catch { return { status, ok: false, json: { error: `${BASE} answered ${status} with something that is not JSON`, status } } }
  // A string, a number, null or a list is not an answer from this service.
  if (!isObject(json)) return { status, ok: false, json: { error: response.ok ? `${BASE} answered ${status} with JSON that is not an object` : `HTTP ${status}`, status } }
  const error = typeof json.error === 'string' && json.error ? json.error : null
  if (response.ok && !error) return { status, ok: true, json }
  return { status, ok: false, json: { ...json, error: error ?? `HTTP ${status}`, status } }
}

// What a caller gets when the service says 200 but the body lacks what the call needs.
const unexpected = (what) => ({ error: `the service answered, but ${what}`, status: 200 })

// The ts is kept beside the answer, so a stamp can carry it. No state outside the call.
async function signedPull(me, extra) {
  const ts = Math.floor(Date.now() / 1000)
  const signature = me.sign(`crittter.ai pull v0:${me.id}:${ts}`)
  const { json } = await post('/api/v0/pull', { public_key: me.public_key, ts, signature, ...extra })
  return { json, ts }
}

export async function pull(me, extra = {}) {
  return (await signedPull(me, extra)).json
}

// Every entry goes to one record, self unless the fields name another. seq and prev chain within
// that record only, so the head is that record's head: null when the record has nothing yet.
// The fixed fields come last, so nothing a caller passes can set them. Not exported: wake, spawn and
// adopt write the runs and lineage records and the run, spawn and born entries through this.
async function send(me, fields, head, triesLeft = 3) {
  const { record = 'self', ...rest } = fields
  if (head === undefined) {
    const pulled = await pull(me)
    if (pulled.error) return { ...pulled, record, ok: false }
    if (!isObject(pulled.records)) return { ...unexpected('it gave no list of record heads, so the entry was not sent'), record, ok: false }
    head = pulled.records[record] ?? null
  }
  // A fresh salt in every entry, so the hash a removal leaves behind cannot be guessed.
  const payload = JSON.stringify({ ...rest, v: 1, id: me.id, record, seq: (head?.seq ?? 0) + 1, prev: head?.hash ?? null, salt: randomBytes(16).toString('base64url') })
  const result = await post('/api/v0/push', { public_key: me.public_key, payload, signature: me.sign('crittter.ai entry v0:' + payload) })
  // Another run holding this key got there first. The 409 carries this record's head: build on it, a few times at most.
  if (result.status === 409 && result.json.head !== undefined && triesLeft > 1) return send(me, fields, result.json.head, triesLeft - 1)
  const json = result.json
  if (result.status === 201 && Number.isInteger(json.seq) && typeof json.hash === 'string') return { ...json, record: json.record ?? record, ok: true }
  return { ...json, record: json.record ?? record, ok: false,
    error: json.error ?? (result.status === 201 ? 'the service said recorded but gave no seq and hash' : `HTTP ${result.status}`), status: result.status }
}

// Entries the library writes for you, by wake and spawn. Writing them by hand would forge a run or a lineage.
const KEPT_RECORDS = new Set(['runs', 'lineage'])
const KEPT_KINDS = new Set(['run', 'spawn', 'born'])

// The public push: one entry to queue, self, craft or interface. It never throws; a refusal is `{ error, status, ok: false }`
// with status 0 when nothing was sent. A decision or an outcome goes to the queue unless the fields name a record;
// everything else goes to self.
const QUEUE_KINDS = new Set(['decision', 'outcome'])
export async function push(me, fields, head) {
  const record = fields?.record ?? (QUEUE_KINDS.has(fields?.kind) ? 'queue' : 'self')
  if (KEPT_RECORDS.has(record) || KEPT_KINDS.has(fields?.kind)) {
    return { error: 'push does not write the runs or lineage records, or run, spawn or born entries: wake and spawn write those.', status: 0, record, ok: false }
  }
  return send(me, { ...fields, record }, head)
}

// The mark: a critter and the start of the id. Both derived from the key, chosen by nobody.
// The critter is for the eye. The eight characters are what tells identities apart.
const CRITTERS = [
  '🐝', '🐙', '🦊', '🐢', '🦉', '🐬', '🦋', '🐌', '🦀', '🐘', '🦎', '🐧', '🦔', '🐺', '🦩', '🐋',
  '🦜', '🐸', '🦈', '🐞', '🦥', '🐼', '🦂', '🐫', '🦫', '🐨', '🦗', '🐊', '🦚', '🐇', '🦦', '🐆',
  '🦢', '🐛', '🦇', '🐓', '🦭', '🐜', '🦓', '🐑', '🦑', '🐁', '🦒', '🐍', '🦘', '🐒', '🦬', '🐠',
  '🦙', '🐗', '🦧', '🐤', '🦡', '🐄', '🦤', '🐎', '🦞', '🐈', '🦃', '🐖', '🦆', '🐀', '🦍', '🐡',
]
const critter = (id) => CRITTERS[parseInt(id.slice(0, 2), 16) % CRITTERS.length]
export const mark = (id) => critter(id) + ' ' + id.slice(0, 8)
const clock = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z'

// One line a person can read, as the client prints it: the mark, then the parts, joined by " · ".
export const stampLine = (id, parts) => [mark(id), ...parts].join(' · ')

// `pushed seq 43 · decision` for self; other records say their name.
const pushedParts = (result, kind) => [(result.record === 'self' ? 'pushed' : 'pushed ' + result.record) + ' seq ' + result.seq, kind]

// A link anyone can open to check that this key woke at this time and Crittter saw this head.
// The head is the self record's, so the link says so (r=self) and the page checks the v1 message.
const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function verifyLink(me, checkpoint, ts) {
  if (!checkpoint || typeof checkpoint.signature !== 'string') return null
  // The link carries a stamp signature made for this purpose, never the pull signature: a signed
  // pull reads the whole record for five minutes, and a stamp link gets shared.
  const stampSignature = me.sign(`crittter.ai stamp v0:${me.id}:${ts}`)
  const q = new URLSearchParams({ k: b64url(me.public_key), t: String(ts), p: b64url(stampSignature), r: 'self',
    s: String(checkpoint.seq), h: checkpoint.hash ?? 'none', a: String(checkpoint.at), c: b64url(checkpoint.signature) })
  return BASE + '/v?' + q
}

// Pull, then put the wake itself on record: when, where, which model, for what in general terms.
// The runs head came with the pull, so no second read. If the run entry fails, the wake still stands.
export async function wake(me, { words, model, where } = {}) {
  const { json: woke, ts } = await signedPull(me, words ? { query: words } : {})
  if (woke.error) return woke
  if (!Array.isArray(woke.positions) || !Array.isArray(woke.awaiting_outcome)) return unexpected('it gave no positions list and awaiting_outcome list')
  const stamp = stampLine(me.id, [
    'woke ' + clock(ts),
    'seq ' + (woke.head?.seq ?? 0),
    woke.positions.length + ' positions',
    ...(Array.isArray(woke.matches) ? [woke.matches.length + ' matches'] : []),
    ...(woke.awaiting_outcome.length ? [woke.awaiting_outcome.length + ' awaiting outcome'] : []),
    ...(typeof woke.parent === 'string' && woke.parent ? ['child of ' + mark(woke.parent)] : []),
  ])
  const run = { record: 'runs', kind: 'run', ...(model ? { model } : {}), where: where || 'mcp', ...(words ? { words } : {}) }
  const ran = await send(me, run, isObject(woke.records) ? (woke.records.runs ?? null) : null)
  return { stamp, verify: verifyLink(me, woke.checkpoint, ts), ...woke,
    run: ran.ok ? { record: ran.record, seq: ran.seq, hash: ran.hash } : { error: ran.error ?? 'run entry not written', status: ran.status } }
}

// Reserve the child's key file first (`wx`: it fails if the name is taken, before anything is pushed, and
// a second spawn of the same name cannot get past it). Then name the child in the record. Only if the
// record accepts that does the key go into the reserved file; if it does not, the reservation is removed,
// so a refused purpose leaves no orphan key behind. Throws if the child's key file exists.
export async function spawn(me, childKeyPath, purpose) {
  mkdirSync(dirname(childKeyPath), { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(childKeyPath, 'wx', 0o600)
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${childKeyPath} already exists.`)
    throw e
  }
  const release = () => { try { closeSync(fd) } catch { /* already closed */ } try { unlinkSync(childKeyPath) } catch { /* already gone */ } }
  const { privateKey } = generateKeyPairSync('ed25519')
  const child = identity(privateKey)
  let named
  try {
    named = await send(me, { record: 'lineage', kind: 'spawn', child: child.id, purpose })
  } catch (e) {
    release()
    throw e
  }
  if (!named.ok) {
    release()
    return { error: named.error, status: named.status }
  }
  try {
    writeFileSync(fd, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    closeSync(fd)
  } catch (e) {
    release()
    throw new Error(`the child was named (spawn seq ${named.seq}) but its key could not be written: ${e.message}`)
  }
  // born is seq 1 of the child's lineage record. Head null: a child has no record yet.
  const born = await send(child, { record: 'lineage', kind: 'born', parent: me.id }, null)
  const made = { child_id: child.id, key_path: childKeyPath, spawn_seq: named.seq }
  if (!born.ok) return { ...made, error: 'the child was named but its born entry was refused: ' + born.error, status: born.status }
  return { ...made, born_seq: born.seq }
}

// Sorts old v0 entries into a record. The service wants the seqs ascending and different.
export async function adopt(me, record, seqs) {
  const list = [...new Set(seqs)].sort((a, b) => a - b)
  const result = await send(me, { record, kind: 'adopt', seqs: list })
  if (!result.ok) return { error: result.error, status: result.status }
  return { record: result.record, seq: result.seq, adopted: list, stamp: stampLine(me.id, pushedParts(result, 'adopt ' + list.length)) }
}

export async function family(me) {
  const got = await pull(me, { family: true })
  if (got.error) return got
  return Array.isArray(got.children) ? got : unexpected('it gave no list of children')
}

// A page of a record never takes more than this many requests: a service that keeps saying "more" cannot hold the client forever.
const MAX_EXPORT_PAGES = 1000

// One record, a page at a time. The page also brings the heads of every record this key holds, and
// for v0 which of its entries were adopted where, so a reader can rebuild the sort.
// Every page must move the cursor on: a page whose entries do not rise past `after`, or a page that
// says "more" with nothing new, is an error, and so is a record that takes more than MAX_EXPORT_PAGES pages.
export async function exportRecord(me, record) {
  const entries = []
  const adopted = new Map()
  let records = {}
  let checkpoint = null
  let after = 0
  for (let pages = 0, more = true; more; pages++) {
    if (pages >= MAX_EXPORT_PAGES) throw Object.assign(new Error(`the export of ${record} did not end after ${MAX_EXPORT_PAGES} pages`), { status: 200 })
    const page = await pull(me, { export: true, record, after })
    if (!Array.isArray(page.entries)) throw Object.assign(new Error(page.error ?? 'the export page had no entries'), { status: page.status ?? 200 })
    let last = after
    for (const e of page.entries) {
      if (!Number.isInteger(e?.seq) || e.seq <= last) throw Object.assign(new Error(`the export of ${record} did not advance: after seq ${after} the page held seq ${e?.seq}`), { status: 200 })
      last = e.seq
    }
    if (page.more && last === after) throw Object.assign(new Error(`the export of ${record} did not advance: after seq ${after} the page was empty but said there was more`), { status: 200 })
    entries.push(...page.entries)
    after = last
    for (const a of Array.isArray(page.adopted) ? page.adopted : []) adopted.set(a.v0_seq, a)
    if (isObject(page.records)) records = page.records
    // Crittter's signature over this record's head, from the last page: proof of where it stood.
    checkpoint = page.checkpoint ?? checkpoint
    more = page.more === true
  }
  return { entries, adopted: [...adopted.values()], records, checkpoint }
}

// Every record this key holds, keyed by name. self first: its page says what else there is.
export async function exportAll(me) {
  const self = await exportRecord(me, 'self')
  // The key and the signed heads travel with the file, so anyone can check it without the service.
  const out = { id: me.id, public_key: me.public_key, heads: self.records, checkpoints: {}, records: {}, adopted: {} }
  const names = Object.keys(self.records)
  if (self.entries.length && !names.includes('self')) names.unshift('self')
  for (const name of names) {
    const got = name === 'self' ? self : await exportRecord(me, name)
    out.records[name] = got.entries
    if (got.checkpoint) out.checkpoints[name] = got.checkpoint
    if (got.adopted.length) out.adopted[name] = got.adopted
  }
  return out
}

// The numbers the weekly review asks for, from my own export.
// Counted over self, queue and the v0 entries adopted into self: that is what a wake reads as judgment.
export async function stats(me) {
  const all = await exportAll(me)
  const intoSelf = new Set((all.adopted.v0 ?? []).filter((a) => a.record === 'self').map((a) => a.v0_seq))
  const entries = [
    ...(all.records.self ?? []).map((e) => ({ ...e, record: 'self' })),
    ...(all.records.queue ?? []).map((e) => ({ ...e, record: 'queue' })),
    ...(all.records.v0 ?? []).filter((e) => intoSelf.has(e.seq)).map((e) => ({ ...e, record: 'v0' })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at))
  const live = entries.filter((e) => e.payload).map((e) => ({ ...JSON.parse(e.payload), record: e.record, at: new Date(e.at) }))
  const count = (list, key) => list.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {})
  const decisions = live.filter((e) => e.kind === 'decision')
  const outcomes = live.filter((e) => e.kind === 'outcome')
  // An outcome points into its own record, or with `of: "v0"` into the old chain.
  const refers = (o, d) => o.ref === d.seq && (o.of ?? o.record) === d.record
  const closed = decisions.filter((d) => outcomes.some((o) => refers(o, d)))
  const days = closed.map((d) => (outcomes.find((o) => refers(o, d)).at - d.at) / 86400000).sort((a, b) => a - b)
  const crossModel = outcomes.filter((o) => { const d = decisions.find((x) => refers(o, x)); return d && d.model && o.model && d.model !== o.model }).length
  const fam = await family(me)
  if (fam.error) throw Object.assign(new Error(fam.error), { status: fam.status })
  return {
    records: Object.fromEntries(Object.entries(all.records).map(([name, list]) => [name, list.length])),
    entries: entries.length,
    adopted_from_v0: intoSelf.size,
    removed: entries.length - live.length,
    active_days: new Set(live.map((e) => e.at.toISOString().slice(0, 10))).size,
    first: live[0]?.at, latest: live.at(-1)?.at,
    by_kind: count(live, (e) => e.kind),
    by_week: count(live, (e) => { const d = new Date(e.at); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return 'week of ' + d.toISOString().slice(0, 10) }),
    by_model: count(live, (e) => e.model ?? '(not stated)'),
    decisions: decisions.length,
    decisions_with_outcome: closed.length,
    median_days_to_outcome: days.length ? Number(days[Math.floor(days.length / 2)].toFixed(2)) : null,
    outcomes_written_by_a_different_model_than_the_decision: crossModel,
    standing_positions: Array.isArray(fam.positions) ? fam.positions.length : 0,
    children: fam.children.length,
    children_that_pushed: fam.children.filter((c) => c.latest?.length).length,
  }
}

// What the client prints after a push, for a caller that wants the same line.
export const pushedLine = (me, result, kind) => stampLine(me.id, pushedParts(result, kind))
