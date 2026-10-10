// FSEQ reader (and a small writer used by tests / test patterns).
// Layout follows FPP's src/fseq/FSEQFile.cpp; see PRIMER.md "fseq" for the
// details that matter: little-endian everywhere, 12-bit block count, zero-
// length block entries skipped, block 0 is short (10 frames), each block is
// an independent zstd frame or zlib (RFC 1950) stream, sparse ranges are
// concatenated in table order.

const fs = require('fs');
const zlib = require('zlib');

const COMP_NONE = 0, COMP_ZSTD = 1, COMP_ZLIB = 2;

// Byte length of the zstd (or skippable) frame starting at `pos`, from the
// frame format in RFC 8878. Needed because Node's zstd decoder stops after the
// first frame, while FPP accepts blocks holding several concatenated frames.
function zstdFrameLength(buf, pos) {
  const magic = buf.readUInt32LE(pos);
  if ((magic & 0xfffffff0) === 0x184d2a50) return 8 + buf.readUInt32LE(pos + 4); // skippable
  if (magic !== 0xfd2fb528) return -1;
  let p = pos + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
    p += type === 1 ? 1 : size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p - pos;
}

function zstdDecompressAll(buf, expected) {
  const first = zlib.zstdDecompressSync(buf);
  if (first.length >= expected) return first;
  const parts = [];
  let pos = 0, total = 0;
  while (pos + 4 <= buf.length && total < expected) {
    const len = zstdFrameLength(buf, pos);
    if (len <= 0 || pos + len > buf.length) break;
    const magic = buf.readUInt32LE(pos);
    if (magic === 0xfd2fb528) {
      const out = zlib.zstdDecompressSync(buf.subarray(pos, pos + len));
      parts.push(out);
      total += out.length;
    }
    pos += len;
  }
  return parts.length ? Buffer.concat(parts) : first;
}

function readHeader(fd, fileSize) {
  const peek = Buffer.alloc(8);
  fs.readSync(fd, peek, 0, 8, 0);
  const magic = peek.toString('latin1', 0, 4);

  if (magic === 'ESEQ') {
    const b = Buffer.alloc(20);
    fs.readSync(fd, b, 0, 20, 0);
    const cc = b.readUInt32LE(8), ms = b.readUInt32LE(12), ml = b.readUInt32LE(16);
    return {
      magic, major: 2, minor: 0, dataOffset: 20, channelCount: cc, stepMs: 50,
      frameCount: cc ? Math.floor((fileSize - 20) / cc) : 0, compression: COMP_NONE,
      blocks: [{ firstFrame: 0, offset: 20 }], sparse: [[ms ? ms - 1 : 0, ml]], vars: {}, uniqueId: 0n,
      chanDataEnd: fileSize,
    };
  }
  if (magic !== 'PSEQ' && magic !== 'FSEQ') throw new Error('not an fseq file (bad magic)');

  const dataOffset = peek.readUInt16LE(4);
  const minor = peek[6], major = peek[7];
  if (major !== 1 && major !== 2) throw new Error(`unsupported fseq major version ${major}`);
  if (dataOffset < (major === 1 ? 19 : 32) || dataOffset > fileSize) throw new Error('corrupt fseq header');

  const buf = Buffer.alloc(dataOffset);
  fs.readSync(fd, buf, 0, dataOffset, 0);
  const h = {
    magic, major, minor, dataOffset,
    channelCount: buf.readUInt32LE(10),
    frameCount: buf.readUInt32LE(14),
    stepMs: buf[18] || 50,
    compression: COMP_NONE, blocks: [], sparse: [], vars: {}, uniqueId: 0n, chanDataEnd: fileSize,
  };

  let pos;
  if (major === 1) {
    pos = 28;
    h.blocks = [{ firstFrame: 0, offset: dataOffset }];
  } else {
    h.compression = buf[20] & 0x0f;
    if (h.compression > COMP_ZLIB) h.compression = COMP_NONE;
    const nBlocks = ((buf[20] & 0xf0) << 4) | buf[21];
    const nRanges = buf[22];
    h.uniqueId = buf.readBigUInt64LE(24);
    pos = 32;
    let off = dataOffset;
    let lastFirst = 0;
    for (let i = 0; i < nBlocks && pos + 8 <= dataOffset; i++, pos += 8) {
      let ff = buf.readUInt32LE(pos);
      const len = buf.readUInt32LE(pos + 4);
      if (len === 0) continue;
      if (ff < lastFirst) ff = lastFirst;
      lastFirst = ff;
      h.blocks.push({ firstFrame: ff, offset: off });
      off += len;
    }
    if (h.compression === COMP_NONE || h.blocks.length === 0) {
      h.blocks = [{ firstFrame: 0, offset: dataOffset }];
      h.chanDataEnd = fileSize;
    } else {
      h.blocks[0].firstFrame = 0;
      h.chanDataEnd = Math.min(off, fileSize);
    }
    for (let i = 0; i < nRanges && pos + 6 <= dataOffset; i++, pos += 6) {
      h.sparse.push([buf.readUIntLE(pos, 3), buf.readUIntLE(pos + 3, 3)]);
    }
  }

  // Variable headers. Zero padding before the channel data parses as empty
  // headers with code "\0\0"; those are skipped.
  while (pos + 4 < dataOffset) {
    const len = buf.readUInt16LE(pos);
    const code = buf.toString('latin1', pos + 2, pos + 4);
    if (len <= 4) { pos += 4; continue; }
    if (code === 'ED') {
      if (pos + 18 > dataOffset) break;
      const real = buf.toString('latin1', pos + 4, pos + 6);
      const extOff = Number(buf.readBigUInt64LE(pos + 6));
      const extLen = buf.readUInt32LE(pos + 14);
      h.vars[real] = { extOffset: extOff, extLength: extLen };
      if (extOff < h.chanDataEnd) h.chanDataEnd = extOff;
      pos += 18;
      continue;
    }
    if (pos + len > dataOffset) break;
    if (code !== '\0\0') h.vars[code] = buf.subarray(pos + 4, pos + len);
    pos += len;
  }

  // Sentinel so block i spans [offset[i], offset[i+1]).
  h.blocks.push({ firstFrame: h.frameCount + 2, offset: h.chanDataEnd });
  return h;
}

function cString(b) {
  if (!b || !Buffer.isBuffer(b)) return '';
  const nul = b.indexOf(0);
  return b.toString('utf8', 0, nul === -1 ? b.length : nul);
}

class FseqFile {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.h = readHeader(this.fd, this.size);
    const sparse = this.h.sparse;
    this.maxChannel = sparse.length
      ? Math.max(...sparse.map(([s, l]) => s + l))
      : this.h.channelCount;
    this._cache = new Map(); // block index -> { first, data }; at most 3 kept
    this.syncDecodes = 0;    // blocks decoded on the caller's thread (not handed in via putBlock)
  }

  get compressed() { return this.h.major !== 1 && this.h.compression !== COMP_NONE; }
  get blockCount() { return this.compressed ? this.h.blocks.length - 1 : 0; }
  blockIndexFor(n) { return this._blockIndex(n); }
  hasBlock(i) { return this._cache.has(i); }

  // Hand in a block decoded elsewhere (the decode thread).
  // Returns the blocks pushed out of the cache, so their memory can be reused.
  putBlock(i, first, data) {
    this._cache.set(i, { first, data });
    const evicted = [];
    while (this._cache.size > 3) {
      const k = this._cache.keys().next().value;
      evicted.push(this._cache.get(k));
      this._cache.delete(k);
    }
    return evicted;
  }

  get frameCount() { return this.h.frameCount; }
  get stepMs() { return this.h.stepMs; }
  get channelCount() { return this.h.channelCount; }
  get durationMs() { return this.h.frameCount * this.h.stepMs; }
  // xLights writes the media's full path on the PC it ran on; keep the file name.
  get mediaFilename() { return cString(this.h.vars.mf).split(/[\\/]/).pop(); }
  get producer() { return cString(this.h.vars.sp); }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    this._cache.clear();
  }

  _blockIndex(n) {
    const b = this.h.blocks;
    // Linear walk is what FPP does; block counts are small (<4096) and the
    // cache means this runs once per block, not per frame.
    let i = 0;
    while (i + 2 < b.length && n >= b[i + 1].firstFrame) i++;
    return i;
  }

  _loadBlock(i) {
    const hit = this._cache.get(i);
    if (hit) return hit;
    this.syncDecodes++;
    const entry = this.decodeBlock(i);
    this.putBlock(i, entry.first, entry.data);
    return entry;
  }

  // Read and decompress block i without touching the cache.
  decodeBlock(i) {
    const b = this.h.blocks;
    const start = b[i].offset, end = b[i + 1].offset;
    const comp = Buffer.alloc(Math.max(0, end - start));
    fs.readSync(this.fd, comp, 0, comp.length, start);
    const frames = Math.min(b[i + 1].firstFrame, this.h.frameCount) - b[i].firstFrame;
    const expected = Math.max(0, frames) * this.h.channelCount;
    let out;
    if (this.h.compression === COMP_ZSTD) out = zstdDecompressAll(comp, expected);
    else out = zlib.inflateSync(comp);
    return { first: b[i].firstFrame, data: out };
  }

  // Decode the block holding frame n ahead of time (called in idle time
  // between frames) so a block boundary never costs a late frame.
  prefetch(n) {
    if (this.h.major === 1 || this.h.compression === COMP_NONE) return;
    if (n < 0 || n >= this.h.frameCount) return;
    this._loadBlock(this._blockIndex(n));
  }

  // Raw stored bytes for frame n (sparse ranges still concatenated).
  rawFrame(n) {
    if (n < 0 || n >= this.h.frameCount) return null;
    const cc = this.h.channelCount;
    if (this.h.major === 1 || this.h.compression === COMP_NONE) {
      const out = Buffer.alloc(cc);
      fs.readSync(this.fd, out, 0, cc, this.h.dataOffset + n * cc);
      return out;
    }
    const blk = this._loadBlock(this._blockIndex(n));
    const off = (n - blk.first) * cc;
    if (off + cc > blk.data.length) {
      // Short/corrupt block: FPP zero-fills rather than stopping the show.
      const out = Buffer.alloc(cc);
      if (off < blk.data.length) blk.data.copy(out, 0, off);
      return out;
    }
    return blk.data.subarray(off, off + cc);
  }

  // Copy frame n into an absolute 0-based channel buffer.
  frameInto(n, target) {
    const raw = this.rawFrame(n);
    if (!raw) return false;
    if (!this.h.sparse.length) {
      raw.copy(target, 0, 0, Math.min(raw.length, target.length));
      return true;
    }
    let src = 0;
    for (const [s, l] of this.h.sparse) {
      if (s < target.length) raw.copy(target, s, src, src + Math.min(l, target.length - s));
      src += l;
    }
    return true;
  }

  // Shape xLights compares in GET /api/sequence/<n>/meta before deciding
  // whether to upload (fsequtils -j in FPP).
  meta(name) {
    const h = this.h;
    const m = {
      Name: name,
      Version: `${h.major}.${h.minor}`,
      ID: h.uniqueId.toString(),
      StepTime: h.stepMs,
      NumFrames: h.frameCount,
      MaxChannel: this.maxChannel,
      ChannelCount: h.channelCount,
    };
    const vars = {};
    for (const [k, v] of Object.entries(h.vars)) if (Buffer.isBuffer(v) && (k === 'mf' || k === 'sp')) vars[k] = cString(v);
    if (Object.keys(vars).length) m.variableHeaders = vars;
    if (h.major === 2) {
      if (h.sparse.length) m.Ranges = h.sparse.map(([s, l]) => ({ Start: s, Length: l }));
      m.CompressionType = h.compression;
      m.CompressionTypeString = ['none', 'zstd', 'zlib'][h.compression];
    }
    return m;
  }
}

// ------------------------------------------------------------------
// Writer: v2, optional zstd/zlib compression and sparse ranges. Matches
// FPP's choices (block 0 = 10 frames, spare zero entries in the table).
// ------------------------------------------------------------------
function writeFseq(file, { channelCount, stepMs = 25, frames, compression = COMP_ZSTD,
  framesPerBlock = 40, sparse = [], mediaFile = '', producer = 'ShowPilot Player', uniqueId } = {}) {
  const frameCount = frames.length;
  const storedCC = sparse.length ? sparse.reduce((a, [, l]) => a + l, 0) : channelCount;

  const blocks = [];
  if (compression !== COMP_NONE) {
    let i = 0;
    let first = true;
    while (i < frameCount) {
      const n = first ? Math.min(10, frameCount - i) : Math.min(framesPerBlock, frameCount - i);
      first = false;
      const raw = Buffer.concat(frames.slice(i, i + n).map((f) => stored(f)));
      const data = compression === COMP_ZSTD ? zlib.zstdCompressSync(raw) : zlib.deflateSync(raw);
      blocks.push({ firstFrame: i, data });
      i += n;
    }
  }
  function stored(f) {
    if (!sparse.length) return f.subarray(0, storedCC);
    return Buffer.concat(sparse.map(([s, l]) => f.subarray(s, s + l)));
  }

  const tableEntries = blocks.length ? blocks.length + 2 : 0; // spare empty slots, like FPP
  const vh = [];
  const addVar = (code, str) => {
    if (!str) return;
    const data = Buffer.from(str + '\0', 'utf8');
    const b = Buffer.alloc(4 + data.length);
    b.writeUInt16LE(4 + data.length, 0);
    b.write(code, 2, 'latin1');
    data.copy(b, 4);
    vh.push(b);
  };
  addVar('mf', mediaFile);
  addVar('sp', producer);
  const varBuf = Buffer.concat(vh);
  const fixedLen = 32 + 8 * tableEntries + 6 * sparse.length;
  let dataOffset = fixedLen + varBuf.length;
  dataOffset = (dataOffset + 3) & ~3;

  const hdr = Buffer.alloc(dataOffset);
  hdr.write('PSEQ', 0, 'latin1');
  hdr.writeUInt16LE(dataOffset, 4);
  hdr[6] = 1; hdr[7] = 2; // v2.1
  hdr.writeUInt16LE(fixedLen, 8);
  hdr.writeUInt32LE(storedCC, 10);
  hdr.writeUInt32LE(frameCount, 14);
  hdr[18] = stepMs;
  hdr[19] = 0;
  hdr[20] = (compression & 0x0f) | ((tableEntries >> 4) & 0xf0);
  hdr[21] = tableEntries & 0xff;
  hdr[22] = sparse.length;
  hdr.writeBigUInt64LE(uniqueId !== undefined ? BigInt(uniqueId) : BigInt(Date.now()) * 1000n, 24);
  let p = 32;
  for (const b of blocks) { hdr.writeUInt32LE(b.firstFrame, p); hdr.writeUInt32LE(b.data.length, p + 4); p += 8; }
  p = 32 + 8 * tableEntries;
  for (const [s, l] of sparse) { hdr.writeUIntLE(s, p, 3); hdr.writeUIntLE(l, p + 3, 3); p += 6; }
  varBuf.copy(hdr, fixedLen);

  const body = compression === COMP_NONE
    ? Buffer.concat(frames.map((f) => stored(f)))
    : Buffer.concat(blocks.map((b) => b.data));
  fs.writeFileSync(file, Buffer.concat([hdr, body]));
}

function probe(file) {
  const f = new FseqFile(file);
  try {
    return {
      frameCount: f.frameCount, stepMs: f.stepMs, durationMs: f.durationMs,
      channelCount: f.channelCount, maxChannel: f.maxChannel,
      mediaFilename: f.mediaFilename, version: `${f.h.major}.${f.h.minor}`,
      compression: ['none', 'zstd', 'zlib'][f.h.compression],
    };
  } finally { f.close(); }
}

module.exports = { FseqFile, writeFseq, probe, COMP_NONE, COMP_ZSTD, COMP_ZLIB };
