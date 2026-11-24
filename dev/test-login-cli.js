'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'skill', 'understand', 'app', 'server.js');
const MOCK_CODEX = path.join(__dirname, 'mock-codex.js');
const MOCK_CLAUDE = path.join(__dirname, 'mock-claude.js');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  OK  ' : '  NG  '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-login-cli-'));
const FAKE_HOME = path.join(TMP, 'home');
const CODEX_HOME = path.join(FAKE_HOME, '.codex');
const CLAUDE_DIR = path.join(FAKE_HOME, '.claude');
const CODEX_LOG = path.join(TMP, 'codex-log.jsonl');
const CLAUDE_LOG = path.join(TMP, 'claude-log.jsonl');
const STORE = path.join(TMP, 'store.json');
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(CODEX_HOME, { recursive: true });
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.writeFileSync(path.join(CODEX_HOME, 'auth.json'), '{"mock":true}', { mode: 0o600 });
fs.writeFileSync(path.join(CLAUDE_DIR, '.credentials.json'), '{"mock":true}', { mode: 0o600 });

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); } catch (_) { return []; }
}

function startServer({ agent = 'claude', session = null, codexHome = CODEX_HOME, home = FAKE_HOME, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'dir-'));
  fs.writeFileSync(path.join(dir, 'main.md'), '# 本筋\nテスト本文\n');
  const args = [SERVER, '--dir', dir, '--agent', agent, '--cwd', ROOT, '--port', '0', '--no-open'];
  if (session) args.push('--session', session);
  const child = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      HOME: home,
      CODEX_HOME: codexHome,
      UNDERSTAND_CODEX_BIN: MOCK_CODEX,
      UNDERSTAND_CLAUDE_BIN: MOCK_CLAUDE,
      MOCK_CODEX_STORE: STORE,
      MOCK_CODEX_LOG: CODEX_LOG,
      MOCK_CLAUDE_LOG: CLAUDE_LOG,
      UNDERSTAND_MOCK_DELAY: '1',
      CODEX_API_KEY: 'leak-check-key',
      ANTHROPIC_API_KEY: 'leak-check-key',
      ANTHROPIC_BASE_URL: 'https://leak-check.invalid',
      OPENAI_API_KEY: 'leak-check-key',
    }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('url.txt が出ませんでした')), 15000);
    const iv = setInterval(() => {
      const f = path.join(dir, 'url.txt');
      if (fs.existsSync(f)) {
        clearInterval(iv); clearTimeout(deadline);
        const m = fs.readFileSync(f, 'utf8').match(/(http:\/\/127\.0\.0\.1:(\d+)\/\?t=([\w-]+))/);
        resolve({ child, dir, base: `http://127.0.0.1:${m[2]}`, token: m[3] });
      }
    }, 50);
  });
}

function req(srv, method, name, body, token = srv.token) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${srv.base}${name}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-understand-token': token },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

const post = (srv, name, body, token) => req(srv, 'POST', name, body, token);
const get = (srv, name, token) => req(srv, 'GET', name, undefined, token);
const stop = (srv) => new Promise((res) => { srv.child.once('exit', res); srv.child.kill('SIGKILL'); });
const SECRET = 'SECRET-DO-NOT-LEAK-9f2e';

(async () => {
  let srv = await startServer();
  try {
    let r = await get(srv, '/api/providers');
    ok('providers: 両プロバイダとモデル一覧', r.json && r.json.ok === true &&
      JSON.stringify(r.json.providers) === JSON.stringify([
        { id: 'codex', models: ['gpt-6.2-terra', 'gpt-6.2-astra'] },
        { id: 'claude', models: ['haiku', 'sonnet', 'opus'] },
      ]), JSON.stringify(r.json));
    ok('providers: アカウント情報を含まない', !/email|orgId|account|subscription|@/.test(JSON.stringify(r.json)), JSON.stringify(r.json));

    r = await get(srv, '/api/providers', null);
    ok('providers: トークンなしは拒否', r.status === 403);

    r = await get(srv, '/api/init');
    ok('init: loginPicker 能力フラグ', r.json.loginPicker === true);

    r = await post(srv, '/api/cli-question', { provider: 'claude', model: 'sonnet', question: '質問です', anchor: SECRET });
    ok('cli-question: Claude が回答', r.json && r.json.ok === true && typeof r.json.text === 'string', JSON.stringify(r.json));
    ok('cli-question: sessionId を返さない', !('sessionId' in (r.json || {})), JSON.stringify(r.json));

    const clog = readLog(CLAUDE_LOG);
    const cq = clog.find((e) => e.argv.includes('-p'));
    ok('claude: プロンプトは stdin リテラル', cq && cq.stdin === `引用:\n${SECRET}\n\n質問:\n質問です`, cq && cq.stdin);
    ok('claude: 必須フラグ', cq && ['--safe-mode', '--setting-sources', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config'].every((f) => cq.argv.includes(f)) &&
      cq.argv[cq.argv.indexOf('--setting-sources') + 1] === '' &&
      cq.argv.includes('--tools') && cq.argv[cq.argv.indexOf('--tools') + 1] === '' &&
      cq.argv.includes('--mcp-config') && cq.argv[cq.argv.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}' &&
      cq.argv.includes('--model') && cq.argv[cq.argv.indexOf('--model') + 1] === 'sonnet' &&
      cq.argv.includes('--system-prompt') && cq.argv[cq.argv.indexOf('--system-prompt') + 1] === 'Answer the user directly.', cq && cq.argv.join(' '));
    ok('claude: 秘密環境変数を渡さない', cq && cq.sensitive.length === 0, cq && cq.sensitive.join(','));
    const cauth = clog.find((e) => e.argv.includes('auth') && e.argv.includes('status'));
    ok('claude: 状態確認に --safe-mode --setting-sources', cauth && cauth.argv.includes('--safe-mode') &&
      cauth.argv.includes('--setting-sources') && cauth.argv.includes('--json'), cauth && cauth.argv.join(' '));

    r = await post(srv, '/api/cli-question', { provider: 'codex', model: 'gpt-6.2-astra', question: 'そのままの質問', anchor: '' });
    ok('cli-question: Codex が回答', r.json && r.json.ok === true && typeof r.json.text === 'string', JSON.stringify(r.json));

    const klog = readLog(CODEX_LOG);
    const kq = klog.find((e) => e.argv.includes('exec'));
    ok('codex: anchor 空なら質問はそのまま', kq && kq.stdin === 'そのままの質問', kq && kq.stdin);
    ok('codex: ephemeral・モデル指定', kq && kq.argv.includes('--ephemeral') && kq.argv.includes('-m') &&
      kq.argv[kq.argv.indexOf('-m') + 1] === 'gpt-6.2-astra' && kq.argv.includes('--json'), kq && kq.argv.join(' '));
    ok('codex: read-only・承認なし・記録を残さない', kq && kq.argv.includes('--sandbox') &&
      kq.argv[kq.argv.indexOf('--sandbox') + 1] === 'read-only' && kq.argv.includes('approval_policy="never"') &&
      !kq.argv.includes('--last') && !kq.argv.includes('fork') && !kq.argv.includes('resume'), kq && kq.argv.join(' '));
    ok('codex: 認証ファイルはリンクで渡る', kq && kq.hasAuth === true);
    ok('codex: 秘密環境変数を渡さない', kq && kq.sensitive.length === 0, kq && kq.sensitive.join(','));
    ok('codex: login status 確認を先に呼ぶ', klog.findIndex((e) => e.argv[0] === 'login' && e.argv[1] === 'status') > -1 &&
      klog.findIndex((e) => e.argv[0] === 'login') < klog.findIndex((e) => e.argv.includes('exec')));

    r = await post(srv, '/api/cli-question', { provider: 'codex', model: 'gpt-6.2-terra', question: 'Q', anchor: 'A' });
    const kq2 = readLog(CODEX_LOG).filter((e) => e.argv.includes('exec')).at(-1);
    ok('codex: 引用形式', kq2 && kq2.stdin === '引用:\nA\n\n質問:\nQ', kq2 && kq2.stdin);

    for (const [name, body] of [
      ['未知のプロバイダ', { provider: 'gemini', model: 'x', question: 'q' }],
      ['未知のモデル', { provider: 'claude', model: 'gpt-5', question: 'q' }],
      ['空の質問', { provider: 'claude', model: 'haiku', question: '  ' }],
      ['長すぎる質問', { provider: 'claude', model: 'haiku', question: 'x'.repeat(12001) }],
      ['長すぎる引用', { provider: 'claude', model: 'haiku', question: 'q', anchor: 'x'.repeat(12001) }],
      ['プロトタイプ汚染のプロバイダ', { provider: 'toString', model: 'x', question: 'q' }],
    ]) {
      const n0 = readLog(CLAUDE_LOG).length + readLog(CODEX_LOG).length;
      r = await post(srv, '/api/cli-question', body);
      const n1 = readLog(CLAUDE_LOG).length + readLog(CODEX_LOG).length;
      ok(`cli-question: ${name} は断り CLI を呼ばない`, r.json && r.json.ok === false && n1 === n0, JSON.stringify(r.json));
    }
    ok('エラーに秘密・生出力を含まない', !JSON.stringify(r.json).includes(SECRET) && !/mock-codex|\.claude|auth\.json/.test(JSON.stringify(r.json)), JSON.stringify(r.json));

    r = await post(srv, '/api/return', { text: '' });
    ok('return で終了', r.json && r.json.ok === true);
  } finally {
    await stop(srv);
  }

  const emptyCodexHome = path.join(TMP, 'codex-none');
  fs.mkdirSync(emptyCodexHome, { recursive: true });
  fs.writeFileSync(CODEX_LOG, '');
  srv = await startServer({ codexHome: emptyCodexHome });
  try {
    let r = await get(srv, '/api/providers');
    ok('providers: codex 未ログインなら claude だけ', r.json && r.json.ok === true &&
      r.json.providers.length === 1 && r.json.providers[0].id === 'claude', JSON.stringify(r.json));
    r = await post(srv, '/api/cli-question', { provider: 'codex', model: 'gpt-6.2-terra', question: 'q' });
    ok('cli-question: 未ログイン codex は失敗', r.json && r.json.ok === false && /codex/.test(r.json.error), JSON.stringify(r.json));
    ok('codex: 未ログインなら exec を呼ばない', !readLog(CODEX_LOG).some((e) => e.argv.includes('exec')));
  } finally {
    await stop(srv);
  }

  srv = await startServer({ codexHome: emptyCodexHome, extraEnv: { MOCK_CODEX_KEYRING: '1' } });
  try {
    const r = await get(srv, '/api/providers');
    ok('providers: keyring だけの codex は出さない', r.json && r.json.ok === true &&
      r.json.providers.every((p) => p.id !== 'codex'), JSON.stringify(r.json));
  } finally {
    await stop(srv);
  }

  const weakCodexHome = path.join(TMP, 'codex-weak');
  fs.mkdirSync(weakCodexHome, { recursive: true });
  fs.writeFileSync(path.join(weakCodexHome, 'auth.json'), '{}', { mode: 0o644 });
  srv = await startServer({ codexHome: weakCodexHome });
  try {
    const r = await get(srv, '/api/providers');
    ok('providers: 権限の緩い auth.json は使わない', r.json && r.json.ok === true &&
      r.json.providers.every((p) => p.id !== 'codex'), JSON.stringify(r.json));
  } finally {
    await stop(srv);
  }

  const home2 = path.join(TMP, 'home2');
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  srv = await startServer({ home: home2, codexHome: emptyCodexHome, session: 'mock-session', extraEnv: { MOCK_CLAUDE_LOGGED_OUT: '1' } });
  try {
    const r = await get(srv, '/api/providers');
    ok('providers: どちらも未ログインなら空', r.json && r.json.ok === true && r.json.providers.length === 0, JSON.stringify(r.json));
    const r2 = await post(srv, '/api/cli-question', { provider: 'claude', model: 'opus', question: 'q' });
    ok('cli-question: 未ログイン claude は失敗', r2.json && r2.json.ok === false, JSON.stringify(r2.json));
    const n0 = readLog(CLAUDE_LOG).filter((e) => e.argv.includes('-p')).length;
    const r3 = await post(srv, '/api/ask', { action: 'question', anchor: 'a', question: 'SECRET' });
    const n1 = readLog(CLAUDE_LOG).filter((e) => e.argv.includes('-p')).length;
    ok('inherited: 未ログインなら ask は失敗し、プロンプトを一度も送らない',
      r3.json && r3.json.ok === false && n1 === n0, JSON.stringify(r3.json));
  } finally {
    await stop(srv);
  }

  srv = await startServer({ session: 'mock-session' });
  try {
    const r = await post(srv, '/api/ask', { action: 'question', anchor: '本文', question: 'q' });
    ok('inherited: ログイン済みなら従来の ask が通る', r.json && r.json.ok === true, JSON.stringify(r.json));
    const probe = readLog(CLAUDE_LOG).find((e) => e.argv.includes('auth'));
    const call = readLog(CLAUDE_LOG).find((e) => e.argv.includes('-p'));
    ok('inherited: auth status のあとで -p を呼ぶ', probe && call && probe.sensitive.length === 0 && call.sensitive.length === 0,
      probe && probe.sensitive.join(',') + '|' + (call && call.sensitive.join(',')));
  } finally {
    await stop(srv);
  }

  const cfgDir = path.join(TMP, 'claude-cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, '.credentials.json'), '{"mock":true}', { mode: 0o600 });
  const home3 = path.join(TMP, 'home3');
  fs.mkdirSync(home3, { recursive: true });
  fs.writeFileSync(CLAUDE_LOG, '');
  srv = await startServer({ home: home3, codexHome: emptyCodexHome, extraEnv: { CLAUDE_CONFIG_DIR: cfgDir } });
  try {
    const r = await get(srv, '/api/providers');
    ok('providers: CLAUDE_CONFIG_DIR から claude を見つける', r.json && r.json.ok === true &&
      r.json.providers.some((p) => p.id === 'claude'), JSON.stringify(r.json));
    const r2 = await post(srv, '/api/cli-question', { provider: 'claude', model: 'haiku', question: 'q' });
    ok('cli-question: CLAUDE_CONFIG_DIR 経由でも回答', r2.json && r2.json.ok === true, JSON.stringify(r2.json));
    const cq = readLog(CLAUDE_LOG).find((e) => e.argv.includes('-p'));
    ok('claude: CLAUDE_CONFIG_DIR 以外の秘密環境変数は渡さない', cq &&
      cq.sensitive.every((k) => k === 'CLAUDE_CONFIG_DIR'), cq && cq.sensitive.join(','));
  } finally {
    await stop(srv);
  }

  fs.writeFileSync(CLAUDE_LOG, '');
  srv = await startServer({ home: home3, codexHome: emptyCodexHome });
  try {
    const r = await get(srv, '/api/providers');
    ok('providers: 鍵ファイル無しでも claude の状態確認は試す（mock は loggedIn）', r.json && r.json.ok === true &&
      r.json.providers.some((p) => p.id === 'claude'), JSON.stringify(r.json));
  } finally {
    await stop(srv);
  }

  const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const sessionsDir = path.join(CODEX_HOME, 'sessions', '2026', '01', '01');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${P}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: P, model_provider: 'openai' } }) + '\n');
  fs.writeFileSync(STORE, JSON.stringify({ threads: { [P]: { facts: {}, turns: 1 } } }));
  fs.writeFileSync(CODEX_LOG, '');
  srv = await startServer({ agent: 'codex', session: P });
  try {
    const r = await post(srv, '/api/ask', { action: 'question', anchor: '本文', question: 'q', sessionId: null, continueSession: false });
    ok('codex 継承ボードの質問が通る', r.json && r.json.ok === true, JSON.stringify(r.json));
    const kq = readLog(CODEX_LOG).find((e) => e.argv.includes('exec'));
    ok('継承モードでも auth.json をリンクで渡す', kq && kq.hasAuth === true, JSON.stringify(kq));
  } finally {
    await stop(srv);
  }

  console.log(failed ? `\n${failed} 件失敗` : '\nすべて通りました');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
