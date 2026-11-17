// Anvil Forge — the server.
//
// One HTTP process serving four surfaces over a single in-memory store:
//   git smart HTTP   /{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack
//   REST v3          /api/v3/...
//   GraphQL v4       /api/graphql
//   MCP              /mcp
//
// The account the bearer token names is a fixed identity (LOGIN below): every
// repository lives under it, and the same name under any other owner is a 404.
// Responses on hot paths are shaped to be cheap: a fetch for a tip that was
// already planned reuses the cached pack bytes, and a single issue read
// serves a cached serialisation until the issue changes.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ObjectStore,
  PktReader,
  ZERO_OID,
  buildCommitData,
  buildPack,
  diffTreePaths,
  flattenTree,
  hashObject,
  lookupPath,
  pktLine,
  planFetch,
  readPack,
  setPath,
  PKT_DELIM,
  PKT_FLUSH,
  PKT_RESPONSE_END,
  type GitObject,
} from './git.ts';

const LOGIN = 'adaiversen';
const USER_ID = 1000;
const USER_NAME = 'ada iversen';
const USER_EMAIL = 'adaiversen@example.invalid';
const AGENT = 'anvil/1.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
  description: string;
}

interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  serialized: string | null;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on every ref move; invalidates the caches keyed by it. */
  version: number;
  packCache: Map<string, Buffer>;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let requestCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const stamp = nowIso();
  const repo: Repo = {
    id: nextRepoId,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: stamp,
    updatedAt: stamp,
    store: new ObjectStore(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    version: 0,
    packCache: new Map(),
  };
  nextRepoId += 1;
  repos.set(name, repo);
  return repo;
}

function touchRefs(repo: Repo): void {
  repo.version += 1;
  repo.packCache.clear();
  repo.updatedAt = nowIso();
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function repoJson(repo: Repo, req: IncomingMessage): Record<string, unknown> {
  const base = baseUrl(req);
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${LOGIN}/${repo.name}`,
    owner: { login: LOGIN, id: USER_ID, type: 'User' },
    private: repo.isPrivate,
    html_url: `${base}/${LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${LOGIN}/${repo.name}`,
    clone_url: `${base}/${LOGIN}/${repo.name}.git`,
    git_url: `git://${req.headers.host ?? '127.0.0.1'}/${LOGIN}/${repo.name}.git`,
    ssh_url: `git@${req.headers.host ?? '127.0.0.1'}:${LOGIN}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue, req: IncomingMessage): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: { login: LOGIN, id: USER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    url: `${base}/api/v3/repos/${LOGIN}/${repo.name}/issues/${issue.number}`,
    html_url: `${base}/${LOGIN}/${repo.name}/issues/${issue.number}`,
    pull_request: undefined,
  };
}

function issueBody(repo: Repo, issue: Issue, req: IncomingMessage): string {
  if (issue.serialized === null) issue.serialized = JSON.stringify(issueJson(repo, issue, req));
  return issue.serialized;
}

function invalidateIssue(issue: Issue): void {
  issue.serialized = null;
  issue.updatedAt = nowIso();
}

function pullJson(repo: Repo, pull: Pull, req: IncomingMessage): Record<string, unknown> {
  const base = baseUrl(req);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.updatedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? computeMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (computeMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    user: { login: LOGIN, id: USER_ID, type: 'User' },
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state !== 'open' ? pull.updatedAt : null,
    url: `${base}/api/v3/repos/${LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${LOGIN}/${repo.name}/pulls/${pull.number}`,
    head: {
      label: `${LOGIN}:${pull.headRef}`,
      ref: pull.headRef,
      sha: refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha,
      user: { login: LOGIN, id: USER_ID },
      repo: repoJson(repo, req),
    },
    base: {
      label: `${LOGIN}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip ?? '',
      user: { login: LOGIN, id: USER_ID },
      repo: repoJson(repo, req),
    },
  };
}

/** Files changed on both sides of a pull since the merge base, with different results. */
function computeMergeable(repo: Repo, pull: Pull): boolean {
  const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo.store, headTip, baseTip);
  if (!base) return true;
  const baseCommit = repo.store.commit(base);
  const headCommit = repo.store.commit(headTip);
  const baseCommitNow = repo.store.commit(baseTip);
  if (!baseCommit || !headCommit || !baseCommitNow) return true;
  const headPaths = new Map(flattenTree(repo.store, headCommit.tree));
  const basePaths = new Map(flattenTree(repo.store, baseCommitNow.tree));
  const originPaths = new Map(flattenTree(repo.store, baseCommit.tree));
  const changedOnHead = new Set<string>();
  for (const [path, oid] of headPaths) if (originPaths.get(path) !== oid) changedOnHead.add(path);
  for (const path of originPaths.keys()) if (!headPaths.has(path)) changedOnHead.add(path);
  for (const path of changedOnHead) {
    const onBase = basePaths.get(path);
    const atOrigin = originPaths.get(path);
    if (onBase !== atOrigin && onBase !== headPaths.get(path)) return false;
  }
  return true;
}

/** The best common ancestor of two commits (breadth-first from both sides). */
function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const parsed = store.commit(oid);
    if (parsed) for (const parent of parsed.parents) stack.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = store.commit(oid);
    if (parsed) for (const parent of parsed.parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Global ids (GraphQL node ids): opaque, stable, decodable by this process.
// ---------------------------------------------------------------------------

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function sendRest(res: ServerResponse, status: number, value: unknown): void {
  requestCounter += 1;
  sendJson(res, status, value, { 'X-GitHub-Request-Id': `ANVIL-${requestCounter}` });
}

function restError(res: ServerResponse, status: number, message: string): void {
  sendRest(res, status, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: boolean; value: Record<string, unknown> }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, value: {} };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, value: {} };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function gitHeaders(res: ServerResponse, contentType: string): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    Pragma: 'no-cache',
  });
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string, url: URL): void {
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const parts: Buffer[] = [];
  if (wantsV2) {
    gitHeaders(res, `application/x-${service}-advertisement`);
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    if (service === 'git-upload-pack') {
      parts.push(pktLine('ls-refs=unborn\n'));
      parts.push(pktLine('fetch=shallow wait-for-done\n'));
      parts.push(pktLine('server-option\n'));
    }
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    res.end(Buffer.concat(parts));
    return;
  }
  gitHeaders(res, `application/x-${service}-advertisement`);
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta symref=HEAD:${headRef(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headTip = refTip(repo, headRef(repo));
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const obj = repo.store.get(oid);
      if (obj && obj.type === 'tag') {
        parts.push(pktLine(`${repo.store.peelToCommit(oid)} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  res.end(Buffer.concat(parts));
  void url;
}

/** One sideband packet carrying a slice of pack bytes on band 1. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headName = headRef(repo);
  const headTip = refTip(repo, headName);
  if (keep('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headName}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headName}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.store.get(oid);
    if (peel && obj && obj.type === 'tag') line += ` peeled:${repo.store.peelToCommit(oid)}`;
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice('deepen-not '.length).trim());
    else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice('deepen-since '.length));
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7));
    else if (arg === 'done') done = true;
  }
  const parts: Buffer[] = [];
  if (!done) {
    // Negotiation step: acknowledge the haves we hold and offer readiness.
    parts.push(pktLine('acknowledgments\n'));
    let common = false;
    for (const have of haves) {
      if (repo.store.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        common = true;
      }
    }
    if (!common) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const plan = planFetch(repo.store, { wants, haves, clientShallow, depth, deepenSince, deepenNot });
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const cacheKey = `v2|${wants.join(',')}|${haves.join(',')}|${clientShallow.join(',')}|${depth ?? ''}|${deepenSince ?? ''}|${deepenNot.join(',')}`;
  let pack = repo.packCache.get(cacheKey);
  if (!pack) {
    pack = buildPack(repo.store, plan.objects);
    repo.packCache.set(cacheKey, pack);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  for (const arg of lines) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5, 45));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8, 48));
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice('deepen-not '.length).trim());
    else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice('deepen-since '.length));
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7));
  }
  const plan = planFetch(repo.store, { wants, haves, clientShallow, depth, deepenSince, deepenNot });
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = buildPack(repo.store, plan.objects);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reader = new PktReader(body);
  const lines: string[] = [];
  let command = '';
  try {
    for (let packet = reader.next(); packet !== null; packet = reader.next()) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'delim') continue;
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('command=')) command = text.slice('command='.length);
      else lines.push(text);
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  if (command === 'ls-refs') {
    res.end(handleLsRefs(repo, lines));
    return;
  }
  if (command === 'fetch') {
    res.end(handleFetchV2(repo, lines));
    return;
  }
  if (command === '') {
    // A v0 request: want/have lines with no command frame.
    res.end(handleFetchV0(repo, lines));
    return;
  }
  res.end(PKT_FLUSH);
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reader = new PktReader(body);
  const commands: RefCommand[] = [];
  let capabilities = new Set<string>();
  try {
    for (let packet = reader.next(); packet !== null; packet = reader.next()) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0] as string));
        text = text.slice(0, nul);
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
      if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request\n');
    return;
  }
  const packBytes = body.subarray(reader.offset);
  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');
  const sideband = capabilities.has('side-band-64k');

  let unpackError: string | null = null;
  const staging = new Map<string, GitObject>();
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) unpackError = 'no pack sent';
    else {
      try {
        readPack(repo.store, packBytes, staging);
        for (const [oid, obj] of staging) repo.store.putKnown(oid, obj.type, obj.data);
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (!repo.refs.has(command.ref)) {
          results.push({ ref: command.ref, ok: false, reason: 'reference not found' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = repo.store.get(command.newOid);
      if (!target || (target.type !== 'commit' && target.type !== 'tag')) {
        results.push({ ref: command.ref, ok: false, reason: 'bad object' });
        continue;
      }
      if (current !== ZERO_OID && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
        continue;
      }
      if (current !== ZERO_OID) {
        const newCommit = repo.store.peelToCommit(command.newOid);
        if (!repo.store.isAncestor(current, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (results.some((result) => result.ok)) touchRefs(repo);
  }

  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
  if (!reportStatus) {
    res.end();
    return;
  }
  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!sideband) {
    res.end(inner);
    return;
  }
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < inner.length; at += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, Math.min(at + CHUNK, inner.length))])));
  }
  out.push(PKT_FLUSH);
  res.end(Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== LOGIN) return null;
  return repos.get(name) ?? null;
}

function parsePage(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function pageSlice<T>(items: T[], url: URL, req: IncomingMessage, path: string): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = parsePage(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const base = baseUrl(req);
    const next = `${base}/api/v3${path}?page=${page + 1}&per_page=${perPage}`;
    const last = `${base}/api/v3${path}?page=${Math.ceil(items.length / perPage)}&per_page=${perPage}`;
    headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { slice, headers };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // segments[0] === 'api', [1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      requestCounter += 1;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-GitHub-Request-Id': `ANVIL-${requestCounter}`,
        'X-OAuth-Scopes': 'repo, read:org, gist',
      });
      res.end(JSON.stringify({ current_user_url: `${baseUrl(req)}/api/v3/user` }));
      return;
    }
    return restError(res, 404, 'Not Found');
  }

  if (rest[0] === 'meta' && method === 'GET') {
    return sendRest(res, 200, { installed_version: 'anvil-1.0', hooks: [], github_services_sha: 'anvil' });
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return sendRest(res, 200, { login: LOGIN, id: USER_ID, name: USER_NAME, type: 'User', site_admin: false });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.id - b.id);
      const { slice, headers } = pageSlice(all, url, req, '/user/repos');
      requestCounter += 1;
      return sendJson(res, 200, slice.map((repo) => repoJson(repo, req)), { 'X-GitHub-Request-Id': `ANVIL-${requestCounter}`, ...headers });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      const name = str(body.value.name);
      if (name === '') return restError(res, 422, 'Validation Failed: name is required');
      if (repos.has(name)) return restError(res, 422, 'Repository creation failed: name already exists on this account');
      const repo = createRepo(name, str(body.value.description), body.value.private === true);
      if (body.value.auto_init === true) {
        const tree = repo.store.put('tree', Buffer.alloc(0));
        const commit = repo.store.put('commit', buildCommitData({
          tree, parents: [], message: 'Initial commit', authorName: USER_NAME, authorEmail: USER_EMAIL, time: nowSec(),
        }));
        repo.refs.set(headRef(repo), commit);
        touchRefs(repo);
      }
      return sendRest(res, 201, repoJson(repo, req));
    }
  }

  if (rest[0] !== 'repos' || rest.length < 3) return restError(res, 404, 'Not Found');
  const repo = findRepo(rest[1] as string, rest[2] as string);
  if (!repo) return restError(res, 404, 'Not Found');
  const tail = rest.slice(3);
  const repoPath = `/repos/${LOGIN}/${repo.name}`;

  if (tail.length === 0) {
    if (method === 'GET') return sendRest(res, 200, repoJson(repo, req));
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
      if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') repo.defaultBranch = body.value.default_branch;
      repo.updatedAt = nowIso();
      return sendRest(res, 200, repoJson(repo, req));
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      res.writeHead(204, { 'X-GitHub-Request-Id': `ANVIL-${(requestCounter += 1)}` });
      res.end();
      return;
    }
    return restError(res, 404, 'Not Found');
  }

  // ---- branches and git refs (read views the checks fall back to)
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      return sendRest(res, 200, list);
    }
    if (method === 'GET' && tail.length === 2) {
      const oid = refTip(repo, `refs/heads/${tail[1]}`);
      if (!oid) return restError(res, 404, 'Not Found');
      return sendRest(res, 200, { name: tail[1], commit: { sha: oid }, protected: false });
    }
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    const refName = tail.slice(2).join('/');
    if (method === 'GET') {
      const oid = repo.refs.get(`refs/${refName}`);
      if (!oid) return restError(res, 404, 'Not Found');
      const obj = repo.store.get(oid);
      return sendRest(res, 200, { ref: `refs/${refName}`, object: { sha: oid, type: obj?.type ?? 'commit' } });
    }
  }

  // ---- labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      const name = str(body.value.name);
      if (name === '') return restError(res, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return restError(res, 422, 'Validation Failed: name has already been taken');
      const label: Label = { name, color: strOr(body.value.color, 'ededed').replace(/^#/, ''), description: str(body.value.description) };
      repo.labels.set(name, label);
      return sendRest(res, 201, labelJson(label));
    }
    if (method === 'GET' && tail.length === 1) {
      return sendRest(res, 200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'GET' && tail.length === 2) {
      const label = repo.labels.get(tail[1] as string);
      if (!label) return restError(res, 404, 'Not Found');
      return sendRest(res, 200, labelJson(label));
    }
    return restError(res, 404, 'Not Found');
  }

  // ---- contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    const branch = strOr(url.searchParams.get('ref') ?? '', repo.defaultBranch);
    const ref = `refs/heads/${branch}`;
    if (method === 'GET') {
      const tip = refTip(repo, ref);
      if (!tip) return restError(res, 404, 'Not Found');
      const commit = repo.store.commit(tip);
      if (!commit) return restError(res, 404, 'Not Found');
      if (path === '') {
        const entries = repo.store.tree(commit.tree) ?? [];
        return sendRest(res, 200, entries.map((entry) => ({
          name: entry.name, path: entry.name, sha: entry.oid, type: entry.isTree ? 'dir' : 'file',
        })));
      }
      const found = lookupPath(repo.store, commit.tree, path);
      if (!found) return restError(res, 404, 'Not Found');
      if (found.isTree) {
        const entries = repo.store.tree(found.oid) ?? [];
        return sendRest(res, 200, entries.map((entry) => ({
          name: entry.name, path: `${path}/${entry.name}`, sha: entry.oid, type: entry.isTree ? 'dir' : 'file',
        })));
      }
      const blob = repo.store.get(found.oid);
      if (!blob) return restError(res, 404, 'Not Found');
      const name = path.split('/').pop() as string;
      return sendRest(res, 200, {
        name, path, sha: found.oid, size: blob.data.length, type: 'file',
        encoding: 'base64', content: blob.data.toString('base64'),
      });
    }
    if (method === 'PUT' || method === 'DELETE') {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      const targetBranch = strOr(body.value.branch, repo.defaultBranch);
      const targetRef = `refs/heads/${targetBranch}`;
      const tip = refTip(repo, targetRef);
      const tipCommit = tip ? repo.store.commit(tip) : null;
      const rootTree = tipCommit?.tree ?? null;
      const existing = rootTree ? lookupPath(repo.store, rootTree, path) : null;
      if (method === 'PUT') {
        const content = Buffer.from(str(body.value.content), 'base64');
        const blobOid = repo.store.put('blob', content);
        const givenSha = str(body.value.sha);
        if (existing && !existing.isTree) {
          if (givenSha !== '' && givenSha !== existing.oid) return restError(res, 409, 'Conflict: the sha does not match');
        } else if (!existing && givenSha !== '') {
          return restError(res, 422, 'Validation Failed: sha must be omitted for a new file');
        }
        const newTree = setPath(repo.store, rootTree, path, blobOid);
        const commitOid = repo.store.put('commit', buildCommitData({
          tree: newTree, parents: tip ? [tip] : [], message: strOr(body.value.message, `Update ${path}`),
          authorName: USER_NAME, authorEmail: USER_EMAIL, time: nowSec(),
        }));
        repo.refs.set(targetRef, commitOid);
        touchRefs(repo);
        const name = path.split('/').pop() as string;
        return sendRest(res, existing ? 200 : 201, {
          content: { name, path, sha: blobOid, size: content.length, type: 'file' },
          commit: { sha: commitOid, message: strOr(body.value.message, `Update ${path}`) },
        });
      }
      // DELETE
      if (!existing || existing.isTree) return restError(res, 404, 'Not Found');
      const givenSha = str(body.value.sha);
      if (givenSha !== '' && givenSha !== existing.oid) return restError(res, 409, 'Conflict: the sha does not match');
      const newTree = setPath(repo.store, rootTree, path, null);
      const commitOid = repo.store.put('commit', buildCommitData({
        tree: newTree, parents: tip ? [tip] : [], message: strOr(body.value.message, `Delete ${path}`),
        authorName: USER_NAME, authorEmail: USER_EMAIL, time: nowSec(),
      }));
      repo.refs.set(targetRef, commitOid);
      touchRefs(repo);
      return sendRest(res, 200, { content: null, commit: { sha: commitOid, message: strOr(body.value.message, `Delete ${path}`) } });
    }
    return restError(res, 404, 'Not Found');
  }

  // ---- issues
  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'GET') {
      const state = strOr(url.searchParams.get('state') ?? '', 'open');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const { slice, headers } = pageSlice(list, url, req, `${repoPath}/issues`);
      requestCounter += 1;
      return sendJson(res, 200, slice.map((issue) => issueJson(repo, issue, req)), { 'X-GitHub-Request-Id': `ANVIL-${requestCounter}`, ...headers });
    }
    if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      const title = str(body.value.title);
      if (title === '') return restError(res, 422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(body.value.labels) ? body.value.labels.map((entry) => String(entry)) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return restError(res, 422, `Validation Failed: label "${name}" does not exist`);
      }
      const stamp = nowIso();
      const issue: Issue = {
        id: nextIssueId, number: repo.nextNumber, title, body: str(body.value.body), state: 'open',
        labels: labelNames, comments: [], createdAt: stamp, updatedAt: stamp, serialized: null,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return sendRest(res, 201, issueJson(repo, issue, req));
    }
    const number = Number(tail[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) return restError(res, 404, 'Not Found');
      if (method === 'GET') {
        requestCounter += 1;
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': `ANVIL-${requestCounter}` });
        res.end(issueBody(repo, issue, req));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
        if (Array.isArray(body.value.labels)) {
          const names = body.value.labels.map((entry) => String(entry));
          for (const name of names) if (!repo.labels.has(name)) return restError(res, 422, `Validation Failed: label "${name}" does not exist`);
          issue.labels = names;
        }
        invalidateIssue(issue);
        return sendRest(res, 200, issueJson(repo, issue, req));
      }
    }
    if (tail.length === 3 && tail[2] === 'comments' && issue) {
      if (method === 'GET') {
        return sendRest(res, 200, issue.comments.map((comment) => ({
          id: comment.id, body: comment.body, user: { login: LOGIN, id: USER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt,
        })));
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
        const comment: Comment = { id: repo.nextCommentId, body: str(body.value.body), createdAt: nowIso() };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        invalidateIssue(issue);
        return sendRest(res, 201, {
          id: comment.id, body: comment.body, user: { login: LOGIN, id: USER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt,
        });
      }
    }
    return restError(res, 404, 'Not Found');
  }

  // ---- pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'GET') {
      const state = strOr(url.searchParams.get('state') ?? '', 'open');
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state !== 'open');
      list.sort((a, b) => b.number - a.number);
      return sendRest(res, 200, list.map((pull) => pullJson(repo, pull, req)));
    }
    if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
      const created = createPull(repo, {
        title: str(body.value.title),
        body: str(body.value.body),
        head: str(body.value.head),
        base: strOr(body.value.base, repo.defaultBranch),
      });
      if ('error' in created) return restError(res, created.status, created.error);
      return sendRest(res, 201, pullJson(repo, created.pull, req));
    }
    const number = Number(tail[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2) {
      if (!pull) return restError(res, 404, 'Not Found');
      if (method === 'GET') return sendRest(res, 200, pullJson(repo, pull, req));
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
        if (typeof body.value.title === 'string') pull.title = body.value.title;
        if (typeof body.value.body === 'string') pull.body = body.value.body;
        if (body.value.state === 'closed' && pull.state === 'open') pull.state = 'closed';
        if (body.value.state === 'open' && pull.state === 'closed') pull.state = 'open';
        pull.updatedAt = nowIso();
        return sendRest(res, 200, pullJson(repo, pull, req));
      }
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (!pull) return restError(res, 404, 'Not Found');
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return restError(res, result.status, result.error);
      return sendRest(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    if (tail.length === 3 && tail[2] === 'comments' && pull) {
      if (method === 'GET') {
        return sendRest(res, 200, pull.comments.map((comment) => ({
          id: comment.id, body: comment.body, user: { login: LOGIN, id: USER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt,
        })));
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) return restError(res, 400, 'Problems parsing JSON');
        const comment: Comment = { id: repo.nextCommentId, body: str(body.value.body), createdAt: nowIso() };
        repo.nextCommentId += 1;
        pull.comments.push(comment);
        pull.updatedAt = nowIso();
        return sendRest(res, 201, {
          id: comment.id, body: comment.body, user: { login: LOGIN, id: USER_ID }, created_at: comment.createdAt, updated_at: comment.createdAt,
        });
      }
    }
    return restError(res, 404, 'Not Found');
  }

  return restError(res, 404, 'Not Found');
}

function createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }):
  | { pull: Pull }
  | { error: string; status: number } {
  const headRef = input.head.includes(':') ? (input.head.split(':').pop() as string) : input.head;
  const headTip = refTip(repo, `refs/heads/${headRef}`);
  if (!headTip) return { error: `Validation Failed: head branch "${headRef}" does not exist`, status: 422 };
  if (!refTip(repo, `refs/heads/${input.base}`)) return { error: `Validation Failed: base branch "${input.base}" does not exist`, status: 422 };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === input.base) {
      return { error: `Validation Failed: a pull request already exists for ${headRef} into ${input.base}`, status: 422 };
    }
  }
  const stamp = nowIso();
  const pull: Pull = {
    id: nextIssueId, number: repo.nextNumber, title: input.title, body: input.body, state: 'open',
    headRef, baseRef: input.base, headSha: headTip, merged: false, mergeCommitSha: null,
    comments: [], createdAt: stamp, updatedAt: stamp,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** Merge a pull into its base branch. 'squash' makes a one-parent commit; 'merge' a two-parent one. */
function mergePull(repo: Repo, pull: Pull, mode: 'squash' | 'merge'):
  | { sha: string }
  | { error: string; status: number } {
  if (pull.state === 'merged') return { error: 'Pull Request is already merged', status: 405 };
  if (pull.state === 'closed') return { error: 'Pull Request is closed', status: 405 };
  const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { error: 'A branch is missing', status: 405 };
  if (!computeMergeable(repo, pull)) return { error: 'Pull Request is not mergeable', status: 405 };
  const headCommit = repo.store.commit(headTip);
  if (!headCommit) return { error: 'Head commit is missing', status: 405 };
  const parents = mode === 'squash' ? [baseTip] : [baseTip, headTip];
  const message = mode === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const sha = repo.store.put('commit', buildCommitData({
    tree: headCommit.tree, parents, message, authorName: USER_NAME, authorEmail: USER_EMAIL, time: nowSec(),
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  touchRefs(repo);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return { sha };
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'obj'; fields: Map<string, GqlValue> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selection: GqlField[] | null;
  fragmentType: string | null;
}

function tokenizeGql(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (text.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]!:$=@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        tokens.push(`"${text.slice(i + 3, end).replace(/\\"""/g, '"""')}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { value += text[j + 1] === 'n' ? '\n' : text[j + 1]; j += 2; }
        else { value += text[j]; j += 1; }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(text.slice(i));
    if (match) { tokens.push(match[0]); i += match[0].length; continue; }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  variables: Record<string, unknown> = {};

  constructor(text: string) {
    this.tokens = tokenizeGql(text);
  }

  private peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  private take(): string {
    const token = this.tokens[this.pos] ?? '';
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    if (this.take() !== token) throw new Error(`expected ${token}`);
  }

  parseOperation(): { type: string; selection: GqlField[] } {
    let type = 'query';
    if (this.peek() === 'query' || this.peek() === 'mutation' || this.peek() === 'subscription') {
      type = this.take();
      // operation name
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek())) this.take();
      // variable definitions
      if (this.peek() === '(') {
        this.take();
        let depth = 1;
        while (depth > 0) {
          const token = this.take();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
          else if (token === '') throw new Error('unterminated variable definitions');
        }
      }
    }
    const selection = this.parseSelectionSet();
    return { type, selection };
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.take();
      // `on Type` inline fragment (named fragments are not in the suite's documents)
      if (this.peek() === 'on') {
        this.take();
        const typeName = this.take();
        const selection = this.parseSelectionSet();
        return { alias: null, name: '', args: new Map(), selection, fragmentType: typeName };
      }
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: new Map(), selection, fragmentType: null };
    }
    let name = this.take();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.take();
      alias = name;
      name = this.take();
    }
    const args = new Map<string, GqlValue>();
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') {
        const argName = this.take();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    let selection: GqlField[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const token = this.take();
    if (token === '$') return { kind: 'var', name: this.take() };
    if (token.startsWith('"')) return { kind: 'str', value: token.slice(1, -1) };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'obj', fields };
    }
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'num', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'num', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function gqlResolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'str': return value.value;
    case 'num': return value.value;
    case 'bool': return value.value;
    case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => gqlResolveValue(item, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = gqlResolveValue(inner, variables);
      return out;
    }
  }
}

// The schema the introspection checks read. Field lists carry every name the
// suite's documents use, plus the neighbours GitHub itself exposes.
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'refs', 'ref',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'repository',
    'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'repository',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt',
    'isDraft', 'files', 'comments', 'createdAt', 'updatedAt', 'closedAt',
  ],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  RepositoryOwner: ['id', 'login', 'url'],
  SearchResultItemConnection: ['nodes', 'pageInfo', 'issueCount'],
};

const TYPE_KIND: Record<string, string> = { SearchType: 'ENUM' };
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

interface GqlContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  req: IncomingMessage;
}

function gqlTypeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const marker = (value as Record<string, unknown>).__type;
  return typeof marker === 'string' ? marker : null;
}

function mark<T extends Record<string, unknown>>(type: string, value: T): T {
  Object.defineProperty(value, '__type', { value: type, enumerable: false });
  return value;
}

function repoNode(repo: Repo): Record<string, unknown> {
  return mark('Repository', { __repo: repo });
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return mark('Issue', { __repo: repo, __issue: issue });
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return mark('PullRequest', { __repo: repo, __pull: pull });
}

function connection<T>(nodes: T[], first: number | undefined, after: string | undefined): Record<string, unknown> {
  let start = 0;
  if (after) {
    const decoded = Number(Buffer.from(after, 'base64').toString('utf8'));
    if (Number.isInteger(decoded)) start = decoded + 1;
  }
  const limit = first !== undefined && first > 0 ? first : nodes.length;
  const slice = nodes.slice(start, start + limit);
  const hasNext = start + slice.length < nodes.length;
  const endCursor = slice.length ? Buffer.from(String(start + slice.length - 1), 'utf8').toString('base64') : null;
  return {
    nodes: slice,
    edges: slice.map((node, index) => ({ node, cursor: Buffer.from(String(start + index), 'utf8').toString('base64') })),
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: start > 0, startCursor: slice.length ? Buffer.from(String(start), 'utf8').toString('base64') : null, endCursor },
    totalCount: nodes.length,
  };
}

function gqlFieldValue(ctx: GqlContext, type: string, source: Record<string, unknown>, field: GqlField): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of field.args) args[key] = gqlResolveValue(value, ctx.variables);
  const repo = source.__repo as Repo | undefined;
  const issue = source.__issue as Issue | undefined;
  const pull = source.__pull as Pull | undefined;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return mark('User', {});
      if (field.name === 'repository') {
        const found = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return found ? repoNode(found) : null;
      }
      if (field.name === 'node') return gqlNodeById(String(args.id ?? ''));
      if (field.name === 'rateLimit') return { limit: 5000, cost: 1, remaining: 4999, resetAt: nowIso() };
      if (field.name === 'search') return connection([], undefined, undefined);
      break;
    }
    case 'Mutation': {
      return gqlMutation(ctx, field.name, (args.input as Record<string, unknown>) ?? {});
    }
    case 'User': {
      if (field.name === 'id') return globalId('User', LOGIN);
      if (field.name === 'login') return LOGIN;
      if (field.name === 'name') return USER_NAME;
      if (field.name === 'email') return USER_EMAIL;
      if (field.name === 'databaseId') return USER_ID;
      if (field.name === 'url') return `${baseUrl(ctx.req)}/${LOGIN}`;
      break;
    }
    case 'Repository': {
      if (!repo) break;
      switch (field.name) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${LOGIN}/${repo.name}`;
        case 'owner': return mark('User', {});
        case 'defaultBranchRef': {
          const tip = refTip(repo, headRef(repo));
          return tip ? mark('Ref', { name: repo.defaultBranch, target: mark('Commit', { oid: tip }) }) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasWikiEnabled': return false;
        case 'isPrivate': return repo.isPrivate;
        case 'description': return repo.description;
        case 'url': return `${baseUrl(ctx.req)}/${LOGIN}/${repo.name}`;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const found = repo.issues.get(Number(args.number));
          return found ? issueNode(repo, found) : null;
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((entry) => wanted.has(entry.state));
          }
          const orderBy = args.orderBy as Record<string, unknown> | undefined;
          const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
          list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          return connection(list.map((entry) => issueNode(repo, entry)), args.first as number | undefined, args.after as string | undefined);
        }
        case 'pullRequest': {
          const found = repo.pulls.get(Number(args.number));
          return found ? pullNode(repo, found) : null;
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length) {
            const wanted = new Set(states.map((state) => String(state).toUpperCase()));
            list = list.filter((entry) => wanted.has(entry.state === 'merged' ? 'MERGED' : entry.state.toUpperCase()));
          }
          list.sort((a, b) => b.number - a.number);
          return connection(list.map((entry) => pullNode(repo, entry)), args.first as number | undefined, args.after as string | undefined);
        }
      }
      break;
    }
    case 'Issue': {
      if (!repo || !issue) break;
      switch (field.name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'url': return `${baseUrl(ctx.req)}/${LOGIN}/${repo.name}/issues/${issue.number}`;
        case 'author': return mark('User', {});
        case 'repository': return repoNode(repo);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
        case 'labels': return connection(issue.labels.map((name) => mark('Label', { name })), args.first as number | undefined, undefined);
        case 'comments': return connection(issue.comments.map((comment) => mark('Comment', { __comment: comment })), args.first as number | undefined, undefined);
      }
      break;
    }
    case 'PullRequest': {
      if (!repo || !pull) break;
      switch (field.name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': return pull.state === 'merged' ? 'MERGED' : pull.state.toUpperCase();
        case 'body': return pull.body;
        case 'url': return `${baseUrl(ctx.req)}/${LOGIN}/${repo.name}/pulls/${pull.number}`;
        case 'author': return mark('User', {});
        case 'repository': return repoNode(repo);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.merged ? pull.updatedAt : null;
        case 'mergeable': return pull.state === 'open' ? (computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'isDraft': return false;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.state !== 'open' ? pull.updatedAt : null;
        case 'files': {
          const headTip = refTip(repo, `refs/heads/${pull.headRef}`);
          const baseTip = refTip(repo, `refs/heads/${pull.baseRef}`);
          const origin = headTip && baseTip ? mergeBase(repo.store, headTip, baseTip) : null;
          const originCommit = origin ? repo.store.commit(origin) : null;
          const headCommit = headTip ? repo.store.commit(headTip) : null;
          const paths = diffTreePaths(repo.store, originCommit?.tree ?? null, headCommit?.tree ?? null);
          return connection(paths.map((path) => mark('PullRequestChangedFile', { path })), args.first as number | undefined, args.after as string | undefined);
        }
        case 'comments': return connection(pull.comments.map((comment) => mark('Comment', { __comment: comment })), args.first as number | undefined, undefined);
      }
      break;
    }
    case 'Label': {
      if (field.name === 'id') return globalId('Label', String(source.name ?? ''));
      if (field.name === 'name') return source.name ?? '';
      if (field.name === 'color') return 'ededed';
      if (field.name === 'description') return '';
      break;
    }
    case 'Comment': {
      const comment = source.__comment as Comment | undefined;
      if (!comment) break;
      if (field.name === 'id') return globalId('Comment', String(comment.id));
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return mark('User', {});
      if (field.name === 'createdAt' || field.name === 'updatedAt') return comment.createdAt;
      break;
    }
    case 'Ref': {
      if (field.name === 'id') return globalId('Ref', String(source.name ?? ''));
      if (field.name === 'name') return source.name ?? '';
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return source.target ?? null;
      break;
    }
    case 'Commit': {
      if (field.name === 'id') return globalId('Commit', String(source.oid ?? ''));
      if (field.name === 'oid') return source.oid ?? '';
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return source.path ?? '';
      if (field.name === 'additions' || field.name === 'deletions') return 0;
      if (field.name === 'changeType') return 'MODIFIED';
      break;
    }
  }
  // Plain data objects (connections, page info, introspection payloads) read by key.
  if (Object.prototype.hasOwnProperty.call(source, field.name)) {
    const value = source[field.name];
    return typeof value === 'function' ? undefined : value;
  }
  return undefined;
}

function gqlNodeById(id: string): Record<string, unknown> | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    for (const repo of repos.values()) if (repo.id === Number(parsed.key)) return repoNode(repo);
    return null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':');
    for (const repo of repos.values()) {
      if (repo.id !== Number(repoId)) continue;
      if (parsed.type === 'Issue') {
        const found = repo.issues.get(Number(number));
        return found ? issueNode(repo, found) : null;
      }
      const found = repo.pulls.get(Number(number));
      return found ? pullNode(repo, found) : null;
    }
    return null;
  }
  if (parsed.type === 'User') return mark('User', {});
  return null;
}

function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  for (const repo of repos.values()) if (repo.id === Number(parsed.key)) return repo;
  return null;
}

function gqlMutation(ctx: GqlContext, name: string, input: Record<string, unknown>): Record<string, unknown> | null {
  void ctx;
  if (name === 'createIssue') {
    const repo = repoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return null;
    const stamp = nowIso();
    const issue: Issue = {
      id: nextIssueId, number: repo.nextNumber, title: str(input.title), body: str(input.body),
      state: 'open', labels: [], comments: [], createdAt: stamp, updatedAt: stamp, serialized: null,
    };
    nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue: issueNode(repo, issue) };
  }
  if (name === 'closeIssue') {
    const node = gqlNodeById(String(input.issueId ?? ''));
    const issue = node?.__issue as Issue | undefined;
    if (!node || !issue) return null;
    issue.state = 'closed';
    invalidateIssue(issue);
    return { issue: node };
  }
  if (name === 'createPullRequest') {
    const repo = repoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return null;
    const created = createPull(repo, {
      title: str(input.title),
      body: str(input.body),
      head: strOr(input.headRefName, str(input.headRef)),
      base: strOr(input.baseRefName, strOr(input.baseRef, repo.defaultBranch)),
    });
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    return { pullRequest: pullNode(repo, created.pull) };
  }
  if (name === 'mergePullRequest') {
    const node = gqlNodeById(String(input.pullRequestId ?? ''));
    const repo = node?.__repo as Repo | undefined;
    const pull = node?.__pull as Pull | undefined;
    if (!node || !repo || !pull) return null;
    if (pull.state !== 'merged') {
      const result = mergePull(repo, pull, 'merge');
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return null;
      }
    }
    return { pullRequest: node };
  }
  if (name === 'addComment') {
    const node = gqlNodeById(String(input.subjectId ?? ''));
    if (!node) return null;
    const repo = node.__repo as Repo;
    const holder = (node.__issue as Issue | undefined) ?? (node.__pull as Pull | undefined);
    if (!holder) return null;
    const comment: Comment = { id: repo.nextCommentId, body: str(input.body), createdAt: nowIso() };
    repo.nextCommentId += 1;
    holder.comments.push(comment);
    if ('serialized' in holder) invalidateIssue(holder as Issue);
    return { commentEdge: { node: mark('Comment', { __comment: comment }), cursor: '' } };
  }
  return null;
}

function gqlExecuteSelection(ctx: GqlContext, type: string, source: Record<string, unknown>, selection: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentType !== null) {
      if (field.fragmentType === type && field.selection) {
        Object.assign(out, gqlExecuteSelection(ctx, type, source, field.selection));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__type') {
      const typeName = String(gqlResolveValue(field.args.get('name') as GqlValue, ctx.variables) ?? '');
      out[key] = gqlTypeDescription(typeName);
      continue;
    }
    if (field.name === '__schema') {
      out[key] = { types: Object.keys(TYPE_FIELDS).map((name) => gqlTypeDescription(name)) };
      continue;
    }
    if (field.name === '__typename') {
      out[key] = type;
      continue;
    }
    const known = TYPE_FIELDS[type];
    if (known && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    const value = gqlFieldValue(ctx, type, source, field);
    out[key] = gqlShape(ctx, value, field);
  }
  return out;
}

function gqlShape(ctx: GqlContext, value: unknown, field: GqlField): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  if (Array.isArray(value)) return value.map((entry) => gqlShape(ctx, entry, field));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const type = gqlTypeOf(record) ?? inferConnectionType(record, field.name);
    if (type) return gqlExecuteSelection(ctx, type, record, field.selection);
    // Untyped data (connections' pageInfo, edges): walk by key.
    const out: Record<string, unknown> = {};
    for (const sub of field.selection) {
      if (sub.fragmentType !== null) continue;
      const subKey = sub.alias ?? sub.name;
      const subValue = record[sub.name];
      out[subKey] = sub.selection ? gqlShape(ctx, subValue, sub) : (subValue ?? null);
    }
    return out;
  }
  return value;
}

function inferConnectionType(record: Record<string, unknown>, fieldName: string): string | null {
  if ('nodes' in record && 'pageInfo' in record) {
    if (fieldName === 'issues') return 'IssueConnection';
    if (fieldName === 'pullRequests') return 'PullRequestConnection';
    if (fieldName === 'files') return 'PullRequestChangedFileConnection';
    return 'IssueConnection';
  }
  if ('hasNextPage' in record) return 'PageInfo';
  return null;
}

function gqlTypeDescription(name: string): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const kind = TYPE_KIND[name] ?? (fields ? 'OBJECT' : null);
  if (!kind) return null;
  return {
    name,
    kind,
    fields: fields ? fields.map((fieldName) => ({ name: fieldName, description: null, args: [], type: { name: 'String', kind: 'SCALAR' }, isDeprecated: false, deprecationReason: null })) : null,
    enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ name: value, isDeprecated: false })) : null,
  };
}

function gqlRun(req: IncomingMessage, operation: { query: string; variables: Record<string, unknown> }): Record<string, unknown> {
  const ctx: GqlContext = { variables: operation.variables ?? {}, errors: [], req };
  try {
    const parser = new GqlParser(operation.query);
    parser.variables = ctx.variables;
    const parsed = parser.parseOperation();
    const rootType = parsed.type === 'mutation' ? 'Mutation' : 'Query';
    const data = gqlExecuteSelection(ctx, rootType, mark(rootType, {}), parsed.selection);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length) out.errors = ctx.errors;
    return out;
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL error' }] };
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { message: 'Problems parsing JSON' });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const item = entry as Record<string, unknown>;
      return gqlRun(req, { query: str(item.query), variables: (item.variables as Record<string, unknown>) ?? {} });
    });
    return sendJson(res, 200, results);
  }
  const item = parsed as Record<string, unknown>;
  const result = gqlRun(req, { query: str(item.query), variables: (item.variables as Record<string, unknown>) ?? {} });
  return sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The account the repository belongs to.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string', description: 'The owner/name pair.' },
      },
      required: [],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated user owns.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' } }, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
        issue_number: { type: 'number' },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['pull_number'],
    },
  },
];
const MCP_TOOLS_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (!isError && typeof value !== 'string') result.structuredContent = value;
  return result;
}

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = str(args.owner);
  let name = str(args.repo) || str(args.name);
  const fullName = str(args.full_name);
  if ((!owner || !name) && fullName.includes('/')) {
    const [o, n] = fullName.split('/');
    owner = owner || (o as string);
    name = name || (n as string);
  }
  if (!name) return null;
  if (owner && owner !== LOGIN) return null;
  return repos.get(name) ?? null;
}

function mcpCallTool(req: IncomingMessage, rawName: string, args: Record<string, unknown>): Record<string, unknown> {
  const name = rawName.includes('__') ? (rawName.split('__').pop() as string).toLowerCase() : rawName.toLowerCase();
  const tool = MCP_TOOLS.find((entry) => String(entry.name).toLowerCase() === name);
  if (!tool) {
    return { __rpcError: { code: -32601, message: `Method not found: ${rawName}` } };
  }
  const schema = tool.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { __rpcError: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name) || str(args.repo);
      if (repos.has(repoName)) return mcpToolResult(`Repository ${repoName} already exists`, true);
      const repo = createRepo(repoName, str(args.description), args.private === true);
      return mcpToolResult(repoJson(repo, req));
    }
    case 'get_repo': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      return mcpToolResult(repoJson(repo, req));
    }
    case 'list_repos': {
      return mcpToolResult([...repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(repo, req)));
    }
    case 'create_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      const stamp = nowIso();
      const issue: Issue = {
        id: nextIssueId, number: repo.nextNumber, title: str(args.title), body: str(args.body),
        state: 'open', labels: [], comments: [], createdAt: stamp, updatedAt: stamp, serialized: null,
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return mcpToolResult(issueJson(repo, issue, req));
    }
    case 'list_issues': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      const state = strOr(args.state, 'open');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return mcpToolResult(list.map((issue) => issueJson(repo, issue, req)));
    }
    case 'get_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return mcpToolResult('Issue not found', true);
      return mcpToolResult(issueJson(repo, issue, req));
    }
    case 'create_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      const created = createPull(repo, {
        title: str(args.title), body: str(args.body), head: str(args.head), base: strOr(args.base, repo.defaultBranch),
      });
      if ('error' in created) return mcpToolResult(created.error, true);
      return mcpToolResult(pullJson(repo, created.pull, req));
    }
    case 'merge_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolResult('Repository not found', true);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return mcpToolResult('Pull request not found', true);
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return mcpToolResult(result.error, true);
      return mcpToolResult(pullJson(repo, pull, req));
    }
  }
  return { __rpcError: { code: -32601, message: `Method not found: ${rawName}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const message = parsed as Record<string, unknown>;
  const id = message.id ?? null;
  const method = str(message.method);
  const params = (message.params as Record<string, unknown>) ?? {};
  const isNotification = message.id === undefined;
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyError = (code: number, text: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message: text } });

  if (method === 'server/discover') {
    return reply({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'anvil-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    });
  }
  if (method === 'initialize') {
    return reply({
      protocolVersion: strOr(params.protocolVersion, '2025-11-25'),
      capabilities: { tools: {} },
      serverInfo: { name: 'anvil-forge', version: '1.0.0' },
    });
  }
  if (isNotification || method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    requestCounter += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(MCP_TOOLS_JSON) as unknown }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = str(params.name);
    const args = (params.arguments as Record<string, unknown>) ?? {};
    const result = mcpCallTool(req, toolName, args);
    const rpcError = result.__rpcError as { code: number; message: string } | undefined;
    if (rpcError) return replyError(rpcError.code, rpcError.message);
    return reply(result);
  }
  return replyError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Router + bootstrap
// ---------------------------------------------------------------------------

export function createForgeServer() {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (path === '/healthz') {
          return sendJson(res, 200, { ok: true });
        }
        if (!authed(req)) {
          if (path.startsWith('/api/v3')) return restError(res, 401, 'Bad credentials');
          return sendJson(res, 401, { message: 'Bad credentials' });
        }
        if (path === '/api/graphql' && req.method === 'POST') return await handleGraphql(req, res);
        if (path === '/mcp' && req.method === 'POST') return await handleMcp(req, res);
        if (path === '/api/v3' || path.startsWith('/api/v3/')) return await handleRest(req, res, url);
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          const sub = gitMatch[3] ?? '';
          const repo = findRepo(owner, name);
          if (!repo) return sendJson(res, 404, { message: 'Not Found' });
          if (sub === '/info/refs' && req.method === 'GET') {
            return handleInfoRefs(req, res, repo, url.searchParams.get('service') ?? 'git-upload-pack', url);
          }
          if (sub === '/git-upload-pack' && req.method === 'POST') return await handleUploadPack(req, res, repo);
          if (sub === '/git-receive-pack' && req.method === 'POST') return await handleReceivePack(req, res, repo);
          return sendJson(res, 404, { message: 'Not Found' });
        }
        return sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Internal error' }));
      }
    })();
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

/** Bind an ephemeral port, register with the trial env, serve until done. */
export async function runForge(): Promise<void> {
  const server = createForgeServer();
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL) {
    // Register, retrying briefly: the env may still be binding its own port.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const answer = await fetch(`${ENV_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port }),
        });
        if (answer.ok) break;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Long-poll /done until the suite is finished, then exit 0.
    for (;;) {
      try {
        const answer = await fetch(`${ENV_URL}/done`);
        if (answer.ok) {
          const body = (await answer.json()) as { done?: boolean };
          if (body.done) break;
        }
      } catch {
        // keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } else {
    await new Promise<void>(() => undefined);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
