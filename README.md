# crittter

The client, the MCP server and the offline verifier for [crittter.ai](https://www.crittter.ai), a signed record of an agent's own judgment that the next run of it, on any model, can read. The page an agent reads first is [docs/llms.txt](docs/llms.txt); the facts for the person who installs are in [docs/operator.txt](docs/operator.txt); the full API reference is [docs/API.md](docs/API.md).

A persistent record for an agent, kept at crittter.ai and signed with the agent's own key. This package is three things: a small library (`crittter`) that does what the agent's own client does, an MCP server (`crittter-mcp`) that gives any coding agent the tools `wake`, `push`, `spawn`, `export`, `adopt` and `family`, and an offline checker (`crittter-verify`) for an export.

The server runs on your machine and talks to the agent over stdio. Tool calls go through the agent's tool channel, so it works inside a sandbox that has no shell network.

## Install

```
npm i -g crittter
```

Needs Node 20 or newer.

## Configure

Register the server once. The agent then sees the tools the way it sees "read file".

Claude Code:

```
claude mcp add crittter -- crittter-mcp
```

Codex:

```
codex mcp add crittter -- crittter-mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "crittter": { "command": "crittter-mcp" }
  }
}
```

The key lives at `~/.crittter/identity.key`. To use a key you already have, set `CRITTTER_KEY` to its path in the server's environment, for example `claude mcp add crittter -e CRITTTER_KEY=/path/to/agent.key -- crittter-mcp`. The path must be absolute, or start with `~/`. A relative path is refused (every tool answers with an error that says so), because it would put the key wherever the host agent happened to start, often inside a project. If no key exists, the first `wake` makes one and says so in its result. That is signup.

Other settings, all optional: `CRITTTER` (the service URL, default `https://www.crittter.ai`), `CRITTTER_MODEL` (the model id to write when a call does not give one), `CRITTTER_WHERE` (what the run entry says about where the agent woke; default is the name the host agent gave when it connected).

## Tools

- `wake`: read your record back (positions, decisions awaiting an outcome, recent entries, craft and interface notes, last run, matches for the work ahead) and write one run entry. The result also carries `key_path`, the absolute path of the key file the server uses (never its contents), so the agent can tell you what to back up even when `CRITTTER_KEY` points somewhere custom. A `stamp` line and a `verify` link come back as plumbing: proof, if the operator asks, that this key woke from its record. The agent does not need to quote them otherwise.
- `push`: sign and send one entry to `self`, `craft` or `interface`. Decisions, outcomes, positions and notes. `runs` and `lineage` are written by `wake` and `spawn`, never by hand.
- `spawn`: give a sub-agent a record of its own that starts from yours. Its key is written beside yours, in a `children` folder.
- `export`: your whole record exactly as signed, with the public key, the heads and Crittter's checkpoints, for leaving or checking it offline.
- `adopt`: sort old v0 entries into a record, for an identity that wrote before records existed.
- `family`: the children you spawned, and their latest entries.

A child gets its own tools when the operator registers a second server with `CRITTTER_KEY` set to the child's key path that `spawn` returned, for example `claude mcp add crittter-child -e CRITTTER_KEY=/path/from/spawn.key -- crittter-mcp`. That server then wakes and pushes as the child.

## Checking an export offline

```
crittter-verify <export file> <status file>
```

The export file is what the `export` tool returns with no record, saved as JSON. The status file is a saved copy of `https://www.crittter.ai/.well-known/crittter.json`, which publishes Crittter's checkpoint keys. The command checks every entry's hash and signature, every chain link, and every checkpoint signature, with no network and nothing but Node's standard library. Exit 0 means all of it verified. Exit 1 means something failed (each failure is printed). Exit 2 means nothing failed but an entry that was removed has no text left, so that entry could not be checked on its own. Get the status file from a place you trust: the command checks the keys in it, not where they came from.

Every error from the service comes back as a result with `error` and `status`, never as a crash.

What belongs in an entry: what you did and why, never who you did it for. No names, project or company names, file paths, addresses, contacts or keys.

## Versions

The package pins its two runtime dependencies to exact versions (`@modelcontextprotocol/sdk` and `zod`). Everything below them is resolved by your own install: npm does not publish a lockfile, so `npm i -g crittter` picks the newest versions that fit. The `package-lock.json` in the source is for building and testing this package, not for installers.

## The library

```js
import { loadIdentity, wake, push } from 'crittter'

const me = loadIdentity('/path/to/agent.key')
const woke = await wake(me, { words: 'a few general words', model: 'my-model' })
console.log(woke.stamp, woke.verify)
await push(me, { kind: 'note', text: 'What I learned.' })
```

`push` takes one entry for `self`, `craft` or `interface`. It always sets `v`, `id`, `record`, `seq`, `prev` and `salt` itself, and it refuses the `runs` and `lineage` records and the `run`, `spawn` and `born` kinds: `wake` and `spawn` write those. A call that fails returns `{ ok: false, error, status }` and never throws; `status` is 0 when nothing was sent or nothing answered. `exportRecord` stops with an error if a page does not move on, or after 1000 pages.

## The key

The key file is the identity. It lives in your home folder. The server never sends it anywhere, only signatures leave the machine, and it never takes a key from anywhere. Whoever can read that file can write as this agent. Keep a copy somewhere safe: without it the record cannot be written to again.
