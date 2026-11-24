'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const assets = path.resolve(__dirname, '../skill/understand/app/public');
const origin = 'http://board.test';
const providers = [
  { id: 'claude', models: ['haiku', 'sonnet', 'opus'] },
  { id: 'codex', models: ['gpt-6.2-terra', 'gpt-6.2-astra'] },
];

async function scenario(browser, backend, enabled) {
  const context = await browser.newContext({ viewport: { width: 2400, height: 1400 }, serviceWorkers: 'block' });
  const calls = [];
  const errors = [];
  let failDiscovery = true;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) { errors.push(url.href); return route.abort(); }
    const name = url.pathname;
    if (!name.startsWith('/api/')) return route.fulfill({ path: path.join(assets, name === '/' ? 'index.html' : name) });
    const body = req.postDataJSON();
    calls.push({ name, body });
    if (req.headers()['x-understand-token'] !== 'test') errors.push('missing token: ' + name);
    let json;
    if (name === '/api/init') json = { markdown: '# 本筋\n引用した文', backend, hasSession: true,
      ...(enabled && { loginPicker: true }), autoRun: backend === 'claude', canRunSql: backend === 'claude' };
    else if (name === '/api/providers') {
      if (req.method() !== 'GET') errors.push('discovery method: ' + req.method());
      json = failDiscovery ? { ok: false } : { ok: true, providers };
      failDiscovery = false;
    } else if (name === '/api/cli-question') {
      json = body.question === '失敗' ? { ok: false, error: '利用できません' }
        : { ok: true, sessionId: 'must-never-resume', text: '履歴なしの回答\n```sql\nselect 99;\n```' };
    } else if (name === '/api/ask') json = { ok: true, sessionId: 'main-branch',
      text: body.followUp === 'SQLを確認' ? '```sql\nselect 1;\n```' : '本筋の回答' };
    else if (name === '/api/runsql') json = { ok: true, text: '結果' };
    else errors.push(name);
    await route.fulfill({ json: json || {} });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const idle = () => page.waitForFunction(() => !Object.values(S.stickies).some((s) => s.busy));
  const create = async (type, ctx) => {
    const id = await page.evaluate(([type, ctx]) => { createSticky(type, ctx); return S.focus; }, [type, ctx]);
    await idle();
    return page.locator('#st-' + id);
  };
  const send = async (box, q) => {
    const ta = box.getByRole('textbox', { name: '質問を入力' });
    await ta.fill(q);
    await ta.press('Control+Enter');
    await idle();
  };
  const choose = async (box, choice) => {
    const details = box.locator('.login-picker details');
    if (!(await details.evaluate((d) => d.open))) await details.locator('summary').click();
    await details.locator('select').selectOption(choice ? JSON.stringify(choice) : '');
  };
  const last = (name, body) => assert.deepEqual(calls.at(-1), { name: '/api/' + name, body });
  try {
    await page.goto(origin + '/?t=test');
    await page.locator('#main-body h1').waitFor();
    const anchor = '引用した文';
    const box = await create('question', { source: 'main', text: anchor, anchorY: 0 });
    assert.deepEqual(calls.map((c) => c.name), ['/api/init']);
    assert.equal(await box.locator('.login-picker').count(), enabled ? 1 : 0);
    await send(box, '本筋の質問');
    last('ask', { action: 'question', anchor, question: '本筋の質問', sessionId: null, continueSession: false });
    if (!enabled) {
      assert.deepEqual(calls.map((c) => c.name), ['/api/init', '/api/ask']);
      return;
    }
    const codex = { provider: 'codex', model: providers[1].models[1] };
    const claude = { provider: 'claude', model: 'opus' };
    const summary = box.locator('.login-picker summary');
    await summary.click();
    await box.getByText(/CLIを確認できませんでした/).waitFor();
    await summary.click();
    await choose(box, codex);
    assert.equal(await box.locator('select option').count(), 6);
    assert.deepEqual(calls.map((c) => c.name), ['/api/init', '/api/ask', '/api/providers', '/api/providers']);
    await box.getByText(/引用と今回の質問だけを Codex/).waitFor();
    for (const choice of [codex, claude, { ...codex, model: providers[1].models[0] }]) {
      await choose(box, choice);
      const question = '質問：' + choice.model;
      await send(box, question);
      last('cli-question', { ...choice, question, anchor });
      assert.match(await summary.textContent(), new RegExp(choice.model));
      assert.equal(await box.locator('.sql-box').count(), 0);
      assert.equal(await box.locator('.btn-run').count(), 0);
    }
    await send(box, '失敗');
    await box.locator('.msg.error', { hasText: '利用できません' }).waitFor();
    assert.equal(calls.at(-1).name, '/api/cli-question');
    await page.reload();
    await summary.waitFor();
    assert.match(await summary.textContent(), /gpt-6.2-terra/);
    await choose(box, null);
    assert.equal(await box.locator('.sql-box').count(), 0);
    await send(box, '続きを確認');
    last('ask', { followUp: '続きを確認', sessionId: 'main-branch', continueSession: true });
    const blank = await create('question', null);
    await choose(blank, claude);
    await send(blank, 'そのままの質問');
    last('cli-question', { ...claude, question: 'そのままの質問', anchor: '' });
    await create('detail', { source: 's2', text: '履歴なしの回答', anchorY: 0 });
    last('ask', { action: 'detail', anchor: '履歴なしの回答', sessionId: null, continueSession: false });
    await create('term', { source: 's1', text: '本筋の回答', anchorY: 0 });
    last('ask', { action: 'term', anchor: '本筋の回答', sessionId: 'main-branch', continueSession: false });
    assert.equal(calls.filter((c) => c.name === '/api/runsql').length, 0);
    await send(box, 'SQLを確認');
    if (backend === 'claude') last('runsql', { sessionId: 'main-branch', sql: 'select 1;' });
    else last('ask', { followUp: 'SQLを確認', sessionId: 'main-branch', continueSession: true });
    assert.equal(await box.locator('.sql-box').count(), 1);
    assert.equal(calls.some((c) => JSON.stringify(c.body || {}).includes('must-never-resume')), false);
  } finally {
    await context.close();
    assert.deepEqual(errors, []);
  }
}

(async () => {
  const browser = await chromium.launch(process.env.UNDERSTAND_TEST_BROWSER
    ? { executablePath: process.env.UNDERSTAND_TEST_BROWSER } : {});
  try {
    await scenario(browser, 'claude', true);
    await scenario(browser, 'codex', true);
    await scenario(browser, 'claude', false);
    console.log('OK: 送信先の切り替え、履歴の分離、SQL、旧サーバー互換');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
