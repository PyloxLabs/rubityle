'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

function wrongOwner(p) {
  try {
    return fs.lstatSync(p).uid !== config.serverUid || fs.lstatSync(p).gid !== config.serverGid;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

// Cheap top-level check so normal starts do not walk node_modules/.npm on every
// boot. Install containers run as root, so a single wrong top-level entry means
// the whole tree needs to be handed back to the container user.
function needsOwnershipFix(uuid) {
  const dir = config.serverDir(uuid);
  if (!fs.existsSync(dir)) return false;
  if (wrongOwner(dir)) return true;
  try {
    return fs.readdirSync(dir).some((name) => wrongOwner(path.join(dir, name)));
  } catch (_) {
    return false;
  }
}

function chownTree(p) {
  let stat;
  try { stat = fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  // lchown does not follow symlinks out of the server directory.
  fs.lchownSync(p, config.serverUid, config.serverGid);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of fs.readdirSync(p)) chownTree(path.join(p, name));
}

function fixServerOwnership(uuid, force = false) {
  if (!force && !needsOwnershipFix(uuid)) return false;
  const dir = config.serverDir(uuid);
  if (!fs.existsSync(dir)) return false;
  try {
    chownTree(dir);
    logger.info(`Normalized ownership for ${uuid} to ${config.serverUid}:${config.serverGid}`);
    return true;
  } catch (err) {
    logger.warn(`Could not fix ownership for ${uuid}: ${err.message}`);
    return false;
  }
}

module.exports = { fixServerOwnership, needsOwnershipFix };
