'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const args = process.argv.slice(2);
const live = args[0] === '--live';
const models = new Map([['codex', 'gpt-6.2-terra'], ['claude', 'haiku']]);
const installer = path.join(__dirname, '..', 'install.sh');
const session = '00000000-0000-4000-8000-000000000001';
const question = 'Reply exactly OK';
let root, child, cleaning, interrupted;

function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
    if (running()) {
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && running(); i++) await sleep(50);
      if (running()) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
        for (let i = 0; i < 40 && running(); i++) await sleep(50);
        if (running()) throw new Error();
      }
    }
    child = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  })().finally(() => { cleaning = null; });
  return cleaning;
}

for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    cleanup().then(() => process.exit(code), () => { process.stderr.write('FAIL setup: cleanup\n'); process.exit(1); });
  });
}

function fixture(bin, provider, model) {
  const program = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const codex = ${provider === 'codex'};
const root = ${JSON.stringify(fs.realpathSync(root) + path.sep)};
if (![process.env.HOME,process.cwd()].every(p => p && fs.realpathSync(p).startsWith(root))) process.exit(1);
if (fs.readdirSync(process.cwd()).length) process.exit(1);
const source = root + 'credential-source';
if (codex) {
  const dir = fs.realpathSync(process.env.CODEX_HOME);
  const auth = dir + '/auth.json';
  if (!dir.startsWith(root) || dir === source || !fs.lstatSync(auth).isSymbolicLink() ||
      fs.realpathSync(auth) !== source + '/auth.json') process.exit(1);
} else {
  if (fs.realpathSync(process.env.CLAUDE_CONFIG_DIR) !== source ||
      !fs.lstatSync(source + '/.credentials.json').isFile() ||
      !a.includes('--safe-mode') || !a.some((v,i) => v === '--setting-sources' && a[i+1] === '')) process.exit(1);
}
if (a.includes('--version')) console.log(codex ? 'codex-cli 0.171.0' : '2.1.100 (Claude Code)');
else if (codex && a.some((v,i) => v === 'login' && a[i+1] === 'status')) console.error('Logged in using ChatGPT');
else if (!codex && a.some((v,i) => v === 'auth' && a[i+1] === 'status'))
  console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
else if (codex && a.includes('mcp') && a.includes('list')) console.log('[]');
else {
  if (!(codex ? a.includes('exec') : a.includes('-p') || a.includes('--print'))) process.exit(1);
  const model = ${JSON.stringify(model)};
  if (!a.some((v,i) => (['--model','-m'].includes(v) && a[i+1] === model) || v === '--model=' + model)) process.exit(1);
  if (a.includes('resume') || a.includes('fork') || a.includes('--resume')) process.exit(1);
  if (fs.readFileSync(0,'utf8').trim() !== ${JSON.stringify(question)}) process.exit(1);
  fs.writeFileSync(${JSON.stringify(path.join(bin, 'answered'))}, '1', {flag:'wx'});
  const last = a.findIndex(v => ['-o','--output-last-message'].includes(v));
  if (codex && last >= 0) {
    const output = require('node:path').resolve(a[last+1]);
    if (!fs.realpathSync(require('node:path').dirname(output)).startsWith(${JSON.stringify(fs.realpathSync(root) + path.sep)})) process.exit(1);
    fs.writeFileSync(output,'OK');
  }
  if (codex && a.includes('--json')) {
    for (const event of [
      {type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000002'},{type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:'OK'}},{type:'turn.completed'}
    ]) console.log(JSON.stringify(event));
  } else if (!codex && a.includes('json')) console.log(JSON.stringify({type:'result',is_error:false,result:'OK'}));
  else console.log('OK');
}
`;
  fs.writeFileSync(path.join(bin, provider), program, { mode: 0o700 });
}

function failureCategory(error) {
  if (error === 'そのモデルはこのCLIでは利用できません') return 'provider: model unavailable';
  if (error === 'CLI の利用上限に達しました') return 'provider: usage limit';
  if (typeof error === 'string' && /ログイン|認証/.test(error)) return 'provider: authentication failed';
  return 'provider: CLI question failed';
}

async function serverURL(board) {
  for (let i = 0; i < 200; i++) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) break;
    try {
      if (fs.readFileSync(path.join(board, 'server.pid'), 'utf8').trim() === String(child.pid)) {
        const url = new URL(fs.readFileSync(path.join(board, 'url.txt'), 'utf8').trim());
        if (/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/.test(url.href)) return url;
      }
    } catch {}
    await sleep(50);
  }
  throw new Error();
}

function request(url, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url.origin + endpoint, {
      agent: false,
      method: body ? 'POST' : 'GET',
      headers: { 'X-Understand-Token': url.searchParams.get('t'), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000),
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 65536) req.destroy(new Error());
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error();
          resolve(JSON.parse(data));
        } catch { reject(new Error()); }
      });
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}

async function test(provider, model) {
  let stage = 'setup: temporary directories';
  try {
    const tempParent = live ? require('node:os').tmpdir() : '/tmp';
    if (!path.isAbsolute(tempParent)) throw new Error();
    root = fs.mkdtempSync(path.join(tempParent, 'understand-installed-'));
    const [installHome, home, cwd, board, bin, tmp] =
      ['install', 'home', 'work', 'board', 'bin', 'tmp'].map(name => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { mode: 0o700 });
        return dir;
      });
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const env = { HOME: installHome, PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', TMPDIR: tmp };
    stage = 'setup: installer';
    const r = spawnSync('/bin/bash', [installer, ...(provider === 'codex' ? ['--codex'] : [])],
      { cwd, env, stdio: 'ignore', timeout: 30000 });
    if (r.status !== 0) throw new Error();
    const dir = provider === 'codex' ? '.agents' : '.claude';
    const installed = path.join(installHome, dir, 'skills', 'understand', 'app', 'server.js');
    if (fs.realpathSync(installed) !== path.join(fs.realpathSync(installHome), path.relative(installHome, installed))) throw new Error();
    env.HOME = home;
    const sourceKey = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    if (live) {
      stage = 'setup: OAuth paths';
      env.PATH = process.env.PATH;
      if (!env.PATH) throw new Error();
      env[sourceKey] = process.env[sourceKey] || path.join(process.env.HOME, `.${provider}`);
      if (!path.isAbsolute(env[sourceKey])) throw new Error();
    } else {
      env.PATH = bin;
      const credentialDir = path.join(root, 'credential-source');
      fs.mkdirSync(credentialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(credentialDir, provider === 'codex' ? 'auth.json' : '.credentials.json'),
        '{}', { mode: 0o600 });
      env[sourceKey] = credentialDir;
      fixture(bin, provider, model);
    }
    stage = 'setup: installed server';
    child = spawn(process.execPath, [installed, '--agent', provider, '--dir', board, '--cwd', cwd,
      '--session', session, '--port', '0', '--no-open'], { env, cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    const url = await serverURL(board);
    stage = 'setup: provider catalog API';
    const catalog = await request(url, '/api/providers');
    if (catalog?.ok !== true || !Array.isArray(catalog.providers)) throw new Error();
    stage = 'provider: login or model not listed';
    if (!catalog.providers.some(p => p.id === provider && Array.isArray(p.models) && p.models.includes(model))) throw new Error();
    stage = 'setup: CLI question API';
    const reply = await request(url, '/api/cli-question', { provider, model, question, anchor: '' });
    if (reply?.ok !== true) {
      stage = failureCategory(reply?.error);
      throw new Error();
    }
    stage = 'provider: expected OK';
    if (typeof reply.text !== 'string' || reply.text.trim() !== 'OK') throw new Error();
    if (!live && !fs.existsSync(path.join(bin, 'answered'))) throw new Error();
    console.log(`PASS ${provider} ${model} (${live ? 'live' : 'fixture'})`);
  } catch {
    process.stderr.write(`FAIL ${provider} ${model} (${live ? 'live' : 'fixture'}): ${stage}\n`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

async function main() {
  if ((args.length && !(live && (args.length === 1 || (args.length === 2 && models.has(args[1]))))) ||
      process.platform === 'win32') {
    process.stderr.write('Usage (macOS/Linux): node dev/test-installed-login.js [--live [codex|claude]]\n');
    process.exitCode = 2;
    return;
  }
  for (const [provider, model] of models) {
    if (!interrupted && (!args[1] || args[1] === provider)) await test(provider, model);
  }
}

main().catch(() => { process.stderr.write('FAIL setup: cleanup\n'); process.exitCode = 1; });
