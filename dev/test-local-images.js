'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-local-images-'));
  const dir = path.join(work, 'images');
  const name = 'figure-0001.png';
  let browser, server;
  try {
    browser = await chromium.launch(process.env.UNDERSTAND_TEST_BROWSER ? { executablePath: process.env.UNDERSTAND_TEST_BROWSER } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 60;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#efdfbe';
      ctx.fillRect(0, 0, 160, 60);
      ctx.font = '16px sans-serif';
      ctx.fillStyle = '#202020';
      ctx.fillText('iPS  ○ → ○ ○', 8, 36);
      return ['png', 'jpeg', 'webp'].map(type => canvas.toDataURL(`image/${type}`).split(',')[1]);
    });
    const [png, jpg, webp] = encoded.map(b => Buffer.from(b, 'base64'));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), png);
    fs.writeFileSync(path.join(work, 'main.md'), [
      '# iPS 細胞の模式図', `![模式図](images/${name})`,
      '![外部](https://blocked.invalid/test-markdown-image)',
      '<img src="https://blocked.invalid/test-html-direct-image">',
      '<picture><source srcset="https://blocked.invalid/test-source-image"><img src="/test-html-image" srcset="https://blocked.invalid/test-html-image 2x"></picture>',
      '<svg><image href="/test-svg-image"></image></svg>',
    ].join('\n\n'));
    server = spawn(process.execPath, [path.join(root, 'skill/understand/app/server.js'), '--dir', work, '--cwd', work, '--port', '0', '--no-open'], {
      env: { ...process.env, UNDERSTAND_AGENT: 'claude', UNDERSTAND_CLAUDE_BIN: path.join(__dirname, 'mock-claude.js') }, stdio: 'ignore',
    });
    const ready = path.join(work, 'url.txt');
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 50));
    const url = new URL(fs.readFileSync(ready, 'utf8').trim());
    const base = `${url.origin}/api/figures`;
    const token = { 'X-Understand-Token': url.searchParams.get('t') };
    const get = (suffix = '') => fetch(base + suffix, { headers: token });
    const post = (b, type = 'image/png', h = token) => fetch(base, { method: 'POST', headers: { ...h, 'Content-Type': type }, body: b });
    assert.equal((await fetch(base)).status, 403);
    assert.equal((await fetch(base + '/' + name + url.search)).status, 403);
    assert.equal((await post(png, 'image/png', {})).status, 403);
    assert.deepEqual(await (await get()).json(), { names: [name] });
    assert.deepEqual(Buffer.from(await (await get('/' + name)).arrayBuffer()), png);
    assert.equal((await post(png, 'image/jpeg')).status, 415);
    assert.equal((await post(Buffer.from('<svg/>'))).status, 415);
    assert.equal((await post(Buffer.alloc(4 * 1024 * 1024 + 1))).status, 413);
    const chunked = await fetch(base, { method: 'POST', headers: { ...token, 'Content-Type': 'image/png' }, duplex: 'half',
      body: (async function* () { for (let i = 0; i < 5; i++) yield Buffer.alloc(1024 * 1024); })() });
    assert.equal(chunked.status, 413);
    for (const [type, b] of [['jpeg', jpg], ['webp', webp]]) {
      const r = await post(b, `image/${type}`);
      assert.equal(r.status, 201);
      const stored = (await r.json()).name;
      assert.equal((await get('/' + stored)).headers.get('content-type'), `image/${type}`);
      fs.unlinkSync(path.join(dir, stored));
    }
    fs.writeFileSync(path.join(work, 'outside.png'), png);
    fs.symlinkSync(path.join(work, 'outside.png'), path.join(dir, 'link.png'));
    fs.writeFileSync(path.join(dir, 'fake.webp'), png);
    fs.writeFileSync(path.join(dir, 'oversize.png'), Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]));
    assert.deepEqual(await (await get()).json(), { names: [name] });
    for (const suffix of ['/link.png', '/%2e%2e%2fmain.md', '/sub/' + name]) assert.equal((await get(suffix)).status, 404);
    assert.equal((await get('/fake.webp')).status, 415);
    assert.equal((await get('/oversize.png')).status, 413);
    for (const f of ['link.png', 'fake.webp', 'oversize.png']) fs.unlinkSync(path.join(dir, f));
    fs.renameSync(dir, dir + '-real');
    fs.symlinkSync(dir + '-real', dir);
    for (const r of [await get(), await get('/' + name), await post(png)]) assert.equal(r.status, 404);
    fs.unlinkSync(dir);
    fs.renameSync(dir + '-real', dir);
    for (let i = 0; i < 31; i++) fs.writeFileSync(path.join(dir, `item-${i}`), '');
    assert.equal((await post(png)).status, 409);
    for (let i = 0; i < 31; i++) fs.unlinkSync(path.join(dir, `item-${i}`));
    console.log('OK: 認証・画像形式・サイズ・件数・パス・リンク');

    const blocked = [], api = [], errors = [];
    await context.route(/^https?:\/\//, async route => {
      const u = new URL(route.request().url());
      if (u.origin !== url.origin || u.pathname.startsWith('/test-')) {
        blocked.push(u.pathname);
        return route.abort();
      }
      if (u.pathname.startsWith('/api/')) api.push([u.pathname, u.search, route.request().headers()['x-understand-token']]);
      await route.continue();
    });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.released = 0;
      window.refusedImages = [];
      document.addEventListener('securitypolicyviolation', e => { if (e.effectiveDirective === 'img-src') window.refusedImages.push(e.blockedURI); });
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.released++; revoke(url); };
    });
    await page.goto(url.href);
    const images = async (selector, count) => page.waitForFunction(([s, n]) => {
      const imgs = [...document.querySelectorAll(s)];
      return imgs.length === n && imgs.every(img => img.src.startsWith('blob:') && img.naturalWidth === 160);
    }, [selector, count]);
    await images('#main-body img', 1);
    assert.equal(await page.locator('#main-body img').getAttribute('alt'), '模式図');
    await page.click('#btn-tsuzuri');
    await page.click('#tz-tab-read');
    await images('#tz-read img', 1);
    await page.click('#figure-gallery summary');
    await images('.figure-list img', 1);
    await page.locator('#figure-gallery input').setInputFiles({ name: 'Codexの出力.png', mimeType: 'image/png', buffer: png });
    await images('.figure-list img', 2);
    const stored = (await (await get()).json()).names.find(n => n !== name);
    assert.match(stored, /^figure-[0-9a-f-]+\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(dir, stored)), png);
    assert.equal(await page.locator('#figure-gallery').evaluate(e => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right <= window.innerWidth), true);
    const released = await page.evaluate(() => window.released);
    await page.click('#figure-gallery summary');
    await page.waitForFunction(n => window.released >= n + 2, released);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    assert.deepEqual(await page.evaluate(() => window.refusedImages), []);
    assert.ok(api.every(([p, q, h]) => (p === '/api/init' || p.startsWith('/api/figures')) && !q && h === token['X-Understand-Token']));
    console.log('OK: モバイルの本筋・読む表示・一覧・ファイル選択・URL解放・外部通信なし');
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    if (browser) await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
