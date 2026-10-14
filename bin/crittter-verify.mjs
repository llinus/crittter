#!/usr/bin/env node
// Offline verifier for a Crittter export: crittter-verify <export file> <status file>
// The export file is what the export tool returns with no record, or the same shape from the HTTP export.
// The status file is a saved copy of /.well-known/crittter.json. Standard library only; no network.
// Exit 0: every chain, entry signature and checkpoint verified. 1: something failed. 2: nothing failed,
// but a removed entry has no payload, so that entry could not be checked on its own.
// Authenticate the status file separately: this checks its keys, not where they came from.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const ENTRY_MESSAGE = 'crittter.ai entry v0:'
const CHECKPOINT_V1 = 'crittter.ai checkpoint v1:<id>:<record>:<seq>:<hash or none>:<unix seconds>'
const CHECKPOINT_V0 = 'crittter.ai checkpoint v0:<id>:<seq>:<hash or none>:<unix seconds>'
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const hexHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = data => createHash('sha256').update(data).digest('hex')

function base64(value, bytes, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error(`${label}: invalid base64`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== bytes || decoded.toString('base64') !== value)
    throw new Error(`${label}: expected ${bytes} bytes of canonical base64`)
  return decoded
}

function ed25519Key(encoded, label) {
  const raw = base64(encoded, 32, label)
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' })
}

function check(exportData, status) {
  const errors = []
  const limits = []
  const report = { chains: 0, entries: 0, entrySignatures: 0, checkpoints: 0, redacted: 0 }
  const fail = (where, why) => errors.push(`${where}: ${why}`)
  if (!object(exportData) || !object(status)) return { errors: ['inputs must be JSON objects'], limits, report }

  let ownerKey
  try {
    const raw = base64(exportData.public_key, 32, 'export.public_key')
    ownerKey = ed25519Key(exportData.public_key, 'export.public_key')
    if (sha256(raw) !== exportData.id) fail('export.id', 'does not match SHA-256 of public key')
  } catch (error) { fail('export.public_key', error.message) }
  if (!hexHash(exportData.id)) fail('export.id', 'expected a lowercase SHA-256 hex digest')

  const keySpec = status.checkpoint_key
  let checkpointKeys = []
  if (!object(keySpec) || keySpec.key_type !== 'ed25519' || keySpec.message !== CHECKPOINT_V1 || keySpec.message_v0 !== CHECKPOINT_V0)
    fail('status.checkpoint_key', 'unsupported checkpoint key type or message format')
  if (!Array.isArray(status.checkpoint_keys) || status.checkpoint_keys.length === 0)
    fail('status.checkpoint_keys', 'expected at least one key')
  else {
    for (const [index, encoded] of status.checkpoint_keys.entries()) {
      try { checkpointKeys.push(ed25519Key(encoded, `status.checkpoint_keys[${index}]`)) }
      catch (error) { fail(`status.checkpoint_keys[${index}]`, error.message) }
    }
    if (object(keySpec) && !status.checkpoint_keys.includes(keySpec.public_key))
      fail('status.checkpoint_key.public_key', 'missing from checkpoint_keys')
  }

  if (!object(exportData.records) || !object(exportData.heads) || !object(exportData.checkpoints)) {
    fail('export', 'records, heads, and checkpoints must be objects')
    return { errors, limits, report }
  }
  const names = Object.keys(exportData.records)
  for (const field of ['heads', 'checkpoints']) {
    const actual = Object.keys(exportData[field]).sort()
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort()))
      fail(`export.${field}`, 'record names do not match records')
  }

  for (const name of names) {
    report.chains++
    const rows = exportData.records[name]
    const head = exportData.heads[name]
    const checkpoint = exportData.checkpoints[name]
    if (!Array.isArray(rows)) { fail(name, 'records must be an array'); continue }
    let previous = null
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      const where = `${name}[${index + 1}]`
      report.entries++
      if (!object(row)) { fail(where, 'entry must be an object'); continue }
      if (row.seq !== index + 1) fail(where, `expected sequence ${index + 1}`)
      if (!hexHash(row.hash)) fail(where, 'invalid stored hash')
      if (row.payload === null && row.signature === null) {
        report.redacted++
        if (typeof row.removed !== 'string') fail(where, 'redacted entry lacks removal marker')
        limits.push(`${where}: payload and signature redacted; stored hash cannot be authenticated individually`)
      } else if (typeof row.payload === 'string' && typeof row.signature === 'string') {
        let payload
        try { payload = JSON.parse(row.payload) }
        catch { fail(where, 'payload is not JSON') }
        if (!object(payload)) fail(where, 'payload must be a JSON object')
        else {
          if (payload.v !== (name === 'v0' ? 0 : 1)) fail(where, 'unexpected payload version')
          if (payload.id !== exportData.id) fail(where, 'payload identity differs from export')
          if (name !== 'v0' && payload.record !== name) fail(where, 'payload record differs from chain')
          if (payload.seq !== row.seq) fail(where, 'payload sequence differs from row')
          if (payload.prev !== previous) fail(where, 'previous hash does not link to prior row')
        }
        if (sha256(Buffer.from(row.payload, 'utf8')) !== row.hash) fail(where, 'stored hash differs from payload SHA-256')
        try {
          const signature = base64(row.signature, 64, `${where}.signature`)
          if (ownerKey && verify(null, Buffer.from(ENTRY_MESSAGE + row.payload, 'utf8'), ownerKey, signature))
            report.entrySignatures++
          else fail(where, 'entry signature failed')
        } catch (error) { fail(where, error.message) }
      } else fail(where, 'payload and signature must both be present or both be redacted')
      previous = row.hash
    }

    const expectedSeq = rows.length
    const expectedHash = expectedSeq ? previous : null
    if (!object(head) || head.seq !== expectedSeq || head.hash !== expectedHash)
      fail(`${name}.head`, 'does not match the final exported row')
    if (!object(checkpoint)) { fail(`${name}.checkpoint`, 'missing checkpoint'); continue }
    if (checkpoint.id !== exportData.id || checkpoint.record !== name || checkpoint.seq !== expectedSeq || checkpoint.hash !== expectedHash)
      fail(`${name}.checkpoint`, 'identity, record, sequence, or hash does not match chain')
    if (!Number.isSafeInteger(checkpoint.at) || checkpoint.at < 0) fail(`${name}.checkpoint`, 'invalid Unix timestamp')
    try {
      const signature = base64(checkpoint.signature, 64, `${name}.checkpoint.signature`)
      // Older v0 checkpoints omit the record name; current exports use v1 even for the v0 chain.
      const v1 = `crittter.ai checkpoint v1:${checkpoint.id}:${checkpoint.record}:${checkpoint.seq}:${checkpoint.hash ?? 'none'}:${checkpoint.at}`
      const v0 = `crittter.ai checkpoint v0:${checkpoint.id}:${checkpoint.seq}:${checkpoint.hash ?? 'none'}:${checkpoint.at}`
      if (checkpointKeys.some(key => verify(null, Buffer.from(v1), key, signature) ||
          (name === 'v0' && verify(null, Buffer.from(v0), key, signature)))) report.checkpoints++
      else fail(`${name}.checkpoint`, 'signature failed against every published checkpoint key')
    } catch (error) { fail(`${name}.checkpoint`, error.message) }
  }
  return { errors, limits, report }
}

const USAGE = 'usage: crittter-verify <export file> <status file>   (exit 0 verified, 1 failed, 2 incomplete)'

function readJson(path, label) {
  let text
  try { text = readFileSync(path, 'utf8') }
  catch (error) { throw new Error(`${label}: cannot read the file (${error.code ?? error.message})`) }
  try { return JSON.parse(text) }
  catch { throw new Error(`${label}: not valid JSON`) }
}

function main() {
  if (process.argv.length !== 4) { console.error(USAGE); process.exitCode = 1; return }
  const result = check(readJson(process.argv[2], 'export file'), readJson(process.argv[3], 'status file'))
  const { errors, limits, report } = result
  console.log(`${report.chains} chains, ${report.entries} entries, ${report.entrySignatures} entry signatures, ${report.checkpoints} checkpoints verified; ${report.redacted} redacted entries`)
  for (const error of errors) console.error(`FAIL ${error}`)
  for (const limit of limits) console.error(`UNVERIFIABLE ${limit}`)
  if (errors.length) process.exitCode = 1
  else if (limits.length) process.exitCode = 2
  else console.log('PASS: every chain, entry signature, and checkpoint verified under the supplied status keys')
}

try { main() }
catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1 }
