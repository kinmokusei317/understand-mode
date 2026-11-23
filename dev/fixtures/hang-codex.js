#!/usr/bin/env node
// 契約テスト用の偽 codex（UNDERSTAND_CODEX_BIN に指定する）。
// プロセスグループの後始末を確かめるため、同じグループに孫プロセスを1匹産む。
// 孫は自分の PID を MOCK_CODEX_LOG と同じフォルダの grandchild.pid に書き、
// 12秒後には自力で終わる（試験が失敗しても残り続けない）。
//
// モード（exec の標準入力に含まれる語で決まる）:
//   hang … 封筒の頭だけ出して孫を産み、12秒ぶら下がる（推論中のふり）
//   その他 … 正常な封筒を全部出して終了するが、孫は stdio を切り離して残す
//            （リーダーは普通に死ぬのに、グループには残党がいる状態）
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHILD_ID = '11111111-2222-3333-4444-555555555555';
const argv = process.argv.slice(2);

// 孫側：マーカーに自分のPIDを書き、準備ができたことをIPCで親に知らせてから12秒残る
if (argv[0] === '--descendant') {
  fs.writeFileSync(argv[1], String(process.pid));
  try { process.send('ready', () => process.disconnect()); } catch (_) {}
  setTimeout(() => process.exit(0), 12000);
  return;
}

if (argv[0] === '--version') { console.log('codex-cli 0.171.0'); process.exit(0); }
if (argv[0] === 'mcp') { console.log('[]'); process.exit(0); }

// マーカーは MOCK_CODEX_LOG と同じフォルダに置く（試験側の一時フォルダ内）
const MARKER = path.join(path.dirname(process.env.MOCK_CODEX_LOG || 'log'), 'grandchild.pid');

// 同じグループの子孫を、このファイル自身を --descendant で起動して産む。
// stdio は親と切るが、準備の合図用に ipc だけ通す
function leaveDescendant() {
  return spawn(process.execPath, [process.argv[1], '--descendant', MARKER],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  if (/hang/.test(input)) {
    // 推論の途中に見えるよう封筒の頭だけ出してからぶら下がる（自力の上限あり）
    emit({ type: 'thread.started', thread_id: CHILD_ID });
    emit({ type: 'turn.started' });
    const d = leaveDescendant();
    d.unref();
    d.on('message', () => d.disconnect());
    setTimeout(() => process.exit(0), 12000);
    return;
  }
  const d = leaveDescendant();
  let emitted = false;
  // 孫がマーカーを書いた合図を受けてから正常に終わる（合図が来なくても3秒で終わる）
  const finish = () => {
    if (emitted) return;
    emitted = true;
    try { d.disconnect(); } catch (_) {}
    d.unref();
    emit({ type: 'thread.started', thread_id: CHILD_ID });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } });
  };
  d.on('message', finish);
  setTimeout(finish, 3000);
});
