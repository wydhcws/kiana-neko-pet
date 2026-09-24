// 编译跟唱功能需要的原生小工具。跟唱依赖 macOS 的 MediaRemote，
// 所以在 Windows / Linux 上本脚本直接跳过（程序其余功能不受影响）。
'use strict';
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const ADAPTER = path.join(ROOT, 'native', 'mediaremote-adapter');

if (process.platform !== 'darwin') {
  console.log('跳过原生编译：跟唱音乐功能仅 macOS 可用（Windows/Linux 上该功能自动隐藏，其余功能正常）。');
  process.exit(0);
}

const has = (cmd) => {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
};

fs.mkdirSync(BIN, { recursive: true });

// 1) 历史版本的读取器（macOS 15.4 起已被系统限制，仅留作参考，不被程序使用）
if (has('clang')) {
  try {
    execFileSync('clang', ['-fobjc-arc', '-O2', '-framework', 'AppKit',
      path.join(ROOT, 'native', 'nowplaying.m'), '-o', path.join(BIN, 'nowplaying-legacy')], { stdio: 'inherit' });
    console.log('✓ bin/nowplaying-legacy（历史参考，未被使用）');
  } catch { console.warn('! nowplaying-legacy 编译失败，不影响使用'); }
} else {
  console.warn('! 未找到 clang，跳过 nowplaying-legacy（可装 Xcode Command Line Tools：xcode-select --install）');
}

// 2) mediaremote-adapter：跟唱功能真正依赖的部分
if (!fs.existsSync(path.join(ADAPTER, 'CMakeLists.txt'))) {
  console.error('✗ 缺少 native/mediaremote-adapter/，跟唱功能将不可用。');
  console.error('  请先获取它（BSD-3-Clause）：');
  console.error('  git clone --depth 1 https://github.com/ungive/mediaremote-adapter.git /tmp/mra \\');
  console.error('    && rsync -a --exclude=.git --exclude=build /tmp/mra/ native/mediaremote-adapter/');
  process.exit(1);
}
if (!has('cmake')) {
  console.error('✗ 未找到 cmake，跟唱功能将不可用。安装：brew install cmake');
  process.exit(1);
}

const build = path.join(ADAPTER, 'build');
fs.mkdirSync(build, { recursive: true });
execFileSync('cmake', ['..', '-DCMAKE_BUILD_TYPE=Release'], { cwd: build, stdio: 'inherit' });
execFileSync('cmake', ['--build', '.'], { cwd: build, stdio: 'inherit' });
console.log('✓ MediaRemoteAdapter.framework');

// 3) 桥接脚本 → bin/nowplaying（main.js 实际 spawn 的文件）
fs.copyFileSync(path.join(ROOT, 'native', 'nowplaying-bridge.js'), path.join(BIN, 'nowplaying'));
fs.chmodSync(path.join(BIN, 'nowplaying'), 0o755);
console.log('✓ bin/nowplaying');
console.log('\n完成。跟唱功能已就绪。');
