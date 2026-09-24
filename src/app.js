// 渲染进程：场景、动画状态机、交互、提醒
import * as THREE from '../node_modules/three/build/three.module.js';
import { createChibi } from './avatars/chibi.js';
import { createMMD } from './avatars/mmd.js';
import { Sfx } from './sfx.js';
import { LINES as BASE_LINES, pick, hourLine, openingLine, durationText } from './lines.js';
import { Choreographer } from './dance.js';

// 在普通浏览器里打开时（调试用）提供空实现
const api = window.petAPI || {
  setIgnore() {}, dragStart() {}, dragEnd: async () => false, showMenu() {}, sendStats() {}, quit() {}, on() {},
  getSettings: async () => ({}),
};
const boot = await api.getSettings();

const sfx = new Sfx();
const $bubble = document.getElementById('bubble');
const $pomo = document.getElementById('pomo');
const canvas = document.getElementById('scene');

// ---------- three.js 场景 ----------
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 500);

let avatar = null, loadError = null;
if (boot.model !== 'chibi' && boot.modelUrl) {
  try { avatar = await createMMD(boot.modelUrl, { physics: boot.physics !== false, profile: boot.modelProfile || {}, motionStyle: boot.motionStyle }); } catch (e) { loadError = e; console.error(e); }
}
if (!avatar) avatar = createChibi();
scene.add(avatar.root);
{
  const f = avatar.frame;
  camera.fov = f.fov;
  camera.far = f.pos[2] * 4;
  camera.position.set(...f.pos);
  camera.lookAt(...f.look);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => { resize(); placeBubble(); });
resize();

// ---------- 状态 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  settings: { muted: false, voiceOn: true, water: true, ...boot },
  affection: boot.affection ?? store.get('affection', 0),
  fed: 0,
  action: null,
  sleeping: false,
  dragging: false,
  down: null,
  lastInteract: Date.now(),
  nextIdle: Date.now() + 20000,
  lastWater: Date.now(),
  lastHour: new Date().getHours(),
  pomoEnd: 0,
  cursor: { x: -1, y: -1, t: 0 },
  look: { x: 0, y: 0, tx: 0, ty: 0 },
  blinkAt: 0,
  earTwitch: null,
  rub: 0,
  lastRub: null,
  interactive: false,
  talkUntil: 0,
  lastClick: 0,
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now() / 1000;

function pushStats() {
  api.sendStats({ affection: S.affection, pomodoro: S.pomoEnd > 0 });
}

function addAffection(n) {
  const before = S.affection;
  S.affection += n;
  store.set('affection', S.affection);
  pushStats();
  const p = headScreen();
  fx(`+${n} 💗`, p.x + 40, p.y - 10, { size: 14, dy: '-50px' });
  if (Math.floor(before / 50) !== Math.floor(S.affection / 50)) {
    setTimeout(() => { sfx.sparkle(); play('happy', 2); say(`${pick(LINES.love)}（好感度 ${S.affection}）`); burst(['💖', '✨', '💕'], 8); }, 1500);
  }
}

// ---------- 固定台词的角色适配 ----------
// lines.js 里的台词是按琪亚娜写的。换成别的角色时，把三类专属用语换掉：
// 自称、对玩家的称呼、句尾口癖。角色档案由主进程的 characters.js 算好后随设置传过来
// （渲染进程是 ESM，require 不到主进程模块，所以这里重写一份同样的替换逻辑）。
// 琪亚娜时直接原样返回，保证原有台词一个字都不变。
const CH = boot.character || null;
const isKiana = !CH || (CH.name === '琪亚娜' && CH.you === '舰长');
function adaptLine(text) {
  if (isKiana || !text) return text;
  let s = text;
  if (CH.you !== '舰长') s = s.split('舰长').join(CH.you);
  if (CH.self !== '本小姐') s = s.split('本小姐').join(CH.self);
  if (CH.tic !== '喵') {
    s = s.split('喵').join(CH.tic);
    if (CH.tic) s = s.split(CH.tic + '？').join('？').split(CH.tic + '。').join('。');
  }
  return s;
}

// ---------- 角色专属台词 ----------
// 把角色自己的台词盖到通用台词上（只盖写了的分类，其余仍用通用的走用语替换）。
// 没有专属台词的角色（含琪亚娜）拿到的就是原来的 LINES 本身，引用都不变。
const LINES = (() => {
  const ov = CH && CH.lines;
  if (!ov) return BASE_LINES;
  const out = { ...BASE_LINES };
  for (const k of Object.keys(ov)) {
    out[k] = k === 'greet' ? { ...BASE_LINES.greet, ...ov.greet } : ov[k];
  }
  return out;
})();

// ---------- 角色的动作幅度 ----------
// 有的角色沉稳、有的元气，动作幅度跟着人走。ENERGY === 1 时下面两个函数都是恒等映射，
// 琪亚娜（以及所有没写动作档案的角色）的动作与改动前逐帧一致。
const ENERGY = (CH && CH.motion && CH.motion.energy) || 1;
const scaleArr = ENERGY === 1 ? (a) => a : (a) => (Array.isArray(a) ? a.map((v) => v * ENERGY) : a);
const scaleDance = ENERGY === 1 ? (d) => d : (d) => {
  if (!d) return d;
  const o = {};
  // turn 是整体转身角度，缩放它会让转圈转不满一圈，所以保持原值
  for (const k in d) o[k] = typeof d[k] === 'number' && k !== 'turn' ? d[k] * ENERGY : d[k];
  return o;
};

// ---------- 对话气泡 ----------
let typeTimer = null, hideTimer = null, sayId = 0;
const voiceWanted = () => S.settings.voiceOn !== false && !S.settings.muted && !!window.petAPI;

function say(text, hold, { silent = false } = {}) {
  text = adaptLine(text);   // 琪亚娜时原样返回；换角色时改掉自称/称呼/口癖
  const id = ++sayId;
  clearInterval(typeTimer);
  clearTimeout(hideTimer);
  sfx.stopVoice();
  $bubble.textContent = '';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = CH ? CH.name : '琪亚娜';   // 换角色后气泡署名跟着换
  const body = document.createElement('span');
  $bubble.append(name, body);
  $bubble.classList.add('show');
  $bubble.classList.remove('lyric');

  const chars = [...text];
  resetBubbleFit();
  $bubble.classList.toggle('long', chars.length > 34);
  placeBubble();
  let i = 0;
  // waiting：等配音；voiced：配音在播；none：没有配音，用打字音效
  let mode = silent ? 'silent' : voiceWanted() ? 'waiting' : 'none';
  const t0 = now();
  S.talkUntil = t0 + chars.length * 0.05 + 0.1;
  typeTimer = setInterval(() => {
    if (i >= chars.length) { clearInterval(typeTimer); return; }
    body.textContent += chars[i];
    if (mode === 'none' && i % 2 === 0) sfx.blip(chars[i]);
    i++;
    placeBubble();   // 打字时气泡在长高，每个字都重新贴一次头顶
  }, 50);
  const hideIn = (sec) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => $bubble.classList.remove('show'), sec * 1000);
  };
  hideIn(hold || Math.max(3, chars.length * 0.16 + 1.8));

  if (mode === 'waiting') {
    // 没缓存的句子要现合成（1.5~3 秒，网络差时更久），按长度放宽等待（最多 12 秒）
    const limit = Math.min(12000, Math.max(4000, 2000 + chars.length * 120));
    const timeout = new Promise((r) => setTimeout(() => r(null), limit));
    Promise.race([api.voiceGet(text), timeout]).then(async (url) => {
      if (id !== sayId) return;
      if (!url) { mode = 'none'; return; }
      // 先让喵叫出来，再接配音
      const wait = 0.25 - (now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
      if (id !== sayId) return;
      const dur = await sfx.playVoice(url);
      if (id !== sayId) return;
      if (!dur) { mode = 'none'; return; }
      mode = 'voiced';
      S.talkUntil = 0; // 口型改由配音音量驱动
      hideIn(Math.max(hold || 0, dur + 1.8, chars.length * 0.1 + 1.5));
    }).catch(() => { mode = 'none'; });
  }
}
$bubble.addEventListener('click', () => { clearTimeout(hideTimer); $bubble.classList.remove('show'); sfx.stopVoice(); sfx.pop(); });

// ---------- 飘浮特效 ----------
function fx(text, x, y, { size = 20, dx = `${rand(-30, 30)}px`, dy = '-90px', d = 1.4, cls = '' } = {}) {
  const el = document.createElement('div');
  el.className = `fx ${cls}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.fontSize = `${size}px`;
  el.style.setProperty('--dx', dx);
  el.style.setProperty('--dy', dy);
  el.style.setProperty('--d', `${d}s`);
  el.style.setProperty('--r', `${rand(-25, 25)}deg`);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), d * 1000 + 100);
}

function burst(list, n = 5) {
  const p = headScreen();
  for (let i = 0; i < n; i++) {
    setTimeout(() => fx(pick(list), p.x + rand(-50, 50), p.y + rand(-20, 30), { size: rand(14, 24) }), i * 90);
  }
}

const _v = new THREE.Vector3();
// ---------- 气泡避让头部 ----------
// 气泡原来是 top 固定、内容变长往下长，歌词一长就压到脸上。改成「底边贴着头顶上方」
// 往上长；上方空间不够时先缩字号（long → tiny），仍放不下才裁并做渐隐。
const BUBBLE_GAP = 10;   // 气泡底边与头顶的间距，同时给起伏/跳舞留一点余量
const BUBBLE_TOP = 4;    // 距窗口顶边的最小留白
// 换一句话时把上一句留下的收窄状态清掉，否则会一直保持小字号
function resetBubbleFit() {
  $bubble.classList.remove('tiny', 'clip');
  $bubble.style.maxHeight = '';
}
function placeBubble() {
  if (!$bubble.classList.contains('show')) return;
  const headY = headScreen().y;
  // 气泡底边不得越过这条线（headAnchor 已经在头顶之上，再留 GAP）
  const floor = Math.max(BUBBLE_TOP + 24, headY - BUBBLE_GAP);
  const avail = floor - BUBBLE_TOP;

  // 逐级收窄：正常 → long（小字）→ tiny（更小）→ 裁切
  $bubble.classList.remove('clip');
  $bubble.style.maxHeight = '';
  let h = $bubble.getBoundingClientRect().height;
  if (h > avail && !$bubble.classList.contains('long')) {
    $bubble.classList.add('long');
    h = $bubble.getBoundingClientRect().height;
  }
  if (h > avail && !$bubble.classList.contains('tiny')) {
    $bubble.classList.add('tiny');
    h = $bubble.getBoundingClientRect().height;
  }
  if (h > avail) {
    $bubble.style.maxHeight = avail + 'px';
    $bubble.classList.add('clip');
    h = avail;
  }
  $bubble.style.top = Math.max(BUBBLE_TOP, floor - h) + 'px';
}

function toScreen(world) {
  _v.copy(world).project(camera);
  return { x: (_v.x * 0.5 + 0.5) * window.innerWidth, y: (-_v.y * 0.5 + 0.5) * window.innerHeight };
}
const headScreen = () => toScreen(avatar.headAnchor());

// 律者模型没有猫耳和尾巴，跳过相关台词
const idleLine = () => pick(avatar.hasCatParts ? LINES.idle : LINES.idle.filter((l) => !/猫耳|尾巴/.test(l)));

// ---------- 动作 ----------
function play(name, dur, opts = {}) {
  S.action = { name, t0: now(), dur, ...opts };
}

function wake(silent) {
  if (!S.sleeping) return false;
  S.sleeping = false;
  if (!silent) {
    sfx.meow(0.9, 0.7);
    play('stretch', 2.2);
    say(pick(LINES.wake));
  }
  return true;
}

function touch() {
  S.lastInteract = Date.now();
  S.nextIdle = Date.now() + rand(30000, 60000);
}

function doPat() {
  touch();
  if (wake()) return;
  play('pat', 2.2);
  logEvent('舰长摸了摸你的头');
  sfx.purr(2);
  setTimeout(() => sfx.meow(1.25, 0.4), 350);
  say(pick(LINES.pat));
  burst(['💕', '💖', '✨', '💗'], 5);
  addAffection(1);
}

function doFeed() {
  touch();
  wake(true);
  const p = toScreen(avatar.mouthAnchor());
  fx('🐟', p.x, p.y, { cls: 'fish', size: 26, d: 0.9 });
  sfx.whoosh();
  setTimeout(() => {
    if (S.fed >= 5) {
      play('shake', 1.2);
      sfx.meow(0.8, 0.6);
      say(pick(LINES.full));
      return;
    }
    S.fed++;
    logEvent('舰长喂你吃了小鱼干');
    play('eat', 1.8);
    sfx.munch();
    setTimeout(() => { sfx.meow(1.3, 0.45); sfx.heart(); }, 900);
    say(pick(LINES.feed));
    burst(['✨', '💖', '🌟'], 4);
    addAffection(3);
  }, 800);
}

function doDance() {
  touch();
  wake(true);
  play('dance', 4.4);
  logEvent('你刚跳了一段舞');
  sfx.tune();
  say(pick(LINES.dance));
  const iv = setInterval(() => burst(['♪', '♫', '✨', '🎵'], 2), 600);
  setTimeout(() => clearInterval(iv), 4200);
  addAffection(1);
}

function doTalk() {
  touch();
  wake(true);
  sfx.meow(rand(1, 1.3), 0.45);
  play('tilt', 1.6);
  chatter();
}

// ---------- AI ----------
const HOLIDAY_NAMES = { '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '4-1': '愚人节', '5-1': '劳动节', '5-20': '520', '6-1': '儿童节', '10-1': '国庆节', '10-31': '万圣节', '12-7': '琪亚娜的生日', '12-24': '平安夜', '12-25': '圣诞节' };
const FORM = { chibi: 'chibi', flamescion: 'flamescion', finality: 'finality', diva: 'diva', custom: 'custom' };
let aiStatus = { ready: false, on: false };
const aiOn = () => aiStatus.ready && S.settings.aiOn !== false && !!window.petAPI;
const refreshAi = () => api.aiStatus?.().then((st) => { aiStatus = st; }).catch(() => {});
refreshAi();

S.events = [];
function logEvent(text) {
  S.events.push({ text, at: Date.now() });
  S.events = S.events.filter((e) => Date.now() - e.at < 10 * 60 * 1000).slice(-4);
}

function aiCtx() {
  const d = new Date();
  return {
    time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    weekday: `星期${'日一二三四五六'[d.getDay()]}`,
    holiday: HOLIDAY_NAMES[`${d.getMonth() + 1}-${d.getDate()}`] || null,
    form: FORM[boot.model] || 'chibi',
    affection: S.affection,
    recent: S.events.map((e) => e.text),
  };
}

// AI 回复里的情绪 → 动作
function emote(emotion) {
  const map = {
    happy: () => { play('happy', 1.4); burst(['✨', '💕'], 2); },
    shy: () => { play('pat', 1.6); burst(['💗'], 2); },
    angry: () => { play('shake', 1.0); burst(['💢'], 1); },
    sad: () => play('tilt', 1.8),
    surprised: () => { play('jump', 0.7); burst(['❗'], 1); },
  };
  (map[emotion] || (() => play('tilt', 1.4)))();
}

// 闲聊：开了 AI 就让 AI 说，失败或超时用固定台词
async function chatter() {
  const fixed = () => {
    const d = new Date();
    if (d.getHours() < 5 && Math.random() < 0.4) return pick(LINES.lateNight);
    if ((d.getDay() === 0 || d.getDay() === 6) && Math.random() < 0.15) return pick(LINES.weekend);
    return idleLine();
  };
  if (!aiOn()) return say(fixed());
  const id = sayId;
  const r = await api.aiIdle(aiCtx()).catch(() => null);
  // 等 AI 的时候如果已经说了别的话，就不插嘴了
  if (id !== sayId || S.hidden) return;
  if (r && r.text) { say(r.text); if (r.emotion && r.emotion !== 'normal') emote(r.emotion); }
  else say(fixed());
}

// ---------- 聊天框 ----------
const $chat = document.getElementById('chat');
const $chatInput = document.getElementById('chat-input');
let chatBusy = false;
function openChat() {
  if (!aiOn() && !aiStatus.ready) { say('还没有配置 AI 喵…（需要 DEEPSEEK_API_KEY）'); return; }
  touch();
  wake(true);
  $chat.classList.add('show');
  api.setIgnore(false);
  api.focusWindow();
  setTimeout(() => $chatInput.focus(), 50);
  if (!$bubble.classList.contains('show')) say(pick(['想聊什么呀舰长？', '嗯嗯，我在听喵～', '说吧说吧～']), 0, { silent: true });
}
function closeChat() {
  $chat.classList.remove('show');
  $chatInput.blur();
}
$chatInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { closeChat(); return; }
  if (e.key !== 'Enter' || e.isComposing || chatBusy) return;
  const text = $chatInput.value.trim();
  if (!text) return;
  $chatInput.value = '';
  chatBusy = true;
  $chat.classList.add('busy');
  touch();
  sfx.pop();
  say(pick(LINES.thinking), 30, { silent: true });
  play('tilt', 1.2);
  const r = await api.aiChat(text, aiCtx()).catch(() => ({ error: 'ipc' }));
  chatBusy = false;
  $chat.classList.remove('busy');
  if (!r || r.error) { say(pick(LINES.aiFail)); return; }
  logEvent(`舰长和你聊了「${text.slice(0, 20)}」`);
  sfx.meow(rand(1.05, 1.3), 0.35);
  say(r.text);
  emote(r.emotion);
});
$chatInput.addEventListener('blur', () => {
  // 失焦后一会儿没输入就收起
  setTimeout(() => { if (document.activeElement !== $chatInput && !$chatInput.value && !chatBusy) closeChat(); }, 8000);
});

function doTime() {
  touch();
  wake(true);
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  const wk = '日一二三四五六'[d.getDay()];
  sfx.chime();
  play('wave', 1.8);
  say(`现在是 ${hh}:${mm}，${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${wk}喵～`);
}

function togglePomodoro() {
  touch();
  wake(true);
  if (S.pomoEnd) {
    S.pomoEnd = 0;
    $pomo.style.display = 'none';
    sfx.pop();
    say(pick(LINES.pomoStop));
  } else {
    S.pomoEnd = Date.now() + 25 * 60 * 1000;
    sfx.sparkle();
    play('wave', 1.8);
    say(pick(LINES.pomoStart));
  }
  pushStats();
}

function doBye() {
  play('wave', 2.2);
  sfx.meow(1.1, 0.7);
  say(pick(LINES.bye), 3);
  burst(['👋', '💕', '✨'], 5);
}

function onClick(part) {
  touch();
  const t = performance.now();
  const dbl = t - S.lastClick < 320;
  S.lastClick = t;
  if (dbl) { doDance(); return; }
  if (wake()) return;

  if (part === 'head') doPat();
  else if (part === 'ear') {
    play('ear', 0.9);
    logEvent('舰长捏了你的猫耳朵');
    sfx.meow(1.45, 0.3);
    say(pick(LINES.ear));
    burst(['💢', '❗'], 2);
  } else if (part === 'tail') {
    play('shake', 1.2);
    logEvent('舰长拽了你的尾巴');
    sfx.hiss();
    setTimeout(() => sfx.meow(1.5, 0.35), 200);
    say(pick(LINES.tail));
    burst(['💢', '⚡', '❗'], 3);
  } else if (part === 'bell') {
    play('happy', 1.2);
    sfx.bell();
    say(pick(LINES.bell));
    burst(['🔔', '♪', '✨'], 3);
  } else {
    play('jump', 0.7);
    sfx.boing();
    setTimeout(() => sfx.meow(rand(1, 1.25), 0.45), 120);
    say(pick(LINES.body));
  }
}

// ---------- 命中测试 / 鼠标穿透 ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hitAt(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return avatar.hit(ray);
}
function overBubble(x, y) {
  if ($chat.classList.contains('show')) {
    const c = $chat.getBoundingClientRect();
    if (x >= c.left && x <= c.right && y >= c.top - 4 && y <= c.bottom + 4) return true;
  }
  if (!$bubble.classList.contains('show')) return false;
  const r = $bubble.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom + 6;
}

function updateHover(x, y) {
  const part = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight ? hitAt(x, y) : null;
  const over = !!part || overBubble(x, y) || S.dragging || !!S.down;
  if (over !== S.interactive) {
    S.interactive = over;
    api.setIgnore(!over);
  }
  document.body.style.cursor = S.dragging ? 'grabbing' : part === 'head' ? 'pointer' : part ? 'grab' : 'default';

  // 在头上来回“撸”也算摸头
  if (part === 'head' && !S.down && !S.dragging) {
    if (S.lastRub) S.rub += Math.hypot(x - S.lastRub.x, y - S.lastRub.y);
    S.lastRub = { x, y };
    if (S.rub > 450) { S.rub = 0; if (!S.action || S.action.name !== 'pat') doPat(); }
  } else {
    S.lastRub = null;
  }
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const part = hitAt(e.clientX, e.clientY);
  if (!part) return;
  S.down = { part };
  api.dragStart();
});
window.addEventListener('mouseup', async (e) => {
  if (e.button !== 0 || !S.down) return;
  const d = S.down;
  S.down = null;
  const moved = await api.dragEnd();
  if (!moved) onClick(d.part);
});
window.addEventListener('mousemove', (e) => {
  // 保险：如果错过了 mouseup，按键已松开就结束拖动
  if (S.down && e.buttons === 0) window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  updateHover(e.clientX, e.clientY);
});
window.addEventListener('blur', () => { if (S.down) window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })); });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.showMenu(); });

api.on('cursor', (c) => {
  if (c.x !== S.cursor.x || c.y !== S.cursor.y) S.cursor = { x: c.x, y: c.y, t: now() };
  updateHover(c.x, c.y);
});
api.on('settings', (s) => {
  S.settings = s;
  sfx.muted = !!s.muted || !!S.hidden;
  avatar.setMotionStyle?.(s.motionStyle);
  refreshAi();
  sfx.meowVol = voiceWanted() ? 0.5 : 1;
  if (!voiceWanted()) sfx.stopVoice();
});
api.on('long-work', (min) => {
  if (S.hidden || S.singing) return;
  touch();
  wake(true);
  sfx.chime();
  play('wave', 1.8);
  say(pick(LINES.longWork).replace('%s', durationText(min)));
  burst(['☕', '🧘', '✨'], 4);
});
api.on('hidden', (h) => {
  S.hidden = h;
  sfx.muted = h || !!S.settings.muted;
  if (h) {
    sfx.stopVoice();
    clearInterval(typeTimer);
    $bubble.classList.remove('show');
    S.down = null;
    S.dragging = false;
    return;
  }
  touch();
  S.sleeping = false;
  // 番茄钟到点被叫出来的，交给定时器去庆祝
  if (S.pomoEnd && S.pomoEnd <= Date.now()) return;
  setTimeout(() => {
    play('wave', 2);
    sfx.meow(1.2, 0.5);
    say(pick(LINES.back));
    burst(['✨', '💕'], 4);
  }, 300);
});
api.on('drag-state', (on) => {
  S.dragging = on;
  touch();
  if (on) {
    wake(true);
    S.action = null;
    sfx.whoosh();
    sfx.meow(1.4, 0.5);
    say(pick(LINES.dragStart));
  } else {
    sfx.thud();
    play('dizzy', 1.6);
    setTimeout(() => say(pick(LINES.dragEnd)), 500);
  }
});
api.on('action', (a) => {
  ({ pat: doPat, feed: doFeed, dance: doDance, talk: doTalk, time: doTime, pomodoro: togglePomodoro, bye: doBye,
     chat: openChat,
     'dance-preview': dancePreview,
     'voice-sample': () => { touch(); wake(true); play('wave', 1.8); say('舰长，这个声音喜欢吗？本小姐可是天才美少女哦！'); } })[a]?.();
});

// 浏览器调试：没有主进程推送鼠标位置
if (!window.petAPI) {
  window.addEventListener('mousemove', (e) => { S.cursor = { x: e.clientX, y: e.clientY, t: now() }; });
}

// ---------- 跟唱（波点音乐等） ----------
// 系统拿不到音乐的实时音量，口型按歌词时间轴逐字开合；没有时间轴就哼唱
const songPos = () => (S.song ? S.song.pos + (S.song.playing ? (Date.now() - S.song.at) / 1000 : 0) : 0);

function syllables(text) {
  let n = 0;
  for (const w of text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|[A-Za-z']+/g) || []) {
    n += /^[A-Za-z']+$/.test(w) ? Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) || []).length) : 1;
  }
  return n;
}

function onSong(song) {
  const prev = S.song;
  S.song = song;
  if (!song || !song.playing) {
    if (S.singing) {
      S.singing = false;
      if (!S.hidden && prev && Date.now() - S.singStart > 15000) say(pick(LINES.singPause), 0, { silent: true });
    }
    return;
  }
  if (!prev || prev.id !== song.id) {
    S.lyr = null;
    S.lineIdx = -1;
    S.bpmInfo = null;
    const id = song.id;
    api.songBpm?.(song.title, song.artist).then((r) => { if (S.song && S.song.id === id) S.bpmInfo = r; }).catch(() => {});
  }
  if (!S.singing) {
    S.singing = true;
    S.singStart = Date.now();
    S.lineIdx = -1;
    wake(true);
    touch();
    if (!S.hidden && (!prev || prev.id !== song.id || Date.now() - (S.lastAnnounce || 0) > 60000)) {
      S.lastAnnounce = Date.now();
      S.announceUntil = Date.now() + 3500;
      play('happy', 1.4);
      burst(['♪', '♫', '🎵', '✨'], 5);
      say(pick(LINES.singStart).replace('%s', song.title), 3.2, { silent: true });
    }
  } else if (prev && prev.id !== song.id && !S.hidden) {
    S.announceUntil = Date.now() + 3000;
    burst(['♪', '♫', '🎵'], 4);
    say(pick(LINES.singNext).replace('%s', song.title), 2.8, { silent: true });
  }
}

function currentLine(pos) {
  const L = S.lyr && S.lyr.synced ? S.lyr.lines : null;
  if (!L || !L.length) return null;
  let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t <= pos + 0.12) i = k; else break; }
  if (i < 0) return null;
  const next = L[i + 1] ? L[i + 1].t : L[i].t + 6;
  return { i, text: L[i].text, start: L[i].t, end: next };
}

function showLyric(text) {
  clearInterval(typeTimer);
  clearTimeout(hideTimer);
  $bubble.textContent = '';
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = '♪';
  const b = document.createElement('span');
  b.textContent = text;
  $bubble.append(n, b);
  resetBubbleFit();
  // 歌词一句一句地换，长度差别很大，每句都按当前长度重新判断字号
  $bubble.classList.toggle('long', [...text].length > 34);
  $bubble.classList.add('show', 'lyric');
  placeBubble();
}

// 当前唱歌口型：{ lvl 0~1, vowel 0~4, emo: 这句是否闭眼唱 }
function singMouth(pos, t) {
  const line = currentLine(pos);
  if (line) {
    const n = syllables(line.text);
    if (!n) return { lvl: 0, vowel: 0, emo: false };
    const dur = Math.min((line.end - line.start) * 0.9, n * 0.55 + 0.4);
    const u = (pos - line.start) / dur;
    if (u < 0 || u >= 1) return { lvl: 0, vowel: 0, emo: line.i % 3 === 2 };
    const k = u * n, frac = k % 1, idx = Math.floor(k);
    return { lvl: 0.25 + 0.65 * Math.pow(Math.sin(Math.PI * frac), 0.6), vowel: (idx * 7 + line.i * 3) % 5, emo: line.i % 3 === 2 };
  }
  if (S.lyr && S.lyr.synced) return { lvl: 0, vowel: 0, emo: false }; // 前奏/间奏
  // 没有时间轴：唱 4 秒歇 1.5 秒地哼
  const ph = t % 5.5;
  if (ph > 4) return { lvl: 0, vowel: 0, emo: false };
  const k = ph * 3;
  return { lvl: 0.2 + 0.5 * Math.pow(Math.sin(Math.PI * (k % 1)), 0.6), vowel: 1 + (Math.floor(k) % 3), emo: Math.floor(t / 5.5) % 3 === 1 };
}

setInterval(() => {
  if (!S.singing || S.hidden || !S.song) return;
  if (Date.now() < (S.announceUntil || 0) || sfx.voicePlaying) return;
  const pos = songPos();
  const line = currentLine(pos);
  if (line) {
    if (line.i !== S.lineIdx) {
      S.lineIdx = line.i;
      if (line.text) { showLyric(line.text); if (Math.random() < 0.5) burst(['♪', '♫'], 1); }
      else $bubble.classList.remove('show');
    }
    // 间奏太长就先收起气泡
    if (pos - line.start > 10 && $bubble.classList.contains('lyric')) $bubble.classList.remove('show');
  } else if (S.lineIdx !== -2 && !(S.lyr && S.lyr.synced)) {
    // 没有时间轴歌词：显示歌名，偶尔冒音符
    S.lineIdx = -2;
    showLyric(`《${S.song.title}》${S.song.artist ? ' - ' + S.song.artist : ''}`);
  }
  if (!line && S.lineIdx === -2 && Math.random() < 0.02) burst(['♪', '♫', '🎵'], 1);
}, 100);

api.on('song', onSong);
api.on('lyrics', (l) => { if (S.song && l && l.id === S.song.id) { S.lyr = l; S.lineIdx = -1; } });

// ---------- 舞步模式 ----------
// 波点放歌时按节拍跳舞：节拍 = 歌曲进度 × BPM；每 8 拍一个小节，按歌词判断前奏/主歌/副歌/结尾来挑舞步
const danceOn = () => S.settings.danceMode !== false;
let choreo = null;
const normLine = (x) => (x || '').replace(/[\s，。！？,.!?'"“”‘’（）()~～-]/g, '').toLowerCase();

function effectiveBpm() {
  let b = (S.bpmInfo && S.bpmInfo.bpm) || 120;
  // 太快的歌跳半拍，太慢的跳双拍，动作才看得清
  while (b > 135) b /= 2;
  while (b < 70) b *= 2;
  return b;
}

// 副歌 = 歌词里重复出现的句子
function chorusSet() {
  const L = S.lyr;
  if (!L) return new Set();
  if (L._chorus) return L._chorus;
  const count = new Map();
  for (const l of L.lines) {
    const k = normLine(l.text);
    if (k.length >= 3) count.set(k, (count.get(k) || 0) + 1);
  }
  L._chorus = new Set([...count].filter(([, n]) => n >= 2).map(([k]) => k));
  return L._chorus;
}

// 让 8 拍小节的起点对齐第一句歌词（歌手一般在强拍开唱）
function songPhase(spb) {
  const first = S.lyr && S.lyr.synced && S.lyr.lines.find((l) => l.text);
  if (!first) return 0;
  const bar = 8 * spb;
  return ((first.t % bar) + bar) % bar;
}

function blockKind(idx, phase, spb) {
  const t0 = phase + idx * 8 * spb, t1 = t0 + 8 * spb;
  const dur = (S.song && S.song.duration) || 0;
  if (dur && t1 > dur - 1) return 'end';
  const L = S.lyr && S.lyr.synced ? S.lyr.lines.filter((l) => l.text) : null;
  if (!L || !L.length) return idx < 2 ? 'intro' : idx % 4 >= 2 ? 'chorus' : 'verse';
  if (t1 <= L[0].t) return 'intro';
  let inBlock = L.filter((l) => l.t >= t0 - 0.5 && l.t < t1);
  if (!inBlock.length) {
    // 这 8 拍里没有新句子：上一句还在唱就沿用它，否则是间奏
    const before = L.filter((l) => l.t < t0).pop();
    if (!before || t0 - before.t > 6) return 'intro';
    inBlock = [before];
  }
  const ch = chorusSet();
  return inBlock.some((l) => ch.has(normLine(l.text))) ? 'chorus' : 'verse';
}

// 返回当前舞蹈时钟 { beat, kindOf, seed, bpm }，不跳舞时返回 null
function danceClock() {
  if (S.preview) {
    const beat = (now() - S.preview.t0) * S.preview.bpm / 60;
    if (beat > S.preview.beats) { S.preview = null; return null; }
    const kinds = ['intro', 'verse', 'chorus', 'chorus', 'end'];
    return { beat, kindOf: (i) => kinds[Math.min(i, kinds.length - 1)], seed: 'preview', bpm: S.preview.bpm };
  }
  if (!S.singing || !S.song || !danceOn()) return null;
  const bpm = effectiveBpm(), spb = 60 / bpm;
  const phase = songPhase(spb);
  return { beat: (songPos() - phase) / spb, kindOf: (i) => blockKind(i, phase, spb), seed: S.song.id, bpm };
}

function dancePreview() {
  touch();
  wake(true);
  S.preview = { t0: now() + 0.6, bpm: 120, beats: 40 };
  say('看本小姐的新舞步喵～', 2.5);
  burst(['♪', '♫', '✨'], 4);
}

// ---------- 定时行为 ----------
setInterval(() => {
  const t = Date.now();
  const d = new Date();

  // 隐藏期间：番茄钟到点会自己跳出来，其它提醒先攒着
  if (S.hidden) {
    if (S.pomoEnd && S.pomoEnd - t <= 0) api.requestShow();
    return;
  }

  // 整点报时
  if (d.getMinutes() === 0 && d.getHours() !== S.lastHour) {
    S.lastHour = d.getHours();
    wake(true);
    sfx.chime();
    play('wave', 1.8);
    say(hourLine(d.getHours()));
    return;
  }
  if (d.getMinutes() !== 0) S.lastHour = -1;

  // 番茄钟
  if (S.pomoEnd) {
    const left = S.pomoEnd - t;
    if (left <= 0) {
      S.pomoEnd = 0;
      $pomo.style.display = 'none';
      wake(true);
      sfx.chime();
      setTimeout(() => sfx.meow(1.2, 0.5), 800);
      play('dance', 3);
      say(pick(LINES.pomoDone));
      burst(['🍅', '🎉', '✨'], 6);
      pushStats();
      return;
    }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $pomo.textContent = `🍅 ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $pomo.style.display = 'block';
  }

  // 喝水提醒
  if (S.settings.water && t - S.lastWater > 45 * 60 * 1000) {
    S.lastWater = t;
    wake(true);
    sfx.chime();
    play('wave', 1.8);
    say(pick(LINES.water));
    burst(['💧', '🥤', '💦'], 5);
    return;
  }

  // 吃饱了会慢慢消化
  if (S.fed > 0 && Math.random() < 1 / 300) S.fed--;

  if (S.sleeping) {
    if (t % 3000 < 1000) {
      const p = headScreen();
      fx(pick(['z', 'Z', 'z']), p.x + 30, p.y - 10, { size: rand(12, 20), dx: '25px', dy: '-60px', d: 2.2 });
    }
    if (Math.random() < 0.12) sfx.snore();
    return;
  }

  if (S.action || S.dragging || S.singing || S.preview || sfx.voicePlaying) return; // 配音没播完不插嘴

  // 太久没人理就睡着
  if (t - S.lastInteract > 3 * 60 * 1000) {
    S.sleeping = true;
    sfx.meow(0.8, 0.9);
    say(pick(LINES.sleepy));
    return;
  }

  // 闲置小动作
  if (t > S.nextIdle) {
    S.nextIdle = t + rand(25000, 60000);
    const r = Math.random();
    if (r < 0.45) { sfx.meow(rand(0.95, 1.3), 0.45); play('tilt', 1.6); chatter(); }
    else if (r < 0.6) { sfx.meow(0.85, 0.8); play('stretch', 2.2); }
    else if (r < 0.75) { play('look', 3); }
    else if (r < 0.88) { play('wave', 1.8); sfx.meow(1.2, 0.4); }
    else { play('jump', 0.7); sfx.boing(); }
  }
}, 1000);

// ---------- 动画 ----------
let last = now();
const lerp = (a, b, k) => a + (b - a) * k;

function animate() {
  requestAnimationFrame(animate);
  if (S.hidden) { last = now(); return; } // 隐藏时不渲染、不跑物理，省电
  const t = now();
  const dt = Math.min(0.05, t - last);
  last = t;

  let a = S.action;
  let p = 0;
  if (a) {
    p = (t - a.t0) / a.dur;
    if (p >= 1) { S.action = a = null; p = 0; }
  }
  const dc = !S.dragging && !a ? danceClock() : null;
  const name = S.dragging ? 'drag' : a ? a.name : dc ? 'dancing' : S.singing ? 'sing' : S.sleeping ? 'sleep' : 'idle';
  const sm = name === 'sing' || (name === 'dancing' && S.singing && !S.preview) ? singMouth(songPos(), t) : null;
  let dance = null, x = 0;

  // 默认姿态
  let eyes = 'open', mouth = 'cat', blush = 0.5, eyeScale = 1;
  let y = 0, rotY = 0, rotZ = Math.sin(t * 0.9) * 0.02, squash = 1;
  let raise = [0, 0], fwd = [0, 0];
  let headRoll = Math.sin(t * 0.7) * 0.03, headPitch = 0, headYawAdd = 0;
  let tailAmp = 0.12, tailSpeed = 2.2, tailPuff = 1;
  let legSwing = 0;
  let breath = 2.2;

  const s = Math.sin(p * Math.PI);
  switch (name) {
    case 'jump':
      y = Math.sin(p * Math.PI) * 0.35;
      squash = p < 0.12 ? 1 - Math.sin((p / 0.12) * Math.PI) * 0.1 : 1;
      raise = [s * 1.6, s * 1.6];
      eyes = 'happy'; mouth = 'open';
      break;
    case 'pat':
      eyes = 'happy'; mouth = 'smile'; blush = 1;
      headRoll = Math.sin(t * 5) * 0.12;
      headPitch = 0.12;
      squash = 1 - 0.03 * Math.abs(Math.sin(t * 5));
      tailAmp = 0.3; tailSpeed = 5;
      break;
    case 'happy':
      eyes = 'happy'; mouth = 'smile'; blush = 0.9;
      y = Math.abs(Math.sin(p * Math.PI * 3)) * 0.08;
      raise = [s * 0.6, s * 0.6];
      tailAmp = 0.3; tailSpeed = 5;
      break;
    case 'ear':
      eyes = 'closed'; mouth = 'o'; blush = 0.9;
      headRoll = Math.sin(t * 30) * 0.05 * s;
      break;
    case 'shake':
      eyeScale = 1.18; mouth = 'o';
      y = s * 0.12;
      rotZ = Math.sin(t * 50) * 0.04 * s;
      tailPuff = 1 + s * 0.5; tailAmp = 0.05; tailSpeed = 18;
      raise = [s * 2.2, s * 2.2];
      break;
    case 'dance': {
      eyes = 'happy'; mouth = 'smile'; blush = 0.8;
      const b = t * 9.5;
      y = Math.abs(Math.sin(b)) * 0.1;
      rotY = p > 0.4 && p < 0.6 ? ((p - 0.4) / 0.2) * Math.PI * 2 : Math.sin(b * 0.5) * 0.5;
      rotZ = Math.sin(b * 0.5) * 0.08;
      raise = [(Math.sin(b) + 1) * 1.2, (Math.sin(b + Math.PI) + 1) * 1.2];
      headRoll = Math.sin(b * 0.5) * 0.15;
      tailAmp = 0.35; tailSpeed = 9.5;
      legSwing = Math.sin(b) * 0.25;
      break;
    }
    case 'wave':
      mouth = 'smile';
      raise = [0, 2.3 * Math.min(1, s * 2) + Math.sin(t * 14) * 0.25 * s];
      headRoll = -0.1 * s;
      tailAmp = 0.25; tailSpeed = 4;
      break;
    case 'eat':
      eyes = 'happy'; blush = 0.9;
      mouth = Math.sin(t * 16) > 0 ? 'munch' : 'open';
      fwd = [s * 1.3, s * 1.3];
      raise = [s * 0.3, s * 0.3];
      headPitch = Math.sin(t * 16) * 0.05 + 0.08;
      tailAmp = 0.3; tailSpeed = 6;
      break;
    case 'stretch':
      eyes = 'closed'; mouth = 'o';
      raise = [s * 2.7, s * 2.7];
      squash = 1 + s * 0.06;
      headPitch = -0.2 * s;
      break;
    case 'tilt':
      headRoll = 0.22 * s;
      mouth = 'cat';
      tailAmp = 0.2;
      break;
    case 'look':
      headYawAdd = Math.sin(p * Math.PI * 2) * 0.6;
      break;
    case 'dizzy':
      eyes = 'dizzy'; mouth = 'o';
      headRoll = Math.sin(t * 9) * 0.15 * (1 - p);
      rotZ = Math.sin(t * 9) * 0.05 * (1 - p);
      break;
    case 'drag':
      eyeScale = 1.12; mouth = 'o';
      y = 0.05;
      rotZ = Math.sin(t * 4) * 0.12;
      raise = [1.4 + Math.sin(t * 12) * 0.4, 1.4 + Math.sin(t * 12 + 1) * 0.4];
      legSwing = Math.sin(t * 10) * 0.5;
      tailAmp = 0.4; tailSpeed = 8;
      break;
    case 'sing': {
      // 跟着节奏左右摇摆，双手收在胸前
      const b = t * 1.75;
      mouth = 'cat'; blush = 0.75;
      if (sm.emo) eyes = 'happy';
      y = Math.abs(Math.sin(b)) * 0.025;
      rotZ = Math.sin(b) * 0.05;
      headRoll = Math.sin(b) * 0.12;
      headPitch = -0.05;
      raise = [0.35 + Math.sin(b) * 0.08, 0.35 - Math.sin(b) * 0.08];
      fwd = [0.55, 0.55];
      tailAmp = 0.28; tailSpeed = 3.5;
      break;
    }
    case 'dancing': {
      if (!choreo || choreo.seed !== dc.seed) choreo = new Choreographer(dc.seed);
      const D = choreo.pose(dc.beat, dc.kindOf);
      mouth = 'smile'; blush = 0.8;
      if (sm && sm.emo) eyes = 'happy';
      tailAmp = 0.35; tailSpeed = dc.bpm / 60 * Math.PI;
      if (avatar.kind === 'chibi') {
        // Q 版没有手肘和膝盖，把舞蹈参数折算成它已有的动作
        // 手举太高会藏到大头和长发后面，Q 版抬手封顶
        raise = [Math.min(D.rR * 0.95, 1.85), Math.min(D.rL * 0.95, 1.85)];
        fwd = [D.fR, D.fL];
        rotZ = -D.lean * 0.8;
        rotY = D.turn;
        y = D.bounce - D.squat * 0.1;
        squash = 1 - D.squat * 0.1;
        legSwing = (D.kR - D.kL) * 0.6;
        headRoll = -D.hRoll; headPitch = D.hPitch; headYawAdd = D.hYaw;
        x = D.hipX;
      } else {
        dance = D;
        headRoll = 0;
      }
      break;
    }
    case 'sleep':
      eyes = 'closed'; mouth = 'cat'; blush = 0.6;
      headPitch = 0.28; headRoll = 0.18 + Math.sin(t * 0.8) * 0.03;
      tailAmp = 0.04; tailSpeed = 0.8;
      breath = 1.1;
      break;
  }

  // 说话时嘴巴一张一合
  // 有配音时按配音音量开合，没有配音时按打字节奏
  const singing = !!sm && !sfx.voicePlaying;
  const voiceLvl = singing ? sm.lvl : sfx.voiceLevel();
  const talking = singing ? sm.lvl > 0.05 : sfx.voicePlaying || t < S.talkUntil;
  if (talking && mouth !== 'munch' && name !== 'eat') {
    const open = singing || sfx.voicePlaying ? voiceLvl > 0.3 : Math.sin(t * 22) > 0;
    if (open) mouth = 'open';
  }

  // 眨眼
  if (t > S.blinkAt) S.blinkAt = t + rand(2, 5.5);
  const bt = S.blinkAt - t;
  const blinkScale = eyes === 'open' && bt < 0.13 ? 0.12 : 1;

  // 视线跟随鼠标
  let tx = 0, ty = 0;
  const cursorFresh = t - S.cursor.t < 6 && S.cursor.x > -9999;
  if (name === 'sleep' || name === 'dizzy') {
    tx = 0; ty = 0;
  } else if (cursorFresh) {
    const h = headScreen();
    tx = clamp((S.cursor.x - h.x) / (window.innerWidth * 0.8), -1, 1);
    ty = clamp((S.cursor.y - h.y) / (window.innerHeight * 0.8), -1, 1);
  } else {
    if (!S.wander || t > S.wander.until) S.wander = { x: rand(-0.5, 0.5), y: rand(-0.2, 0.3), until: t + rand(2, 4) };
    tx = S.wander.x; ty = S.wander.y;
  }
  const kLook = 1 - Math.pow(0.001, dt);
  S.look.x = lerp(S.look.x, tx, kLook);
  S.look.y = lerp(S.look.y, ty, kLook);

  const kPose = 1 - Math.pow(0.0005, dt);
  avatar.update({
    name, eyes, mouth, blush, eyeScale, blink: blinkScale < 1, talking, voiceLvl: singing || sfx.voicePlaying ? voiceLvl : -1, vowel: singing ? sm.vowel : 0,
    y, rotY, rotZ, squash,
    // 不同角色的动作幅度不一样（琪亚娜 1.0，芽衣稳一点，布洛妮娅更收敛）。
    // ENERGY 为 1 时全部是恒等运算，琪亚娜的动作与原来完全一致。
    raise: scaleArr(raise), fwd: scaleArr(fwd), headRoll, headPitch, headYaw: headYawAdd,
    lookX: S.look.x, lookY: S.look.y,
    tailAmp, tailSpeed, tailPuff, legSwing: legSwing * ENERGY, breath, dance: scaleDance(dance), x,
    snapY: name === 'jump' || name === 'dance', snapRotY: name === 'dance' || name === 'dancing',
  }, t, dt, kPose);

  renderer.render(scene, camera);
}
animate();

// ---------- 自选模型：自动量出合适的窗口比例 ----------
// PMX 静止是 A 字站姿（手臂平举），宽度和实际运行时（手臂放下）差很多，
// 所以不能靠 geometry 包围盒估算，必须等姿势摆好、物理稳定后量真实渲染轮廓。
// 量的时候临时把画布拉到最宽比例，确保模型不会被裁掉而量少了。
if (avatar.measure && boot.model === 'custom') {
  setTimeout(() => {
    try {
      const w0 = renderer.domElement.width, h0 = renderer.domElement.height, a0 = camera.aspect;
      const hpx = window.innerHeight, wpx = Math.round(hpx * 1.4);
      renderer.setSize(wpx, hpx, false);
      camera.aspect = 1.4;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const m = avatar.measure(renderer, camera, scene);
      // 还原
      renderer.setSize(w0, h0, false);
      camera.aspect = a0;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      if (m) petAPI.reportModelMetrics(m);
    } catch (e) { console.warn('量窗口比例失败', e); }
  }, 2500);
}

// ---------- 开场 ----------
if (api.getSong) {
  api.getSong().then((r) => {
    if (!r) return;
    if (r.lyrics) S.lyr = r.lyrics;
    // 开场问候之后再开始唱
    setTimeout(() => { onSong(r.song && { ...r.song, pos: r.song.pos + 3.5, at: Date.now() }); if (r.lyrics) S.lyr = r.lyrics; }, 3500);
  }).catch(() => {});
}
// 后台把固定台词的配音提前合成好（只第一次需要联网，之后走缓存）
setTimeout(() => {
  if (!voiceWanted() || !api.voicePrefetch) return;
  const all = [];
  const walk = (v) => (Array.isArray(v) ? all.push(...v) : typeof v === 'object' && Object.values(v).forEach(walk));
  walk(LINES);
  api.voicePrefetch(all);
}, 3000);
pushStats();
setTimeout(() => {
  play('wave', 2);
  sfx.meow(1.15, 0.6);
  sfx.sparkle();
  say(loadError || boot.modelMissing ? '呜…找不到模型文件，先用 Q 版形态陪你喵！（右键 → 模型 可以重新选择）' : openingLine(new Date(), LINES));
  burst(['✨', '💕', '⭐'], 5);
}, 700);
