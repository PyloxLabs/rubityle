'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const archiver = require('archiver');
const config = require('../config');

function resolveServerPath(uuid, relPath) {
  const base = path.resolve(config.serverDir(uuid));
  // Paths arrive as virtual, server-relative paths (always rooted at "/").
  // Treat them as relative so "/" maps to the server dir instead of the
  // filesystem root (path.resolve treats a leading "/" as absolute).
  let rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(base, rel || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error('Invalid path');
    err.statusCode = 400;
    throw err;
  }
  return target;
}

function safeBaseName(name) {
  return String(name == null ? '' : name).replace(/[\/\\]/g, '').replace(/\.\./g, '').trim();
}

function withinServerDir(uuid, target) {
  const base = path.resolve(config.serverDir(uuid));
  const t = path.resolve(target);
  return t === base || t.startsWith(base + path.sep);
}

function withinServerDirBase(target, destDir) {
  const b = path.resolve(destDir);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

const COMPRESSED_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'tbz2', 'txz', 'lz', 'lzma', 'lzo', 'zst']);

function archiveExtension(name) {
  const base = path.basename(String(name || ''));
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function looksLikeTar(buf) {
  if (buf.length < 512 || buf.length % 512 !== 0) return false;
  const magic = buf.toString('utf8', 257, 262);
  return magic === 'ustar';
}

function extractTarInto(buf, destDir) {
  const base = path.resolve(destDir);

  function readString(start, len) {
    let end = start;
    while (end < start + len && buf[end] !== 0) end += 1;
    return buf.toString('utf8', start, end);
  }
  function parseNumber(start, len) {
    if (buf[start] & 0x80) {
      let value = 0;
      for (let i = start; i < start + len; i += 1) value = value * 256 + buf[i];
      return value;
    }
    const parsed = parseInt(readString(start, len).trim(), 8);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  let offset = 0;
  let written = 0;
  let pendingLongName = null;
  let pendingPaxName = null;

  while (offset + 512 <= buf.length) {
    let empty = true;
    for (let i = 0; i < 512; i += 1) { if (buf[offset + i] !== 0) { empty = false; break; } }
    if (empty) break;

    const rawName = readString(offset, 100);
    const size = parseNumber(offset + 124, 12);
    const type = String.fromCharCode(buf[offset + 156] || 0);
    const prefix = readString(offset + 345, 155);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      pendingLongName = buf.toString('utf8', dataStart, dataStart + size).replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const text = buf.toString('utf8', dataStart, dataStart + size);
      const match = text.match(/\d+ path=([^\n]+)\n/);
      if (match) pendingPaxName = match[1].replace(/\0+$/, '');
      continue;
    }

    let entryName = pendingPaxName || pendingLongName || (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    pendingPaxName = null;
    entryName = entryName.replace(/^\.\//, '');
    if (!entryName || entryName === '.' || entryName === '/') continue;

    const target = path.resolve(base, entryName);
    if (target !== base && !target.startsWith(base + path.sep)) continue;

    if (type === '5' || entryName.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0') continue;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf.slice(dataStart, dataStart + size));
    written += 1;
  }
  return written;
}

function readRange(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buf : buf.slice(0, read);
}

function extractZipInto(zipPath, destDir) {
  const base = path.resolve(destDir);
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;

    const tailLen = Math.min(size, 0x10000 + 22);
    const tailStart = size - tailLen;
    const tail = readRange(fd, tailStart, tailLen);
    let eocdRel = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdRel = i; break; }
    }
    if (eocdRel === -1) throw new Error('archive is not a valid zip (missing central directory)');
    const eocdBuf = tail.slice(eocdRel, eocdRel + 22);

    let cdOffset = eocdBuf.readUInt32LE(16);
    let entryCount = eocdBuf.readUInt16LE(10);

    if (cdOffset === 0xffffffff || entryCount === 0xffff) {
      if (eocdRel >= 20 && tail.readUInt32LE(eocdRel - 20) === 0x07064b50) {
        const z64 = Number(tail.readBigUInt64LE(eocdRel - 20 + 8));
        const hdr = readRange(fd, z64, 56);
        if (hdr.length >= 56 && hdr.readUInt32LE(0) === 0x06064b50) {
          entryCount = Number(hdr.readBigUInt64LE(32));
          cdOffset = Number(hdr.readBigUInt64LE(48));
        }
      }
    }

    const cd = readRange(fd, cdOffset, size - cdOffset);
    let p = 0;
    let written = 0;

    for (let n = 0; n < entryCount; n += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) {
        throw new Error('archive is not a valid zip (corrupt central directory)');
      }
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');

      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const sz = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + sz;
        }
      }

      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;

      const target = path.resolve(base, name);
      if (target !== base && !target.startsWith(base + path.sep)) continue;

      const lh = readRange(fd, localOffset, 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('archive is not a valid zip (corrupt entry header)');
      }
      const lNameLen = lh.readUInt16LE(26);
      const lExtraLen = lh.readUInt16LE(28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const comp = readRange(fd, dataStart, compSize);
      if (comp.length !== compSize) throw new Error('archive is truncated or corrupt');

      let data;
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else throw new Error(`unsupported compression method ${method}`);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      written += 1;
    }

    return written;
  } finally {
    fs.closeSync(fd);
  }
}

function extractArchive(full, entryName) {
  const destDir = path.dirname(full);
  const lower = String(entryName || '').toLowerCase();
  const ext = archiveExtension(entryName);

  if (ext === 'zip') {
    return extractZipInto(full, destDir);
  }
  if (ext === 'tar') {
    return extractTarInto(fs.readFileSync(full), destDir);
  }
  if (ext === 'tgz' || lower.endsWith('.tar.gz')) {
    return extractTarInto(zlib.gunzipSync(fs.readFileSync(full)), destDir);
  }
  if (ext === 'gz') {
    const out = zlib.gunzipSync(fs.readFileSync(full));
    if (looksLikeTar(out)) return extractTarInto(out, destDir);
    const outName = path.basename(entryName).replace(/\.gz$/i, '') || `${path.basename(entryName)}.out`;
    const target = path.resolve(destDir, outName);
    if (!withinServerDirBase(target, destDir)) throw Object.assign(new Error('Invalid archive entry'), { statusCode: 400 });
    fs.writeFileSync(target, out);
    return 1;
  }

  const err = new Error(`Unsupported archive format ".${ext || 'unknown'}". Only zip, tar, tgz and gz archives can be extracted.`);
  err.statusCode = 400;
  throw err;
}

// Mount the file-manager routes on an express router.
function registerFileRoutes(router) {
  router.get('/:uuid/files', (req, res) => {
    const { uuid } = req.params;
    const rel = String(req.query.path || '/');
    try {
      const dir = resolveServerPath(uuid, rel);
      if (!fs.existsSync(dir)) return res.json({ files: [], path: rel, exists: false });
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

      const files = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const full = path.join(dir, entry.name);
        let size = 0;
        let modified = null;
        try {
          const s = fs.statSync(full);
          size = s.isDirectory() ? 0 : s.size;
          modified = s.mtime;
        } catch (_) { /* ignore */ }
        return { name: entry.name, isDirectory: entry.isDirectory(), size, modified };
      });

      files.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1)));
      res.json({ files, path: rel, exists: true });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.get('/:uuid/files/read', (req, res) => {
    const { uuid } = req.params;
    const rel = String(req.query.path || '');
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
      if (fs.statSync(full).isDirectory()) return res.status(400).json({ error: 'Cannot read a directory' });
      res.sendFile(full);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/write', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, content, encoding } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        return res.status(400).json({ error: 'Cannot write to a directory' });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content == null ? '' : String(content), encoding || 'utf8');
      res.json({ status: 'written', path: rel });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/mkdir', (req, res) => {
    const { uuid } = req.params;
    const { path: rel } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      fs.mkdirSync(full, { recursive: true });
      res.json({ status: 'created', path: rel });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/delete', (req, res) => {
    const { uuid } = req.params;
    const { path: rel } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
      res.json({ status: 'deleted', path: rel });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/upload', (req, res) => {
    const { uuid } = req.params;
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: 'path required' });

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 2 * 1024 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const full = resolveServerPath(uuid, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, Buffer.concat(chunks));
        res.json({ status: 'uploaded', path: rel, size });
      } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
      }
    });
    req.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });

  router.post('/:uuid/files/rename', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, newName } = req.body || {};
    if (!rel || !newName) return res.status(400).json({ error: 'path and newName required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      const name = safeBaseName(newName);
      if (!name) return res.status(400).json({ error: 'Invalid name' });
      const target = path.join(path.dirname(full), name);
      if (!withinServerDir(uuid, target)) return res.status(400).json({ error: 'Invalid name' });
      if (fs.existsSync(target) && target !== full) return res.status(409).json({ error: 'Already exists' });
      fs.renameSync(full, target);
      res.json({ status: 'renamed', path: rel, name });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/move', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, toDir } = req.body || {};
    if (!rel || toDir == null) return res.status(400).json({ error: 'path and toDir required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      const destDir = resolveServerPath(uuid, toDir);
      if (!withinServerDir(uuid, destDir)) return res.status(400).json({ error: 'Invalid destination' });
      if (!fs.existsSync(destDir)) return res.status(404).json({ error: 'Destination not found' });
      if (!fs.statSync(destDir).isDirectory()) return res.status(400).json({ error: 'Destination is not a directory' });
      const target = path.join(destDir, path.basename(full));
      if (target === full) return res.json({ status: 'moved', path: rel });
      if (path.resolve(full).startsWith(path.resolve(target) + path.sep)) {
        return res.status(400).json({ error: 'Cannot move a folder into itself' });
      }
      if (fs.existsSync(target)) return res.status(409).json({ error: 'Already exists in destination' });
      fs.renameSync(full, target);
      res.json({ status: 'moved', path: rel, toDir });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/copy', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, newName } = req.body || {};
    if (!rel || !newName) return res.status(400).json({ error: 'path and newName required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      const name = safeBaseName(newName);
      if (!name) return res.status(400).json({ error: 'Invalid name' });
      const target = path.join(path.dirname(full), name);
      if (!withinServerDir(uuid, target)) return res.status(400).json({ error: 'Invalid name' });
      if (fs.existsSync(target)) return res.status(409).json({ error: 'Already exists' });
      fs.cpSync(full, target, { recursive: true });
      res.json({ status: 'copied', path: rel, name });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/chmod', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, mode } = req.body || {};
    if (!rel || !mode) return res.status(400).json({ error: 'path and mode required' });
    const parsed = parseInt(String(mode), 8);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0o777) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      fs.chmodSync(full, parsed);
      if (fs.statSync(full).isDirectory()) {
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            try { fs.chmodSync(p, parsed); } catch (_) { /* ignore */ }
            if (entry.isDirectory()) walk(p);
          }
        };
        try { walk(full); } catch (_) { /* ignore */ }
      }
      res.json({ status: 'chmod', path: rel, mode: parsed.toString(8) });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/compress', (req, res) => {
    const { uuid } = req.params;
    const { path: rel, name } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      const baseName = safeBaseName(name || path.basename(full));
      if (!baseName) return res.status(400).json({ error: 'Invalid name' });
      const zipName = baseName.replace(/\.zip$/i, '') + '.zip';
      const target = path.join(path.dirname(full), zipName);
      if (!withinServerDir(uuid, target)) return res.status(400).json({ error: 'Invalid name' });
      if (fs.existsSync(target)) return res.status(409).json({ error: 'Archive already exists' });

      const output = fs.createWriteStream(target);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', () => res.json({ status: 'compressed', path: rel, name: zipName }));
      archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      archive.pipe(output);
      if (fs.statSync(full).isDirectory()) {
        archive.directory(full, path.basename(full));
      } else {
        archive.file(full, { name: path.basename(full) });
      }
      archive.finalize();
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.post('/:uuid/files/extract', (req, res) => {
    const { uuid } = req.params;
    const { path: rel } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      if (fs.statSync(full).isDirectory()) return res.status(400).json({ error: 'Not a file' });
      if (!COMPRESSED_EXTENSIONS.has(archiveExtension(full))) {
        return res.status(400).json({ error: 'Not a compressed archive' });
      }
      const files = extractArchive(full, rel);
      res.json({ status: 'extracted', path: rel, files });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.get('/:uuid/files/download', (req, res) => {
    const { uuid } = req.params;
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: 'path required' });
    try {
      const full = resolveServerPath(uuid, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
      const baseName = path.basename(full);
      if (fs.statSync(full).isDirectory()) {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.zip"`);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', () => { try { res.end(); } catch (_) { /* ignore */ } });
        archive.pipe(res);
        archive.directory(full, baseName);
        archive.finalize();
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}"`);
        res.sendFile(full);
      }
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });
}

module.exports = { registerFileRoutes, resolveServerPath, extractZipInto, extractTarInto, extractArchive, archiveExtension, COMPRESSED_EXTENSIONS };
