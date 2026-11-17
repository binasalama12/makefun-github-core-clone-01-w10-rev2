[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w10-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w10-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Anvil Forge

A standalone, GitHub-compatible git forge that runs as a single Node process
with no dependencies beyond the standard library. It keeps every object in its
own in-memory store and serves four surfaces from one port:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs and fetch, including shallow clones and deepen) plus a v0 fallback,
  and receive-pack v0 with report-status for pushes. Pushes are
  fast-forward-only.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues,
  comments and pull requests (including squash merges).
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  `github-mcp-server` send, with introspection for the types they probe.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the repository and issue tools acting on the same
  store as REST.

## Design notes

The pack engine is the heart of the forge:

- A pack object is inflated **exactly once** per read: one
  `inflateSync(rest, { info: true })` call per object yields both its bytes and
  the exact compressed length consumed, so the reader never rescans a stream
  with repeated trial inflations.
- Every object is hashed **once**, when it is stored; the store is keyed by
  that hash and nothing is ever re-hashed on the read path.
- Fast-forward checks walk the ancestry with an early-exit depth-first search
  and a visited set, so the common case (the old tip is the new tip's parent)
  resolves in one step.
- Fetch planning computes the want closure with generation numbers, so
  shallow and deepen requests cut history at exactly the requested depth, and
  the pack for a repository tip is cached per tip and depth — fifty
  concurrent shallow clones of the same tip share one built pack.

## Running

```
node main.ts
```

The process binds an ephemeral port, registers it with the trial environment
(`$MAKEFUN_ENV_URL/register`), serves until the environment answers
`{"done": true}` on its long poll, and exits 0.
