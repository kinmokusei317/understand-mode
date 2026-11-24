'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const { chromium } = require('playwright');

async function test() {
  const app = path.resolve(__dirname, '../skill/understand/app');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-revisions-'));
  const file = name => path.join(dir, name);
  const main = '青い箱を開く。\n手で灯す。';
  const edited = main.replace('青', '赤');
  const ai = '手元を照らす。';
  let server, browser;
  try {
    fs.writeFileSync(file('main.md'), main);
    fs.writeFileSync(file('fake'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
fs.writeFileSync('call.json', JSON.stringify(process.argv.slice(2)));
const {text, comment} = JSON.parse(prompt.split('\\n').pop());
const result = comment === '同じ' ? text : comment === '空' ? '  ' : ${JSON.stringify(ai)};
setTimeout(() => console.log(JSON.stringify({result})), 100);
`, { mode: 0o700 });
    server = spawn(process.execPath, [path.join(app, 'server.js'), '--dir', dir, '--cwd', dir,
      '--session', 'test-revisions', '--port', '0', '--no-open', '--agent', 'claude'], {
      cwd: dir, env: { HOME: dir, PATH: process.env.PATH, TMPDIR: dir, UNDERSTAND_CLAUDE_BIN: file('fake') }
    });
    for (let i = 0; i < 150 && !fs.existsSync(file('url.txt')); i++) await wait(50);
    const url = fs.readFileSync(file('url.txt'), 'utf8').trim();
    const key = 'understand-tsuzuri-v1:' + new URL(url).searchParams.get('t');
    browser = await chromium.launch({ executablePath: process.env.UNDERSTAND_TEST_BROWSER });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const editor = page.locator('#tz-edit');
    const record = page.locator('#btn-tz-record');
    const open = () => page.click('#btn-tsuzuri');
    const history = () => page.click('#tz-tab-history');
    const write = () => page.click('#tz-tab-write');
    const preview = () => page.locator('#tz-manual-preview dd').allTextContents();
    const saved = () => page.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key);
    const request = async comment => {
      await write();
      await editor.evaluate(e => {
        const at = e.value.indexOf('手で灯す。');
        e.setSelectionRange(at, at + 5);
        e.dispatchEvent(new Event('select'));
      });
      await page.fill('#tz-comment', comment);
      await page.click('#btn-tz-revise');
    };
    await page.goto(url);
    await open();
    await history();
    assert.ok(await record.isDisabled());
    await write();
    await editor.fill('');
    await history();
    assert.ok(await record.isDisabled());
    await write();
    await editor.fill(edited);
    await history();
    assert.deepEqual(await preview(), ['青', '赤']);
    assert.ok(!fs.existsSync(file('call.json')));
    await request('捨てる');
    await page.click('#btn-tz-discard');
    assert.deepEqual((await saved()).records, []);
    for (const comment of ['空', '同じ']) {
      await request(comment);
      await page.waitForSelector('#tz-error:not([hidden])');
      assert.ok(await page.locator('#tz-suggest').isHidden());
      assert.deepEqual((await saved()).records, []);
    }
    await request('原稿を変更');
    await page.waitForSelector('#tz-suggest:not([hidden])');
    await editor.fill(edited + '!');
    await page.click('#btn-tz-adopt');
    assert.match(await page.textContent('#tz-error'), /原稿が変わった/);
    assert.deepEqual((await saved()).records, []);
    await page.click('#btn-tz-discard');
    await editor.fill(edited);
    await request('小学生向け');
    await page.fill('#tz-comment', '採用時の別の希望');
    await page.click('#btn-tz-adopt');
    const args = JSON.parse(fs.readFileSync(file('call.json'), 'utf8'));
    const prompt = args[args.indexOf('-p') + 1];
    const skill = fs.readFileSync(path.join(app, 'public/vendor/yomiyasu/SKILL.md'), 'utf8');
    const start = skill.indexOf('### 最優先ルール: 意味の保持');
    const end = skill.indexOf('\n\n### 情報の不増補', start);
    assert.ok(start >= 0 && end > start);
    assert.ok(prompt.endsWith('校正には同梱の yomiyasu の基本原則を使い、提案文だけを返してください。\n' +
      skill.slice(start, end) + '\n' + JSON.stringify({ text: '手で灯す。', comment: '小学生向け' })));
    assert.ok(!prompt.includes('赤い箱'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--no-session-persistence'));
    await page.reload();
    await open();
    assert.equal(await editor.inputValue(), edited.replace('手で灯す。', ai));
    await editor.fill((await editor.inputValue()) + '🌿');
    await history();
    assert.deepEqual(await preview(), ['青', '赤']);
    await page.fill('#tz-reason', '色を訂正');
    await record.click();
    assert.deepEqual(await preview(), ['（なし）', '🌿']);
    await record.click();
    assert.ok(await record.isDisabled());
    assert.equal(await page.locator('#tz-records li').count(), 3);
    const download = page.waitForEvent('download');
    await page.click('#btn-tz-history-export');
    await (await download).saveAs(file('export.json'));
    const rows = JSON.parse(fs.readFileSync(file('export.json'), 'utf8'));
    assert.deepEqual(rows.map(({ time, ...r }) => {
      assert.equal(new Date(time).toISOString(), time);
      return r;
    }), [
      { kind: 'ai', before: '手で灯す。', after: ai, comment: '小学生向け' },
      { kind: 'manual', before: '青', after: '赤', comment: '色を訂正' },
      { kind: 'manual', before: '', after: '🌿', comment: '' },
    ]);
    const other = await context.newPage();
    await other.goto(url);
    assert.equal(await other.evaluate(k => sessionStorage.getItem(k), key), null);
    await other.evaluate(k => sessionStorage.setItem(k, JSON.stringify({ draft: '壊れた', base: '', queue: [], records: [null] })), key);
    await other.click('#btn-tsuzuri');
    assert.equal(await other.inputValue('#tz-edit'), main);
    assert.ok(await other.locator('#tz-storage-warning').isVisible());
    await other.close();
    await write();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; });
    await editor.fill('保存できない原稿');
    assert.match(await page.textContent('#tz-storage-warning'), /保存できません/);
    await page.click('#btn-tz-close');
    await open();
    assert.equal(await editor.inputValue(), '保存できない原稿');
    await page.click('#btn-tz-close');
    await page.click('#btn-finish');
    await page.fill('#ret-text', '確認しました');
    await page.route('**/api/return', route => route.fulfill({ json: { ok: false, error: 'やり直し' } }), { times: 1 });
    page.once('dialog', dialog => dialog.accept());
    await page.click('#btn-ret-send');
    assert.deepEqual((await saved()).records, rows);
    await page.click('#btn-ret-send');
    await page.waitForSelector('#done:not([hidden])');
    assert.equal(await saved(), null);
    assert.equal(fs.readFileSync(file('main.md'), 'utf8'), main);
    assert.deepEqual(errors, []);
    console.log('OK: 手直し、AI採用、希望の固定、空・同文・破棄・古い提案、復元、タブ分離、JSON、容量超過、終了時の消去、同梱原文の送信');
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      const ended = new Promise(resolve => server.once('close', resolve));
      server.kill();
      await ended;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test().catch(e => { console.error(e); process.exitCode = 1; });
