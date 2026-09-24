// MMD（PMX）模型适配器：骨骼驱动动作、表情 morph、Ammo 物理让头发和披风飘动
import * as THREE from '../../node_modules/three/build/three.module.js';
import { MMDLoader } from '../../node_modules/three/examples/jsm/loaders/MMDLoader.js';
import { MMDPhysics } from '../../node_modules/three/examples/jsm/animation/MMDPhysics.js';

const lerp = (a, b, k) => a + (b - a) * k;

function loadAmmo() {
  if (window.Ammo && window.Ammo.btVector3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '../node_modules/three/examples/jsm/libs/ammo.wasm.js';
    s.onload = () => window.Ammo().then((A) => { window.Ammo = A; resolve(); }, reject);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// 通用表情 → morph。每项是候选列表，按顺序取第一个模型里全都有的
const EYES = {
  happy: [{ 笑い: 1 }],
  closed: [{ まばたき: 1 }],
  dizzy: [{ はぅ: 1 }, { はちゅ目: 1 }],
};
const MOUTH = {
  cat: [{ ω: 0.6 }, { 口角上げ: 0.7 }],
  open: [{ あ: 0.75 }],
  o: [{ お: 0.8 }],
  smile: [{ ワ: 0.65 }, { にっこり: 0.8 }, { あ: 0.45, 口角上げ: 0.6 }],
  munch: [{ い: 0.7 }],
};
const BROWS = { shake: [{ 怒り: 1 }], ear: [{ 困る: 0.8 }], drag: [{ 困る: 1 }], dizzy: [{ 困る: 0.6 }] };
// 按动作替换眼睛的特殊表情（有的模型才有）
const EYES_BY_ACTION = { happy: [{ はぁと: 1 }, { 笑い: 1 }] };
const SURPRISED = [{ びっくり: 1 }, { 瞳小: 0.8 }];
// 按动作叠加的额外 morph（可以是材质 morph）。终焉律者的「翅膀出现」试过：翅膀会被物理拽得耷拉下来，暂不启用
const EXTRA_BY_ACTION = {};
// 点击判定用的材质名关键词。不同作者的命名习惯差别很大（中文 / 日文 / 英文都有），
// 所以这里只做「快速通道」：命中就直接定性，命中不了就退回下面 hit() 里的几何判定，
// 这样没见过的模型也能正确区分摸头和戳身体。注意用 search 而不是完全匹配，
// 因为常见写法是带编号或前后缀的（髪_01、hair.001、头发2）。
const HEAD_MATS = new RegExp([
  // 中文
  '头发|头饰|头冠|头带|发饰|辫子|脸|颜|眼|睛|瞳|睫毛|眉|表情|腮红|脸红|牙|舌|口腔|嘴|耳',
  // 日文（MMD 模型最常见）
  '髪|前髪|後髪|横髪|髪飾|顔|face|目|瞳|白目|眼|まつげ|まつ毛|睫毛|眉|まゆ|口|歯|舌|ベロ|耳|頬|あご',
  // 英文
  'hair|bang|face|head|eye|pupil|iris|sclera|lash|brow|mouth|lip|teeth|tongue|ear|cheek',
].join('|'), 'i');
// 明确属于身体的关键词，避免「胸」「手」里的字被上面的宽松规则误判
const BODY_MATS = new RegExp([
  '身体|肌|皮肤|衣服|上衣|裙|裤|鞋|袜|手|腕|脚|腿|披风|斗篷|armor|盔甲|武器|剑|枪|翅膀|尾',
  '体|服|スカート|靴|くつ|手袋|グローブ|マント|ケープ|鎧|武器|羽|翼|尻尾|しっぽ',
  'body|skin|cloth|dress|skirt|pant|shoe|sock|glove|hand|arm|leg|foot|cape|cloak|weapon|wing|tail|belt|ribbon',
].join('|'), 'i');

const shadowTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(60,40,90,0.35)');
  gr.addColorStop(1, 'rgba(60,40,90,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();

// 动作风格：container 是身体整体动作走外层容器的比例。
// 外层容器一动，three 的 MMD 物理就会让头发裙摆高频颤动；走根骨骼则很平稳
const MOTION_STYLES = {
  lively: { container: 1, strictGuard: true },   // 原样：活泼，带颤动
  light: { container: 0.35, strictGuard: false }, // 轻微颤动
  calm: { container: 0, strictGuard: false },     // 平稳
};

export async function createMMD(url, { physics = true, profile = {}, motionStyle = 'lively' } = {}) {
  let style = MOTION_STYLES[motionStyle] || MOTION_STYLES.lively;
  let usePhysics = physics;
  if (usePhysics) {
    try { await loadAmmo(); } catch (e) { console.warn('ammo 加载失败，关闭物理', e); usePhysics = false; }
  }
  // 截住解析结果：three 不支持材质 morph（比如终焉律者的「翅膀出现」），要自己处理
  const loader = new MMDLoader();
  let raw = null;
  const getParser = loader._getParser.bind(loader);
  loader._getParser = () => {
    const p = getParser();
    return { parsePmx: (b, l) => (raw = p.parsePmx(b, l)), parsePmd: (b, l) => (raw = p.parsePmd(b, l)) };
  };
  const mesh = await loader.loadAsync(url);
  const mats = [].concat(mesh.material);

  // 各模型的环境光系数不一（0.5~0.75），统一压到同一水平，否则有的会发白
  const EMISSIVE_MAX = new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace).r;
  for (const m of mats) {
    if (!m.emissive) continue;
    const peak = Math.max(m.emissive.r, m.emissive.g, m.emissive.b);
    if (peak > EMISSIVE_MAX) m.emissive.multiplyScalar(EMISSIVE_MAX / peak);
  }
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const H = box.max.y - box.min.y;
  const U = H / 2.1; // 与 Q 版模型的单位换算（Q 版身高约 2.1）

  const root = new THREE.Group();
  const char = new THREE.Group();
  root.add(char);
  char.add(mesh);
  root.add(new THREE.AmbientLight(0xffffff, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(-1, 2, 4);
  root.add(key);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 0.45, H * 0.45),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y + 0.02;
  root.add(shadow);

  const B = Object.fromEntries(mesh.skeleton.bones.map((b) => [b.name, b]));
  const bone = (n) => B[n] || null;
  const center = bone('センター') || bone('全ての親');
  const centerRest = center ? center.position.clone() : null;
  const head = bone('頭'), neck = bone('首'), upper = bone('上半身'), eyes = bone('両目');
  const armR = bone('右腕'), armL = bone('左腕'), elbowR = bone('右ひじ'), elbowL = bone('左ひじ');
  const legR = bone('右足'), legL = bone('左足');
  const upper2 = bone('上半身2');

  // 腿：MMD 模型通常还有一套 D 骨骼（真正带动网格的变形骨），跳舞时两套一起转
  const legSet = (s) => ({
    thigh: [bone(s + '足'), bone(s + '足D')].filter(Boolean),
    knee: [bone(s + 'ひざ'), bone(s + 'ひざD')].filter(Boolean),
    ankle: [bone(s + '足首'), bone(s + '足首D')].filter(Boolean),
  });
  const LEGS = { R: legSet('右'), L: legSet('左') };
  mesh.updateMatrixWorld(true);
  const wpos = (b) => b.getWorldPosition(new THREE.Vector3());
  const segLen = (a, b) => (a && b ? wpos(a).distanceTo(wpos(b)) : H * 0.24);
  const THIGH = segLen(LEGS.R.thigh[0], LEGS.R.knee[0]);
  const SHIN = segLen(LEGS.R.knee[0], LEGS.R.ankle[0]);
  const DANCE_KEYS = ['rR', 'rL', 'fR', 'fL', 'eR', 'eL', 'ezR', 'ezL', 'lean', 'twist', 'bend', 'hipX', 'squat', 'bounce', 'turn', 'kR', 'kL', 'hRoll', 'hPitch', 'hYaw'];
  const dcur = Object.fromEntries(DANCE_KEYS.map((k) => [k, 0]));

  // 默认是 A 字站姿，先把手臂放下来
  const REST = { arm: 0.75, elbow: 0.3 };
  const cur = { yaw: 0, pitch: 0, roll: 0, y: 0, rotY: 0, rotZ: 0, raise: [0, 0], fwd: [0, 0], leg: 0 };

  const dict = mesh.morphTargetDictionary;
  const infl = mesh.morphTargetInfluences;
  // 材质 morph：只处理不透明度（显示/隐藏部件）
  const matMorphs = {};
  for (const m of raw?.morphs || []) {
    if (m.type !== 8) continue;
    const els = m.elements.filter((e) => e.index >= 0 && mats[e.index]).map((e) => ({ mat: mats[e.index], add: e.type === 1, a: e.diffuse[3] }));
    if (els.length) matMorphs[m.name] = els;
  }
  const baseOpacity = new Map(mats.map((m) => [m, m.opacity]));
  const matWeights = {};
  function applyMatMorphs() {
    const touched = new Map();
    for (const [name, w] of Object.entries(matWeights)) {
      for (const e of matMorphs[name]) {
        let op = touched.has(e.mat) ? touched.get(e.mat) : baseOpacity.get(e.mat);
        op = e.add ? op + w * e.a : op * (1 - w + w * e.a);
        touched.set(e.mat, op);
      }
    }
    for (const [m, op] of touched) {
      m.opacity = Math.max(0, Math.min(1, op));
      m.transparent = m.opacity < 1 || baseOpacity.get(m) < 1;
      m.visible = m.opacity > 0.01;
    }
  }

  const has = (n) => n in dict || n in matMorphs;
  const choose = (cands) => (cands || []).find((c) => Object.keys(c).every(has)) || null;
  const resolve = (table) => Object.fromEntries(Object.entries(table).map(([k, c]) => [k, choose(c)]));
  const eyesM = resolve(EYES), mouthM = resolve(MOUTH), browsM = resolve(BROWS);
  const eyesAct = resolve(EYES_BY_ACTION), extraAct = resolve(EXTRA_BY_ACTION);
  const surprised = choose(SURPRISED);
  // 只控制下面这些 morph，模型里其它 morph 一律保持默认（0）
  const vowels = ['あ', 'い', 'う', 'え', 'お'].filter((n) => n in dict);
  const managed = new Set(['まばたき', '照れ', 'あ', 'なごみ', ...vowels]);
  for (const t of [eyesM, mouthM, browsM, eyesAct, extraAct, { s: surprised }]) {
    for (const m of Object.values(t)) if (m) for (const n of Object.keys(m)) managed.add(n);
  }
  const managedIdx = [...managed].filter((n) => n in dict).map((n) => [n, dict[n]]);
  const managedMat = [...managed].filter((n) => n in matMorphs);
  for (const n of managedMat) matWeights[n] = 0;
  applyMatMorphs();

  function pose(P, t, k) {
    cur.yaw = lerp(cur.yaw, P.lookX * 0.45 + P.headYaw, k);
    cur.pitch = lerp(cur.pitch, P.lookY * 0.3 + P.headPitch, k);
    cur.roll = lerp(cur.roll, P.headRoll - P.lookX * 0.06, k);
    cur.y = lerp(cur.y, P.y, P.snapY ? 0.5 : k);
    cur.rotY = P.snapRotY ? P.rotY : lerp(cur.rotY, P.rotY, k);
    cur.rotZ = lerp(cur.rotZ, P.rotZ, k);
    cur.leg = lerp(cur.leg, P.legSwing, k);
    // 真人比例的手臂很容易穿进身体把物理弄炸，这里收着点
    for (const i of [0, 1]) {
      cur.raise[i] = lerp(cur.raise[i], Math.min(P.raise[i], 2.4), k * 0.7);
      cur.fwd[i] = lerp(cur.fwd[i], P.fwd[i] * 0.35, k * 0.7);
    }

    // 舞蹈参数（叠加在平时姿势上，平滑过渡，开始/结束都不会跳变）
    const D = P.dance || {};
    const kd = Math.min(1, k * 2.5);
    for (const key of DANCE_KEYS) {
      // 转身按原值走（跨一圈时不要反向插值回去）
      dcur[key] = key === 'turn' && P.dance ? (D.turn || 0) : lerp(dcur[key], D[key] || 0, kd);
    }

    // 按动作风格把整体动作分给外层容器和根骨骼
    const f = center ? style.container : 1, g = 1 - f;
    const lift = cur.y * U * 0.35;
    char.position.y = lift * f;
    char.rotation.set(0, cur.rotY * f, cur.rotZ * f);
    // 下蹲：身体降低 drop，按大腿小腿长度算出屈膝角度，脚尽量留在原地
    const drop = Math.min(0.6, dcur.squat) * (THIGH + SHIN) * 0.35;
    const sq = Math.acos(Math.max(-1, Math.min(1, 1 - drop / (THIGH + SHIN))));
    if (center) {
      // 跳舞的整体动作一律走根骨骼，不会引起头发的高频颤动
      center.position.set(
        centerRest.x + dcur.hipX * U,
        centerRest.y + lift * g + dcur.bounce * U - drop,
        centerRest.z,
      );
      center.rotation.set(0, cur.rotY * g + dcur.turn, cur.rotZ * g - dcur.lean * 0.3);
    }
    shadow.scale.setScalar(1 - cur.y * 0.8);
    shadow.material.opacity = 1 - cur.y * 1.5;

    const br = Math.sin(t * P.breath);
    const split = upper2 ? 0.5 : 1; // 有上半身2 就把前倾/扭转分给两节，弯得更自然
    if (upper) upper.rotation.set(br * 0.015 + cur.pitch * 0.15 + dcur.bend * split, cur.yaw * 0.15 + dcur.twist * split, -dcur.lean * 0.7 * split);
    if (upper2) upper2.rotation.set(dcur.bend * split, dcur.twist * split, -dcur.lean * 0.7 * split);
    if (neck) neck.rotation.set(cur.pitch * 0.35 + dcur.hPitch * 0.4, cur.yaw * 0.35 + dcur.hYaw * 0.4, cur.roll * 0.4 - dcur.hRoll * 0.4);
    if (head) head.rotation.set(cur.pitch * 0.5 + dcur.hPitch * 0.6, cur.yaw * 0.5 + dcur.hYaw * 0.6, cur.roll * 0.6 - dcur.hRoll * 0.6);
    if (eyes) eyes.rotation.set(P.lookY * 0.12, P.lookX * 0.3, 0);

    // 屏幕左侧那只（i=0）是她的右手
    const [r0, r1] = cur.raise, [f0, f1] = cur.fwd;
    if (armR) armR.rotation.set(0, f0 * 0.9 + dcur.fR * 0.9, REST.arm - r0 * 0.85 - dcur.rR + br * 0.01);
    if (armL) armL.rotation.set(0, -f1 * 0.9 - dcur.fL * 0.9, -REST.arm + r1 * 0.85 + dcur.rL - br * 0.01);
    // 手肘：y 轴是向前弯，z 轴是在手臂抬起的平面内弯（与抬手臂同一个方向）
    if (elbowR) elbowR.rotation.set(0, REST.elbow + f0 * 1.3 + r0 * 0.25 + dcur.eR, -dcur.ezR);
    if (elbowL) elbowL.rotation.set(0, -(REST.elbow + f1 * 1.3 + r1 * 0.25 + dcur.eL), dcur.ezL);

    // 腿：大腿向前为负、膝盖向后弯为正；下蹲时 大腿 -a、膝 +2a、脚踝 -a，小腿与大腿对称，脚掌保持水平
    const setLeg = (L, thigh, knee, ankle, out = 0) => {
      for (const b of L.thigh) b.rotation.set(thigh, 0, out);
      for (const b of L.knee) b.rotation.set(knee, 0, 0);
      for (const b of L.ankle) b.rotation.set(ankle, 0, 0);
    };
    const kr = dcur.kR, kl = dcur.kL;
    // 抬膝时膝盖同时往外打开一点（右腿往 -x、左腿往 +x），从正面也看得出来
    setLeg(LEGS.R, cur.leg * 0.6 - sq - kr * 1.3, 2 * sq + kr * 1.7, -sq - kr * 0.4, -kr * 0.45);
    setLeg(LEGS.L, -cur.leg * 0.6 - sq - kl * 1.3, 2 * sq + kl * 1.7, -sq - kl * 0.4, kl * 0.45);
  }

  const target = {};
  function face(P, t, dt) {
    for (const n of managed) target[n] = 0;
    const add = (m) => { if (m) for (const [n, w] of Object.entries(m)) target[n] = Math.max(target[n] || 0, w); };
    add(eyesAct[P.name] || eyesM[P.eyes]);
    add(browsM[P.name]);
    add(extraAct[P.name]);
    if (P.name === 'sleep') add({ なごみ: 0.4 });
    if (P.eyeScale > 1.05) add(surprised);
    if (P.talking && P.name !== 'eat') {
      const w = P.voiceLvl >= 0 ? Math.min(0.85, P.voiceLvl * 1.1) : Math.abs(Math.sin(t * 11)) * 0.7;
      target[vowels[P.vowel % vowels.length] || 'あ'] = w;
    }
    else add(mouthM[P.mouth]);
    target.照れ = Math.max(0, (P.blush - 0.5) * 2);
    if (P.blink && P.eyes === 'open' && !eyesAct[P.name]) target.まばたき = 1;

    const km = 1 - Math.pow(1e-6, dt);
    if (managedMat.length) {
      for (const n of managedMat) matWeights[n] = lerp(matWeights[n], target[n] || 0, 1 - Math.pow(0.02, dt));
      applyMatMorphs();
    }
    for (const [n, i] of managedIdx) {
      const fast = (n === 'まばたき' && P.blink) || (vowels.includes(n) && P.voiceLvl >= 0);
      infl[i] = fast ? lerp(infl[i], target[n] || 0, 0.6) : lerp(infl[i], target[n] || 0, km);
    }
  }

  // 先摆好姿势再预热物理，避免一开始披风乱飞
  const P0 = { lookX: 0, lookY: 0, headYaw: 0, headPitch: 0, headRoll: 0, y: 0, rotY: 0, rotZ: 0, raise: [0, 0], fwd: [0, 0], legSwing: 0, breath: 2 };
  pose(P0, 0, 1);
  mesh.updateMatrixWorld(true);
  let phys = null;
  if (usePhysics) {
    const data = mesh.geometry.userData.MMD;
    phys = new MMDPhysics(mesh, data.rigidBodies, data.constraints, { unitStep: 1 / 120, maxStepNum: 5 });
    phys.warmup(60);
  }

  let frame = 0;
  const restDist = new Map(); // 每根物理骨骼正常时到头部的距离
  const dynBones = phys
    ? [...new Set(phys.bodies.filter((b) => b.params.type !== 0).map((b) => b.bone))]
    : [];

  const v = new THREE.Vector3();
  const headTop = new THREE.Vector3(0, 3.3 * (H / 20.9), 0);
  const mouthOff = new THREE.Vector3(0, 0.5 * (H / 20.9), 1.3 * (H / 20.9));

  // 构图：模型占窗口下方约 76%，上面留给对话气泡
  const V = H / 0.76;
  const fov = 30;
  const dist = V / 2 / Math.tan((fov / 2) * Math.PI / 180);
  const cy = box.min.y - V * 0.02 + V / 2;
  // 镜头水平偏移：已知模型用实测调好的 frameX；没有配置（自选模型）就按模型自身的
  // 左右包围盒自动居中——披风/裙摆偏向一侧的模型会被自动摆正，不用手工试参数
  const autoFrameX = ((box.max.x + box.min.x) / 2) / H;
  const cx = H * (profile.frameX != null ? profile.frameX : autoFrameX);

  // 注意：不能拿 geometry.boundingBox 的宽度去反推窗口比例。PMX 的静止姿势是 A 字站姿，
  // 手臂平举张开，而程序运行时手臂是放下的，两者宽度差很多（实测薪炎律者会算出 1.4，
  // 实际只需要 0.88）。正确做法是等姿势摆好、物理稳定后，渲染一帧量真实轮廓，
  // 见下面 measure()：它由 app.js 在首帧之后调用。
  const measure = (renderer, camera) => {
    const gl = renderer.getContext();
    const W = gl.drawingBufferWidth, Ht = gl.drawingBufferHeight;
    if (!W || !Ht) return null;
    const px = new Uint8Array(W * Ht * 4);
    gl.readPixels(0, 0, W, Ht, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // 逐行求不透明像素的左右边界（alpha > 12 算实心）
    const lo = [], hi = [], mid = [];
    for (let y = 0; y < Ht; y++) {
      const row = y * W * 4;
      let a = W, b = -1;
      for (let x = 0; x < W; x++) {
        if (px[row + x * 4 + 3] > 12) { if (x < a) a = x; if (x > b) b = x; }
      }
      if (b >= 0) { lo.push(a); hi.push(b); mid.push((a + b) / 2); }
    }
    if (!mid.length) return null;               // 整屏透明（还没画出来）

    const pick = (arr, f) => {
      const s = [...arr].sort((p, q) => p - q);
      return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * f)))];
    };
    // 画面中心取各行中点的中位数：披风只影响部分行，中位数能稳稳落在身体上，保证人是居中的
    const cxPix = pick(mid, 0.5);
    // 需要的半宽取 99.5 分位（近似整体轮廓，但能剔掉个别杂散像素），再留 15% 余白
    const half = [];
    for (let i = 0; i < mid.length; i++) half.push(Math.max(hi[i] + 1 - cxPix, cxPix - lo[i]));
    const halfPix = pick(half, 0.995);

    const worldW = V * camera.aspect;
    const halfWorld = (halfPix / W) * worldW * 1.15;
    return {
      // 上限 1.1：披风/裙摆特别夸张的模型就让它溢出一点，不然窗口会宽得离谱。
      // 宁可稍宽也不要裁到人——多出来的是透明区域，本来就鼠标穿透，不挡操作。
      ratio: Math.min(1.1, Math.max(0.45, (halfWorld * 2) / V)),
      // 把画面中心对到身体中位线上
      frameX: (cx + ((cxPix - W / 2) / W) * worldW) / H,
    };
  };

  return {
    kind: 'mmd',
    root,
    unit: U,
    hasCatParts: false,
    frame: { fov, pos: [cx, cy, dist], look: [cx, cy, 0] },
    // 量真实轮廓算窗口比例；由 app.js 在姿势摆好、物理稳定、渲染过之后调用
    measure,

    hit(ray) {
      const h = ray.intersectObject(mesh, false)[0];
      if (!h) return null;
      const mat = Array.isArray(mesh.material) ? mesh.material[h.face.materialIndex] : mesh.material;
      const name = (mat && mat.name) || '';
      // 先按材质名快速判定（头部关键词优先于身体关键词）
      if (HEAD_MATS.test(name)) return 'head';
      if (BODY_MATS.test(name)) return 'body';
      // 名字不认识（没见过的命名习惯）→ 用几何位置判定：点在脖子以上就算头。
      // 这条与命名无关，任何模型都适用，保证新模型摸头不会失效。
      const neckY = (neck || head || upper)
        ? (neck || head || upper).getWorldPosition(v).y
        : root.position.y + box.min.y + H * 0.82;
      return h.point.y >= neckY ? 'head' : 'body';
    },
    headAnchor: () => (head ? head.getWorldPosition(v).add(headTop) : v.set(0, box.max.y, 0)),
    mouthAnchor: () => (head ? head.getWorldPosition(v).add(mouthOff) : v.set(0, box.max.y * 0.85, 0)),

    setMotionStyle(name) {
      style = MOTION_STYLES[name] || MOTION_STYLES.lively;
    },

    update(P, t, dt, k) {
      pose(P, t, k);
      face(P, t, dt);
      mesh.updateMatrixWorld(true);
      if (phys) {
        phys.update(Math.min(dt, 1 / 30));
        // 物理偶尔会炸开：发现骨骼飞离身体太远就复位
        if (++frame % 20 === 0) {
          head.getWorldPosition(v);
          const cx = v.x, cy = v.y, cz = v.z, lim = (H * 1.1) ** 2;
          for (const b of dynBones) {
            b.getWorldPosition(v);
            const d2 = (v.x - cx) ** 2 + (v.y - cy) ** 2 + (v.z - cz) ** 2;
            if (!restDist.has(b)) restDist.set(b, Math.sqrt(d2));
            // 原样模式沿用旧判断（长裙带会被误判而频繁复位，这也是颤动的一部分）；其它模式按各自正常长度判断
            const over = style.strictGuard ? d2 > lim : Math.sqrt(d2) > restDist.get(b) + H * 0.5;
            if (over) { phys.reset(); break; }
          }
        }
      }
    },
  };
}
