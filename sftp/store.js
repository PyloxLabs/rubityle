'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// SFTP credential store. Users connect as <server uuid> and authenticate with
// the per-server password the panel generates. Only salted hashes are persisted.
function loadSftpUsers() {
  const file = path.join(config.dataDir, 'sftp_users.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function saveSftpUsers(users) {
  fs.writeFileSync(path.join(config.dataDir, 'sftp_users.json'), JSON.stringify(users, null, 2));
}

function storeSftpPassword(uuid, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  const users = loadSftpUsers();
  users[uuid] = { salt, hash };
  saveSftpUsers(users);
}

function removeSftpUser(uuid) {
  const users = loadSftpUsers();
  if (!users[uuid]) return;
  delete users[uuid];
  saveSftpUsers(users);
}

function loadSftpHostKey() {
  const file = path.join(config.dataDir, 'sftp_host_key.pem');
  if (fs.existsSync(file)) {
    return { pem: fs.readFileSync(file), file };
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs1' });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return { pem, file };
}

module.exports = { loadSftpUsers, storeSftpPassword, removeSftpUser, loadSftpHostKey };
