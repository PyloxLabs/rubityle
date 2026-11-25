'use strict';

// Keep config's data/log directories off the real daemon paths.
const os = require('os');
const path = require('path');
const tmp = path.join(os.tmpdir(), 'pylox-docker-tests');
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;

const assert = require('node:assert/strict');
const test = require('node:test');

let inspectResult;
let removeCalled = false;
let finishRemove;
let createCalls = [];

class FakeDocker {
  getContainer() {
    return {
      inspect: async () => inspectResult,
      remove: async () => {
        removeCalled = true;
        await new Promise((resolve) => { finishRemove = resolve; });
      },
      update: async () => {},
    };
  }

  getNetwork() {
    return { inspect: (cb) => cb(null) };
  }

  createNetwork(_opts, cb) {
    cb(null);
  }

  getImage() {
    return { inspect: (cb) => cb(null) };
  }

  pull(_image, cb) {
    cb(null, {});
  }

  modem = { followProgress: (_stream, cb) => cb(null) };

  createContainer(opts) {
    createCalls.push(opts);
    return { id: 'new-container-id', inspect: async () => ({ State: { Running: false } }) };
  }
}

// Inject the fake before docker.js constructs its Dockerode client.
const dockerodePath = require.resolve('dockerode');
require.cache[dockerodePath] = {
  id: dockerodePath,
  filename: dockerodePath,
  loaded: true,
  exports: FakeDocker,
};

const docker = require('./docker');
const { configHash } = require('../utils');

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for container removal');
}

test('a changed config recreates the container only after the old one is removed', async () => {
  const uuid = 'recreate-test';
  const cfg = {
    uuid,
    name: 'Recreate test',
    image: 'alpine:latest',
    env: [],
    memory: 128,
    ports: [{ ip: '203.0.113.10', container: 25565, host: 25565 }],
    startup: '',
  };

  inspectResult = {
    Id: 'old-container-id',
    Config: { Labels: { 'pylox.config.hash': 'old-hash' } },
    State: { Running: false },
  };
  removeCalled = false;
  createCalls = [];

  const pending = docker.ensureContainer(cfg);
  await waitFor(() => removeCalled);

  assert.equal(createCalls.length, 0, 'create must wait for the old container to be removed');

  finishRemove();
  await pending;

  assert.equal(createCalls.length, 1);
  const created = createCalls[0];
  assert.equal(created.Labels['pylox.config.hash'], configHash(cfg));
  assert.equal(created.HostConfig.PortBindings['25565/tcp'][0].HostIp, '203.0.113.10');
});
