'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const assets = path.resolve(__dirname, '../skill/understand/app/public');
const origin = 'http://board.test';
const flow = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../skill/understand/app/login-flow.json'), 'utf8'));
const shots = path.resolve(__dirname, 'shots');

async function runCase(browser, name, providerId, state) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const calls = [];
  const errors = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) { errors.push('外部への要求: ' + url.href); return route.abort(); }
    const name = url.pathname;
    if (!name.startsWith('/api/')) return route.fulfill({ path: path.join(assets, name === '/' ? 'index.html' : name) });
    calls.push({ name, method: req.method(), token: req.headers()['x-understand-token'], body: req.postDataJSON() });
    let json;
    if (name === '/api/init') {
      json = { markdown: '# 本筋\n引用した文', backend: 'claude', hasSession: true,
        autoRun: true, canRunSql: true, loginPicker: true, loginFlow: true };
    } else if (name === '/api/providers') {
      json = state === 'signedIn'
        ? { ok: true, providers: [{ id: providerId, models: flow.providers[providerId] ? ['m1'] : [] }], states: { [providerId]: 'signedIn' } }
        : { ok: true, providers: [], states: { [providerId]: 'signedOut' } };
    } else if (name === '/api/login/start') {
      json = { ok: true };
    } else if (name === '/api/cli-question' || name === '/api/ask') {
      errors.push('質問を送信しました: ' + name);
      json = { ok: false };
    } else {
      errors.push('想定外のAPI: ' + name);
      json = { ok: false };
    }
    await route.fulfill({ json });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const fails = [];
  const fail = (msg) => fails.push(msg);
  try {
    await page.goto(origin + '/?t=test');
    await page.locator('#main-body h1').waitFor();
    assert.equal(await page.locator('#main-body h1').textContent(), '本筋');
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `login-screen-${name}.png`), fullPage: true });

    const label = flow.providers[providerId].buttonLabel;
    const button = page.getByRole('button', { name: label, exact: true });
    if (state === 'signedOut') {
      const pre = calls.map((c) => c.name);
      if (pre.some((n) => n === '/api/login/start')) fail('操作なしで /api/login/start が呼ばれました');
      if (pre.some((n) => n === '/api/cli-question' || n === '/api/ask')) fail('初期表示で質問系APIが呼ばれました: ' + pre.join(','));
      try {
        await button.waitFor({ state: 'visible', timeout: 2000 });
      } catch (_) {
        fail(`ログアウト状態でボタン「${label}」が2秒以内に表示されませんでした`);
      }
      if (fails.length === 0) {
        await button.click();
        await page.waitForTimeout(200);
        const starts = calls.filter((c) => c.name === '/api/login/start');
        if (starts.length !== 1) fail(`/api/login/start の呼び出しが ${starts.length} 回です（期待: 1）`);
        else {
          if (starts[0].method !== 'POST') fail('/api/login/start が POST ではありません: ' + starts[0].method);
          if (starts[0].token !== 'test') fail('/api/login/start にトークンがありません');
          try { assert.deepEqual(starts[0].body, { provider: providerId }); }
          catch (_) { fail('/api/login/start の body が不正です: ' + JSON.stringify(starts[0].body)) }
        }
        if (calls.some((c) => c.name === '/api/cli-question' || c.name === '/api/ask')) {
          fail('ログイン開始時に質問が送信されました');
        }
      }
    } else {
      if (!calls.some((c) => c.name === '/api/providers' && c.token === 'test')) {
        fail('ログイン状態の確認（/api/providers）が呼ばれていません');
      }
      if (await button.count() !== 0) fail(`サインイン済みなのにボタン「${label}」が表示されています`);
      if (calls.some((c) => c.name === '/api/login/start')) fail('サインイン済みで /api/login/start が呼ばれました');
      if (!(await page.locator('#main-body h1').isVisible())) fail('ボードが使える状態ではありません');
    }
  } catch (e) {
    fail('予期しない例外: ' + (e && e.message));
  } finally {
    await context.close();
  }
  for (const e of errors) fail(e);
  return fails;
}

(async () => {
  const browser = await chromium.launch(process.env.UNDERSTAND_TEST_BROWSER
    ? { executablePath: process.env.UNDERSTAND_TEST_BROWSER } : {});
  const results = [];
  try {
    results.push(['codex 未ログイン', await runCase(browser, 'signedout-codex', 'codex', 'signedOut')]);
    results.push(['claude 未ログイン', await runCase(browser, 'signedout-claude', 'claude', 'signedOut')]);
    results.push(['claude ログイン済み', await runCase(browser, 'signedin-claude', 'claude', 'signedIn')]);
  } finally {
    await browser.close();
  }
  let bad = 0;
  for (const [name, fails] of results) {
    if (fails.length === 0) { console.log('PASS ' + name); continue; }
    bad++;
    for (const f of fails) console.log(`FAIL ${name}: ${f}`);
  }
  if (bad) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
