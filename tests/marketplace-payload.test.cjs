const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { prepareMarketplacePayload } = require('../scripts/marketplace-payload');
const { runtimeFileNames, targetForPlatform } = require('../scripts/runtime-preflight-lib');

function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbsl-payload-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, data = 'test') => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), data);
  };
  const browserRoot = `browser/${platform}`;
  const browser = { schemaVersion: 1, platformId: platform, nodePath: 'node/node', launcherPath: 'node_modules/@playwright/mcp/cli.js', browserExecutablePath: `browsers/${platform === 'linux-x64' ? 'chromium_headless_shell-1232' : 'chromium-1232'}/chrome` };
  put('package.json', JSON.stringify({ xbsl: { schemaVersion: 1, package: { requiredFiles: ['media/chat.js'] } } }));
  put(`${browserRoot}/runtime.json`, JSON.stringify(browser));
  for (const name of [browser.nodePath, browser.launcherPath, browser.browserExecutablePath, 'browsers/chromium-1232/chrome', 'browsers/chromium_headless_shell-1232/chrome', 'browsers/ffmpeg-1011/ffmpeg', 'node_modules/.bin/playwright']) put(`${browserRoot}/${name}`);
  for (const name of runtimeFileNames(targetForPlatform(platform))) put(`bin/${platform}/${name}`);
  for (const name of ['dist/extension.js', 'media/chat.js', 'docs/guide.md', 'tests/fixture', '.github/workflow', 'src/extension.ts', 'LICENSE']) put(name);
  return { root, browserRoot, browser, put };
}
for (const platform of ['linux-x64', 'win32-x64']) {
  test(`prepares ${platform} without changing the selected browser`, t => {
    const { root, browserRoot, browser } = fixture(t, platform);
    const result = prepareMarketplacePayload(root, platform);
    assert.ok(result.unpackedBytes > 0);
    assert.ok(fs.existsSync(path.join(root, browserRoot, browser.browserExecutablePath)));
    assert.ok(fs.existsSync(path.join(root, browserRoot, 'browsers/ffmpeg-1011/ffmpeg')));
    assert.equal(fs.readdirSync(path.join(root, browserRoot, 'browsers')).filter(n => n.startsWith('chromium')).length, 1);
    for (const name of ['tests', '.github', 'src', `${browserRoot}/node_modules/.bin`]) assert.equal(fs.existsSync(path.join(root, name)), false);
    const required = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).xbsl.package.requiredFiles;
    assert.ok(required.includes('dist/extension.js'));
    assert.ok(required.includes(`${browserRoot}/${browser.browserExecutablePath}`));
    assert.equal(result.requiredFiles, required.length);
    assert.deepEqual(prepareMarketplacePayload(root, platform), result, 'idempotent');
  });
}
test('rejects source checkout, not a disposable stage', () => {
  assert.throws(() => prepareMarketplacePayload(path.resolve(__dirname, '..'), 'linux-x64'), /separate staging/);
});
test('rejects escaping browser references before pruning', t => {
  const { root, browser, browserRoot, put } = fixture(t, 'linux-x64');
  put(`${browserRoot}/runtime.json`, JSON.stringify({ ...browser, nodePath: '../outside' }));
  assert.throws(() => prepareMarketplacePayload(root, 'linux-x64'), /Unsafe browser path/);
  assert.ok(fs.existsSync(path.join(root, 'tests/fixture')));
});
test('rejects required-file loss', t => {
  const { root } = fixture(t, 'linux-x64');
  fs.unlinkSync(path.join(root, 'media/chat.js'));
  assert.throws(() => prepareMarketplacePayload(root, 'linux-x64'), /Missing required file/);
});
test('rejects unexpected symlinks', t => {
  const { root } = fixture(t, 'linux-x64');
  fs.symlinkSync('extension.js', path.join(root, 'dist/link.js'));
  assert.throws(() => prepareMarketplacePayload(root, 'linux-x64'), /Unsupported archive entry/);
});
