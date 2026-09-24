#!/usr/bin/env node
// 跟唱数据源桥接（2026-09 新增，见 KIANA_PET_REBUILD.md 第 5 节第 13 条）
// macOS 15.4 起，Apple 只放行 bundle id 以 com.apple. 开头的进程直接调用私有框架
// MediaRemote，native/nowplaying.m 的 MRMediaRemoteGetNowPlayingInfo 直接调用会静默
// 返回空数据。这里借系统自带、天然带 com.apple. 签名的 /usr/bin/perl 去加载
// native/mediaremote-adapter/（第三方 vendored，BSD-3-Clause）间接读取，
// 再把它的字段名换回 main.js 原本期望的那套 JSON 行格式，main.js 不用改一行。
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRAMEWORK = path.join(ROOT, 'native', 'mediaremote-adapter', 'build', 'MediaRemoteAdapter.framework');
const PL = path.join(ROOT, 'native', 'mediaremote-adapter', 'bin', 'mediaremote-adapter.pl');

const child = spawn('/usr/bin/perl', [PL, FRAMEWORK, 'stream', '--no-diff', '--no-artwork'], {
  stdio: ['ignore', 'pipe', 'ignore'],
});

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    emit(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
child.on('exit', () => process.exit(0));
child.on('error', () => process.exit(1));

// 波点的歌手名/歌名里夹着零宽空格，原 native/nowplaying.m 的 clean() 会去掉，这里保持一致
function clean(v) {
  return typeof v === 'string' ? v.replace(/​/g, '').trim() : '';
}

function emit(line) {
  let payload;
  try {
    payload = JSON.parse(line).payload || {};
  } catch {
    return;
  }
  const out = {
    bundle: payload.bundleIdentifier || '',
    title: clean(payload.title),
    artist: clean(payload.artist),
    album: clean(payload.album),
    duration: payload.duration || 0,
    elapsed: payload.elapsedTime || 0,
    rate: payload.playbackRate || 0,
    timestamp: payload.timestamp ? Date.parse(payload.timestamp) : 0,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function shutdown() {
  child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
