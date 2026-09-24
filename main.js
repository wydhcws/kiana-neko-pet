// 琪亚娜猫娘桌面助手 —— Electron 主进程
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, protocol, net, dialog, globalShortcut, shell, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { scan: scanMods } = require('./modlib');
const { profile: charProfile, PROFILES: CHAR_PROFILES } = require('./characters');
const { Voice, VOICES } = require('./voice');
const { Lyrics } = require('./lyrics');
const { AI } = require('./ai');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 自己的配音别出现在系统「正在播放」里，否则会把自己当成音乐
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

// 页面和模型都通过 app:// 协议加载（file:// 下 wasm 物理库和模型贴图会被拦）
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// 模型搜索目录（按顺序找，先找到先用）：
//   1. 项目 / 安装目录下的 models/  —— 推荐位置，「打开模型文件夹…」菜单指向这里
//   2. ~/Downloads                 —— 兼容早期版本的解压位置
// 模型是第三方二次创作作品（版权属 miHoYo，编辑者见各自的「使用规则.txt」），
// 规则明确「请勿二次配布」，所以仓库和安装包都不包含模型，由用户自行下载放入。
const modelRoots = () => [
  app.isPackaged ? path.join(app.getPath('userData'), 'models') : path.join(__dirname, 'models'),
  path.join(os.homedir(), 'Downloads'),
];
const modelsDir = () => modelRoots()[0];
// 已适配的 MMD 模型。ratio：窗口宽高比；frameX：镜头水平偏移（按身高比例），给偏向一侧的披风/裙摆留位置
const MODELS = [
  { id: 'flamescion', label: '薪炎律者', dir: 'Kiana Kaslana - Herrscher of Flamescion', pmx: 'Kiana Kaslana - Herrscher of Flamescion.pmx', ratio: 0.88, frameX: 0.1 },
  { id: 'finality', label: '终焉律者', dir: 'Kiana Kaslana - Herrscher of Finality', pmx: 'Kiana Kaslana.pmx', ratio: 0.74, frameX: -0.04 },
  { id: 'diva', label: '崩坏的歌姬 World Diva', dir: 'Kiana Kaslana - World Diva', pmx: 'Kiana Kaslana - World Diva.pmx', ratio: 0.62, frameX: 0 },
];
// ---------- 模组库 ----------
// 按「游戏 / 人物 / 模型」组织的模型合集，扫出来后在菜单里按人物分组选。
// 位置由用户在菜单里指定（存进 settings.modRoot）；没指定时看 models/mods 这个约定目录。
// 不要在这里写死任何本机路径。
const modRoots = () => [settings.modRoot, path.join(modelsDir(), 'mods')].filter(Boolean);
let modCache = null;
function modLibrary(force = false) {
  if (modCache && !force) return modCache;
  // 把已知角色名喂给扫描器：目录平铺、认不出结构时可以靠它把模型归到正确的人物名下
  const knownNames = Object.keys(CHAR_PROFILES);
  for (const r of modRoots()) {
    const lib = scanMods(r, { knownNames });
    if (lib.length) return (modCache = { root: r, lib });
  }
  return (modCache = { root: null, lib: [] });
}

// 跨平台比路径：Windows 不分大小写
const samePath = (a, b) => !!a && !!b && (process.platform === 'win32'
  ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
  : path.normalize(a) === path.normalize(b));
// 在各搜索目录里找模型文件，找不到返回 null
function findModelFile(m) {
  for (const root of modelRoots()) {
    const f = path.join(root, m.dir, m.pmx);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const CHIBI_SIZES = { 小: [260, 380], 中: [320, 460], 大: [400, 570] };
const MMD_HEIGHTS = { 小: 440, 中: 540, 大: 680 };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  muted: false, voiceOn: true, voiceKey: 'genki', water: true, onTop: true, size: '中', x: null, y: null,
  model: 'chibi', customPath: null, physics: true, affection: null, opacity: 1, singAlong: true, aiOn: true, motionStyle: 'calm', autoStart: false, danceMode: true,
};
// 当前选中的 MMD 模型（含自选文件），不存在就返回 null
function mmdEntry(id = settings.model) {
  if (id === 'custom') {
    if (!settings.customPath) return null;
    // 自选模型的窗口比例/镜头偏移没法预先知道，首次加载后由渲染进程按模型包围盒量出来
    // 回报（见 ipcMain 'model-metrics'），存进 customFit 里按文件路径缓存
    const fit = (settings.customFit || {})[settings.customPath];
    return {
      id: 'custom',
      // 从模组库选的会带上「人物 · 模型名」，比光看文件名清楚
      label: settings.customLabel || path.basename(settings.customPath).replace(/\.(pmx|pmd)$/i, ''),
      file: settings.customPath,
      ratio: fit ? fit.ratio : 0.75,
      // frameX 为 null 表示「让渲染进程自动按模型左右居中」，不是写死的 0
      frameX: fit ? fit.frameX : null,
    };
  }
  const m = MODELS.find((x) => x.id === id);
  return m ? { ...m, file: findModelFile(m) } : null;
}
const exists = (m) => !!m && !!m.file && fs.existsSync(m.file);
const activeModel = () => (exists(mmdEntry()) ? settings.model : 'chibi');
function sizeOf() {
  const m = mmdEntry(activeModel());
  if (!m) return CHIBI_SIZES[settings.size];
  const h = MMD_HEIGHTS[settings.size];
  return [Math.round(h * m.ratio), h];
}
const appUrl = (file) => 'app://local' + pathToFileURL(file).pathname;
let stats = { affection: 0, pomodoro: false };
let win = null;
let tray = null;
let drag = null;
let voice = null;
let lyrics = null;
let ai = null;
const CHAT_KEY = 'CommandOrControl+Shift+J';

// ---------- 连续用电脑时长（键鼠 5 分钟内有动静算在用，离开 10 分钟清零） ----------
let workMinutes = 0;
let lastLongWorkAt = 0;
setInterval(() => {
  const idle = powerMonitor.getSystemIdleTime();
  if (idle < 300) workMinutes++;
  else if (idle > 600) { workMinutes = 0; lastLongWorkAt = 0; }
  // 连续 2 小时提醒一次，之后每小时再提醒
  if (workMinutes >= 120 && workMinutes - lastLongWorkAt >= 60 && !hidden) {
    lastLongWorkAt = workMinutes;
    send('long-work', workMinutes);
  }
}, 60 * 1000);

// 手选单个 PMX 时也尽量认出这是谁：先在模组库里精确匹配文件，
// 匹配不到就拿「模组库里出现过的人物名 + 已知角色表」去比对路径，取最长的那个
// （避免「华」抢在「符华」前面命中）。实在认不出来才按默认的琪亚娜。
function inferCharacter(file) {
  if (!file) return null;
  const { root, lib } = modLibrary();
  // 1) 模组库里的模型：直接用扫描出来的人物
  for (const e of lib) {
    for (const m of e.models) if (samePath(m.file, file)) return { char: e.char, game: e.game };
  }
  // 2) 只要文件在模组库目录下，就按 <游戏>/<人物>/… 的层级取，
  //    这样即使是扫描时被当作道具过滤掉的文件，也能认出所属角色
  if (root) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const seg = rel.split(path.sep);
      if (seg.length >= 3) return { char: seg[1], game: seg[0] };
    }
  }
  // 3) 都不在库里：拿库里出现过的人物名 + 已知角色表去比对路径
  const p = file.replace(/\\/g, '/');
  const gameOf = new Map();
  const names = new Set(Object.keys(CHAR_PROFILES));
  for (const e of lib) { names.add(e.char); gameOf.set(e.char, e.game); }
  const hit = [...names].filter((n) => p.includes(n)).sort((a, b) => b.length - a.length)[0];
  return hit ? { char: hit, game: gameOf.get(hit) || null } : null;
}

// 当前扮演的角色：内置模型都是琪亚娜；自选模型按认出来的人物走。
// customChar 可能没存（旧版本的设置、或手改过配置），这时当场按路径重新认一次，
// 认出来就补记下来，不要因为字段缺失就退回琪亚娜。
function currentCharacter() {
  if (activeModel() === 'custom') {
    if (!settings.customChar && settings.customPath) {
      const who = inferCharacter(settings.customPath);
      if (who) {
        settings.customChar = who.char;
        settings.customGame = who.game;
        saveSettings();
      }
    }
    if (settings.customChar) return charProfile(settings.customChar, settings.customGame);
  }
  return charProfile('琪亚娜', '崩坏3');
}

function aiContext(ctx = {}) {
  return {
    ...ctx,
    character: currentCharacter(),
    workMinutes,
    song: song && song.playing ? { title: song.title, artist: song.artist } : null,
  };
}

function openChat() {
  if (!win) return;
  if (hidden) showPet();
  app.focus({ steal: true });
  win.focus();
  send('action', 'chat');
}

// ---------- 跟唱：读取系统「正在播放」（波点音乐等） ----------
const SELF_BUNDLES = new Set(['com.github.Electron', 'com.electron.kiana-neko-pet']);
let np = null;          // 子进程
let song = null;        // 当前歌曲状态
function startNowPlaying() {
  if (np || process.platform !== 'darwin' || !settings.singAlong) return;
  const bin = path.join(__dirname, 'bin', 'nowplaying');
  if (!fs.existsSync(bin)) { console.warn('缺少 bin/nowplaying，先运行 npm run build:native'); return; }
  // bin/nowplaying 是 Node 脚本。装了本程序的电脑不一定装了 Node，所以用 Electron 自带的 Node 运行它
  // （ELECTRON_RUN_AS_NODE=1 让 Electron 以纯 Node 模式启动），不要依赖 shebang 里的系统 node。
  np = spawn(process.execPath, [bin], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let buf = '';
  np.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onNowPlaying(JSON.parse(line)); } catch {}
    }
  });
  np.on('exit', () => { np = null; });
}
function stopNowPlaying() {
  if (np) { np.kill(); np = null; }
  if (song) { song = null; send('song', null); }
}

function onNowPlaying(d) {
  const valid = d.title && !SELF_BUNDLES.has(d.bundle);
  const playing = valid && d.rate > 0;
  const now = Date.now();
  const pos = valid ? d.elapsed + (d.timestamp ? Math.max(0, now - d.timestamp) / 1000 : 0) * (d.rate || 0) : 0;
  const id = valid ? `${d.title}|${d.artist}` : null;

  if (!id) {
    if (song) { song = null; send('song', null); }
    return;
  }
  const changed = !song || song.id !== id;
  // 预测位置和上报位置差太多说明拖了进度条
  const predicted = song ? song.pos + (song.playing ? (now - song.at) / 1000 : 0) : 0;
  const seeked = song && Math.abs(predicted - pos) > 1.5;
  if (!changed && !seeked && song.playing === playing) return;

  song = { id, title: d.title, artist: d.artist, album: d.album, duration: d.duration, bundle: d.bundle, pos, at: now, playing };
  send('song', song);
  if (changed && lyrics) {
    const want = id;
    lyrics.get(song).then((l) => { if (song && song.id === want) send('lyrics', { id: want, ...l }); });
  }
}
let hidden = false;
let hideTimer = null;
const HOTKEY = 'CommandOrControl+Shift+K';

// ---------- 暂时隐藏 ----------
function hidePet(minutes) {
  if (!win) return;
  clearTimeout(hideTimer);
  hidden = true;
  send('hidden', true);
  win.hide();
  if (minutes) hideTimer = setTimeout(showPet, minutes * 60 * 1000);
  refreshTray();
}
function showPet() {
  if (!win) return;
  clearTimeout(hideTimer);
  if (!hidden) return;
  hidden = false;
  win.showInactive();
  if (settings.onTop) win.setAlwaysOnTop(true, 'floating');
  send('hidden', false);
  refreshTray();
}
const toggleHidden = () => (hidden ? showPet() : hidePet());

function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch {}
  if (!CHIBI_SIZES[settings.size]) settings.size = '中';
  // 旧版设置：model 为 'mmd'，路径存在 mmdPath 里
  if (settings.model === 'mmd') {
    const known = MODELS.find((m) => samePath(findModelFile(m), settings.mmdPath) || path.basename(m.pmx) === path.basename(settings.mmdPath || ''));
    if (known) settings.model = known.id;
    else { settings.model = 'custom'; settings.customPath = settings.mmdPath; }
  }
  delete settings.mmdPath;
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = sizeOf();
  let { x, y } = settings;
  const visible = x != null && screen.getAllDisplays().some(d =>
    x > d.workArea.x - w / 2 && x < d.workArea.x + d.workArea.width - w / 2 &&
    y > d.workArea.y - h / 2 && y < d.workArea.y + d.workArea.height - h / 2);
  if (!visible) {
    x = workArea.x + workArea.width - w - 40;
    y = workArea.y + workArea.height - h;
  }

  win = new BrowserWindow({
    width: w, height: h, x, y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: settings.onTop, skipTaskbar: true, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (settings.onTop) win.setAlwaysOnTop(true, 'floating');
  win.setOpacity(settings.opacity);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(appUrl(path.join(__dirname, 'src', 'index.html')));

  win.webContents.on('did-finish-load', () => send('settings', settings));
  win.on('moved', () => {
    const b = win.getBounds();
    settings.x = b.x; settings.y = b.y; saveSettings();
  });
  win.on('closed', () => { win = null; });

  // 把全局鼠标位置推给渲染进程，让她的视线一直跟着你
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    send('cursor', { x: p.x - b.x, y: p.y - b.y, w: b.width, h: b.height });
  }, 40);
}

// ---------- 拖动 ----------
ipcMain.on('drag-start', () => {
  if (!win) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  drag = { sx: p.x, sy: p.y, bx: b.x, by: b.y, w: b.width, h: b.height, moved: false };
  drag.timer = setInterval(() => {
    if (!drag || !win) return;
    const c = screen.getCursorScreenPoint();
    const dx = c.x - drag.sx, dy = c.y - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; send('drag-state', true); }
    if (drag.moved) win.setBounds({ x: drag.bx + dx, y: drag.by + dy, width: drag.w, height: drag.h });
  }, 12);
});
ipcMain.handle('drag-end', () => {
  if (!drag) return false;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (moved) send('drag-state', false);
  return moved;
});

ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('stats', (_e, s) => {
  Object.assign(stats, s);
  if (settings.affection !== stats.affection) { settings.affection = stats.affection; saveSettings(); }
  refreshTray();
});
ipcMain.handle('voice-get', async (_e, text) => {
  if (!voice || !settings.voiceOn || settings.muted) return null;
  const file = await voice.get(text, settings.voiceKey);
  return file ? appUrl(file) : null;
});
ipcMain.on('voice-prefetch', (_e, lines) => {
  if (voice && settings.voiceOn) voice.prefetch(lines, settings.voiceKey).catch(() => {});
});
// 渲染进程初始化完成后主动来取当前歌曲（加载模型要几秒，主动推会丢）
ipcMain.handle('ai-status', () => ({ ready: !!ai && ai.ready, on: settings.aiOn }));
// AI 的句子是现场生成的，配音要现合成（长句 1.5~3 秒）。先合成好再一起交给页面，文字和声音同时出来
async function withVoice(r) {
  if (r && r.text && voice && settings.voiceOn && !settings.muted) {
    await Promise.race([voice.get(r.text, settings.voiceKey), new Promise((res) => setTimeout(res, 10000))]);
  }
  return r;
}
ipcMain.handle('ai-idle', async (_e, ctx) => {
  if (!ai || !ai.ready || !settings.aiOn) return null;
  try { return await withVoice(await ai.idle(aiContext(ctx))); } catch (e) { console.warn('ai idle', e.message); return null; }
});
ipcMain.handle('ai-chat', async (_e, text, ctx) => {
  if (!ai || !ai.ready) return { error: 'nokey' };
  try { return await withVoice(await ai.chat(String(text).slice(0, 500), aiContext(ctx))); } catch (e) { console.warn('ai chat', e.message); return { error: e.message }; }
});
// 渲染进程加载完自选模型后，回报按模型包围盒量出来的窗口比例和镜头偏移。
// 存下来并立即校正窗口尺寸——第一次加载会看到窗口调整一下，之后就一直是对的。
ipcMain.on('model-metrics', (_e, m) => {
  if (!m || settings.model !== 'custom' || !settings.customPath) return;
  const ratio = Number(m.ratio), frameX = Number(m.frameX);
  if (!Number.isFinite(ratio) || !Number.isFinite(frameX)) return;
  const fits = settings.customFit || (settings.customFit = {});
  const old = fits[settings.customPath];
  if (old && Math.abs(old.ratio - ratio) < 0.01 && Math.abs(old.frameX - frameX) < 0.01) return;
  fits[settings.customPath] = { ratio, frameX };
  saveSettings();
  applySize();
});
ipcMain.handle('song-bpm', async (_e, title, artist) => {
  if (!ai || !ai.ready) return null;
  try { return await ai.bpm(title, artist); } catch (e) { console.warn('bpm', e.message); return null; }
});
ipcMain.on('focus-window', () => { if (win) { app.focus({ steal: true }); win.focus(); } });
ipcMain.handle('get-song', async () => {
  if (!song) return null;
  const s = { ...song, pos: song.pos + (song.playing ? (Date.now() - song.at) / 1000 : 0), at: Date.now() };
  const l = lyrics ? await lyrics.get(song) : null;
  return { song: s, lyrics: l && song && song.id === s.id ? { id: s.id, ...l } : null };
});
ipcMain.handle('get-settings', () => ({
  ...settings,
  model: activeModel(),
  modelMissing: settings.model !== 'chibi' && !exists(mmdEntry()),
  modelUrl: exists(mmdEntry()) ? appUrl(mmdEntry().file) : null,
  modelProfile: exists(mmdEntry()) ? { id: mmdEntry().id, frameX: mmdEntry().frameX } : null,
  character: currentCharacter(),   // 固定台词按这个角色的口吻改写
}));
ipcMain.on('show-menu', () => buildMenu().popup({ window: win }));
ipcMain.on('quit-now', () => app.quit());
ipcMain.on('request-show', () => showPet());

// ---------- 菜单 ----------
function applySize() {
  if (!win) return;
  const b = win.getBounds();
  const [w, h] = sizeOf();
  // 以脚底中点为锚点缩放
  win.setBounds({ x: Math.round(b.x + b.width / 2 - w / 2), y: b.y + b.height - h, width: w, height: h });
}
function setSize(name) {
  settings.size = name; saveSettings();
  applySize();
}

function setModel(id) {
  if (id !== 'chibi' && !exists(mmdEntry(id))) {
    if (id === 'custom') return pickModel();
    const m = MODELS.find((x) => x.id === id);
    dialog.showMessageBox({
      type: 'info',
      message: `还没有「${m.label}」的模型文件`,
      detail: `模型是第三方二次创作作品，使用规则要求「请勿二次配布」，所以本程序不附带模型，需要你自行下载。\n\n`
        + `下载解压后，把整个文件夹放到：\n${modelsDir()}\n\n`
        + `即文件路径为：\n${path.join(modelsDir(), m.dir, m.pmx)}`,
      buttons: ['打开模型文件夹', '知道了'],
      defaultId: 0,
      cancelId: 1,
    }).then((r) => {
      if (r.response === 0) {
        fs.mkdirSync(modelsDir(), { recursive: true });
        shell.openPath(modelsDir());
      }
    });
    return;
  }
  settings.model = id; saveSettings();
  applySize();
  if (win) win.webContents.reload();
}

// 从模组库选一个模型：走和「自选 PMX」同一套机制，额外记下好看的名字
function useMod(m, entry) {
  settings.customPath = m.file;
  settings.customLabel = `${entry.char} · ${m.label}`;
  settings.customChar = entry.char;    // 台词和 AI 人设会跟着这个角色走
  settings.customGame = entry.game;
  saveSettings();
  setModel('custom');
}

async function pickModRoot() {
  const r = await dialog.showOpenDialog({
    title: '选择模组库文件夹（里面按「游戏 / 人物 / 模型」分层）',
    properties: ['openDirectory'],
    defaultPath: modLibrary().root || app.getPath('downloads'),
  });
  if (r.canceled || !r.filePaths[0]) return;
  settings.modRoot = r.filePaths[0];
  saveSettings();
  const lib = modLibrary(true).lib;
  if (!lib.length) {
    dialog.showMessageBox({
      type: 'info',
      message: '这个文件夹里没找到模型',
      detail: '模组库需要按「游戏 / 人物 / 模型文件夹 / xxx.pmx」的层级存放，例如：\n\n'
        + '崩坏3/琪亚娜/琪亚娜—终焉律者/琪亚娜.pmx\n\n单个模型可以用「选择其他 PMX 模型…」直接加载。',
    });
  }
}

// 模组库菜单：游戏 ▸ 人物 ▸ 模型
function modMenu() {
  const { root, lib } = modLibrary();
  const items = [];
  if (!lib.length) {
    items.push({ label: '还没有加载模组库', enabled: false });
    items.push({ label: '按「游戏 / 人物 / 模型」分层存放', enabled: false });
  } else {
    const byGame = new Map();
    for (const e of lib) {
      if (!byGame.has(e.game)) byGame.set(e.game, []);
      byGame.get(e.game).push(e);
    }
    const cur = activeModel() === 'custom' ? settings.customPath : null;
    for (const [game, chars] of byGame) {
      items.push({
        label: `${game}（${chars.length} 位角色）`,
        submenu: chars.map((c) => ({
          label: c.models.length > 1 ? `${c.char}（${c.models.length}）` : c.char,
          submenu: c.models.map((m) => ({
            label: m.label,
            type: 'radio',
            checked: samePath(cur, m.file),
            click: () => useMod(m, c),
          })),
        })),
      });
    }
  }
  items.push({ type: 'separator' });
  if (root) items.push({ label: `当前目录：${path.basename(root)}`, enabled: false });
  items.push({ label: root ? '更换模组库文件夹…' : '加载模组库文件夹…', click: pickModRoot });
  items.push({ label: '重新扫描', enabled: !!root, click: () => { modLibrary(true); } });
  return items;
}

async function pickModel() {
  const r = await dialog.showOpenDialog({
    title: '选择 MMD 模型', properties: ['openFile'],
    defaultPath: settings.customPath ? path.dirname(settings.customPath)
      : (fs.existsSync(modelsDir()) ? modelsDir() : app.getPath('downloads')),
    filters: [{ name: 'MMD 模型', extensions: ['pmx', 'pmd'] }],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const known = MODELS.find((m) => samePath(findModelFile(m), r.filePaths[0]));
  if (known) return setModel(known.id);
  settings.customPath = r.filePaths[0];
  settings.customLabel = null;              // 名字重新按文件名显示
  // 从路径认出这是哪个角色，台词和 AI 人设跟着走；认不出来才退回琪亚娜
  const who = inferCharacter(r.filePaths[0]);
  settings.customChar = who ? who.char : null;
  settings.customGame = who ? who.game : null;
  setModel('custom');
}

function toggle(key) {
  settings[key] = !settings[key];
  saveSettings();
  if (key === 'onTop' && win) win.setAlwaysOnTop(settings.onTop, 'floating');
  send('settings', settings);
}

function buildMenu() {
  const act = (type) => () => send('action', type);
  if (hidden) {
    return Menu.buildFromTemplate([
      { label: `显示${currentCharacter().name}`, accelerator: HOTKEY, click: showPet },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
  }
  return Menu.buildFromTemplate([
    { label: `${currentCharacter().name} · 好感度 ${stats.affection} ❤`, enabled: false },
    { type: 'separator' },
    { label: '暂时隐藏', submenu: [
      { label: '隐藏（直到手动显示）', accelerator: HOTKEY, click: () => hidePet() },
      { label: '隐藏 30 分钟', click: () => hidePet(30) },
      { label: '隐藏 1 小时', click: () => hidePet(60) },
    ] },
    { type: 'separator' },
    { label: '和她聊天 💬', accelerator: CHAT_KEY, click: openChat },
    { label: '摸摸头', click: act('pat') },
    { label: '喂小鱼干 🐟', click: act('feed') },
    { label: '跳个舞 ♪', click: act('dance') },
    { label: '说句话', click: act('talk') },
    { label: '现在几点？', click: act('time') },
    { type: 'separator' },
    { label: stats.pomodoro ? '停止番茄钟 🍅' : '开始番茄钟 🍅（25 分钟）', click: act('pomodoro') },
    ...(process.platform === 'darwin' ? [{ label: '跟唱音乐', submenu: [
      { label: '波点音乐播放时跟着唱', type: 'checkbox', checked: settings.singAlong, click: () => {
        toggle('singAlong');
        settings.singAlong ? startNowPlaying() : stopNowPlaying();
      } },
      ...(song ? [{ label: `正在播放：${song.title}${song.artist ? ' - ' + song.artist : ''}`, enabled: false }] : []),
      { label: '舞步模式（放歌时跟着节拍跳舞）', type: 'checkbox', checked: settings.danceMode, click: () => toggle('danceMode') },
      { label: '舞步预览（不放音乐试跳一段）', click: act('dance-preview') },
      { type: 'separator' },
      { label: '打开本地歌词文件夹…', click: () => shell.openPath(lyrics.localDir) },
    ] }] : []),
    { label: 'AI 对话', submenu: [
      { label: ai && ai.ready ? '已连接 DeepSeek' : '未配置 DeepSeek Key（需要环境变量 DEEPSEEK_API_KEY）', enabled: false },
      { label: '闲聊时用 AI 生成台词', type: 'checkbox', checked: settings.aiOn, enabled: !!ai && ai.ready, click: () => toggle('aiOn') },
      { label: '和她聊天…', accelerator: CHAT_KEY, enabled: !!ai && ai.ready, click: openChat },
      { type: 'separator' },
      { label: '清空聊天记忆', enabled: !!ai && ai.history.length > 0, click: () => ai.clearHistory() },
      { label: '删除本地保存的 Key', enabled: !!ai && ai.ready, click: () => { ai.clearKey(); send('settings', settings); } },
    ] },
    { label: '喝水提醒（每 45 分钟）', type: 'checkbox', checked: settings.water, click: () => toggle('water') },
    { type: 'separator' },
    { label: '静音', type: 'checkbox', checked: settings.muted, click: () => toggle('muted') },
    { label: '配音', submenu: [
      { label: '开启配音', type: 'checkbox', checked: settings.voiceOn, click: () => toggle('voiceOn') },
      { type: 'separator' },
      ...Object.entries(VOICES).map(([k, v]) => ({
        label: v.label, type: 'radio', checked: settings.voiceKey === k,
        click: () => { settings.voiceKey = k; saveSettings(); send('settings', settings); send('action', 'voice-sample'); },
      })),
    ] },
    { label: '模型', submenu: [
      { label: 'Q 版猫娘', type: 'radio', checked: activeModel() === 'chibi', click: () => setModel('chibi') },
      // 未下载的模型保持可点：点了会弹出下载指引并可一键打开 models 文件夹
      ...MODELS.map((m) => {
        const has = exists(mmdEntry(m.id));
        return {
          label: has ? m.label : `${m.label}（未下载，点此查看获取方式）`, type: 'radio',
          checked: activeModel() === m.id, click: () => setModel(m.id),
        };
      }),
      ...(settings.customPath ? [{
        label: `${mmdEntry('custom').label}（自选）`, type: 'radio', enabled: exists(mmdEntry('custom')),
        checked: activeModel() === 'custom', click: () => setModel('custom'),
      }] : []),
      { type: 'separator' },
      { label: '模组库（按人物选）', submenu: modMenu() },
      { label: '选择其他 PMX 模型…', click: pickModel },
      { label: '打开模型文件夹…', click: () => { fs.mkdirSync(modelsDir(), { recursive: true }); shell.openPath(modelsDir()); } },
      { label: '动作风格', enabled: activeModel() !== 'chibi', submenu: [
        ['calm', '平稳（默认）'], ['light', '轻微颤动'], ['lively', '原样（活泼，头发会细细颤动）'],
      ].map(([k, label]) => ({
        label, type: 'radio', checked: settings.motionStyle === k,
        click: () => { settings.motionStyle = k; saveSettings(); send('settings', settings); },
      })) },
      { label: '物理效果（头发 / 披风飘动）', type: 'checkbox', checked: settings.physics, enabled: activeModel() !== 'chibi',
        click: () => { settings.physics = !settings.physics; saveSettings(); win && win.webContents.reload(); } },
    ] },
    { label: '大小', submenu: Object.keys(CHIBI_SIZES).map(n => ({ label: n, type: 'radio', checked: settings.size === n, click: () => setSize(n) })) },
    { label: '透明度', submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2].map((v) => ({
      label: `${Math.round(v * 100)}%${v === 1 ? '（不透明）' : ''}`, type: 'radio', checked: Math.abs(settings.opacity - v) < 0.01,
      click: () => { settings.opacity = v; saveSettings(); if (win) win.setOpacity(v); },
    })) },
    { label: '总在最前', type: 'checkbox', checked: settings.onTop, click: () => toggle('onTop') },
    {
      label: '开机自启', type: 'checkbox', checked: settings.autoStart,
      click: (item) => { settings.autoStart = item.checked; saveSettings(); syncAutoStart(); },
    },
    { label: '回到屏幕右下角', click: () => {
      const { workArea } = screen.getPrimaryDisplay();
      const [w, h] = sizeOf();
      win.setBounds({ x: workArea.x + workArea.width - w - 40, y: workArea.y + workArea.height - h, width: w, height: h });
    } },
    { type: 'separator' },
    { label: '退出', click: () => { send('action', 'bye'); setTimeout(() => app.quit(), 2200); } },
  ]);
}

// 用代码画一个小猫脸托盘图标（BGRA 位图），不依赖外部图片
function catIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 16;
  const inTri = (px, py, ax, ay, bx, by, cx, cy) => {
    const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = d(px, py, ax, ay, bx, by), d2 = d(px, py, bx, by, cx, cy), d3 = d(px, py, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / s, y = (j + 0.5) / s;
    let c = null;
    const face = (x - 8) ** 2 / 36 + (y - 9.5) ** 2 / 25 <= 1;
    const ear = inTri(x, y, 2.5, 1, 2.8, 7, 7, 5.2) || inTri(x, y, 13.5, 1, 13.2, 7, 9, 5.2);
    if (face || ear) c = [250, 246, 255];
    if ((x - 5.6) ** 2 / 1.1 + (y - 9.3) ** 2 / 2 <= 1 || (x - 10.4) ** 2 / 1.1 + (y - 9.3) ** 2 / 2 <= 1) c = [224, 128, 60];
    if (Math.abs(y - 12.2) < 0.6 && Math.abs(x - 8) < 1.2) c = [140, 110, 240];
    const edge = !face && !ear && ((x - 8) ** 2 / 44 + (y - 9.5) ** 2 / 32 <= 1);
    if (edge) c = [120, 80, 90];
    const k = (j * size + i) * 4;
    if (c) { buf[k] = c[0]; buf[k + 1] = c[1]; buf[k + 2] = c[2]; buf[k + 3] = 255; }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function refreshTray() {
  if (!tray) return;
  const who = currentCharacter().name;
  tray.setToolTip(hidden ? `${who}（已隐藏，点这里显示）` : `${who} · 好感度 ${stats.affection}`);
}

// 只允许访问项目目录和当前模型所在目录
// Windows 上盘符大小写可能不一致（C:\ / c:\），统一小写再比
function allowed(file) {
  const roots = [__dirname];
  if (voice) roots.push(voice.dir);
  const m = mmdEntry(activeModel());
  if (m && m.file) roots.push(path.dirname(m.file));
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const f = norm(file);
  return roots.some((r) => {
    const root = norm(path.normalize(r));
    return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

// ---------- 开机自启 ----------
// 打包版直接用系统 API 登记自己，macOS / Windows 都正确。
// 但开发模式（electron .）下 macOS 的 setLoginItemSettings 只会登记 Electron.app 本身、
// 带不上项目路径，开机会弹出一个空白的 Electron，所以 dev + macOS 走 LaunchAgent，
// 明确写清「用哪个 Electron 启动哪个项目目录」；每次启动按当前路径刷新，项目挪了也不失效。
const AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.kiana.desktop-pet.plist');
function syncAutoStart() {
  const useAgent = process.platform === 'darwin' && !app.isPackaged;
  if (!useAgent) {
    app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
    return;
  }
  try {
    if (settings.autoStart) {
      const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      fs.mkdirSync(path.dirname(AGENT), { recursive: true });
      fs.writeFileSync(AGENT, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kiana.desktop-pet</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(__dirname)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);
    } else if (fs.existsSync(AGENT)) {
      fs.rmSync(AGENT);
    }
    // 清掉旧版用 setLoginItemSettings 登记的（它只会打开 Electron 空白页）
    if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false });
  } catch (e) {
    console.warn('开机自启设置失败', e.message);
  }
}

// 只允许运行一个桌宠
// （测试时要同时开多个，可设环境变量 PET_ALLOW_MULTI=1）
if (!process.env.PET_ALLOW_MULTI && !app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  loadSettings();
  syncAutoStart();
  delete settings.tts;
  voice = new Voice(path.join(app.getPath('userData'), 'voice-cache'));
  ai = new AI(app.getPath('userData'));
  lyrics = new Lyrics(path.join(app.getPath('userData'), 'lyrics-cache'), path.join(app.getPath('music'), '琪亚娜歌词'));
  protocol.handle('app', (req) => {
    // Windows 上 pathToFileURL 产出的 pathname 形如 /C:/…，直接 path.normalize 会变成 \C:\…（非法路径，
    // 导致 allowed() 对自家页面都判 false → 403 白屏）。统一用 fileURLToPath 还原，顺带处理百分号转义。
    let file;
    try {
      file = path.normalize(fileURLToPath('file://' + new URL(req.url).pathname));
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!allowed(file)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();

  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: catIcon(16).toPNG() });
  img.addRepresentation({ scaleFactor: 2, buffer: catIcon(32).toPNG() });
  tray = new Tray(img);
  refreshTray();
  const pop = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', pop);
  tray.on('right-click', pop);
  globalShortcut.register(HOTKEY, toggleHidden);
  globalShortcut.register(CHAT_KEY, openChat);
  startNowPlaying();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopNowPlaying(); });
