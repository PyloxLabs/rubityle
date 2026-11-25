'use strict';

// Keep config's data/log directories off the real daemon paths.
const os = require('os');
const path = require('path');
const tmp = path.join(os.tmpdir(), 'pylox-crash-tests');
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;

const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../config');
const state = require('./state');
const docker = require('./docker');
const power = require('./power');
const crash = require('./crash');

const cooldown = config.crashRestartCooldownMs;

test('shouldRestart respects the cooldown window', () => {
  const now = 100000;
  assert.equal(crash.shouldRestart(null, now), true);
  assert.equal(crash.shouldRestart(now - cooldown + 1000, now), false);
  assert.equal(crash.shouldRestart(now - cooldown, now), true);
});

test('crashMessages includes restart details or the abort reason', () => {
  const info = { exitCode: 1, outOfMemory: false };
  assert.deepEqual(crash.crashMessages(info, true), [
    '---------- Detected server process in a crashed state! ----------',
    'Exit code: 1',
    'Out of memory: false',
    'Updating process configuration files...',
    'Ensuring file permissions are set correctly, this could take a few seconds...',
  ]);
  assert.deepEqual(crash.crashMessages(info, false), [
    '---------- Detected server process in a crashed state! ----------',
    'Exit code: 1',
    'Out of memory: false',
    `Aborting automatic restart, last crash occurred less than ${Math.round(cooldown / 1000)} seconds ago.`,
  ]);
});

test('transient console lines are not kept for replay', () => {
  const uuid = 'crash-test-transient';
  const before = state.getSystemHistory(uuid).length;
  state.pushSystemConsole(uuid, 'transient line', false);
  assert.equal(state.getSystemHistory(uuid).length, before);
  state.pushSystemConsole(uuid, 'persistent line');
  assert.equal(state.getSystemHistory(uuid).length, before + 1);
});

test('a second crash inside the cooldown does not restart the server', async () => {
  const uuid = 'crash-test-cooldown';
  state.clearCrash(uuid);
  state.clearIntentionalStop(uuid);

  const lines = [];
  const persisted = [];
  const originalPush = state.pushSystemConsole;
  const originalStart = power.start;
  const originalGetContainer = docker.getContainer;
  let starts = 0;

  state.pushSystemConsole = (id, text, persist) => {
    lines.push(text);
    persisted.push(persist);
  };
  power.start = async () => { starts += 1; return { status: 'starting' }; };
  docker.getContainer = () => ({ inspect: async () => ({ State: { ExitCode: 1, OOMKilled: false } }) });

  const event = { Actor: { Attributes: { exitCode: '1', oomKilled: 'false' } } };
  try {
    await crash.handleContainerExit({ uuid, event });
    assert.equal(starts, 1);
    assert.equal(lines.length, 5);
    assert.ok(persisted.every((p) => p === false), 'crash lines must not be replayed later');
    assert.match(lines[1], /Exit code: 1/);
    assert.match(lines[2], /Out of memory: false/);

    await crash.handleContainerExit({ uuid, event });
    assert.equal(starts, 1);
    assert.equal(lines.length, 9);
    assert.match(lines[8], /Aborting automatic restart/);
  } finally {
    state.pushSystemConsole = originalPush;
    power.start = originalStart;
    docker.getContainer = originalGetContainer;
    state.clearCrash(uuid);
  }
});

test('daemon-requested stops are not treated as crashes', async () => {
  const uuid = 'crash-test-intentional';
  state.clearCrash(uuid);
  state.clearIntentionalStop(uuid);

  const lines = [];
  const originalPush = state.pushSystemConsole;
  const originalStart = power.start;
  let starts = 0;

  state.pushSystemConsole = (id, text) => lines.push(text);
  power.start = async () => { starts += 1; return { status: 'starting' }; };
  state.markIntentionalStop(uuid);

  try {
    await crash.handleContainerExit({ uuid, event: { Actor: { Attributes: { exitCode: '0' } } } });
    assert.equal(starts, 0);
    assert.equal(lines.length, 0);
  } finally {
    state.pushSystemConsole = originalPush;
    power.start = originalStart;
    state.clearIntentionalStop(uuid);
  }
});

test('OOM flag comes through as true when Docker reports it', async () => {
  const uuid = 'crash-test-oom';
  state.clearCrash(uuid);
  state.clearIntentionalStop(uuid);

  const lines = [];
  const originalPush = state.pushSystemConsole;
  const originalStart = power.start;
  const originalGetContainer = docker.getContainer;

  state.pushSystemConsole = (id, text) => lines.push(text);
  power.start = async () => ({ status: 'starting' });
  docker.getContainer = () => ({ inspect: async () => ({ State: { ExitCode: 137, OOMKilled: true } }) });

  try {
    await crash.handleContainerExit({ uuid, event: { Actor: { Attributes: { exitCode: '137', oomKilled: 'true' } } } });
    assert.match(lines[1], /Exit code: 137/);
    assert.match(lines[2], /Out of memory: true/);
  } finally {
    state.pushSystemConsole = originalPush;
    power.start = originalStart;
    docker.getContainer = originalGetContainer;
    state.clearCrash(uuid);
  }
});

test('signal-style stop commands are mapped to a Docker signal', () => {
  assert.equal(power.signalFromStopCommand('^C'), 'SIGINT');
  assert.equal(power.signalFromStopCommand('SIGINT'), 'SIGINT');
  assert.equal(power.signalFromStopCommand('stop'), null);
});
