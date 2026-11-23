#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.MOCK_CODEX_LOG, JSON.stringify({ args, prompt }) + '\n');
  if (prompt.includes('FAIL_MOCK')) { console.error('mock failure'); process.exit(2); }
  if (prompt.includes('BAD_JSON')) { console.log('not json'); return; }
  const id = prompt.includes('BAD_FORK') ? '11111111-1111-4111-8111-111111111111' : args.includes('fork') ? (args[args.indexOf('fork') + 1] === '22222222-2222-4222-8222-222222222222' ? '44444444-4444-4444-8444-444444444444' : '22222222-2222-4222-8222-222222222222') : args.includes('resume') ? args[args.indexOf('resume') + 1] : '33333333-3333-4333-8333-333333333333';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'mock answer' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
});
