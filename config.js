'use strict';

const fs = require('fs');
const path = require('path');

function int(value, fallback) {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let fileConfig = {};
try {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    fileConfig = JSON.parse(raw);
  }
} catch (e) {
  // ignore
}

function getVal(envKey, fileKey, fallback) {
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
    return process.env[envKey];
  }
  if (fileConfig && fileConfig[fileKey] !== undefined && fileConfig[fileKey] !== '') {
    return fileConfig[fileKey];
  }
  if (fileConfig && fileConfig[envKey] !== undefined && fileConfig[envKey] !== '') {
    return fileConfig[envKey];
  }
  return fallback;
}

const config = {
  port: int(getVal('DAEMON_PORT', 'port', getVal('PORT', 'daemon_port', 8080)), 8080),
  sftpPort: int(getVal('SFTP_PORT', 'sftp_port', 2022), 2022),
  token: getVal('DAEMON_TOKEN', 'token', getVal('daemon_token', 'token', 'change-me-daemon-token')),
  dockerSocket: getVal('DOCKER_SOCKET', 'docker_socket', '/var/run/docker.sock'),
  useDockerEnv: !!process.env.DOCKER_HOST || !!fileConfig.docker_host,
  network: getVal('DOCKER_NETWORK', 'network', getVal('docker_network', 'network', 'pylox-servers')),
  dataDir: getVal('DATA_DIR', 'data_dir', getVal('dataDir', 'data_dir', '/var/lib/rubityle')),
  logDir: getVal('LOG_DIR', 'log_dir', getVal('logDir', 'log_dir', '/var/log/rubityle')),
  defaultImage: getVal('DEFAULT_IMAGE', 'default_image', getVal('defaultImage', 'default_image', 'ghcr.io/pterodactyl/yolks:java_17')),
  containerPrefix: getVal('CONTAINER_PREFIX', 'container_prefix', getVal('containerPrefix', 'container_prefix', 'pylox-')),
  containerDir: '/home/container',
  // UID/GID used by the yolks images. Install containers run as root, so files
  // they create must be handed back to this user before the server starts.
  serverUid: int(getVal('SERVER_UID', 'server_uid', 1001), 1001),
  serverGid: int(getVal('SERVER_GID', 'server_gid', 1001), 1001),
  installDir: '/mnt/server',
  // How long a server may sit at/above a resource limit before it is killed.
  resourceLimitGraceMs: int(getVal('RESOURCE_LIMIT_GRACE_SECONDS', 'resource_limit_grace_seconds', 600), 600) * 1000,
  // How often running servers are checked against their limits.
  resourceMonitorIntervalMs: int(getVal('RESOURCE_MONITOR_INTERVAL_SECONDS', 'resource_monitor_interval_seconds', 15), 15) * 1000,
  // How long a server may report "starting" before it is flipped to "running"
  // even when the egg never prints its startup-done line.
  startupTimeoutMs: int(getVal('STARTUP_TIMEOUT_SECONDS', 'startup_timeout_seconds', 180), 180) * 1000,
  // Minimum gap between crashes before the daemon will auto-restart a server.
  crashRestartCooldownMs: int(getVal('CRASH_RESTART_COOLDOWN_SECONDS', 'crash_restart_cooldown_seconds', 60), 60) * 1000,
  // How long an egg stop command gets to shut the server down before the
  // daemon falls back to a Docker stop.
  stopGraceMs: int(getVal('STOP_GRACE_SECONDS', 'stop_grace_seconds', 10), 10) * 1000,
  // Docker stop timeout (SIGTERM grace) before the container is killed.
  stopTimeoutSeconds: int(getVal('STOP_TIMEOUT_SECONDS', 'stop_timeout_seconds', 20), 20),
};

config.containerName = (uuid) => `${config.containerPrefix}${uuid}`;
config.serverDir = (uuid) => path.join(config.dataDir, uuid);

for (const dir of [config.dataDir, config.logDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = config;
