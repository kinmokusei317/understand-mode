'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseExecResult, linkAuthJson, secureOwnerFile, stopGroup, DISABLED_FEATURES } = require('./codex');

const LOGIN_MODELS = new Map([
  ['codex', ['gpt-6.2-terra', 'gpt-6.2-astra']],
  ['claude', ['haiku', 'sonnet', 'opus']],
]);
const CODEX_MIN_VERSION = [0, 170, 0];
const OUT_LIMIT = 8 * 1024 * 1024;
const ERR_LIMIT = 64 * 1024;
const PROBE_TIMEOUT_MS = 10 * 1000;
const ENV_KEYS = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ'];
const CLOSED = 'このボードはすでに閉じています';

function classifyFailure(r) {
  const hay = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (/auth|login|unauthorized|forbidden|credential|401|403/i.test(hay)) {
    return 'CLI のログイン状態が無効です。もう一度ログインしてください';
  }
  if (/usage limit|rate limit|quota|429|insufficient/i.test(hay)) {
    return 'CLI の利用上限に達しました';
  }
  if (/unknown model|unsupported model|model_not_found|model not supported|no such model|invalid model|does not exist/i.test(hay)) {
    return 'そのモデルはこのCLIでは利用できません';
  }
  return 'CLI が失敗を返しました';
}

function create({ workDir, timeoutMs }) {
  if (process.platform === 'win32') {
    throw new Error('ログイン済みCLIの呼び出しは POSIX のプロセスグループに依存するため、Windows では動かせません');
  }
  const codexBin = process.env.UNDERSTAND_CODEX_BIN || 'codex';
  const claudeBin = process.env.UNDERSTAND_CLAUDE_BIN || 'claude';
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300 * 1000;

  const root = fs.mkdtempSync(path.join(workDir, 'login-cli-'));
  fs.chmodSync(root, 0o700);
  const privateHome = path.join(root, 'home');
  const privateCodexHome = path.join(root, 'codex-home');
  const emptyCwd = path.join(root, 'work');
  for (const d of [privateHome, privateCodexHome, emptyCwd]) {
    fs.mkdirSync(d, { mode: 0o700 });
  }
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  let active = null;
  let cleanupFailure = null;
  let chain = Promise.resolve();
  let closed = false;
  let closePromise = null;

  function env(extra, mockKeys) {
    const e = {};
    for (const k of ENV_KEYS) if (process.env[k] !== undefined) e[k] = process.env[k];
    Object.assign(e, extra);
    for (const k of mockKeys) if (process.env[k] !== undefined) e[k] = process.env[k];
    return e;
  }
  function codexEnv() {
    const mock = codexBin === 'codex' ? [] : ['MOCK_CODEX_STORE', 'MOCK_CODEX_LOG', 'MOCK_CODEX_BEHAVE', 'MOCK_CODEX_KEYRING', 'UNDERSTAND_MOCK_DELAY'];
    return env({ HOME: privateHome, CODEX_HOME: privateCodexHome }, mock);
  }
  function claudeEnv() {
    const mock = claudeBin === 'claude' ? [] : ['MOCK_CLAUDE_LOG', 'MOCK_CLAUDE_LOGGED_OUT', 'UNDERSTAND_MOCK_DELAY'];
    const extra = {};
    if (process.env.HOME !== undefined) extra.HOME = process.env.HOME;
    if (process.env.CLAUDE_CONFIG_DIR !== undefined) extra.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    return env(extra, mock);
  }

  function codexAuthReady() {
    const src = path.join(sourceCodexHome, 'auth.json');
    const dst = path.join(privateCodexHome, 'auth.json');
    try {
      if (fs.lstatSync(dst).isSymbolicLink() && fs.readlinkSync(dst) === src) {
        return secureOwnerFile(src);
      }
    } catch (_) {}
    return linkAuthJson(privateCodexHome, sourceCodexHome);
  }

  function runProcess(bin, argv, childEnv, input, timeoutMs) {
    return new Promise((resolve) => {
      const outChunks = [], errChunks = [];
      let outLen = 0, errLen = 0, outOverflow = false, timedOut = false, finished = false, cancelled = false;
      let timer = null;
      const done = (r) => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimeout(timer);
        if (active === cancel) active = null;
        resolve(Object.assign({
          spawnError: null, code: null, signal: null, timedOut,
          outOverflow, unsafe: false,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        }, r));
      };
      const dropPipes = () => {
        try { child.stdin.destroy(); } catch (_) {}
        try { child.stdout.destroy(); } catch (_) {}
        try { child.stderr.destroy(); } catch (_) {}
      };
      function cancel(extra) {
        cancelled = true;
        return verifyGroup().then((ok) => {
          dropPipes();
          done(Object.assign(ok ? { signal: 'SIGKILL' } : { unsafe: true }, extra));
        });
      }
      if (closed) return done({ spawnError: CLOSED });
      if (cleanupFailure) return done({ unsafe: true });
      let child;
      try {
        child = spawn(bin, argv, { detached: true, cwd: emptyCwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return done({ spawnError: e.message });
      }
      const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
      let stopping;
      const verifyGroup = () => (stopping ||= stopGroup(pid).then((ok) => {
        if (!ok) cleanupFailure = '子プロセスの停止を確認できませんでした';
        return ok;
      }));
      active = cancel;
      timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      child.stdout.on('data', (d) => {
        if (outOverflow) return;
        outLen += d.length;
        if (outLen > OUT_LIMIT) { outOverflow = true; cancel(); return; }
        outChunks.push(d);
      });
      child.stderr.on('data', (d) => {
        if (errLen > ERR_LIMIT) return;
        errLen += d.length;
        errChunks.push(d);
      });
      child.once('error', (e) => {
        if (pid === null) { done({ spawnError: e.message }); return; }
        cancel({ spawnError: e.message });
      });
      child.stdin.on('error', () => {});
      if (input != null) child.stdin.write(input);
      child.stdin.end();
      child.once('exit', () => {
        verifyGroup().then((ok) => {
          if (!ok) { dropPipes(); done({ unsafe: true }); }
        });
      });
      child.once('close', async (code, signal) => {
        const ok = await verifyGroup();
        done(!ok ? { unsafe: true } : cancelled ? { signal: 'SIGKILL' } : { code, signal });
      });
    });
  }

  function codexVersionOk(stdout) {
    const m = String(stdout || '').match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < 3; i++) {
      if (v[i] !== CODEX_MIN_VERSION[i]) return v[i] > CODEX_MIN_VERSION[i];
    }
    return true;
  }

  async function codexStatus() {
    if (!codexAuthReady()) {
      return { ok: false, error: 'codex のログイン情報を安全に再利用できません（codex login を確認してください）' };
    }
    const v = await runProcess(codexBin, ['--version'], codexEnv(), null, PROBE_TIMEOUT_MS);
    if (closed) return { ok: false, error: CLOSED };
    if (v.spawnError || v.code !== 0 || !codexVersionOk(v.stdout)) {
      return { ok: false, error: 'codex CLI が見つからないか、対応する版ではありません' };
    }
    const r = await runProcess(codexBin, ['login', 'status'], codexEnv(), null, PROBE_TIMEOUT_MS);
    if (closed) return { ok: false, error: CLOSED };
    if (r.spawnError || r.code !== 0 || !(r.stdout + r.stderr).includes('Logged in using ChatGPT')) {
      return { ok: false, error: 'codex に ChatGPT でログインしていません（codex login を実行してください）' };
    }
    return { ok: true };
  }

  async function claudeStatus() {
    const r = await runProcess(claudeBin, ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'], claudeEnv(), null, PROBE_TIMEOUT_MS);
    if (closed) return { ok: false, error: CLOSED };
    if (r.spawnError || r.code !== 0) {
      return { ok: false, error: 'claude のログイン状態を確認できませんでした' };
    }
    let j;
    try { j = JSON.parse(r.stdout); } catch (_) {
      return { ok: false, error: 'claude のログイン状態を確認できませんでした' };
    }
    if (j.loggedIn === true && j.authMethod === 'claude.ai' && j.apiProvider === 'firstParty') return { ok: true };
    return { ok: false, error: 'claude に claude.ai でログインしていません（claude auth login を実行してください）' };
  }

  function providers() {
    return enqueue(async () => {
      if (closed) throw new Error(CLOSED);
      const out = [];
      try {
        if ((await codexStatus()).ok) out.push({ id: 'codex', models: LOGIN_MODELS.get('codex') });
      } catch (_) {}
      try {
        if ((await claudeStatus()).ok) out.push({ id: 'claude', models: LOGIN_MODELS.get('claude') });
      } catch (_) {}
      return out;
    });
  }

  function resultOf(r, parse) {
    if (closed) return { ok: false, error: CLOSED };
    if (r.unsafe) return { ok: false, error: '子プロセスの停止を確認できませんでした' };
    if (r.spawnError) return { ok: false, error: r.spawnError === CLOSED ? CLOSED : 'CLI を起動できませんでした' };
    if (r.timedOut) return { ok: false, error: 'CLI の応答が時間内に終わりませんでした' };
    if (r.outOverflow) return { ok: false, error: 'CLI の応答が大きすぎます' };
    if (r.code !== 0) return { ok: false, error: classifyFailure(r) };
    try { return { ok: true, text: parse(r.stdout) }; }
    catch (e) {
      if (/認証|ログイン|credential|auth/i.test(e.message)) {
        return { ok: false, error: 'CLI のログイン状態が無効です。もう一度ログインしてください' };
      }
      return { ok: false, error: e.message };
    }
  }

  async function askCodex(model, prompt) {
    const st = await codexStatus();
    if (!st.ok) return { ok: false, error: st.error };
    const argv = [
      'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'agents.enabled=false',
      '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="low"',
      ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      '-m', model, '--ephemeral', '-',
    ];
    const r = await runProcess(codexBin, argv, codexEnv(), prompt, timeout);
    return resultOf(r, (stdout) => parseExecResult(stdout).text);
  }

  async function askClaude(model, prompt) {
    const st = await claudeStatus();
    if (!st.ok) return { ok: false, error: st.error };
    const argv = [
      '-p', '--output-format', 'json',
      '--safe-mode', '--setting-sources', '', '--tools', '', '--disable-slash-commands',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--model', model, '--system-prompt', 'Answer the user directly.',
    ];
    const r = await runProcess(claudeBin, argv, claudeEnv(), prompt, timeout);
    return resultOf(r, (stdout) => {
      let j;
      try { j = JSON.parse(stdout); } catch (_) { throw new Error('CLI の応答が読めない形式でした'); }
      if (j.is_error || typeof j.result !== 'string' || !j.result.trim()) {
        throw new Error('Claude から回答の本文がありませんでした');
      }
      return j.result;
    });
  }

  function enqueue(step) {
    const p = chain.then(step);
    chain = p.then(() => {}, () => {});
    return p;
  }

  function ask({ provider, model, prompt }) {
    if (closed) return Promise.resolve({ ok: false, error: CLOSED });
    if (!LOGIN_MODELS.has(provider) || !LOGIN_MODELS.get(provider).includes(model)) {
      return Promise.resolve({ ok: false, error: '送信先かモデルが対応していません' });
    }
    return enqueue(() => (provider === 'codex' ? askCodex(model, prompt) : askClaude(model, prompt)));
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (active) await active();
      try { await chain; } catch (_) {}
      if (active) await active();
      if (cleanupFailure) return { ok: false, error: cleanupFailure };
      let lastError = null;
      for (let attempt = 0; attempt < 2 && fs.existsSync(root); attempt++) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { lastError = e; }
      }
      if (fs.existsSync(root)) {
        return { ok: false, error: `一時フォルダを消せませんでした${lastError ? `: ${lastError.message}` : ''}` };
      }
      return { ok: true };
    })();
    return closePromise;
  }

  return { providers, ask, close };
}

module.exports = { create, LOGIN_MODELS };
