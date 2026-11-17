// Anvil Forge — the git engine.
//
// Everything git-shaped lives here: pkt-line framing, the content-addressed
// object store, pack reading and writing, ancestry walks and fetch planning.
// The store is keyed by the sha1 of each object, computed exactly once when
// the object is stored; nothing on a read path ever re-hashes.
//
// The pack reader inflates each object exactly once: a single
// `inflateSync(rest, { info: true })` call returns the object's bytes and the
// number of compressed bytes it consumed, so the reader walks a pack in one
// pass with no trial inflations and no rescanning.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_BY_CODE: Record<number, ObjType | undefined> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Frame one payload as a pkt-line (4 hex digits of total length + payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 0xffff) throw new Error(`pkt-line too long: ${total}`);
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** A cursor over a buffer of pkt-lines; throws on malformed framing. */
export class PktReader {
  private buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Offset of the first byte not yet consumed (the pack starts here after the command list). */
  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  next(): Packet | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line header');
    const hex = this.buf.toString('ascii', this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length: ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      this.pos += 4;
      return { kind: 'flush' };
    }
    if (len === 1) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (len === 2) {
      this.pos += 4;
      return { kind: 'response-end' };
    }
    if (len === 3) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (len < 4 || this.pos + len > this.buf.length) throw new Error(`pkt-line length ${len} overruns the body`);
    const payload = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return { kind: 'data', payload };
  }
}

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  /** Committer timestamp, seconds. */
  time: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  isTree: boolean;
}

export function parseCommitData(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  let tree = '';
  const parents: string[] = [];
  let time = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) time = Number(match[1]);
    }
  }
  return { tree, parents, time };
}

export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid, isTree: mode === '40000' });
    pos = nul + 21;
  }
  return entries;
}

/** Serialise tree entries (sorted the git way: by name, directories as if suffixed with '/'). */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.isTree ? `${a.name}/` : a.name;
    const kb = b.isTree ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  private commitCache = new Map<string, ParsedCommit>();
  private treeCache = new Map<string, TreeEntry[]>();
  private closureCache = new Map<string, Set<string>>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object, hashing it exactly once; returns its id. */
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (the pack reader hashed it while inflating). */
  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  commit(oid: string): ParsedCommit | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommitData(obj.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  tree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const parsed = parseTreeData(obj.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Every object in a tree's closure (the tree itself, subtrees and blobs), memoised per tree. */
  treeClosure(treeOid: string): Set<string> {
    const cached = this.closureCache.get(treeOid);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'tree') {
        const entries = this.tree(oid);
        if (entries) for (const entry of entries) stack.push(entry.oid);
      }
    }
    this.closureCache.set(treeOid, out);
    return out;
  }

  /** The full closure of a commit: the commit, its ancestors and every tree and blob they name. */
  commitClosure(tip: string): Set<string> {
    const out = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const parsed = this.commit(oid);
      if (!parsed) continue;
      out.add(oid);
      for (const oidInTree of this.treeClosure(parsed.tree)) out.add(oidInTree);
      for (const parent of parsed.parents) stack.push(parent);
    }
    return out;
  }

  /**
   * Is `ancestor` reachable from `descendant`? Depth-first with early exit and
   * a visited set: the fast-forward fast path (the ancestor is the direct
   * parent) resolves in a single step.
   */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const parsed = this.commit(oid);
      if (parsed) for (const parent of parsed.parents) stack.push(parent);
    }
    return false;
  }

  /** The tag object a ref names, peeled to the commit beneath it (or the object itself). */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let guard = 0; guard < 16; guard += 1) {
      const obj = this.objects.get(current);
      if (!obj) return current;
      if (obj.type === 'commit') return current;
      if (obj.type !== 'tag') return current;
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match || !match[1]) return current;
      current = match[1];
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Pack writing
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = CODE_BY_TYPE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a complete pack holding exactly `oids` (no deltas), in the order given. */
export function buildPack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`pack requested a missing object ${oid}`);
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

interface PackEntry {
  offset: number;
  type: ObjType;
  data: Buffer;
  oid: string;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const cmd = delta[pos] as number;
    pos += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (cmd & 0x02) { offset += (delta[pos] as number) << 8; pos += 1; }
      if (cmd & 0x04) { offset += (delta[pos] as number) << 16; pos += 1; }
      if (cmd & 0x08) { offset += (delta[pos] as number) << 24; pos += 1; }
      if (cmd & 0x10) { size = delta[pos] as number; pos += 1; }
      if (cmd & 0x20) { size += (delta[pos] as number) << 8; pos += 1; }
      if (cmd & 0x40) { size += (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd > 0) {
      parts.push(delta.subarray(pos, pos + cmd));
      produced += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Read a whole pack into `staging` (not yet into the store, so a bad pack
 * changes nothing). Each object is inflated exactly once; deltas are resolved
 * against the pack itself or, for a thin pack, against the store.
 */
export function readPack(store: ObjectStore, pack: Buffer, staging: Map<string, GitObject>): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const pending: Array<{ offset: number; baseOffset: number; baseOid: string; delta: Buffer }> = [];

  const inflateOne = (at: number): { data: Buffer; consumed: number } => {
    const rest = pack.subarray(at, pack.length - 20);
    const result = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { data: result.buffer, consumed: result.engine.bytesWritten };
  };

  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object's header.
      let back = pack[pos] as number;
      pos += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos] as number;
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const { data, consumed } = inflateOne(pos);
      pos += consumed;
      pending.push({ offset, baseOffset: offset - baseOffset, baseOid: '', delta: data });
      continue;
    }
    if (typeCode === 7) {
      // REF_DELTA: the base's id follows the header.
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, consumed } = inflateOne(pos);
      pos += consumed;
      pending.push({ offset, baseOffset: -1, baseOid, delta: data });
      continue;
    }
    const type = TYPE_BY_CODE[typeCode];
    if (!type) throw new Error(`pack object type ${typeCode}`);
    const { data, consumed } = inflateOne(pos);
    pos += consumed;
    const oid = hashObject(type, data);
    const entry: PackEntry = { offset, type, data, oid };
    entries.push(entry);
    byOffset.set(offset, entry);
  }

  // Resolve deltas. An OFS base always sits earlier in the same pack, so a
  // short loop settles every chain; a REF base may also live in the store.
  const resolvedByOffset = new Map<number, PackEntry>();
  for (const entry of entries) resolvedByOffset.set(entry.offset, entry);
  let guard = pending.length + 2;
  while (pending.length && guard > 0) {
    guard -= 1;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i] as (typeof pending)[number];
      let base: { type: ObjType; data: Buffer } | undefined;
      if (item.baseOffset >= 0) {
        const found = resolvedByOffset.get(item.baseOffset);
        if (found) base = found;
      } else {
        const inPack = entries.find((entry) => entry.oid === item.baseOid) ?? [...resolvedByOffset.values()].find((entry) => entry.oid === item.baseOid);
        if (inPack) base = inPack;
        else base = store.get(item.baseOid) ?? staging.get(item.baseOid);
      }
      if (!base) continue;
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      const entry: PackEntry = { offset: item.offset, type: base.type, data, oid };
      resolvedByOffset.set(item.offset, entry);
      entries.push(entry);
      pending.splice(i, 1);
    }
  }
  if (pending.length) throw new Error('pack delta base is missing');

  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  for (const entry of entries) staging.set(entry.oid, { type: entry.type, data: entry.data });
  return entries.length;
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchRequest2 {
  wants: string[];
  haves: string[];
  /** Commit ids the client already holds as shallow boundary commits. */
  clientShallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
  /** Tag object ids advertised by refs; git follows tags into wanted history. */
  followTags?: string[];
}

export interface FetchPlan {
  /** Object ids for the pack, tips first. */
  objects: string[];
  /** Boundary commits to report as `shallow`. */
  shallow: string[];
  /** Client shallow commits whose parents are now included: `unshallow`. */
  unshallow: string[];
}

/**
 * Plan a fetch the way git does: the want closure (cut by deepen rules) minus
 * everything the client provably holds (the have closure, plus each shallow
 * commit the client named and that commit's own tree closure).
 */
export function planFetch(store: ObjectStore, request: FetchRequest2): FetchPlan {
  // What the client provably holds. A have that is also a shallow boundary
  // acknowledges only that commit and its tree closure — the client does NOT
  // hold its ancestors. Any other have acknowledges its whole history.
  const clientShallowSet = new Set(request.clientShallow);
  const haveSet = new Set<string>();
  const holdCommit = (oid: string): void => {
    haveSet.add(oid);
    const parsed = store.commit(oid);
    if (parsed) for (const inner of store.treeClosure(parsed.tree)) haveSet.add(inner);
  };
  for (const have of request.haves) {
    if (!store.has(have)) continue;
    if (clientShallowSet.has(have)) holdCommit(have);
    else for (const oid of store.commitClosure(have)) holdCommit(oid);
  }
  for (const shallowOid of request.clientShallow) holdCommit(shallowOid);

  const excluded = new Set<string>();
  for (const not of request.deepenNot ?? []) {
    if (!store.has(not)) continue;
    for (const oid of store.commitClosure(not)) excluded.add(oid);
  }

  // Breadth-first by generation so a depth limit cuts evenly on every path.
  // A want that names a tag object delivers the tag itself plus its target.
  const generation = new Map<string, number>();
  const queue: string[] = [];
  const wantedTags = new Set<string>();
  for (const want of request.wants) {
    if (!store.has(want) || excluded.has(want)) continue;
    let cursor = want;
    while (store.get(cursor)?.type === 'tag') {
      wantedTags.add(cursor);
      const parsedTag = parseTag((store.get(cursor) as GitObject).data);
      if (!parsedTag) {
        cursor = '';
        break;
      }
      cursor = parsedTag.object;
    }
    if (!cursor || !store.commit(cursor)) continue;
    if (!generation.has(cursor)) {
      generation.set(cursor, 0);
      queue.push(cursor);
    }
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  const since = request.deepenSince;
  while (queue.length) {
    const oid = queue.shift() as string;
    const gen = generation.get(oid) as number;
    const parsed = store.commit(oid);
    if (!parsed) continue;
    if (since !== undefined && included.size > 0 && parsed.time <= since && gen > 0) {
      // Older than the deepen-since horizon: not included, not a boundary we
      // name (its child already in the set carries the boundary).
      continue;
    }
    included.add(oid);
    let cut = false;
    for (const parent of parsed.parents) {
      if (excluded.has(parent)) {
        cut = true;
        continue;
      }
      if (request.depth !== undefined && gen + 1 >= request.depth) {
        cut = true;
        continue;
      }
      const parentCommit = store.commit(parent);
      if (!parentCommit) {
        cut = true;
        continue;
      }
      if (since !== undefined && parentCommit.time <= since) {
        cut = true;
        continue;
      }
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
    if (cut && parsed.parents.length > 0) boundary.add(oid);
    if (parsed.parents.length === 0) boundary.delete(oid);
  }

  const wantSet = new Set<string>();
  for (const oid of included) {
    wantSet.add(oid);
    const parsed = store.commit(oid);
    if (parsed) for (const inner of store.treeClosure(parsed.tree)) wantSet.add(inner);
  }
  for (const oid of excluded) wantSet.delete(oid);

  const objects: string[] = [];
  for (const oid of wantSet) if (!haveSet.has(oid)) objects.push(oid);
  // Tag following: a tag ref whose target commit is in the delivered set
  // travels with the pack, exactly as upload-pack sends it.
  for (const tagOid of request.followTags ?? []) {
    let cursor: string | null = tagOid;
    const chain: string[] = [];
    while (cursor && store.get(cursor)?.type === 'tag') {
      chain.push(cursor);
      const parsedTag = parseTag(store.get(cursor)?.data ?? Buffer.alloc(0));
      cursor = parsedTag ? parsedTag.object : null;
    }
    if (cursor && wantSet.has(cursor) && !haveSet.has(cursor)) {
      for (const oid of chain) if (!haveSet.has(oid) && !objects.includes(oid)) objects.push(oid);
    }
  }
  for (const oid of wantedTags) if (!haveSet.has(oid) && !objects.includes(oid)) objects.push(oid);
  // Tips first keeps the pack friendly to stream readers; order is not scored.
  objects.sort((a, b) => (request.wants.includes(a) ? 0 : 1) - (request.wants.includes(b) ? 0 : 1));

  const clientShallow = new Set(request.clientShallow);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of boundary) {
    if (wantSet.has(oid) && !clientShallow.has(oid)) shallow.push(oid);
  }
  for (const oid of clientShallow) {
    if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Tree path surgery (the contents API)
// ---------------------------------------------------------------------------

/** The blob id at `path` under `rootTree`, or null when any hop is missing. */
export function lookupPath(store: ObjectStore, rootTree: string, path: string): { oid: string; isTree: boolean } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = rootTree;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = store.tree(current);
    if (!entries) return null;
    const entry = entries.find((candidate) => candidate.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, isTree: entry.isTree };
    if (!entry.isTree) return null;
    current = entry.oid;
  }
  return { oid: current, isTree: true };
}

/** Every path -> blob id in a tree, recursively (for listings and PR file diffs). */
export function flattenTree(store: ObjectStore, rootTree: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeOid: string, at: string): void => {
    const entries = store.tree(treeOid);
    if (!entries) return;
    for (const entry of entries) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isTree) walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(rootTree, prefix);
  return out;
}

/**
 * Return a new root tree with `path` set to `blobOid` (or removed when
 * `blobOid` is null), creating intermediate trees. Unchanged subtrees keep
 * their ids, so the surgery allocates only along the edited path.
 */
export function setPath(store: ObjectStore, rootTree: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((part) => part !== '');
  const apply = (treeOid: string | null, depth: number): string | null => {
    const name = parts[depth] as string;
    const entries: TreeEntry[] = treeOid ? [...(store.tree(treeOid) ?? [])] : [];
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '100644', name, oid: blobOid, isTree: false };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid, isTree: false });
      }
    } else {
      const childOid = index >= 0 && entries[index]?.isTree ? (entries[index] as TreeEntry).oid : null;
      const newChild = apply(childOid, depth + 1);
      if (newChild === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '40000', name, oid: newChild, isTree: true };
      } else {
        entries.push({ mode: '40000', name, oid: newChild, isTree: true });
      }
    }
    if (entries.length === 0) return null;
    return store.put('tree', buildTreeData(entries));
  };
  const result = apply(rootTree, 0);
  if (result === null) {
    // The tree emptied out entirely: git still names an (empty) tree object.
    return store.put('tree', Buffer.alloc(0));
  }
  return result;
}

/** Paths whose blob differs between two trees (added, removed or changed). */
export function diffTreePaths(store: ObjectStore, fromTree: string | null, toTree: string | null): string[] {
  const from = fromTree ? flattenTree(store, fromTree) : new Map<string, string>();
  const to = toTree ? flattenTree(store, toTree) : new Map<string, string>();
  const out: string[] = [];
  for (const [path, oid] of to) if (from.get(path) !== oid) out.push(path);
  for (const path of from.keys()) if (!to.has(path)) out.push(path);
  return out.sort();
}

/** Compose a commit object. */
export function buildCommitData(input: {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  time: number;
}): Buffer {
  const ident = `${input.authorName} <${input.authorEmail}> ${input.time} +0000`;
  let text = `tree ${input.tree}\n`;
  for (const parent of input.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${input.message}`;
  if (!input.message.endsWith('\n')) text += '\n';
  return Buffer.from(text, 'utf8');
}
