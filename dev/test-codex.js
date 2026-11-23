#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'skill/understand/app/server.js');
const mock = path.join(__dirname, 'mock-codex.js');
const main = '11111111-1111-4111-8111-111111111111';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-codex-test-'));
const log = path.join(dir, 'calls.jsonl');
const codexHome = path.join(dir, 'source');
const sessions = path.join(codexHome, 'sessions', '2026', '01', '01');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, `rollout-2026-01-01T00-00-00-${main}.jsonl`),
  JSON.stringify({ type: 'session_meta', payload: { id: main, model_provider: 'openai' } }) + '\n');
const env = { ...process.env, HOME: dir, CODEX_HOME: codexHome, UNDERSTAND_CODEX_BIN: mock,
  MOCK_CODEX_LOG: log, MOCK_CODEX_STORE: path.join(dir, 'memory.json') };
const base = ['--backend', 'codex', '--dir', dir, '--cwd', root, '--no-open'];
const bad = spawnSync(process.execPath, [server, ...base], { env, encoding: 'utf8', timeout: 3000 });
assert.notStrictEqual(bad.status, 0, 'missing explicit session must fail');
assert.match(bad.stderr, /session/i);
const proc = spawn(process.execPath, [server, ...base, '--session', main], { env });
let output = '';
proc.stdout.on('data', d => output += d);
proc.stderr.on('data', d => output += d);
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'url.txt')); i++) await delay(30);
    assert.ok(fs.existsSync(path.join(dir, 'url.txt')), output);
    const url = new URL(fs.readFileSync(path.join(dir, 'url.txt'), 'utf8'));
    const headers = { 'content-type': 'application/json', 'x-understand-token': url.searchParams.get('t') };
    const api = async (endpoint, body) => (await fetch(`${url.origin}/api/${endpoint}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })).json();
    const init = await api('init');
    assert.strictEqual(init.backend, 'codex');
    assert.strictEqual(init.sqlEnabled, false);
    let r = await api('ask', { action: 'detail', anchor: 'hello' });
    assert.deepStrictEqual([r.ok, r.text], [true, 'ok']);
    const childId = r.sessionId;
    assert.ok(childId && childId !== main);
    r = await api('ask', { sessionId: childId, continueSession: true, followUp: 'follow' });
    assert.strictEqual(r.ok, true);
    r = await api('ask', { sessionId: childId, continueSession: false, anchor: 'nested' });
    assert.strictEqual(r.ok, true);
    r = await api('ask', { sessionId: main, continueSession: true, followUp: 'unsafe' });
    assert.strictEqual(r.ok, false);
    r = await api('ask', { sessionId: 'unowned', continueSession: false });
    assert.strictEqual(r.ok, false);
    r = await api('runsql', { sessionId: childId, sql: 'SELECT 1' });
    assert.strictEqual(r.ok, false);
    r = await api('draft', { notes: 'notes' });
    assert.strictEqual(r.ok, true);
    r = await api('ask', { followUp: 'behave:exit1' });
    assert.strictEqual(r.ok, false);
    r = await api('ask', { followUp: 'behave:garbage' });
    assert.strictEqual(r.ok, false);
    r = await api('ask', { followUp: 'behave:parentid' });
    assert.strictEqual(r.ok, false);
    r = await api('ask', { sessionId: main, continueSession: true, followUp: 'unsafe after bad fork' });
    assert.strictEqual(r.ok, false);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
      .map(({ argv: args, stdin: prompt }) => ({ args, prompt }));
    assert.strictEqual(calls.length, 7);
    assert.deepStrictEqual(calls.slice(0, 3).map(c => c.args.includes('fork') ? 'fork' : 'resume'), ['fork', 'resume', 'fork']);
    assert.strictEqual(calls[0].args[calls[0].args.indexOf('fork') + 1], main);
    assert.strictEqual(calls[1].args[calls[1].args.indexOf('resume') + 1], childId);
    for (const c of calls) {
      assert.ok(c.args.includes('--json'));
      assert.ok(c.args.includes('--ignore-user-config'));
      for (const feature of ['shell_tool', 'apps', 'hooks', 'plugins', 'browser_use', 'computer_use']) {
        assert.ok(c.args.some((arg, i) => arg === '--disable' && c.args[i + 1] === feature));
      }
      assert.ok(c.args.includes('--sandbox') && c.args[c.args.indexOf('--sandbox') + 1] === 'read-only');
      assert.ok(!c.args.includes('--last'));
      assert.ok(c.prompt);
    }
    if (process.env.UNDERSTAND_TEST_BROWSER) {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ executablePath: process.env.UNDERSTAND_TEST_BROWSER });
      try {
        const page = await browser.newPage();
        await page.goto(url.href);
        await page.waitForFunction(() => document.querySelector('#project').textContent.length > 0);
        const disabled = await page.evaluate(() => {
          const pre = document.createElement('pre');
          pre.innerHTML = '<code>SELECT 1</code>';
          const box = sqlBox({ busy: false }, {}, 'SELECT 1', pre);
          document.body.append(box);
          const button = box.querySelector('.btn-run');
          return !button || button.disabled;
        });
        assert.strictEqual(disabled, true, 'Codex SQL button must be disabled');
        await page.click('#btn-finish');
        await page.fill('#ret-text', '  選んだ文だけ  ');
        await page.click('#btn-ret-send');
        await page.waitForSelector('#done:not([hidden])');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'return.md'), 'utf8'), '  選んだ文だけ  \n');
      } finally { await browser.close(); }
      console.log('Codex browser SQL control and selected-text return passed');
    } else {
      assert.strictEqual((await api('return', { text: 'done' })).ok, true);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'return.md'), 'utf8'), 'done\n');
    }
    console.log('Codex integration tests passed');
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
