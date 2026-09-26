import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const projectRoot = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, projectRoot), 'utf8');
const expectedSpec = 'openclaw@2026.9.6';
const boundaryCases = [
  ['v22.22.3', false], ['v23.11.0', false],
  ['v24.0.0', false], ['v24.15.99', false],
  ['v24.16.0', true], ['24.16.1', true], ['v24.18.0', true],
  ['v25.0.0', false], ['v25.9.0', false],
  ['v26.0.99', false], ['v26.1.0', true], ['v26.2.0', true],
  ['v27.0.0', true], ['v28.0.0', true],
  ['', false], ['invalid', false], ['v24.16', false],
  ['v24.16.0-rc.1', false], ['v26.1.0-rc.1', false],
];

for (const tree of ['src', 'dist']) {
  test(`${tree}: pinned package and generated Docker runtime`, () => {
    const context = vm.createContext({ Buffer });
    vm.runInContext(source(`${tree}/setup/shared/common-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/docker-gen.js`), context);
    const common = context.__openclawCommon;
    assert.equal(common.OPENCLAW_NPM_SPEC, expectedSpec);
    assert.equal(common.NINE_ROUTER_NPM_SPEC, '9router@latest');
    assert.equal(common.build9RouterProviderConfig().auth, 'api-key');
    assert.equal(common.build9RouterProviderConfig().authHeader, true);
    for (const osChoice of ['win', 'macos', 'linux']) {
      for (const provider of ['9router', 'local', 'direct']) {
        for (const isMultiBot of [false, true]) {
          const artifacts = context.__openclawDockerGen.buildDockerArtifacts({
            openClawNpmSpec: common.OPENCLAW_NPM_SPEC,
            openClawRuntimePackages: common.OPENCLAW_RUNTIME_PACKAGES,
            osChoice, isMultiBot,
            is9Router: provider === '9router', isLocal: provider === 'local',
            selectedModel: 'test-model', agentId: 'test-bot',
          });
          assert.match(artifacts.dockerfile, /^FROM node:24-slim\r?\n/);
          assert.ok(artifacts.dockerfile.includes(`ARG OPENCLAW_VER="${expectedSpec}"`));
          if (provider === '9router') assert.match(artifacts.compose, /image: node:22-slim/);
          if (osChoice === 'win') {
            assert.match(artifacts.compose, /- openclaw-home:\/home\/node\/project\/\.openclaw/);
            assert.match(artifacts.compose, /\n  openclaw-home:/);
            assert.doesNotMatch(artifacts.compose, /- \.\.\/\.\.\/\.openclaw:\/home\/node\/project\/\.openclaw/);
            assert.doesNotMatch(artifacts.compose, /- openclaw-(?:state|extensions|plugins):/);
          } else {
            assert.match(artifacts.compose, /- \.\.\/\.\.\/\.openclaw:\/home\/node\/project\/\.openclaw/);
          }
        }
      }
    }
  });

  test(`${tree}: Docker startup reclaims only a stale lease from a previous container`, () => {
    const context = vm.createContext({ Buffer });
    vm.runInContext(source(`${tree}/setup/shared/common-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/docker-gen.js`), context);
    const script = context.__openclawDockerGen.buildDockerGatewayLeaseCleanupScript();
    const run = ({ host, mode = 'foreground', supervisor = null }) => {
      const deletes = [], logs = [];
      class DatabaseSync {
        prepare(sql) {
          if (sql.startsWith('SELECT')) return { get: () => ({ owner: 'lease-owner', payloadJson: JSON.stringify({ owner: { host }, mode, supervisor }) }) };
          return { run: owner => { deletes.push(owner); return { changes: 1 }; } };
        }
        close() {}
      }
      vm.runInNewContext(script, {
        process: { env: { OPENCLAW_STATE_DIR: '/state' }, cwd: () => '/project' },
        console: { log: line => logs.push(line) },
        require: id => ({
          'node:fs': { existsSync: () => true },
          'node:os': { hostname: () => 'current-container' },
          'node:path': path.posix,
          'node:sqlite': { DatabaseSync },
        })[id],
      });
      return { deletes, logs };
    };
    assert.deepEqual(run({ host: 'previous-container' }).deletes, ['lease-owner']);
    assert.deepEqual(run({ host: 'current-container' }).deletes, []);
    assert.deepEqual(run({ host: 'previous-container', mode: 'supervised', supervisor: { kind: 'external' } }).deletes, []);
    const artifacts = context.__openclawDockerGen.buildDockerArtifacts({ openClawNpmSpec: expectedSpec, osChoice: 'win' });
    assert.ok(artifacts.entrypointScript.indexOf('removed stale Gateway lease') < artifacts.entrypointScript.indexOf('openclaw gateway run'));
  });

  test(`${tree}: old Windows projects retain their bind mount during infra updates`, () => {
    const context = vm.createContext({ Buffer });
    vm.runInContext(source(`${tree}/setup/shared/common-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/docker-gen.js`), context);
    const artifacts = context.__openclawDockerGen.buildDockerArtifacts({
      openClawNpmSpec: expectedSpec, osChoice: 'win', windowsHomeStorage: 'bind', is9Router: true,
    });
    assert.match(artifacts.compose, /- \.\.\/\.\.\/\.openclaw:\/home\/node\/project\/\.openclaw/);
    assert.match(artifacts.compose, /- openclaw-state:\/home\/node\/project\/\.openclaw\/state/);
    assert.match(artifacts.compose, /- openclaw-extensions:\/home\/node\/project\/\.openclaw\/extensions/);
    assert.doesNotMatch(artifacts.compose, /openclaw-home:/);
  });

  test(`${tree}: disk grants support named-volume and legacy bind Compose layouts`, async () => {
    const server = source(`${tree}/server/local-server.js`);
    const helperStart = server.indexOf('function injectMountsIntoCompose(');
    const helperEnd = server.indexOf('// Sync a managed "granted mounts" block', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const helpers = server.slice(helperStart, helperEnd);
    const layouts = [
      '      - openclaw-home:/home/node/project/.openclaw',
      '      - ../../.openclaw:/home/node/project/.openclaw',
    ];

    for (const homeMount of layouts) {
      const original = `services:\n  ai-bot:\n    volumes:\n${homeMount}\n      - ../../:/mnt/project\n`;
      let written = '';
      const context = vm.createContext({
        join: path.win32.join,
        existsSync: () => true,
        fsp: {
          readFile: async () => original,
          writeFile: async (_file, value) => { written = value; },
        },
        httpError: (status, message) => Object.assign(new Error(message), { status }),
        sendLog: () => {},
        updateGrantedMountsInAgents: async () => {},
        recreateDockerBot: async () => true,
      });
      vm.runInContext(helpers, context);
      const result = await context.addBotMount('D:\\bot', 'E:\\Team Data\\', 'shared');

      assert.equal(result.target, '/mnt/shared');
      assert.equal(result.applied, true);
      assert.match(written, /- type: bind\n\s+source: 'E:\/Team Data'\n\s+target: \/mnt\/shared/);
      assert.ok(written.indexOf(homeMount) < written.indexOf('target: /mnt/shared'));
      assert.ok(written.indexOf('target: /mnt/shared') < written.indexOf('- ../../:/mnt/project'));
    }
  });

  test(`${tree}: Windows volume setup refuses to overwrite an existing home`, async () => {
    const server = source(`${tree}/server/local-server.js`);
    const helper = server.match(/async function prepareWindowsDockerHome\(projectDir\) \{[\s\S]*?\n\}/);
    assert.ok(helper);
    const calls = [];
    const context = vm.createContext({
      join: path.win32.join, basename: path.win32.basename,
      slugify: (name) => name.toLowerCase(),
      fsp: { lstat: async () => ({ isDirectory: () => true }), mkdir: async () => calls.push('mkdir') },
      run: async () => calls.push('docker'), process: { pid: 42 },
    });
    vm.runInContext(helper[0], context);
    await assert.rejects(() => context.prepareWindowsDockerHome('D:\\bot'), /will not overwrite/);
    assert.deepEqual(calls, []);
    assert.match(server, /await prepareWindowsDockerHome\(projectDir\);\s*\}\s*await writeCoreProject/);
  });

  test(`${tree}: Windows home link is created only after volume verification`, async () => {
    const server = source(`${tree}/server/local-server.js`);
    const helper = server.match(/async function prepareWindowsDockerHome\(projectDir\) \{[\s\S]*?\n\}/)[0];
    const calls = [];
    const fsp = {
      lstat: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      mkdir: async () => calls.push('mkdir'),
      symlink: async (_, link) => calls.push(link.endsWith('\\.openclaw') ? 'home-link' : 'probe-link'),
      unlink: async () => calls.push('unlink'),
      writeFile: async () => calls.push('marker'),
    };
    const context = vm.createContext({
      join: path.win32.join, basename: path.win32.basename,
      slugify: (name) => name.toLowerCase(), fsp, process: { pid: 42 },
      existsSync: () => true, sendLog: () => {},
      run: async (_, args) => { assert.equal(args[2], 'oc-bot_openclaw-home'); calls.push('volume-create'); },
      runCapture: async () => { calls.push('volume-verified'); return { code: 0 }; },
    });
    vm.runInContext(helper, context);
    await context.prepareWindowsDockerHome('D:\\bot');
    assert.ok(calls.indexOf('volume-create') > calls.indexOf('probe-link'));
    assert.ok(calls.indexOf('home-link') > calls.indexOf('volume-verified'));
  });

  test(`${tree}: host Node version gate and install/update preflight`, () => {
    const server = source(`${tree}/server/local-server.js`);
    const gate = server.match(/function nodeVersionSupported\(version\) \{[\s\S]*?\n\}/);
    const preflight = server.match(/function assertOpenclawNodeVersion\(\) \{[\s\S]*?\n\}/);
    assert.ok(gate);
    assert.ok(preflight);
    const context = vm.createContext({
      process: { version: 'v24.18.0' }, OPENCLAW_NPM_SPEC: expectedSpec,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
    });
    vm.runInContext(`${gate[0]}\n${preflight[0]}`, context);
    for (const [version, supported] of boundaryCases) {
      assert.equal(context.nodeVersionSupported(version), supported, version);
      context.process.version = version;
      if (supported) assert.doesNotThrow(() => context.assertOpenclawNodeVersion());
      else assert.throws(() => context.assertOpenclawNodeVersion(), /requires Node\.js/);
    }
    assert.match(server, /async function installCore\([^\n]+\) \{\s*\/\/[^\n]+\s*assertOpenclawNodeVersion\(\);\s*state\.installing = true;/);
    assert.match(server, /if \(isNativeProject\(projectDir\)\) \{\s*if \(!isRouter\) assertOpenclawNodeVersion\(\);\s*sendLog\(`\[native\] Updating/);
  });
  test(`${tree}: 9Router auth migration fills only missing fields`, () => {
    const context = vm.createContext({ Buffer });
    vm.runInContext(source(`${tree}/setup/shared/common-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/docker-gen.js`), context);
    const script = context.__openclawDockerGen.routerAuthDefaultsScript;
    for (const initial of [
      { apiKey: 'test-key' },
      { apiKey: 'test-key', auth: 'custom', authHeader: false },
    ]) {
      let cfg = { models: { providers: { '9router': { ...initial } } }, unrelated: { kept: true } };
      const fs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify(cfg),
        writeFileSync: (_, value) => { cfg = JSON.parse(value); },
      };
      vm.runInNewContext(script, { require: id => id === 'fs' ? fs : path, process: { cwd: () => '/project' } });
      const provider = cfg.models.providers['9router'];
      assert.equal(provider.apiKey, 'test-key');
      assert.equal(provider.auth, initial.auth ?? 'api-key');
      assert.equal(provider.authHeader, initial.authHeader ?? true);
      assert.equal(cfg.unrelated.kept, true);
    }
  });
  test(`${tree}: OpenClaw 2026.9.6 Zalo config stays schema-compatible`, () => {
    const context = vm.createContext({ Buffer });
    vm.runInContext(source(`${tree}/setup/shared/common-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/bot-config-gen.js`), context);
    vm.runInContext(source(`${tree}/setup/shared/docker-gen.js`), context);

    const generated = context.__openclawBotConfig.buildOpenclawJson({
      channelKey: 'zalo-personal',
      providerKey: '9router',
      model: 'smart-route',
      agentMetas: [{ agentId: 'main', name: 'Main', accountId: 'default' }],
    });
    assert.equal(generated.messages.ackReaction, '🦞');
    assert.equal(generated.messages.ackReactionScope, 'all');
    assert.equal(Object.hasOwn(generated.messages, 'removeAckAfterReply'), false);

    let cfg = { messages: { ackReaction: '🦞', ackReactionScope: 'all', removeAckAfterReply: false }, unrelated: { kept: true } };
    let writes = 0;
    const fs = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(cfg),
      writeFileSync: (_, value) => { cfg = JSON.parse(value); writes += 1; },
    };
    const migration = context.__openclawDockerGen.openClaw96ConfigScript;
    const migrationContext = { require: id => id === 'fs' ? fs : path, process: { cwd: () => '/project' } };
    vm.runInNewContext(migration, migrationContext);
    assert.equal(Object.hasOwn(cfg.messages, 'removeAckAfterReply'), false);
    assert.equal(cfg.unrelated.kept, true);
    vm.runInNewContext(migration, migrationContext);
    assert.equal(writes, 1, 'migration should be idempotent');

    const artifacts = context.__openclawDockerGen.buildDockerArtifacts({
      openClawNpmSpec: expectedSpec, osChoice: 'win', is9Router: true,
    });
    const backupAt = artifacts.entrypointScript.indexOf('.openclaw-config-backup.json');
    const migrationAt = artifacts.entrypointScript.indexOf('removeAckAfterReply');
    const pluginCliAt = artifacts.entrypointScript.indexOf('ensure_plugin()');
    assert.ok(backupAt >= 0 && backupAt < migrationAt);
    assert.ok(migrationAt < pluginCliAt, 'schema migration must run before OpenClaw plugin commands');
  });
  test(`${tree}: unsupported Node stops before mutations; 9router update is unchanged`, async () => {
    const server = source(`${tree}/server/local-server.js`);
    const names = ['nodeVersionSupported', 'assertOpenclawNodeVersion', 'installCore', 'updateRuntime'];
    const functions = names.map((name) => {
      const match = server.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(match, name);
      return match[0];
    });
    const calls = [];
    const context = vm.createContext({
      process: { version: 'v22.22.3' }, OPENCLAW_NPM_SPEC: expectedSpec,
      NINE_ROUTER_NPM_SPEC: '9router@latest', state: {},
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      isNativeProject: () => true, sendLog: () => {}, probeCacheClear: () => {},
      run: async (command, args) => calls.push([command, ...args]),
      startNative9Router: async () => {}, restartNativeRuntime: async () => {},
      syncRuntimeState: async () => {},
    });
    vm.runInContext(functions.join('\n'), context);
    await assert.rejects(() => context.installCore({ mode: 'native', projectDir: 'test' }), /requires Node\.js/);
    assert.deepEqual(Object.keys(context.state), []);
    await assert.rejects(() => context.updateRuntime('openclaw', 'test'), /requires Node\.js/);
    assert.equal(calls.length, 0);
    await context.updateRuntime('9router', 'test');
    assert.equal(calls[0].join(' '), 'npm install -g 9router@latest');
    context.process.version = 'v24.16.0';
    await context.updateRuntime('openclaw', 'test');
    assert.equal(calls[1].join(' '), `npm install -g ${expectedSpec}`);
  });
}

test('edited source and distributed files remain identical', () => {
  for (const path of ['setup/shared/common-gen.js', 'setup/shared/bot-config-gen.js', 'setup/shared/docker-gen.js', 'server/local-server.js']) {
    assert.equal(source(`src/${path}`).replace(/\r\n/g, '\n'), source(`dist/${path}`).replace(/\r\n/g, '\n'), path);
  }
  assert.equal(JSON.parse(source('package.json')).version, '5.16.13');
});
