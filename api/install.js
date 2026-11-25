'use strict';

const fs = require('fs');
const config = require('../config');
const logger = require('../logger');
const state = require('../core/state');
const { fixServerOwnership } = require('../core/ownership');
const { docker, ensureImage, ensureNetwork } = require('../core/docker');
const { normalizeEnv, envToMap, substituteInstallScript, demux, ANSI_PURPLE, ANSI_RESET } = require('../utils');

// Run an egg install script inside a throwaway container. Streams the output
// to the server's console and resolves with { exitCode } or rejects with an
// Error carrying statusCode 500 and the tail of the log.
async function runInstall(uuid, install, env) {
  if (!install || !install.script) {
    const err = new Error('install.script is required');
    err.statusCode = 400;
    throw err;
  }

  const image = install.container || 'ghcr.io/parkervcp/installers:alpine';
  const entrypoint = install.entrypoint || '/bin/ash';
  const installName = `${config.containerPrefix}install-${uuid}`;
  const dir = config.serverDir(uuid);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    const leftover = docker.getContainer(installName);
    const info = await leftover.inspect();
    if (info.State.Running) { try { await leftover.stop({ t: 5 }); } catch (_) { /* ignore */ } }
    await leftover.remove({ force: true });
  } catch (_) { /* no leftover */ }

  try {
    await ensureImage(image);
    await ensureNetwork();

    const envList = normalizeEnv(env);
    const envMap = envToMap(envList);
    const script = substituteInstallScript(install.script, envMap);
    if (!script.trim()) {
      const err = new Error('Install script is empty after variable substitution');
      err.statusCode = 400;
      throw err;
    }

    const container = await docker.createContainer({
      Image: image,
      name: installName,
      WorkingDir: config.installDir,
      Env: envList,
      Entrypoint: [entrypoint, '-c'],
      Cmd: [script],
      Tty: true,
      OpenStdin: false,
      Labels: { 'pylox.install': 'true', 'pylox.server.uuid': uuid },
      HostConfig: {
        Binds: [`${dir}:${config.installDir}`],
        NetworkMode: config.network,
        Tmpfs: { '/tmp': 'rw,exec,nosuid,size=100M' },
      },
    });

    await container.start();
    logger.info(`Installation started for ${uuid} using ${image}`);
    state.broadcastConsole(uuid, `${ANSI_PURPLE}[Pylox]${ANSI_RESET} Running installation script on ${image}...\n`);

    let tail = '';
    try {
      // dockerode returns a Promise when no callback is passed, so await the
      // stream before attaching handlers (otherwise install output is lost).
      const follow = await container.logs({ follow: true, stdout: true, stderr: true, tail: 4000 });
      follow.on('data', (chunk) => {
        const text = demux(chunk);
        tail = (tail + text).slice(-8000);
        state.broadcastConsole(uuid, text);
      });
      follow.on('error', () => { /* ignore */ });
    } catch (_) { /* ignore */ }

    const result = await container.wait();
    const exitCode = result.StatusCode;

    // The live follow stream can race the container exit and miss the final
    // lines, so always prefer the full log history for the error excerpt.
    let excerpt = tail;
    try {
      const histBuf = await container.logs({ stdout: true, stderr: true, tail: 8000, follow: false });
      const histText = demux(histBuf);
      if (histText.trim()) {
        excerpt = histText;
        if (!tail.trim()) state.broadcastConsole(uuid, excerpt);
      }
    } catch (_) { /* keep live tail */ }

    try { await container.remove({ force: true }); } catch (_) { /* ignore */ }

    // The install image runs as root, so everything it writes must be handed
    // back to the container user or runtime npm installs fail with EACCES.
    fixServerOwnership(uuid, true);

    if (exitCode !== 0) {
      logger.error(`Installation failed for ${uuid} (exit ${exitCode})`);
      state.broadcastConsole(uuid, `${ANSI_PURPLE}[Pylox]${ANSI_RESET} Installation failed (exit ${exitCode}).\n`);
      const lines = excerpt.trim().split('\n').slice(-8).join('\n');
      const err = new Error(`Installation failed with exit code ${exitCode}${lines ? `:\n${lines}` : ''}`);
      err.statusCode = 500;
      throw err;
    }

    logger.info(`Installation completed for ${uuid}`);
    state.broadcastConsole(uuid, `${ANSI_PURPLE}[Pylox]${ANSI_RESET} Installation completed successfully.\n`);
    return { status: 'installed', exitCode };
  } catch (err) {
    logger.error(`Installation error for ${uuid}: ${err.message}`);
    try { await docker.getContainer(installName).remove({ force: true }); } catch (_) { /* ignore */ }
    fixServerOwnership(uuid, true);
    throw err;
  }
}

module.exports = { runInstall };
