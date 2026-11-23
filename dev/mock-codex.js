#!/usr/bin/env node
// テスト用の偽 codex コマンド。server.js が Codex を呼ぶときの実験台（UNDERSTAND_CODEX_BIN に指定する）。
// `codex exec --json` のイベント形式（thread.started / item.completed / turn.completed）を真似る。
//
// 会話の記憶：
//   - MOCK_CODEX_STORE（JSON）に thread_id → {facts, turns} を保持する。
//   - fork は親の facts を写した新しい thread_id を作る。resume は同じ ID のまま続ける。
//   - スレッドの実在は $CODEX_HOME/sessions/**/rollout-*-<id>.jsonl の有無で判定する
//     （実物と同じく、記録ファイルが消えれば resume できない）。
//   - --ephemeral 付きの呼び出しは、返事だけして記録を残さない。
//
// プロンプトの決まり文（テストが質問文に仕込む）：
//   - `fact:K=V` … このスレッドにだけ K=V を覚える
//   - `ask:K`   … 覚えていれば K=V、知らなければ K=UNKNOWN と答える
//   - `behave:X` … 失敗の仕込み（下記）。環境変数 MOCK_CODEX_BEHAVE でも可
//
// behave の種類：exit1 / garbage / truncated / turnfail / wrongid / nofork / hang
//
// 呼び出しの記録：MOCK_CODEX_LOG に1行JSONで argv・stdin・cwd を追記する（陽性対照つき）。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const STORE = process.env.MOCK_CODEX_STORE || path.join(os.tmpdir(), 'mock-codex-store.json');
const LOG = process.env.MOCK_CODEX_LOG || '';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// 値を取るオプション（次のトークンを値として読み飛ばす）
const VALUE_FLAGS = new Set([
  '-s', '--sandbox', '-m', '--model', '-c', '--config', '-C', '--cd', '-o',
  '--output-last-message', '--output-schema', '--color', '--remote',
  '--remote-auth-token-env', '-p', '--profile', '--local-provider', '-i', '--image',
  '--enable', '--disable', '--add-dir', '--thread-source', '--cyber-access-program',
]);

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', () => resolve(d));
  });
}

function parse() {
  // `codex exec [opts] [fork <ID>|resume <ID>] [PROMPT|-]` と、
  // exec 以外で呼ばれた場合（Claude 形式の argv など）をひとまとめに解く
  const hasExec = argv[0] === 'exec';
  const rest = hasExec ? argv.slice(1) : argv;
  let sub = null, session = null, prompt = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    positional.push(a);
  }
  if (hasExec && (positional[0] === 'fork' || positional[0] === 'resume')) {
    sub = positional[0];
    session = positional[1] || null;
    prompt = positional[2] || null;
  } else {
    prompt = positional[0] || null;
  }
  return { hasExec, sub, session, prompt };
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { return { threads: {} }; }
}
function saveStore(s) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STORE);
}

// 実在判定は記録ファイル（rollout）の有無。実物のファイル名規則は契約にしないので suffix だけ見る
function findRollout(id) {
  const base = path.join(CODEX_HOME, 'sessions');
  const hits = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`-${id}.jsonl`) || e.name === `${id}.jsonl`) hits.push(p);
    }
  })(base);
  return hits[0] || null;
}
function writeRollout(id, line) {
  const existing = findRollout(id);
  if (existing) {
    fs.appendFileSync(existing, JSON.stringify(line) + '\n');
    return existing;
  }
  const now = new Date();
  const dir = path.join(CODEX_HOME, 'sessions',
    String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  return file;
}

function emit(events) {
  for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
}
function result(id, text) {
  emit([
    { type: 'thread.started', thread_id: id },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } },
  ]);
}
function die(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code == null ? 1 : code);
}

(async () => {
  if (argv.includes('--version')) {
    console.log('codex-cli 0.171.0');
    return;
  }
  if (argv.includes('mcp') && argv.includes('list')) {
    if (loadStore().mcpWarning) process.stderr.write('MCP authentication failed (test fixture)\n');
    console.log('[]');
    return;
  }
  const { sub, session, prompt } = parse();
  const input = prompt === '-' ? await readStdin() : (prompt || '');

  if (LOG) {
    try { fs.appendFileSync(LOG, JSON.stringify({ argv, stdin: input, cwd: process.cwd(), home: CODEX_HOME }) + '\n'); } catch (_) {}
  }

  const behave = (input.match(/behave:(\w+)/) || [])[1] || process.env.MOCK_CODEX_BEHAVE || '';
  if (behave === 'exit1') { result(session, 'partial'); die('mock-codex: 失敗の仕込み（exit1）'); }
  if (behave === 'garbage') { process.stdout.write('this is not jsonl\n'); result(session, 'partial'); return; }
  if (behave === 'truncated') {
    emit([{ type: 'thread.started', thread_id: session }, { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }]);
    return;
  }
  if (behave === 'turnfail') {
    // Other than the failure event this looks like a successful exec (even exits zero).
    emit([{ type: 'thread.started', thread_id: session }, { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
      { type: 'turn.failed', error: { message: 'boom' } }, { type: 'turn.completed' }]);
    return;
  }
  if (behave === 'nofork' && sub === 'fork') die("error: unrecognized subcommand 'fork'", 2);
  if (behave === 'parentid' && sub === 'fork') { result(session, 'invalid fork'); return; }
  if (behave === 'collision' && sub === 'fork') {
    result(input.match(/report:([0-9a-f-]{36})/)[1], 'invalid fork');
    return;
  }
  if (behave === 'hang') { setTimeout(() => {}, 60 * 1000); return; }

  const ephemeral = argv.includes('--ephemeral');
  const store = loadStore();

  let id, facts;
  if (sub === 'fork') {
    if (!session || !findRollout(session)) die(`mock-codex: fork 元が見つかりません: ${session}`);
    id = crypto.randomUUID();
    const parent = store.threads[session] || { facts: {} };
    facts = Object.assign({}, parent.facts);
  } else if (sub === 'resume') {
    if (!session || !findRollout(session)) die(`mock-codex: resume 先が見つかりません: ${session}`);
    id = behave === 'wrongid' ? crypto.randomUUID() : session;
    facts = Object.assign({}, (store.threads[session] || {}).facts);
  } else {
    id = crypto.randomUUID();
    facts = {};
  }

  // 質問文からの学習と回答
  for (const m of input.matchAll(/fact:([\w-]+)=([\w-]+)/g)) facts[m[1]] = m[2];
  const answers = [];
  for (const m of input.matchAll(/ask:([\w-]+)/g)) {
    const k = m[1];
    answers.push(`${k}=${facts[k] !== undefined ? facts[k] : 'UNKNOWN'}`);
  }
  const text = answers.length ? answers.join(' ') : 'ok';

  if (!ephemeral) {
    writeRollout(id, { type: 'turn', prompt_chars: input.length });
    store.threads[id] = { facts, turns: ((store.threads[id] || {}).turns || 0) + 1 };
    saveStore(store);
  }
  result(id, text);
  process.exit(0);
})().catch((e) => die('mock-codex: ' + e.message));
