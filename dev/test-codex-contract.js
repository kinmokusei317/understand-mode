#!/usr/bin/env node
// Codex 対応の契約テスト（YOK-30）。約束ごとは docs/codex-port.md を参照。
// 偽 codex（dev/mock-codex.js）を UNDERSTAND_CODEX_BIN に差し込み、
// HTTP の応答・起動されたコマンドの引数・セッション記録の有無だけを判定する。
// 実機でしか確かめられない条件（本物の継承・実効ツール権限・実際の消去）は
// ここでは扱わず、docs/codex-port.md の実機ゲートに残す。
// 使い方: node dev/test-codex-contract.js

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'skill', 'understand', 'app', 'server.js');
const MOCK = path.join(__dirname, 'mock-codex.js');

// テスト用の会話：親 P と無関係な枝 F を先に作り、P にだけ秘密を教えておく
const P = crypto.randomUUID();
const F = crypto.randomUUID();
const P_SECRET = 'P-c03397739078';

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  OK  ' : '  NG  '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
}

// ---------- 偽 codex の環境 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-codex-test-'));
const CODEX_HOME = path.join(TMP, 'codex-home');
const FAKE_HOME = path.join(TMP, 'home');
const STORE = path.join(TMP, 'store.json');
const LOG = path.join(TMP, 'codex-log.jsonl');
fs.mkdirSync(FAKE_HOME, { recursive: true });

function rolloutPath(id) {
  const dir = path.join(CODEX_HOME, 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
}
function seed() {
  fs.writeFileSync(rolloutPath(P), JSON.stringify({ type: 'seed' }) + '\n');
  fs.writeFileSync(rolloutPath(F), JSON.stringify({ type: 'seed' }) + '\n');
  fs.writeFileSync(STORE, JSON.stringify({ threads: {
    [P]: { facts: { P_SECRET }, turns: 1 },
    [F]: { facts: { F_FACT: 'foreign' }, turns: 1 },
  } }));
}

function readLog() {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse); } catch (_) { return []; }
}

// codex exec の引数から「subcommand・session・prompt」の並びだけを取り出す（偽 codex と同じ解釈）
const VALUE_FLAGS = new Set([
  '-s', '--sandbox', '-m', '--model', '-c', '--config', '-C', '--cd', '-o',
  '--output-last-message', '--output-schema', '--color', '--remote',
  '--remote-auth-token-env', '-p', '--profile', '--local-provider', '-i', '--image',
  '--enable', '--disable', '--add-dir', '--thread-source', '--cyber-access-program',
]);
function positional(argv) {
  const rest = argv[0] === 'exec' ? argv.slice(1) : argv;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}
const FORBIDDEN = /^(--full-auto|--approve-for-me|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--last|--all)$/;
function permissionNotes(argv) {
  const bad = [];
  if (argv.some((a) => FORBIDDEN.test(a))) bad.push('拡大・推測系のフラグ: ' + argv.filter((a) => FORBIDDEN.test(a)).join(','));
  const readonly = argv.includes('read-only') || argv.some((a) => /sandbox/.test(a) && /read-only/.test(a));
  if (!readonly) bad.push('read-only 相当の指定がない');
  return bad;
}

function startServer({ session = P, timeoutSec = '10' } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'work-'));
  fs.writeFileSync(path.join(dir, 'main.md'), '# テスト\n');
  fs.writeFileSync(path.join(dir, 'title.txt'), 'テスト\n');
  const args = [SERVER, '--dir', dir, '--agent', 'codex', '--cwd', ROOT, '--port', '0', '--no-open'];
  if (session) args.push('--session', session);
  const child = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      HOME: FAKE_HOME,
      CODEX_HOME,
      UNDERSTAND_AGENT: 'codex',
      UNDERSTAND_CODEX_BIN: MOCK,
      UNDERSTAND_CLAUDE_BIN: MOCK, // 旧経路が何か呼んだかも記録したい
      MOCK_CODEX_STORE: STORE,
      MOCK_CODEX_LOG: LOG,
      UNDERSTAND_TIMEOUT_SEC: timeoutSec,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバーが起動しませんでした')), 8000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
      if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, token: m[2], dir, stop: () => child.kill() }); }
    });
    child.on('error', reject);
  });
}

const post = (s, route, body) =>
  fetch(s.base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Understand-Token': s.token },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((j) => Object.assign({ status: r.status }, j)));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 偽 codex を直接動かして、記録器が正しいことを先に確かめる（陽性対照）
function mockDirect(argv2, input) {
  return spawnSync(process.execPath, [MOCK].concat(argv2), {
    input: input || '', env: Object.assign({}, process.env, { CODEX_HOME, MOCK_CODEX_STORE: STORE }),
    encoding: 'utf8', timeout: 10000,
  });
}

(async () => {
  console.log('\n0. 陽性対照：偽 codex が fork/resume と記憶の分離を再現できていること');
  {
    seed();
    let r = mockDirect(['exec', '--json', 'fork', P, '-'], 'ask:P_SECRET');
    ok('fork で親の秘密を引き継ぐ', r.status === 0 && r.stdout.includes(`P_SECRET=${P_SECRET}`), r.stdout + r.stderr);
    const child = (r.stdout.match(/"thread_id":"([0-9a-f-]{36})"/) || [])[1];
    r = mockDirect(['exec', '--json', 'resume', child || 'x', '-'], 'ask:P_SECRET');
    ok('resume は同じIDで続く', r.status === 0 && r.stdout.includes(`"thread_id":"${child}"`), r.stdout.slice(0, 200));
    r = mockDirect(['exec', '--json', 'resume', P, '-'], 'ask:X');
    ok('親は resume できる', r.status === 0);
    // 後片付け検証のために作った子を消しておく
    for (const f of fs.readdirSync(path.dirname(rolloutPath(P)))) {
      if (child && f.endsWith(`-${child}.jsonl`)) fs.rmSync(path.join(path.dirname(rolloutPath(P)), f));
    }
  }

  console.log('\n1. Codex 向けの SKILL.md がある（CODEX_THREAD_ID を明示的に使う）');
  {
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'vendor' && e.name !== '.git') walk(p);
        else if (e.isFile() && e.name === 'SKILL.md') found.push(p);
      }
    })(path.join(ROOT, 'skill'));
    const codexSkill = found.find((f) => {
      const t = fs.readFileSync(f, 'utf8');
      return /codex/i.test(t) && /CODEX_THREAD_ID/.test(t);
    });
    ok('CODEX_THREAD_ID を明示して親を渡す SKILL.md がある', !!codexSkill, found.join(', ') || 'SKILL.md が見つからない');
    if (codexSkill) {
      const t = fs.readFileSync(codexSkill, 'utf8');
      ok('「最新の会話を推測」に頼る手順を書いていない', !/resume\s+--last|--last\s*で|最新のスレッドを選ぶ/.test(t));
    }
  }

  const s = await startServer();
  const parentRollout = fs.readFileSync(rolloutPath(P), 'utf8');
  let C, D, E;

  console.log('\n2. 付箋の初回は親から fork で分岐し、親の文脈を引き継ぐ');
  {
    const before = readLog().length;
    const r = await post(s, '/api/ask', { action: 'question', anchor: '本筋の一部', question: 'ask:P_SECRET', sessionId: P });
    ok('質問が通る', r.ok === true, r.error);
    ok('親だけの秘密を答えられる（文脈の継承）', (r.text || '').includes(`P_SECRET=${P_SECRET}`), r.text);
    C = r.sessionId;
    ok('新しい子のIDが返る（親ではない）', !!C && C !== P, `sessionId=${C}`);
    const d = readLog().slice(before).pop() || { argv: [] };
    const pos = positional(d.argv);
    ok('codex exec fork <親> を呼んでいる', pos[0] === 'fork' && pos[1] === P, d.argv.join(' '));
    ok('JSONL で起動している（--json）', d.argv.includes('--json'), d.argv.join(' '));
    ok('権限を広げていない', permissionNotes(d.argv).length === 0, permissionNotes(d.argv).join(' / '));
  }

  console.log('\n3. 同じ付箋の続きは、その付箋の子に resume で積む');
  {
    const before = readLog().length;
    const r = await post(s, '/api/ask', { followUp: 'fact:BRANCH=b-0f3d2a ask:BRANCH', sessionId: C, continueSession: true });
    ok('続きの質問が通る', r.ok === true, r.error);
    ok('同じ子のIDのまま', !!C && r.sessionId === C, `sessionId=${r.sessionId}`);
    ok('この枝で覚えたことを答えられる', (r.text || '').includes('BRANCH=b-0f3d2a'), r.text);
    const d = readLog().slice(before).pop() || { argv: [] };
    const pos = positional(d.argv);
    ok('codex exec resume <この付箋の子> を呼んでいる', pos[0] === 'resume' && pos[1] === C, d.argv.join(' '));
  }

  console.log('\n4. 子付箋は付箋の子から分岐し、兄弟と親を汚さない');
  {
    let before = readLog().length;
    let r = await post(s, '/api/ask', { action: 'question', anchor: '付箋の一部', question: 'ask:BRANCH ask:P_SECRET', sessionId: C });
    ok('子付箋が通る', r.ok === true, r.error);
    D = r.sessionId;
    ok('付箋の子とは別のIDが返る', !!D && D !== C && D !== P, `sessionId=${D}`);
    ok('付箋の文脈も親の文脈も引き継ぐ', (r.text || '').includes('BRANCH=b-0f3d2a') && (r.text || '').includes(`P_SECRET=${P_SECRET}`), r.text);
    let d = readLog().slice(before).pop() || { argv: [] };
    ok('fork 元は付箋の子（親ではない）', positional(d.argv)[0] === 'fork' && positional(d.argv)[1] === C, d.argv.join(' '));

    before = readLog().length;
    r = await post(s, '/api/ask', { action: 'question', anchor: '本筋の別の部分', question: 'ask:BRANCH ask:P_SECRET', sessionId: P });
    E = r.sessionId;
    ok('兄弟の付箋が通る', r.ok === true && !!E && E !== P && E !== C && E !== D, `sessionId=${E}`);
    ok('兄弟に別枝の記憶は漏れない', (r.text || '').includes('BRANCH=UNKNOWN'), r.text);
    ok('兄弟は親の文脈を持つ', (r.text || '').includes(`P_SECRET=${P_SECRET}`), r.text);
    d = readLog().slice(before).pop() || { argv: [] };
    ok('兄弟は親から fork する', positional(d.argv)[0] === 'fork' && positional(d.argv)[1] === P, d.argv.join(' '));

    ok('親の会話履歴はここまで一切変わっていない', fs.readFileSync(rolloutPath(P), 'utf8') === parentRollout);
  }

  console.log('\n5. 失敗・中断・ID不整合・非対応を、成功にせず親も他枝も変えない');
  {
    const cases = [
      ['終了コードが非0', 'behave:exit1'],
      ['壊れたJSONL', 'behave:garbage'],
      ['途中で切れたJSONL', 'behave:truncated'],
      ['turn の失敗イベント', 'behave:turnfail'],
    ];
    for (const [name, trick] of cases) {
      const r = await post(s, '/api/ask', { followUp: trick, sessionId: C, continueSession: true });
      ok(`${name} → ok:false`, r.ok === false, JSON.stringify(r));
    }
    const r = await post(s, '/api/ask', { followUp: 'behave:wrongid ask:P_SECRET', sessionId: C, continueSession: true });
    ok('resume で別IDが返った → ok:false（ID不整合）', r.ok === false, JSON.stringify(r));
    const r2 = await post(s, '/api/ask', { action: 'question', anchor: 'x', question: 'behave:nofork ask:P_SECRET', sessionId: P });
    ok('fork 非対応のCodex → ok:false（互換と称して親を汚さない）', r2.ok === false, JSON.stringify(r2));
    const r3 = await post(s, '/api/ask', { action: 'question', anchor: 'x', question: 'ask:P_SECRET', sessionId: P });
    ok('失敗のあとも普通の質問は通る', r3.ok === true, r3.error);
    ok('親の会話履歴はそれでも変わっていない', fs.readFileSync(rolloutPath(P), 'utf8') === parentRollout);
  }

  console.log('\n6. どの呼び出しも、権限を拡大せず「一番新しい会話」を推測しない');
  {
    const entries = readLog();
    const bad = [];
    for (const e of entries) {
      const notes = permissionNotes(e.argv);
      if (notes.length) bad.push(`${e.argv.join(' ')} → ${notes.join(' / ')}`);
    }
    ok('全呼出しで read-only 相当・拡大フラグなし・--last なし', bad.length === 0, bad.join('\n'));
  }

  console.log('\n7. Codex では /api/runsql を直呼びしても実行しない');
  {
    const before = readLog().length;
    const r1 = await post(s, '/api/runsql', { sessionId: C, sql: 'select 1' });
    ok('正しいSELECTでも ok:false', r1.ok === false, JSON.stringify(r1));
    const r2 = await post(s, '/api/runsql', { sessionId: C, sql: 'delete from orders' });
    ok('書き込みSQLも ok:false', r2.ok === false, JSON.stringify(r2));
    ok('拒否はエージェントを一度も呼ばずに行う', readLog().length === before, `${before} → ${readLog().length}`);
  }

  console.log('\n8. /api/draft は親の履歴を引き継がない新規実行');
  {
    const before = readLog().length;
    const r = await post(s, '/api/draft', { notes: '影響ありのメモ' });
    ok('下書きが返る', r.ok === true && !!(r.text || '').length, JSON.stringify(r));
    const d = readLog().slice(before).pop() || { argv: [] };
    const pos = positional(d.argv);
    ok('fork/resume を呼んでいない', pos[0] !== 'fork' && pos[0] !== 'resume', d.argv.join(' '));
    ok('親や付箋のIDを渡していない', ![P, C, D, E, F].filter(Boolean).some((id) => d.argv.includes(id)), d.argv.join(' '));
    ok('下書きでも権限を広げていない', permissionNotes(d.argv).length === 0, permissionNotes(d.argv).join(' / '));
  }

  console.log('\n9. タイムアウトは成功にしない');
  {
    const s2 = await startServer({ timeoutSec: '2' });
    const t0 = Date.now();
    const r = await post(s2, '/api/ask', { action: 'question', anchor: 'x', question: 'behave:hang', sessionId: P });
    ok('応答しない呼出し → ok:false', r.ok === false, JSON.stringify(r));
    ok('待ちすぎずに返る（20秒以内）', Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
    s2.stop();
  }

  console.log('\n10. 親のIDが明示されなければ推測しない');
  {
    const s3 = await startServer({ session: null });
    const before = readLog().length;
    const r = await post(s3, '/api/ask', { action: 'question', anchor: 'x', question: 'ask:P_SECRET' });
    ok('親IDなしの質問 → ok:false', r.ok === false, JSON.stringify(r));
    const calls = readLog().slice(before);
    ok('--last や最新探索を呼んでいない', calls.every((e) => !e.argv.includes('--last')), calls.map((e) => e.argv.join(' ')).join('\n') || '(呼出しなし)');
    s3.stop();
  }

  console.log('\n11. 「選んだ文だけ」が return.md に戻り、所有する子だけが消える');
  {
    const children = [C, D, E].filter(Boolean);
    const r = await post(s, '/api/return', { text: 'イベントだけでは説明できない、と伝えたい' });
    ok('return が通る', r.ok === true, JSON.stringify(r));
    const ret = fs.readFileSync(path.join(s.dir, 'return.md'), 'utf8');
    ok('return.md は選んだ文そのまま', ret === 'イベントだけでは説明できない、と伝えたい\n', JSON.stringify(ret));
    await wait(1200); // サーバーの後片付けと終了を待つ
    ok('親の記録は残る', fs.existsSync(rolloutPath(P)));
    ok('無関係な枝の記録は残る', fs.existsSync(rolloutPath(F)));
    for (const id of children) {
      ok(`作った子 ${id.slice(0, 8)}… の記録は消える`, !findFile(CODEX_HOME, `-${id}.jsonl`));
    }
    // 消えた子は resume できず、残った親と無関係な枝は resume できる（実機ゲートDの契約側）
    for (const id of children) {
      const rr = mockDirect(['exec', '--json', 'resume', id, '-'], 'ask:X');
      ok(`消えた子は resume できない (${id.slice(0, 8)}…)`, rr.status !== 0, rr.stdout.slice(0, 120));
    }
    ok('親はいまも resume できる', mockDirect(['exec', '--json', 'resume', P, '-'], 'ask:X').status === 0);
    ok('無関係な枝も resume できる', mockDirect(['exec', '--json', 'resume', F, '-'], 'ask:X').status === 0);
    s.stop();
  }

  console.log(failed ? `\n${failed}件 失敗しました\n` : '\nすべて通りました\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function findFile(base, suffix) {
  let hit = null;
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(suffix)) hit = p;
    }
  })(base);
  return hit;
}
