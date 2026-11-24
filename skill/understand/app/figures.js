'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LIMIT = 4 * 1024 * 1024;
const COUNT = 32;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:png|jpe?g|webp)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_CREAT, O_EXCL, O_WRONLY, O_NONBLOCK } = fs.constants;
const O_NOFOLLOW_ANY = 0x20000000;
const safeFlags = process.platform === 'darwin' ? O_NOFOLLOW_ANY : O_NOFOLLOW;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function format(b) {
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

function withDirectory(root, create, fn) {
  if (!['darwin', 'linux'].includes(process.platform)) fail(501, 'この環境では安全に図のフォルダを開けません');
  const dir = path.join(fs.realpathSync(root), 'images');
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${fd}` : dir;
    const entries = [];
    const stream = fs.opendirSync(pinned);
    try {
      let entry;
      while ((entry = stream.readSync())) {
        if (entries.length >= COUNT) fail(409, '図のフォルダの項目数が上限を超えています');
        entries.push(entry);
      }
    } finally { stream.closeSync(); }
    return fn(pinned, entries);
  } finally { fs.closeSync(fd); }
}

function read(dir, name, headerOnly) {
  const fd = fs.openSync(path.join(dir, name), O_RDONLY | O_NONBLOCK | safeFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail(404, '図が見つかりません');
    if (stat.size > LIMIT) fail(413, '図は4 MiBまでです');
    const b = Buffer.alloc(headerOnly ? Math.min(12, stat.size) : stat.size);
    let offset = 0;
    while (offset < b.length) {
      const n = fs.readSync(fd, b, offset, b.length - offset, offset);
      if (!n) fail(409, '図が変更されました');
      offset += n;
    }
    const type = TYPES[format(b)];
    if (!type || TYPES[name.split('.').pop()] !== type) fail(415, '画像形式が一致しません');
    return { type, b };
  } finally { fs.closeSync(fd); }
}

async function uploadBytes(req) {
  if (Number(req.headers['content-length']) > LIMIT) fail(413, '図は4 MiBまでです');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > LIMIT) fail(413, '図は4 MiBまでです');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

module.exports = async function figures(req, res, url, root, send) {
  try {
    if (!req.headers['x-understand-token'] || url.search) fail(403, '合言葉はヘッダで渡してください');
    const collection = url.pathname === '/api/figures';
    if (collection && req.method === 'POST') {
      const b = await uploadBytes(req);
      const ext = format(b);
      if (!ext || req.headers['content-type'] !== TYPES[ext]) fail(415, 'PNG・JPEG・WebPの実ファイルを選んでください');
      const name = `figure-${randomUUID()}.${ext}`;
      withDirectory(root, true, (dir, entries) => {
        if (entries.length >= COUNT) fail(409, '図は32件までです');
        const fd = fs.openSync(path.join(dir, name), O_CREAT | O_EXCL | O_WRONLY | safeFlags, 0o600);
        try { fs.writeFileSync(fd, b); } finally { fs.closeSync(fd); }
      });
      return send(res, 201, { name });
    }
    if (req.method !== 'GET') fail(405, 'この操作はできません');
    if (collection) {
      let names;
      try {
        names = withDirectory(root, false, (dir, entries) => entries.filter(entry => {
          if (!entry.isFile() || !NAME.test(entry.name)) return false;
          try { read(dir, entry.name, true); return true; } catch { return false; }
        }).map(entry => entry.name).sort());
      } catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
      return send(res, 200, { names });
    }
    const name = url.pathname.slice('/api/figures/'.length);
    if (!NAME.test(name)) fail(404, '図が見つかりません');
    const { type, b } = withDirectory(root, false, (dir, entries) => {
      if (!entries.some(entry => entry.name === name && entry.isFile())) fail(404, '図が見つかりません');
      return read(dir, name, false);
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return send(res, 200, b, type);
  } catch (e) {
    req.resume();
    return send(res, e.status || 404, { error: e.status ? e.message : '図のフォルダまたはファイルを利用できません' });
  }
};
