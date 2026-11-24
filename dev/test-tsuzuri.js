// Tsuzuriノートの自動確認。偽の claude / codex でサーバーを自分で立てて試す。
// 使い方: NODE_PATH=<playwrightのあるnode_modules> node dev/test-tsuzuri.js [スクリーンショットの保存先]
//   playwright はこのリポジトリの依存にしない（NODE_PATH で解決する）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(__dirname, 'shots');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (_) {
  console.error('playwright が見つかりません。NODE_PATH=<playwrightのあるnode_modules> を付けて実行してください');
  process.exit(1);
}

const MAIN_MD = [
  '# サンプルの本筋',
  '',
  'これは道具を使った試験の文章です。読み手は初めての人です。',
  '',
  '```python',
  'print("hello")',
  '```',
  '',
  '締めの段落です。',
].join('\n');

const errors = [];
const ok = (cond, label) => { if (!cond) errors.push(label); };

// このテスト専用のサーバー（ポートは空いている所）。起動失敗はすぐ止める
function startServer(extraArgs, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-test-'));
  fs.writeFileSync(path.join(dir, 'main.md'), MAIN_MD);
  fs.writeFileSync(path.join(dir, 'title.txt'), 'テスト原稿\n');
  const srv = spawn(process.execPath, [
    path.join(ROOT, 'skill/understand/app/server.js'),
    '--dir', dir, '--cwd', ROOT, '--port', '0', '--no-open',
  ].concat(extraArgs), {
    env: { ...process.env, UNDERSTAND_MOCK_DELAY: '500', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.log = '';
  srv.stdout.on('data', (d) => { srv.log += d; });
  srv.stderr.on('data', (d) => { srv.log += d; });
  srv.dir = dir;
  return srv;
}

async function waitUrl(srv) {
  const f = path.join(srv.dir, 'url.txt');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(f)) throw new Error('サーバーが起動しませんでした\n' + srv.log);
  return fs.readFileSync(f, 'utf8').trim();
}

// 子プロセスは必ず畳む（テストが途中で失敗しても残さない）
const procs = [];
async function main() {
  const srv = startServer(
    ['--session', 'mock-main-session'],
    { UNDERSTAND_CLAUDE_BIN: path.join(ROOT, 'dev/mock-claude.js') });
  procs.push(srv);
  const URL = await waitUrl(srv);

  // Codex のボード（推敲が「記録に残さない下書き」で呼ばれることを確かめる）
  const CODEX_LOG = path.join(os.tmpdir(), 'tz-mock-codex-log.jsonl');
  const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-codex-home-'));
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-home-'));
  fs.rmSync(CODEX_LOG, { force: true });
  const PARENT_UUID = '12345678-1234-1234-1234-1234567890ab';
  const srvCodex = startServer(
    ['--agent', 'codex', '--session', PARENT_UUID],
    {
      HOME: FAKE_HOME,
      CODEX_HOME,
      UNDERSTAND_AGENT: 'codex',
      UNDERSTAND_CODEX_BIN: path.join(ROOT, 'dev/mock-codex.js'),
      MOCK_CODEX_LOG: CODEX_LOG,
      MOCK_CODEX_STORE: path.join(os.tmpdir(), 'tz-mock-codex-store.json'),
    });
  procs.push(srvCodex);
  const CODEX_URL = await waitUrl(srvCodex);

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.UNDERSTAND_TEST_BROWSER
    ? { executablePath: process.env.UNDERSTAND_TEST_BROWSER } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
    const apiCalls = [];
    context.on('request', (req) => { const u = req.url(); if (u.includes('/api/')) apiCalls.push(u); });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(URL);
    await page.waitForSelector('#main-body h1');
    const mainHtmlBefore = await page.evaluate(() => document.getElementById('main-body').innerHTML);
    ok(await page.evaluate(() => !document.getElementById('btn-tsuzuri').hidden), 'tsuzuri対応サーバーなのに入口が出ない');

    // ---- 開くだけではAI・推敲APIを呼ばない ----
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    ok(await page.evaluate(() => document.getElementById('tz-edit').value) === MAIN_MD, 'ノートに写した文が本筋のMarkdownと違う');
    ok(!apiCalls.some((u) => u.includes('revise') || u.includes('ask')), '開いただけでAI系APIを呼んでいる: ' + apiCalls.join(','));
    await page.screenshot({ path: `${OUT}/tz-1-open.png` });

    // ---- 打ち込みはローカルだけ（サーバーにも本筋のDOMにも触れない） ----
    await page.click('#tz-edit');
    await page.keyboard.press('End');
    await page.keyboard.type('（あとで足す）');
    ok(await page.evaluate(() => document.getElementById('main-body').innerHTML) === mainHtmlBefore, '編集で本筋のDOMが変わった');
    ok(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('understand-tsuzuri-'))), '下書きがsessionStorageに無い');

    // ---- 読む（サニタイズ済みプレビュー。図や実行の仕掛けは置かない） ----
    await page.click('#tz-tab-read');
    await page.waitForSelector('#tz-read:not([hidden])');
    ok(await page.evaluate(() => !!document.querySelector('#tz-read h1')), '読む表示にh1が無い');
    ok(await page.evaluate(() => !document.querySelector('#tz-read .diagram-box, #tz-read .chart-box, #tz-read script')), '読む表示に実行要素がある');
    ok(await page.evaluate(() => document.getElementById('btn-tz-revise').disabled), '読む表示でも推敲ボタンが有効');
    await page.screenshot({ path: `${OUT}/tz-2-read.png` });

    // ---- 語の候補（本物のwords.tsv。置き換えはしない） ----
    await page.click('#tz-tab-words');
    await page.waitForSelector('.tz-word', { timeout: 5000 });
    const words = await page.$$eval('.tz-word', (els) => els.map((e) => e.textContent));
    ok(words.some((w) => w.includes('道具') && w.includes('ツール')), '「道具→ツール」の候補が無い: ' + JSON.stringify(words));
    ok(words.some((w) => w.includes('試験') && w.includes('テスト')), '「試験→テスト」の候補が無い: ' + JSON.stringify(words));
    await page.screenshot({ path: `${OUT}/tz-3-words.png` });
    await page.click('.tz-word');
    await page.waitForSelector('#tz-edit:not([hidden])');
    const valAfterWordPick = await page.evaluate(() => document.getElementById('tz-edit').value);
    ok(valAfterWordPick.includes('道具'), '語の候補で原稿が書き換わった');
    ok(await page.evaluate(() => !document.getElementById('btn-tz-revise').disabled), '語を選んだのに推敲ボタンが無効のまま');

    // ---- 推敲（選択範囲だけ送る・提案は採用するまで当たらない） ----
    const before = await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      const at = ta.value.indexOf('読み手は初めての人です');
      ta.setSelectionRange(at, at + '読み手は初めての人です'.length);
      ta.dispatchEvent(new Event('select'));
      return ta.value;
    });
    await page.fill('#tz-comment', '短くして');
    await page.click('#btn-tz-revise');
    await page.waitForSelector('#tz-suggest:not([hidden])', { timeout: 15000 });
    ok((await page.evaluate(() => document.getElementById('tz-suggest-text').textContent)) === '読みやすい提案文。', '提案の表示が違う');
    ok(await page.evaluate(() => document.getElementById('tz-edit').value) === before, '提案が出ただけで原稿が変わった');

    // ---- 新しい依頼を始めたら、前の提案はその場で無効になる ----
    await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      const at = ta.value.indexOf('締めの段落');
      ta.setSelectionRange(at, at + 5);
      ta.dispatchEvent(new Event('select'));
    });
    await page.click('#btn-tz-revise');
    ok(await page.evaluate(() => document.getElementById('tz-suggest').hidden), '新しい依頼中も前の提案が見えている');
    await page.waitForSelector('#tz-suggest:not([hidden])', { timeout: 15000 });
    ok((await page.evaluate(() => document.getElementById('tz-suggest-text').textContent)) === '読みやすい提案文。', '2回目の提案が出ていない');

    // ここで採用 → 「締めの段落」が置き換わる（最初の選択には当たらない）
    await page.click('#btn-tz-adopt');
    const afterAdopt = await page.evaluate(() => document.getElementById('tz-edit').value);
    ok(afterAdopt === before.replace('締めの段落', '読みやすい提案文。'), '採用で範囲が正しく置き換わっていない');
    ok(await page.evaluate(() => document.getElementById('main-body').innerHTML) === mainHtmlBefore, '採用で本筋のDOMが変わった');
    await page.screenshot({ path: `${OUT}/tz-4-adopt.png` });

    // ---- 依頼の途中で閉じたら、その結果は捨てる ----
    await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      const at = ta.value.indexOf('道具');
      ta.setSelectionRange(at, at + 2);
      ta.dispatchEvent(new Event('select'));
    });
    const beforeCloseFlight = await page.evaluate(() => document.getElementById('tz-edit').value);
    await page.click('#btn-tz-revise');
    await page.click('#btn-tz-close'); // 応答を待たずに閉じる
    await page.waitForTimeout(800); // 応答が届くまで待ってから確かめる
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    ok(await page.evaluate(() => document.getElementById('tz-suggest').hidden), '閉じた依頼の提案が残っている');
    ok(await page.evaluate(() => document.getElementById('tz-edit').value) === beforeCloseFlight, '閉じた依頼で原稿が変わった');
    // 依頼中に閉じても、次の依頼は普通に出せる
    ok(await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      ta.setSelectionRange(0, 4);
      ta.dispatchEvent(new Event('select'));
      return !document.getElementById('btn-tz-revise').disabled;
    }), '閉じた依頼が残っていて次の依頼を出せない');

    // ---- 待っているあいだに原稿が変わったら、提案は当てずに止める ----
    await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      const at = ta.value.indexOf('サンプル');
      ta.setSelectionRange(at, at + 4);
      ta.dispatchEvent(new Event('select'));
    });
    await page.click('#btn-tz-revise');
    await page.waitForSelector('#tz-suggest:not([hidden])', { timeout: 15000 });
    await page.evaluate(() => { // 提案を待つあいだに原稿を変えた振る舞い
      const ta = document.getElementById('tz-edit');
      ta.value = '先頭に手を入れた。\n' + ta.value;
      ta.dispatchEvent(new Event('input'));
    });
    await page.click('#btn-tz-adopt');
    await page.waitForSelector('#tz-error:not([hidden])');
    ok((await page.evaluate(() => document.getElementById('tz-edit').value)).startsWith('先頭に手を入れた。'), 'ずれた提案を当てた／編集を失った');
    await page.click('#btn-tz-discard');

    // ---- 失敗時（長すぎる抜粋）はエラー表示だけ、原稿はそのまま ----
    await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      ta.value = 'あ'.repeat(13000);
      ta.dispatchEvent(new Event('input'));
      ta.setSelectionRange(0, 13000);
      ta.dispatchEvent(new Event('select'));
    });
    await page.click('#btn-tz-revise');
    await page.waitForSelector('#tz-error:not([hidden])', { timeout: 15000 });
    ok((await page.evaluate(() => document.getElementById('tz-error').textContent)).includes('12000'), '長さのエラーが出ていない');
    ok((await page.evaluate(() => document.getElementById('tz-edit').value)).length === 13000, '失敗時に原稿を失った');

    // ---- APIの入力検査（画面を通さず直接） ----
    const apiCheck = await page.evaluate(async (token) => {
      const post = (body) => fetch('/api/tsuzuri/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Understand-Token': token },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      return {
        empty: await post({ text: '', comment: '' }),
        blank: await post({ text: '   ', comment: '' }),
        long: await post({ text: 'a'.repeat(12001), comment: '' }),
        longComment: await post({ text: 'これは文です', comment: 'c'.repeat(1001) }),
        good: await post({ text: 'これは文です', comment: '' }),
      };
    }, new URLSearchParams(page.url().split('?')[1]).get('t'));
    ok(apiCheck.empty && apiCheck.empty.ok === false, '空textを通した');
    ok(apiCheck.blank && apiCheck.blank.ok === false, '空白textを通した');
    ok(apiCheck.long && apiCheck.long.ok === false, '12000字超を通した');
    ok(apiCheck.longComment && apiCheck.longComment.ok === false, '1000字超の希望を通した');
    ok(apiCheck.good && apiCheck.good.ok === true && apiCheck.good.text === '読みやすい提案文。', '正常系が通らない: ' + JSON.stringify(apiCheck.good));

    // ---- 下書きの復元と、保存できないタブでの振る舞い ----
    const draftText = '復元できる下書きです。';
    await page.evaluate((t) => {
      const ta = document.getElementById('tz-edit');
      ta.value = t;
      ta.dispatchEvent(new Event('input'));
    }, draftText);
    await page.click('#btn-tz-close');
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    ok(await page.evaluate(() => document.getElementById('tz-edit').value) === draftText, '下書きが復元されなかった');

    // sessionStorage に書けないとき：編集は捨てず、開き直してもページの記憶から戻る
    await page.evaluate(() => { sessionStorage.setItem = () => { throw new Error('quota'); }; });
    const memDraft = '保存できないタブでの編集です。';
    await page.evaluate((t) => {
      const ta = document.getElementById('tz-edit');
      ta.value = t;
      ta.dispatchEvent(new Event('input'));
    }, memDraft);
    await page.click('#btn-tz-close');
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    ok(await page.evaluate(() => document.getElementById('tz-edit').value) === memDraft, '保存に失敗したタブで編集を失った');
    await page.evaluate(() => { delete sessionStorage.setItem; });
    await page.click('#btn-tz-close');

    // 何も編集せずに閉じれば、空の下書きは残らない
    await page.evaluate(() => sessionStorage.clear());
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    await page.click('#btn-tz-close');
    ok(await page.evaluate(() => !Object.keys(sessionStorage).some((k) => k.startsWith('understand-tsuzuri-'))), '編集していないのに下書きができた');

    // 別タブ（別ボード相当）はこの下書きを見ない
    const page2 = await context.newPage();
    await page2.goto(URL);
    await page2.waitForSelector('#main-body h1');
    await page2.click('#btn-tsuzuri');
    await page2.waitForSelector('#tz-dialog[open]');
    ok(await page2.evaluate(() => document.getElementById('tz-edit').value) === MAIN_MD, '別タブに下書きが漏れた');
    await page2.close();

    // ---- Markdownを書き出す ----
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('#btn-tsuzuri').then(() => page.click('#btn-tz-export')),
    ]);
    ok((download.suggestedFilename() || '').endsWith('.md'), '書き出すファイル名が.mdでない: ' + download.suggestedFilename());
    const dlPath = path.join(OUT, 'export.md');
    await download.saveAs(dlPath);
    await page.click('#btn-tz-close');

    // ---- 本筋ファイルは最後まで無改変 ----
    ok(fs.readFileSync(path.join(srv.dir, 'main.md'), 'utf8') === MAIN_MD, 'main.md が書き換わった');

    // ---- 携帯幅でも一通り使える ----
    const mpage = await context.newPage();
    await mpage.setViewportSize({ width: 390, height: 844 });
    await mpage.goto(URL);
    await mpage.waitForSelector('#main-body h1');
    await mpage.click('#btn-tsuzuri');
    await mpage.waitForSelector('#tz-dialog[open]');
    const box = await (await mpage.$('#tz-dialog')).boundingBox();
    ok(box && box.width <= 400 && box.height >= 800, '携帯幅でダイアログが画面に収まっていない: ' + JSON.stringify(box));
    await mpage.click('#tz-tab-words');
    await mpage.waitForSelector('.tz-word', { timeout: 5000 });
    // 語の行が狭い画面でも語を折り返さず、補足は次の行に出る
    const wordLayout = await mpage.evaluate(() => {
      const w = document.querySelector('.tz-word');
      const note = w.querySelector('.tz-word-note');
      return { display: getComputedStyle(w).display, noteTop: note.getBoundingClientRect().top > w.querySelector('.tz-word-from').getBoundingClientRect().top };
    });
    ok(wordLayout.display === 'grid' && wordLayout.noteTop, '携帯幅で語の行が想定の組み方をしていない: ' + JSON.stringify(wordLayout));
    await mpage.screenshot({ path: `${OUT}/tz-5-mobile.png` });
    await mpage.close();

    // ---- 古いサーバー（tsuzuri 能力を返さない）では入口を出さない ----
    const oldPage = await context.newPage();
    await oldPage.route('**/api/init', (route) => route.fulfill({
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ markdown: MAIN_MD, title: '古いサーバー', hasSession: false, project: 'x' }),
    }));
    await oldPage.goto(URL);
    await oldPage.waitForSelector('#main-body h1');
    ok(await oldPage.evaluate(() => document.getElementById('btn-tsuzuri').hidden), '古いAPIでも入口が出ている');
    await oldPage.close();

    // ---- Codex の推敲：親を引き継がない記録に残さない下書き、抜粋と希望だけ ----
    {
      const r = await fetch(`${CODEX_URL.split('?')[0].replace(/\/$/, '')}/api/tsuzuri/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Understand-Token': new URLSearchParams(CODEX_URL.split('?')[1]).get('t') },
        body: JSON.stringify({ text: 'これは道具を使った試験の文章です。', comment: '短く' }),
      }).then((x) => x.json());
      ok(r && r.ok === true, 'Codexの推敲が通らない: ' + JSON.stringify(r));
      const lines = fs.readFileSync(CODEX_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const call = lines.filter((l) => Array.isArray(l.argv) && l.argv.includes('--ephemeral')).pop();
      ok(!!call, 'ephemeral の呼び出しが記録されていない');
      if (call) {
        ok(!call.argv.includes('fork') && !call.argv.includes('resume'), '推敲が fork/resume で呼ばれている');
        ok(!call.argv.includes(PARENT_UUID), '推敲に親の会話IDが渡されている');
        ok(call.stdin.includes('これは道具を使った試験の文章です。'), '抜粋が送られていない');
        ok(call.stdin.includes('"comment":"短く"'), '読み手への希望が送られていない');
        ok(call.stdin.includes('推敲の参考（Tsuzuri「執筆意図の質の確認」）'), 'upstreamの参考資料が同封されていない');
        ok(!call.stdin.includes('締めの段落です'), '抜粋以外の原稿が送られている');
        ok(!call.stdin.includes('サンプルの本筋'), '本筋の他の部分が送られている');
      }
    }

    // ---- メインに返して閉じると、下書きも捨てる ----
    await page.click('#btn-tsuzuri');
    await page.waitForSelector('#tz-dialog[open]');
    await page.evaluate(() => {
      const ta = document.getElementById('tz-edit');
      ta.value = '閉じる前の下書き。';
      ta.dispatchEvent(new Event('input'));
    });
    await page.click('#btn-tz-close');
    await page.click('#btn-finish');
    await page.fill('#ret-text', '確認しました');
    await page.click('#btn-ret-send');
    await page.waitForSelector('#done:not([hidden])', { timeout: 10000 });
    ok(await page.evaluate(() => !Object.keys(sessionStorage).some((k) => k.startsWith('understand-tsuzuri-'))), '閉じたあとに推敲の下書きが残った');

    console.log('errors:', JSON.stringify(errors, null, 1));
    if (!apiCalls.some((u) => u.includes('/api/ask'))) console.log('（確認：推敲の間、付箋APIは一度も呼ばれていません）');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then((code) => {
  process.exit(errors.length ? 1 : 0);
}).catch((e) => { console.error('FAIL', e); process.exit(1); })
  .finally(() => { procs.forEach((p) => { try { p.kill(); } catch (_) {} }); });
