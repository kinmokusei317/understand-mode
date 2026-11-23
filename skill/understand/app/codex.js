'use strict';
// understand-mode の Codex 実行器。
// 親（本筋の会話）の記録を、このボード専用の CODEX_HOME に写してから fork する。
// 寄り道でできた子の記録はすべてこのボードの中に閉じ込め、終了時にまるごと消す。
// 親の会話にも、無関係な会話にも、ユーザーが渡した作業フォルダにも触れない。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 動作を確認した実行ファイルはこの版だけ。別版を互換と称して通さない
const PINNED_VERSION = 'codex-cli 0.171.0';

const READ_LIMIT = 64 * 1024 * 1024;   // 親の記録を読む上限（これを超える形式は扱わない）
const OUT_LIMIT = 8 * 1024 * 1024;     // 子プロセスの stdout を貯める上限
const ERR_LIMIT = 8 * 1024;            // 子プロセスの stderr を貯める上限（報告用）
const PROBE_TIMEOUT_MS = 10 * 1000;    // --version / mcp list の待ち時間
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 寄り道の子に開けてよい能力は「文を読んで答える」だけ。
// それ以外の口は、版によって既定が変わっても閉じたままになるよう、全部明示する。
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'code_mode', 'apps', 'plugins', 'hooks',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'image_generation',
  'skill_mcp_dependency_install', 'shell_snapshot', 'goals',
];

// 子に渡す環境は、動くのに必要なものと明示の認証だけ。他は引き継がない
// （SQL・リモート・SQLite・ホームを指し変える変数は、親の環境から持ち込まない）
function childEnv(home, codexHome) {
  const env = {};
  const take = (k) => { if (typeof process.env[k] === 'string') env[k] = process.env[k]; };
  ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SHELL', 'USER', 'LOGNAME',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
    // テストの偽 codex にだけ渡す差し替え口。本番の分岐・権限・後片付けはこれで変えない
    'MOCK_CODEX_STORE', 'MOCK_CODEX_LOG',
  ].forEach(take);
  for (const k of Object.keys(process.env)) if (/^LC_/.test(k)) env[k] = process.env[k];
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  return env;
}

// エラーメッセージに秘密や質問文を載せないための最小限のマスク
function sanitizeStderr(text, prompt) {
  let t = String(text || '');
  if (prompt) t = t.split(prompt).join('[質問文]');
  for (const k of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY']) {
    const v = process.env[k];
    if (v) t = t.split(v).join('[認証情報]');
  }
  t = t.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[秘匿]')
    .replace(/Bearer\s+\S+/g, 'Bearer [秘匿]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[秘匿]');
  return t.trim().slice(0, 300);
}

// codex exec --json の JSONL は、
//   thread.started → turn.started → …最後の agent_message… → turn.completed
// の封筒の形だけを成功とみなす。行の壊れ・重複・完了後の続き・失敗イベントは全部失敗。
function parseExecResult(stdout) {
  let threadId = null;
  let phase = 0;                 // 0:封筒の外 / 1:thread.started後 / 2:turn.started後 / 3:turn.completed後
  let lastText = null;
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch (_) { throw new Error('Codexの応答が読めない形式でした'); }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
      throw new Error('Codexの応答が読めない形式でした');
    }
    const t = ev.type;
    // 失敗系（イベントでも item でも）が一度でも出たら全体を失敗にする
    if (/error|fail|abort|cancel/i.test(t) ||
        (ev.item && typeof ev.item.type === 'string' && /error|fail|abort|cancel/i.test(ev.item.type))) {
      throw new Error(`Codexが失敗を返しました（${t}）`);
    }
    if (phase === 3) throw new Error('Codexの応答が完了のあとにも続いています');
    if (t === 'thread.started') {
      if (phase !== 0 || threadId) throw new Error('Codexの応答の並びが想定と違います');
      if (typeof ev.thread_id !== 'string' || !UUID.test(ev.thread_id)) {
        throw new Error('Codexが返した会話IDが不正です');
      }
      threadId = ev.thread_id;
      phase = 1;
    } else if (t === 'turn.started') {
      if (phase !== 1) throw new Error('Codexの応答の並びが想定と違います');
      phase = 2;
    } else if (t === 'turn.completed') {
      if (phase !== 2) throw new Error('Codexの応答の並びが想定と違います');
      phase = 3;
    } else {
      // 封筒の中身（item.completed 等）は thread.started〜turn.completed の間だけ許す
      if (phase !== 1 && phase !== 2) throw new Error('Codexの応答の並びが想定と違います');
      if (t === 'item.completed' && ev.item && ev.item.type === 'agent_message') {
        lastText = ev.item.text;
      }
    }
  }
  if (phase !== 3) throw new Error('Codexの応答が途中で切れています');
  if (typeof lastText !== 'string' || !lastText.trim()) {
    throw new Error('Codexから回答の本文がありませんでした');
  }
  return { threadId, text: lastText };
}

// ---------- 親の会話の記録の検査 ----------
// セッション保管庫を辿って rollout-*-<親ID>.jsonl を1つだけ見つける。
// 最新を推測したり、シンボリックリンクを追ったりはしない。
function findParentRollout(codexHome, parentId) {
  const sessionsRoot = path.join(codexHome, 'sessions');
  let st;
  try { st = fs.lstatSync(sessionsRoot); } catch (_) {
    throw new Error(`Codexのセッション保管庫が見つかりません（${sessionsRoot}）。この会話から起動し直してください`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error('Codexのセッション保管庫が不正な形です。対応していません');
  }
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      // Dirent ではシンボリックリンクは isDirectory でも isFile でもないので追わない
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      if (e.name.startsWith('rollout-') && e.name.endsWith(`-${parentId}.jsonl`)) hits.push(p);
    }
  })(sessionsRoot);
  if (!hits.length) {
    throw new Error(`親の会話の記録が見つかりません（${parentId}）。Codexの会話の中から起動し直してください`);
  }
  if (hits.length > 1) throw new Error('親の会話の記録が複数あり、どれを使うか決められません');
  return path.relative(sessionsRoot, hits[0]);
}

// 親の記録を1回だけ開いて読み切り、検査済みのバイト列を返す。
// 読んだあとで生のファイルをもう一度開き直さない（検査と複写で中身がずれるのを防ぐ）。
function readParentRollout(codexHome, rel, parentId) {
  const file = path.join(codexHome, 'sessions', rel);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('親の会話の記録が不正な形です');
    if (st.size > READ_LIMIT) {
      throw new Error('親の会話の記録が大きすぎます。この形式には対応していません');
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const bytes = buf.slice(0, off);
    checkRolloutText(bytes.toString('utf8'), parentId);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

// 記録ファイルが「このボードで扱える形式」かを確かめる。
// 全行を JSON として検査する（途中で切れた行も、対応していない中身も残さず弾く）。
function checkRolloutText(text, parentId) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) throw new Error('親の会話の記録が空です');
  const events = lines.map((line) => {
    try { return JSON.parse(line); } catch (_) {
      throw new Error('親の会話の記録が対応していない形式です（壊れた行があります）');
    }
  });
  const meta = events[0];
  const payload = meta && meta.payload;
  if (!meta || typeof meta !== 'object' || meta.type !== 'session_meta' ||
      !payload || typeof payload !== 'object') {
    throw new Error('親の会話の記録が対応していない形式です（session_meta がありません）');
  }
  if (payload.id !== parentId) throw new Error('親の会話の記録が、指定された会話のものではありません');
  if (payload.model_provider !== 'openai') {
    throw new Error('OpenAI以外のプロバイダの会話には対応していません');
  }
  // history_mode は legacy でも paginated でも、記録がこの1本で完結していれば扱う。
  // 別ファイルへの参照（history_base）を持つものは、どの形式でも扱わない。
  const nonEmpty = (v) => Array.isArray(v) ? v.length > 0
    : (v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const nested = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    for (const src of [ev, nested]) {
      if (src.history_base !== undefined && src.history_base !== null) {
        throw new Error('親の会話の記録が対応していない形式です（分割された履歴を参照しています）');
      }
      const dyn = src.dynamic_tools !== undefined ? src.dynamic_tools : src.dynamicTools;
      if (nonEmpty(dyn)) throw new Error('動的なツールを持つ会話には対応していません');
    }
  }
}

function createCodex({ parentId, workDir, model, timeoutMs }) {
  // 親のIDは明示されたものだけ。推測で埋めない（環境変数にも頼らない）
  const parent = typeof parentId === 'string' && UUID.test(parentId) ? parentId : null;
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new Error('モデルの指定が不正です');
  }
  const bin = process.env.UNDERSTAND_CODEX_BIN || 'codex';
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300 * 1000;

  // このボード専用の根。寄り道で生まれるものは全部この中に閉じ込める
  const root = fs.mkdtempSync(path.join(workDir, 'codex-'));
  fs.chmodSync(root, 0o700);
  const privateHome = path.join(root, 'home');
  const privateCodexHome = path.join(root, 'codex-home');
  const emptyCwd = path.join(root, 'work');
  for (const d of [privateHome, privateCodexHome, emptyCwd]) fs.mkdirSync(d, { mode: 0o700 });

  // 親の記録は「利用者の」保管庫にある。読むのは親の1本だけで、写す先は専用の保管庫
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const owned = new Set();          // このボードが成功裏に作った子だけ
  let snapshotDone = false;         // 親の記録の写しは、最初の質問の直前に作る
  let versionChecked = false;
  let active = null;                // 走っている子プロセス（close で止める）
  let closing = false;
  let closePromise = null;
  let chain = Promise.resolve();    // 子への操作は必ずこの列に並べる

  const fail = (msg) => ({ ok: false, error: msg });
  const closed = () => fail('このボードはすでに閉じています');

  // codex の子プロセスを1回動かす共通の器。probe・exec どちらもこれを通る。
  // 出力はバイト上限まで Buffer のまま貯め、閉じてから一度だけデコードする
  // （UTF-8 の文字の途中で切って連結すると、日本語が壊れる）。
  function runProcess(argv, input, timeoutMs) {
    return new Promise((resolve) => {
      const done = (r) => resolve(Object.assign({
        spawnError: null, code: null, signal: null, timedOut: false,
        outOverflow: false, stdout: '', stderr: '',
      }, r));
      let child;
      try {
        child = spawn(bin, argv, { cwd: emptyCwd, env: childEnv(privateHome, privateCodexHome), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return done({ spawnError: e.message });
      }
      active = child;
      const outChunks = [], errChunks = [];
      let outLen = 0, errLen = 0, outOverflow = false, timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        if (outOverflow) return;               // 超えたあとは足さない
        outLen += d.length;
        if (outLen > OUT_LIMIT) { outOverflow = true; child.kill('SIGKILL'); return; }
        outChunks.push(d);
      });
      child.stderr.on('data', (d) => {
        if (errLen > ERR_LIMIT) return;        // 報告用に頭だけ残す
        errLen += d.length;
        errChunks.push(d);
      });
      child.on('error', (e) => {
        clearTimeout(timer); active = null;
        done({ spawnError: e.message, timedOut, outOverflow });
      });
      child.stdin.on('error', () => {});
      if (input != null) child.stdin.write(input);
      child.stdin.end();
      child.on('close', (code, signal) => {
        clearTimeout(timer); active = null;
        done({
          code, signal, timedOut, outOverflow,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      });
    });
  }

  // モデルを呼ばない短い確認（--version / mcp list）。失敗はすべて「呼ばない」側に倒す
  async function probe(argv) {
    const r = await runProcess(argv, null, PROBE_TIMEOUT_MS);
    if (r.spawnError) return { ok: false, error: `Codexを起動できませんでした: ${r.spawnError}` };
    if (r.timedOut) return { ok: false, error: 'Codexの確認が時間内に終わりませんでした' };
    if (r.code !== 0) {
      const detail = sanitizeStderr(r.stderr);
      return { ok: false, error: `Codexの確認に失敗しました（終了コード ${r.code}）${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  }

  async function ensureVersion() {
    if (versionChecked) return;
    const r = await probe(['--version']);
    if (!r.ok || String(r.stdout).trim() !== PINNED_VERSION) {
      throw new Error(`このunderstand-modeが動かせるCodexは ${PINNED_VERSION} だけです（検出: ${r.ok ? String(r.stdout).trim().slice(0, 80) || '不明' : r.error}）`);
    }
    versionChecked = true;
  }

  // 外部の道具（MCP）がつながっている環境では、寄り道を始めない。
  // モデルを呼ぶたびに確認する（途中で設定が変わっても閉じたままにする）。
  // 終了コードが0でも、認証や起動の失敗が stderr に出ていれば成功とみなさない。
  async function checkMcp() {
    const r = await probe(['mcp', 'list', '--json']);
    if (!r.ok) throw new Error(r.error || 'Codexの道具の確認に失敗しました');
    if (/error|fail|auth/i.test(r.stderr)) {
      throw new Error('Codexの道具の確認でエラーが報告されました。安全のため止まります');
    }
    let list;
    try { list = JSON.parse(r.stdout); } catch (_) {
      throw new Error('Codexの道具の確認結果が読めません。安全のため止まります');
    }
    if (!Array.isArray(list)) throw new Error('Codexの道具の確認結果が想定と違います。安全のため止まります');
    if (list.some((e) => !e || typeof e !== 'object' || e.enabled !== false || e.error)) {
      throw new Error('外部の道具（MCP）が使える環境では動かせません。無効にしてから起動し直してください');
    }
  }

  // codex exec を1回呼ぶ。質問文は argv ではなく stdin の '-' で渡す
  async function execCodex(op, sourceId, prompt) {
    const argv = [
      'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only',
      '-c', 'approval_policy="never"',
      '-c', 'agents.enabled=false',
      '-c', 'web_search="disabled"',
      '-c', 'model_reasoning_effort="low"',
      ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      ...(model ? ['-m', model] : []),
      ...(op === 'draft' ? ['--ephemeral'] : [op, sourceId]),
      '-',
    ];
    const r = await runProcess(argv, prompt, timeout);
    if (r.spawnError) return fail(`Codexを起動できませんでした: ${r.spawnError}`);
    // 時間切れで殺した子が遅れて正常終了しても、成功にはしない
    if (r.timedOut) return fail(`Codexが時間内に応答しませんでした（${Math.round(timeout / 1000)}秒）。もう一度試してください`);
    if (r.outOverflow) return fail('Codexの応答が大きすぎます');
    if (r.signal) return fail(`Codexがシグナルで終了しました（${r.signal}）`);
    if (r.code !== 0) {
      const detail = sanitizeStderr(r.stderr, prompt);
      return fail(`Codexが失敗しました（終了コード ${r.code}）${detail ? `: ${detail}` : ''}`);
    }
    try {
      const { threadId, text } = parseExecResult(r.stdout);
      if (op === 'resume' && threadId !== sourceId) {
        throw new Error('Codexが頼んだのと違う会話IDを返しました');
      }
      if (op === 'fork' && (threadId === sourceId || threadId === parent || owned.has(threadId))) {
        throw new Error('新しい付箋の会話IDではありません');
      }
      return { ok: true, text, sessionId: threadId };
    } catch (e) {
      return fail(e.message);
    }
  }

  // 子への操作を直列化する（別付箋から同時に来ても1つずつ処理する）
  function enqueue(fn) {
    const job = chain.then(fn);
    chain = job.catch(() => {});
    return job;
  }

  // 親の記録を専用の保管庫に写す。起動直後ではなく最初の質問のときに行い、
  // 起動したターンが記録に入ってから文脈を取る（下書きには不要）。
  // 検査したそのバイト列を書くので、確認と複写で中身がずれることはない。
  function ensureSnapshot() {
    if (snapshotDone) return;
    const rel = findParentRollout(sourceCodexHome, parent);
    const bytes = readParentRollout(sourceCodexHome, rel, parent);
    const dest = path.join(privateCodexHome, 'sessions', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    snapshotDone = true;
  }

  function ask({ prompt, sessionId, continueSession }) {
    if (closing) return Promise.resolve(closed());
    return enqueue(async () => {
      if (closing) return closed();
      if (typeof prompt !== 'string' || !prompt.trim()) return fail('質問文がありません');
      if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !UUID.test(sessionId))) {
        return fail('会話IDの指定が不正です');
      }
      if (continueSession) {
        // 続きは「このボードが作って成功した子」にだけ積む
        if (!sessionId || !owned.has(sessionId)) return fail('この付箋の会話を続けられません');
      } else {
        // 分岐元は、明示された親か、このボードが作った子だけ
        if (sessionId && sessionId !== parent && !owned.has(sessionId)) {
          return fail('指定された会話からは分岐できません');
        }
        if (!sessionId && !parent) {
          return fail('メインの会話IDが明示されていません。スキルから起動し直してください');
        }
      }
      const sourceId = continueSession ? sessionId : (sessionId || parent);
      try {
        // 事前確認のたびに閉じていないか確かめる（閉じる途中で新しい子を産まない）
        await ensureVersion();
        if (closing) return closed();
        await checkMcp();
        if (closing) return closed();
        if (!continueSession) ensureSnapshot();
        if (closing) return closed();
        const r = await execCodex(continueSession ? 'resume' : 'fork', sourceId, prompt);
        if (r.ok && r.sessionId) owned.add(r.sessionId);
        return r;
      } catch (e) {
        return fail(e.message);
      }
    });
  }

  // 下書きは親の履歴を引き継がない新規実行（--ephemeral）。記録も残さない
  function draft(prompt) {
    if (closing) return Promise.resolve(closed());
    return enqueue(async () => {
      if (closing) return closed();
      if (typeof prompt !== 'string' || !prompt.trim()) return fail('下書きのもとになる文がありません');
      try {
        await ensureVersion();
        if (closing) return closed();
        await checkMcp();
        if (closing) return closed();
        return await execCodex('draft', null, prompt);
      } catch (e) {
        return fail(e.message);
      }
    });
  }

  // 閉じる：まず closing を同期で立てて新しい仕事を断り、
  // 走っている子を止めて並んだ仕事を待ち、それから専用の根をまるごと消す。
  // 消せなかったときは成功と報告しない。
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (active) { try { active.kill('SIGKILL'); } catch (_) {} }
      await chain.catch(() => {});
      let lastError = null;
      for (let attempt = 0; attempt < 2 && fs.existsSync(root); attempt++) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { lastError = e; }
      }
      if (fs.existsSync(root)) {
        return { ok: false, error: `寄り道の記録を消せませんでした${lastError ? `: ${lastError.message}` : ''}` };
      }
      return { ok: true };
    })();
    return closePromise;
  }

  return { ask, draft, close };
}

module.exports = { createCodex };
