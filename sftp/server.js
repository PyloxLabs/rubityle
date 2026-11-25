'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server: SshServer } = require('ssh2');

const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
};

const OPEN = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
};

const MAX_READ = 32768;
const READDIR_BATCH = 100;

// Raised when a path escapes the server's root.
class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ENOENT';
  }
}

function hashPassword(salt, password) {
  return crypto.createHash('sha256').update(salt + password).digest();
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a == null ? '' : a), 'hex');
  const right = Buffer.from(String(b == null ? '' : b), 'hex');
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

// Resolve a client-supplied SFTP path against the server root, refusing to
// escape the root (no `..` traversal).
function resolvePath(root, input) {
  const raw = String(input == null || input === '' ? '.' : input).replace(/\\/g, '/');
  const normalized = path.posix.normalize('/' + raw); // absolute + normalized
  const rel = normalized === '/' ? '' : normalized.slice(1);
  const full = path.join(root, rel);
  const check = full === root ? root : root + path.sep;
  if (full !== root && !full.startsWith(check)) {
    throw new PathEscapeError('Path escapes server root');
  }
  return full;
}

function toVirtual(root, full) {
  const rel = path.relative(root, full);
  if (!rel) return '/';
  return '/' + rel.split(path.sep).join('/');
}

function statToAttrs(st) {
  const typeBits = st.isDirectory() ? 0o040000 : st.isSymbolicLink() ? 0o120000 : 0o100000;
  return {
    size: st.size,
    uid: Number.isFinite(st.uid) ? st.uid : 0,
    gid: Number.isFinite(st.gid) ? st.gid : 0,
    mode: (st.mode & 0o7777) | typeBits,
    atime: Math.floor((st.atime && st.atime.getTime ? st.atime.getTime() : Date.now()) / 1000),
    mtime: Math.floor((st.mtime && st.mtime.getTime ? st.mtime.getTime() : Date.now()) / 1000),
  };
}

function mapError(err) {
  const code = err && err.code ? err.code : null;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS.PERMISSION_DENIED;
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'EISDIR':
      return STATUS.FAILURE;
    default:
      return STATUS.FAILURE;
  }
}

function openFlagsToMode(flags) {
  const read = !!(flags & OPEN.READ);
  const write = !!(flags & OPEN.WRITE);
  const append = !!(flags & OPEN.APPEND);
  const trunc = !!(flags & OPEN.TRUNC);
  if (read && write) return append ? 'a+' : trunc ? 'w+' : 'r+';
  if (write) return append ? 'a' : trunc ? 'w' : 'w';
  return 'r';
}

// Attach SFTP request handlers for one (already accepted) SFTP subsystem.
function attachSftpHandlers(sftp, root) {
  let nextHandle = 1;
  const handles = new Map();

  function openHandle(fd) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(nextHandle, 0);
    handles.set(nextHandle, { fd });
    nextHandle = (nextHandle + 1) >>> 0;
    return buf;
  }

  function closeHandle(buffer) {
    const id = buffer.readUInt32BE(0);
    const h = handles.get(id);
    handles.delete(id);
    return h;
  }

  function getHandle(buffer) {
    return handles.get(buffer.readUInt32BE(0));
  }

  sftp.on('OPEN', (reqid, filename, flags) => {
    let full;
    try { full = resolvePath(root, filename); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    const flagsStr = openFlagsToMode(flags);
    const exclusive = !!(flags & OPEN.EXCL);
    if (exclusive && fs.existsSync(full)) return sftp.status(reqid, STATUS.FAILURE);
    fs.open(full, flagsStr, 0o644, (err, fd) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.handle(reqid, openHandle(fd));
    });
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const h = closeHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    if (!h.fd) return sftp.status(reqid, STATUS.OK);
    fs.close(h.fd, (err) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.status(reqid, STATUS.OK);
    });
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    const buf = Buffer.alloc(Math.min(length, MAX_READ));
    fs.read(h.fd, buf, 0, buf.length, offset, (err, bytesRead, data) => {
      if (err) return sftp.status(reqid, mapError(err));
      if (bytesRead === 0) return sftp.status(reqid, STATUS.EOF);
      sftp.data(reqid, data.slice(0, bytesRead));
    });
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    fs.write(h.fd, data, 0, data.length, offset, (err) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.status(reqid, STATUS.OK);
    });
  });

  sftp.on('LSTAT', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.lstat(full, (err, st) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.attrs(reqid, statToAttrs(st));
    });
  });

  sftp.on('STAT', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.stat(full, (err, st) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.attrs(reqid, statToAttrs(st));
    });
  });

  sftp.on('FSTAT', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    fs.fstat(h.fd, (err, st) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.attrs(reqid, statToAttrs(st));
    });
  });

  sftp.on('SETSTAT', (reqid, p, attrs) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    setAttrs(full, attrs, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    fs.futimes(h.fd, attrs.atime != null ? attrs.atime : Date.now(), attrs.mtime != null ? attrs.mtime : Date.now(), (err) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.status(reqid, STATUS.OK);
    });
  });

  sftp.on('OPENDIR', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.readdir(full, { withFileTypes: true }, (err, entries) => {
      if (err) return sftp.status(reqid, mapError(err));
      const names = entries
        .filter((e) => e.name !== '.' && e.name !== '..')
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(nextHandle, 0);
      handles.set(nextHandle, { dir: true, names, idx: 0 });
      nextHandle = (nextHandle + 1) >>> 0;
      sftp.handle(reqid, buf);
    });
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    if (h.idx >= h.names.length) return sftp.status(reqid, STATUS.EOF);
    const batch = h.names.slice(h.idx, h.idx + READDIR_BATCH);
    h.idx += batch.length;
    const names = batch.map((e) => {
      // Best effort per-entry stat; fall back to a plain file entry.
      let attrs = { mode: 0o100644, uid: 0, gid: 0, size: 0 };
      try {
        const fst = fs.statSync(path.join(root, e.name));
        attrs = {
          mode: (fst.mode & 0o7777) | (fst.isDirectory() ? 0o40000 : 0o100000),
          uid: Number.isFinite(fst.uid) ? fst.uid : 0,
          gid: Number.isFinite(fst.gid) ? fst.gid : 0,
          size: fst.size,
        };
      } catch (_) { /* fall back */ }
      return { filename: e.name, longname: (e.isDir ? 'd' : '-') + 'rwxr-xr-x ' + e.name, attrs };
    });
    sftp.name(reqid, names);
  });

  sftp.on('REALPATH', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    sftp.name(reqid, [{ filename: toVirtual(root, full), longname: '', attrs: {} }]);
  });

  sftp.on('REMOVE', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.unlink(full, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('MKDIR', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.mkdir(full, { recursive: false, mode: 0o755 }, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('RMDIR', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.rmdir(full, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    let from;
    let to;
    try {
      from = resolvePath(root, oldPath);
      to = resolvePath(root, newPath);
    } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.rename(from, to, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('READLINK', (reqid, p) => {
    let full;
    try { full = resolvePath(root, p); } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.readlink(full, (err, link) => {
      if (err) return sftp.status(reqid, mapError(err));
      sftp.name(reqid, [{ filename: link, longname: link, attrs: {} }]);
    });
  });

  sftp.on('SYMLINK', (reqid, targetPath, linkPath) => {
    let target;
    let link;
    try {
      target = resolvePath(root, targetPath);
      link = resolvePath(root, linkPath);
    } catch { return sftp.status(reqid, STATUS.NO_SUCH_FILE); }
    fs.symlink(target, link, (err) => sftp.status(reqid, err ? mapError(err) : STATUS.OK));
  });

  sftp.on('EXTENDED', (reqid) => {
    sftp.status(reqid, STATUS.OP_UNSUPPORTED);
  });
}

function setAttrs(full, attrs, cb) {
  const hasMode = typeof attrs.mode === 'number' || typeof attrs.mode === 'string';
  const hasTimes = attrs.mtime != null || attrs.atime != null;
  const atime = attrs.atime != null ? attrs.atime * 1000 : Date.now();
  const mtime = attrs.mtime != null ? attrs.mtime * 1000 : Date.now();
  if (hasTimes) {
    fs.utimes(full, atime, mtime, (err) => {
      if (err) return cb(err);
      if (hasMode) fs.chmod(full, attrs.mode, cb);
      else cb();
    });
  } else if (hasMode) {
    fs.chmod(full, attrs.mode, cb);
  } else {
    cb();
  }
}

// Load stored SFTP credentials ({ uuid: { salt, hash } }).
function loadUsers(dataDir) {
  const file = path.join(dataDir, 'sftp_users.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

// Start the SFTP server. opts: { host, port, dataDir, hostKey, log }.
// hostKey may be a Buffer/string PEM or a crypto KeyObject.
function startSftpServer(opts) {
  const log = opts.log || { info: () => {}, warn: () => {}, error: () => {} };
  const hostKey = opts.hostKey;

  const server = new SshServer(
    { hostKeys: [hostKey], passwordAuthentication: true },
    (client) => {
      let authedUser = null;

      client.on('authentication', (ctx) => {
        if (ctx.method !== 'password') {
          // Must advertise the still-available methods; an empty list makes
          // clients abort with "No more authentication methods available".
          return ctx.reject(['password']);
        }
        const users = loadUsers(opts.dataDir);
        const rec = users[ctx.username] || null;
        const root = path.join(opts.dataDir, ctx.username);
        if (!rec || !safeEqualHex(rec.hash, hashPassword(rec.salt, ctx.password).toString('hex'))) {
          log.warn(`SFTP auth failed: unknown user or bad password (${ctx.username})`);
          return ctx.reject(['password']);
        }
        if (!fs.existsSync(root)) {
          log.warn(`SFTP auth failed: no data directory for ${ctx.username}`);
          return ctx.reject(['password']);
        }
        authedUser = ctx.username;
        ctx.accept();
      });

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('sftp', (sftpAccept, sftpReject) => {
            const root = path.join(opts.dataDir, authedUser);
            if (!fs.existsSync(root)) {
              if (sftpReject) sftpReject();
              return;
            }
            const sftp = sftpAccept();
            attachSftpHandlers(sftp, root);
          });
        });
      });

      client.on('error', (err) => {
        log.warn(`SFTP client error: ${err && err.message ? err.message : err}`);
      });
    }
  );

  server.on('error', (err) => {
    log.error(`SFTP server error: ${err && err.message ? err.message : err}`);
  });

  server.listen(opts.port, opts.host || '0.0.0.0', () => {
    log.info(`Pylox SFTP server listening on port ${opts.port}`);
  });

  return server;
}

module.exports = { startSftpServer, loadUsers, attachSftpHandlers };