'use strict';

const path = require('path');
const fs = require('fs');
const config = require('./config');

let logFile = null;
try {
  logFile = fs.createWriteStream(path.join(config.logDir, 'daemon.log'), { flags: 'a' });
} catch (err) {
  console.error(`[daemon] unable to open log file: ${err.message}`);
}

function writeLog(level, message) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (logFile) {
    try { logFile.write(line + '\n'); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  info: (m) => writeLog('info', m),
  warn: (m) => writeLog('warn', m),
  error: (m) => writeLog('error', m),
};
