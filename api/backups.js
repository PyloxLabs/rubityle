'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const config = require('../config');
const logger = require('../logger');
const { resolveServerPath, extractZipInto } = require('./files');

// Normalize a single ignore entry from the panel (strip leading/trailing
// slashes and redundant "./" prefixes) so matching is predictable.
function normalizeIgnore(entry) {
  return String(entry == null ? '' : entry)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

// Convert a glob pattern into a RegExp. Supports *, ** and ?.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') i += 1;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function isIgnored(relPath, matchers) {
  const rel = String(relPath).replace(/\\/g, '/');
  const base = rel.split('/').pop();
  return matchers.some((m) => {
    if (m.raw === rel) return true;
    if (rel.startsWith(m.raw + '/')) return true;
    if (m.re.test(rel)) return true;
    if (m.re.test(base)) return true;
    return false;
  });
}

function addDirectoryToArchive(archive, dir, relBase, matchers) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (isIgnored(rel, matchers)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      addDirectoryToArchive(archive, full, rel, matchers);
    } else if (entry.isFile()) {
      archive.file(full, { name: rel });
    }
  }
}

// Mount backup/restore routes on an express router.
function registerBackupRoutes(router) {
  router.get('/:uuid/backup', (req, res) => {
    const { uuid } = req.params;
    const dir = config.serverDir(uuid);

    let matchers = [];
    try {
      matchers = String(req.query.ignored || '')
        .split(/[\n,]+/)
        .slice(0, 500)
        .map(normalizeIgnore)
        .filter(Boolean)
        .filter((raw) => raw.length <= 512)
        .map((raw) => ({ raw, re: globToRegExp(raw) }));
    } catch (err) {
      logger.warn(`Backup ignore patterns ignored for ${uuid}: ${err.message}`);
      matchers = [];
    }

    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Server directory not found' });
    try {
      if (!fs.statSync(dir).isDirectory()) {
        return res.status(400).json({ error: 'Server path is not a directory' });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${uuid}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      logger.error(`Backup failed for ${uuid}: ${err.message}`);
      if (!res.headersSent) {
        try {
          res.removeHeader('Content-Type');
          res.removeHeader('Content-Disposition');
          res.status(500).json({ error: `Backup failed: ${err.message}` });
          return;
        } catch (_) { /* fall through to destroy */ }
      }
      try { res.destroy(err); } catch (_) { /* ignore */ }
    };
    archive.on('error', fail);
    archive.pipe(res);
    try {
      addDirectoryToArchive(archive, dir, '', matchers);
      Promise.resolve(archive.finalize()).catch(fail);
    } catch (err) {
      fail(err);
    }
  });

  router.post('/:uuid/restore', (req, res) => {
    const { uuid } = req.params;
    const dir = config.serverDir(uuid);
    const stamp = Date.now();
    const tmp = path.join(config.dataDir, `.restore-${uuid}-${stamp}.zip`);
    const staging = path.join(config.dataDir, `.restore-${uuid}-${stamp}`);

    let failed = false;
    const cleanup = () => {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    };
    const fail = (err) => {
      if (failed) return;
      failed = true;
      logger.error(`Restore failed for ${uuid}: ${err.message}`);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: `Restore failed: ${err.message}` });
      else { try { res.end(); } catch (_) { /* ignore */ } }
    };

    const out = fs.createWriteStream(tmp);
    out.on('error', fail);
    req.on('error', fail);

    out.on('finish', async () => {
      if (failed) return;
      try {
        // Extract into a staging directory first so a corrupt archive never
        // destroys the server's current data.
        fs.mkdirSync(staging, { recursive: true });
        const restored = await extractZipInto(tmp, staging);

        // Swap: wipe the live directory, then move the staged files into place.
        if (fs.existsSync(dir)) {
          for (const name of fs.readdirSync(dir)) {
            try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
          }
        } else {
          fs.mkdirSync(dir, { recursive: true });
        }
        for (const name of fs.readdirSync(staging)) {
          fs.renameSync(path.join(staging, name), path.join(dir, name));
        }

        cleanup();
        logger.info(`Restored ${restored} file(s) for ${uuid}`);
        res.json({ status: 'restored', files: restored });
      } catch (err) {
        fail(err);
      }
    });

    req.pipe(out);
  });
}

module.exports = { registerBackupRoutes };
