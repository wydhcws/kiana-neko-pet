// 程序化建模的 Q 版猫娘（琪亚娜风格：白发、蓝瞳、白蓝战斗服）
// 全部由基础几何体 + 卡通着色 + 描边构成，不依赖任何外部模型文件。
import * as THREE from '../../node_modules/three/build/three.module.js';

const C = {
  skin: 0xffe7da,
  hair: 0xf3f1fb,
  hairShade: 0xd9d6ee,
  white: 0xfbfbff,
  blue: 0x3f6fd6,
  navy: 0x27356e,
  gold: 0xf5c451,
  red: 0xe5475f,
  pink: 0xffb3c4,
  line: 0x4a3a5e,
};

const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });

// 沿法线外扩的背面描边，粗细在各种尺寸的部件上保持一致
const outlineMat = new THREE.ShaderMaterial({
  uniforms: { thickness: { value: 0.014 }, color: { value: new THREE.Color(C.line) } },
  vertexShader: `
    uniform float thickness;
    void main() {
      vec3 p = position + normalize(normal) * thickness;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 color;
    void main() { gl_FragColor = vec4(color, 1.0); }`,
  side: THREE.BackSide,
});

const hittables = [];

function part(geo, mat, { name = 'body', pos, rot, scale, outline = true, hit = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.userData.part = name;
  if (outline) {
    const o = new THREE.Mesh(geo, outlineMat);
    o.userData.outline = true;
    o.raycast = () => {};
    m.add(o);
  }
  if (hit) hittables.push(m);
  return m;
}

function group(parent, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const g = new THREE.Group();
  g.position.set(...pos);
  g.rotation.set(...rot);
  parent.add(g);
  return g;
}

function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------- 面部贴图 ----------
const eyeOpen = canvasTex(128, 160, (g, w, h) => {
  // 虹膜：上深下浅的蓝色渐变
  g.save();
  g.beginPath();
  g.ellipse(64, 88, 46, 62, 0, 0, Math.PI * 2);
  g.clip();
  const gr = g.createLinearGradient(0, 26, 0, 150);
  gr.addColorStop(0, '#16307a');
  gr.addColorStop(0.45, '#2f6fd8');
  gr.addColorStop(1, '#8fd8ff');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  // 瞳孔
  g.fillStyle = '#0d1a45';
  g.beginPath(); g.ellipse(64, 84, 20, 30, 0, 0, Math.PI * 2); g.fill();
  // 虹膜里的小星光
  g.strokeStyle = 'rgba(190,235,255,0.55)';
  g.lineWidth = 3;
  g.beginPath(); g.ellipse(64, 96, 32, 40, 0, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.restore();
  // 高光
  g.fillStyle = '#ffffff';
  g.beginPath(); g.ellipse(44, 62, 15, 19, -0.3, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(84, 118, 7, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(78, 58, 5, 0, Math.PI * 2); g.fill();
  // 上睫毛
  g.strokeStyle = '#2a1d3a';
  g.lineCap = 'round';
  g.lineWidth = 11;
  g.beginPath(); g.ellipse(64, 90, 52, 66, 0, 1.12 * Math.PI, 1.88 * Math.PI); g.stroke();
  g.lineWidth = 7;
  g.beginPath(); g.moveTo(112, 50); g.lineTo(124, 38); g.stroke();
  g.beginPath(); g.moveTo(16, 50); g.lineTo(6, 42); g.stroke();
});

const eyeHappy = canvasTex(128, 160, (g) => {
  g.strokeStyle = '#2a1d3a';
  g.lineWidth = 12;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(18, 104); g.quadraticCurveTo(64, 36, 110, 104); g.stroke();
});

const eyeClosed = canvasTex(128, 160, (g) => {
  g.strokeStyle = '#2a1d3a';
  g.lineWidth = 11;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(16, 88); g.quadraticCurveTo(64, 128, 112, 88); g.stroke();
  g.lineWidth = 6;
  g.beginPath(); g.moveTo(26, 100); g.lineTo(16, 112); g.stroke();
  g.beginPath(); g.moveTo(102, 100); g.lineTo(112, 112); g.stroke();
});

const eyeDizzy = canvasTex(128, 160, (g) => {
  g.strokeStyle = '#2a1d3a';
  g.lineWidth = 8;
  g.lineCap = 'round';
  g.beginPath();
  for (let a = 0; a < Math.PI * 6; a += 0.1) {
    const r = 4 + a * 2.2;
    const x = 64 + Math.cos(a) * r, y = 88 + Math.sin(a) * r;
    a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
});

function mouthTex(kind) {
  return canvasTex(128, 80, (g) => {
    g.strokeStyle = '#6b2b3c';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (kind === 'cat') {
      // ω
      g.beginPath();
      g.moveTo(22, 26);
      g.quadraticCurveTo(43, 58, 64, 30);
      g.quadraticCurveTo(85, 58, 106, 26);
      g.stroke();
    } else if (kind === 'open') {
      g.fillStyle = '#b8334f';
      g.beginPath(); g.moveTo(36, 24); g.quadraticCurveTo(64, 20, 92, 24); g.quadraticCurveTo(64, 78, 36, 24); g.fill(); g.stroke();
      g.fillStyle = '#ff8fa6';
      g.beginPath(); g.ellipse(64, 50, 14, 8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(42, 26); g.lineTo(48, 36); g.lineTo(52, 25); g.fill();
    } else if (kind === 'o') {
      g.fillStyle = '#b8334f';
      g.beginPath(); g.ellipse(64, 40, 14, 18, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (kind === 'smile') {
      g.fillStyle = '#b8334f';
      g.beginPath(); g.moveTo(26, 22); g.quadraticCurveTo(64, 30, 102, 22); g.quadraticCurveTo(64, 90, 26, 22); g.fill(); g.stroke();
      g.fillStyle = '#ff8fa6';
      g.beginPath(); g.ellipse(64, 52, 20, 10, 0, 0, Math.PI * 2); g.fill();
    } else if (kind === 'munch') {
      g.beginPath(); g.moveTo(34, 40); g.lineTo(50, 30); g.lineTo(64, 42); g.lineTo(78, 30); g.lineTo(94, 40); g.stroke();
    }
  });
}
const mouths = Object.fromEntries(['cat', 'open', 'o', 'smile', 'munch'].map(k => [k, mouthTex(k)]));

const blushTex = canvasTex(128, 80, (g) => {
  const gr = g.createRadialGradient(64, 40, 4, 64, 40, 60);
  gr.addColorStop(0, 'rgba(255,120,150,0.75)');
  gr.addColorStop(1, 'rgba(255,120,150,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 80);
  g.strokeStyle = 'rgba(230,80,110,0.8)';
  g.lineWidth = 5;
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    g.beginPath(); g.moveTo(40 + i * 20, 52); g.lineTo(52 + i * 20, 30); g.stroke();
  }
});

const shadowTex = canvasTex(128, 128, (g) => {
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(60,40,90,0.35)');
  gr.addColorStop(1, 'rgba(60,40,90,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
});

function decal(tex, w, h, pos, rot) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.renderOrder = 2;
  m.userData.part = 'head';
  hittables.push(m);
  return m;
}

// ---------- 组装 ----------
export function buildKiana() {
  hittables.length = 0;
  const M = {
    skin: toon(C.skin),
    hair: toon(C.hair),
    hairShade: toon(C.hairShade),
    white: toon(C.white),
    blue: toon(C.blue),
    navy: toon(C.navy),
    gold: toon(C.gold, { emissive: 0x3a2a00 }),
    red: toon(C.red),
    pink: toon(C.pink),
    skirt: toon(C.white, { side: THREE.DoubleSide }),
  };

  const root = new THREE.Group();

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.005;
  root.add(shadow);

  const char = group(root);        // 整体跳跃/旋转
  const body = group(char);        // 呼吸

  // 腿 + 鞋
  const legs = [];
  for (const s of [-1, 1]) {
    const leg = group(body, [s * 0.11, 0.38, 0]);
    leg.add(part(new THREE.CapsuleGeometry(0.085, 0.26, 6, 14), M.white, { pos: [0, -0.18, 0] }));
    leg.add(part(new THREE.SphereGeometry(0.1, 16, 12), M.navy, { pos: [0, -0.34, 0.03], scale: [1, 0.7, 1.35] }));
    legs.push(leg);
  }

  // 裙子 + 蓝色裙边
  body.add(part(new THREE.CylinderGeometry(0.24, 0.46, 0.34, 32, 1, true), M.skirt, { pos: [0, 0.48, 0] }));
  body.add(part(new THREE.TorusGeometry(0.455, 0.028, 8, 40), M.blue, { pos: [0, 0.315, 0], rot: [Math.PI / 2, 0, 0] }));
  body.add(part(new THREE.TorusGeometry(0.24, 0.03, 8, 32), M.blue, { pos: [0, 0.63, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 0.82, 1] }));

  // 躯干
  const torso = part(new THREE.CapsuleGeometry(0.23, 0.2, 8, 20), M.white, { pos: [0, 0.76, 0], scale: [1, 1, 0.82] });
  body.add(torso);
  // 胸前蓝色菱形徽章
  body.add(part(new THREE.OctahedronGeometry(0.06), M.blue, { pos: [0, 0.78, 0.19], scale: [0.8, 1.2, 0.4] }));

  // 脖子、项圈、铃铛
  body.add(part(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 12), M.skin, { pos: [0, 0.98, 0], outline: false }));
  body.add(part(new THREE.TorusGeometry(0.085, 0.024, 8, 24), M.red, { pos: [0, 0.95, 0], rot: [Math.PI / 2 + 0.15, 0, 0] }));
  const bell = part(new THREE.SphereGeometry(0.052, 16, 12), M.gold, { name: 'bell', pos: [0, 0.9, 0.1] });
  body.add(bell);

  // 手臂
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = group(body, [s * 0.27, 0.9, 0], [0, 0, s * 0.28]);
    arm.add(part(new THREE.SphereGeometry(0.1, 16, 12), M.white, { pos: [0, 0, 0] }));
    arm.add(part(new THREE.CapsuleGeometry(0.068, 0.22, 6, 12), M.white, { pos: [0, -0.17, 0] }));
    arm.add(part(new THREE.TorusGeometry(0.07, 0.022, 8, 20), M.blue, { pos: [0, -0.3, 0], rot: [Math.PI / 2, 0, 0] }));
    arm.add(part(new THREE.SphereGeometry(0.066, 14, 12), M.skin, { pos: [0, -0.37, 0] }));
    arms.push(arm);
  }

  // 背后的长发（挂在身体上，转头时不会穿模）
  body.add(part(new THREE.CapsuleGeometry(0.4, 0.72, 8, 20), M.hair, { name: 'head', pos: [0, 1.0, -0.36], scale: [1.18, 1, 0.45] }));
  const strands = [];
  for (const s of [-1, 1]) {
    const g = group(body, [s * 0.43, 1.3, -0.2], [0, 0, s * 0.1]);
    g.add(part(new THREE.CapsuleGeometry(0.11, 0.78, 6, 14), M.hair, { name: 'head', pos: [0, -0.5, 0], scale: [1, 1, 0.7] }));
    g.add(part(new THREE.TorusGeometry(0.1, 0.03, 8, 20), M.blue, { name: 'head', pos: [0, -0.06, 0], rot: [Math.PI / 2, 0, 0] }));
    strands.push(g);
  }

  // 尾巴：一串嵌套关节，逐节摆动
  const tailRoot = group(body, [0.2, 0.4, -0.2], [-0.15, 0.25, -1.4]);
  const tail = [];
  let parent = tailRoot;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const seg = group(parent, [0, i === 0 ? 0 : 0.088, 0]);
    const r = i === N - 1 ? 0.085 : 0.055 + 0.012 * Math.sin((i / N) * Math.PI);
    seg.add(part(new THREE.SphereGeometry(r, 14, 10), i >= N - 2 ? M.white : M.hair, { name: 'tail', scale: [1, 1.35, 1] }));
    if (i === 2) seg.add(part(new THREE.TorusGeometry(0.068, 0.02, 8, 20), M.blue, { name: 'tail', rot: [Math.PI / 2, 0, 0] }));
    seg.userData.base = 0.1; // 逐节向上卷
    tail.push(seg);
    parent = seg;
  }

  // ---------- 头 ----------
  const headPivot = group(body, [0, 1.0, 0]);
  const head = group(headPivot, [0, 0.47, 0]);
  const face = part(new THREE.SphereGeometry(0.55, 40, 32), M.skin, { name: 'head', scale: [1, 0.93, 0.92] });
  head.add(face);

  // 头发：顶部发帽 + 后脑半球
  head.add(part(new THREE.SphereGeometry(0.585, 40, 20, 0, Math.PI * 2, 0, 1.22), M.hair, { name: 'head', pos: [0, 0.02, -0.01], scale: [1, 0.95, 0.94] }));
  head.add(part(new THREE.SphereGeometry(0.595, 40, 24, Math.PI, Math.PI), M.hair, { name: 'head', pos: [0, 0.0, -0.02], scale: [1, 0.98, 0.95] }));

  // 刘海：一排交错的扁平发束
  const bangs = [
    [-0.95, 0.34, 0.13], [-0.72, 0.4, 0.13], [-0.48, 0.36, 0.13], [-0.24, 0.42, 0.13], [0.0, 0.34, 0.12],
    [0.22, 0.42, 0.13], [0.46, 0.36, 0.13], [0.7, 0.4, 0.13], [0.93, 0.34, 0.13],
  ];
  for (const [a, len, r] of bangs) {
    const g = group(head, [0, 0, 0], [0, a, 0]);
    g.add(part(new THREE.ConeGeometry(r, len, 10), M.hair, {
      name: 'head', pos: [0, 0.27 - len * 0.33, 0.5], rot: [Math.PI - 0.24, 0, -a * 0.2], scale: [1, 1, 0.42],
    }));
  }
  // 两侧鬓发：内外两层，垂到下巴以下，把脸框起来
  for (const s of [-1, 1]) {
    for (const [ang, r, len, y] of [[1.14, 0.14, 0.84, -0.12], [1.36, 0.19, 0.95, -0.14], [1.62, 0.2, 0.8, -0.08]]) {
      const g = group(head, [0, 0, 0], [0, s * ang, 0]);
      g.add(part(new THREE.ConeGeometry(r, len, 12), M.hair, {
        name: 'head', pos: [0, y, 0.5], rot: [Math.PI - 0.1, 0, s * 0.06], scale: [1, 1, 0.5],
      }));
    }
  }
  // 蓝色菱形发卡
  head.add(part(new THREE.OctahedronGeometry(0.06), M.blue, { name: 'head', pos: [-0.36, 0.32, 0.38], rot: [0, -0.6, 0.4], scale: [0.7, 1.3, 0.5] }));
  head.add(part(new THREE.OctahedronGeometry(0.045), M.blue, { name: 'head', pos: [-0.44, 0.22, 0.32], rot: [0, -0.8, 0.9], scale: [0.7, 1.3, 0.5] }));

  // 呆毛
  const ahoge = group(head, [0.02, 0.52, 0.04]);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, 0.18, 0.05),
    new THREE.Vector3(0.13, 0.27, 0.12), new THREE.Vector3(0.2, 0.19, 0.16),
  ]);
  ahoge.add(part(new THREE.TubeGeometry(curve, 20, 0.026, 8), M.hair, { name: 'head' }));

  // 猫耳
  const ears = [];
  for (const s of [-1, 1]) {
    const e = group(head, [s * 0.3, 0.4, -0.04], [0, 0, -s * 0.38]);
    e.add(part(new THREE.ConeGeometry(0.16, 0.34, 18), M.hair, { name: 'ear', pos: [0, 0.13, 0], scale: [1, 1, 0.55] }));
    e.add(part(new THREE.ConeGeometry(0.095, 0.22, 16), M.pink, { name: 'ear', pos: [0, 0.1, 0.05], scale: [1, 1, 0.3], outline: false }));
    ears.push(e);
  }

  // 眼睛 / 嘴 / 腮红
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = decal(eyeOpen, 0.215, 0.27, [s * 0.19, -0.04, 0.482], [0, s * 0.38, 0]);
    e.userData.baseX = s * 0.19;
    head.add(e);
    eyes.push(e);
  }
  const mouth = decal(mouths.cat, 0.13, 0.08, [0, -0.25, 0.448], [0.45, 0, 0]);
  head.add(mouth);
  const blush = [];
  for (const s of [-1, 1]) {
    const b = decal(blushTex, 0.15, 0.09, [s * 0.29, -0.15, 0.412], [0, s * 0.62, 0]);
    b.material.opacity = 0.55;
    head.add(b);
    blush.push(b);
  }

  const eyeTex = { open: eyeOpen, happy: eyeHappy, closed: eyeClosed, dizzy: eyeDizzy };
  let curEye = 'open', curMouth = 'cat';

  return {
    root, char, body, torso, headPivot, head, ears, tail, tailRoot, arms, legs, strands, ahoge, eyes, mouth, blush, bell, shadow,
    hittables,
    setEyes(kind) {
      if (kind === curEye) return;
      curEye = kind;
      for (const e of eyes) { e.material.map = eyeTex[kind]; e.material.needsUpdate = true; }
    },
    setMouth(kind) {
      if (kind === curMouth) return;
      curMouth = kind;
      mouth.material.map = mouths[kind];
      mouth.material.needsUpdate = true;
    },
    setBlush(v) { for (const b of blush) b.material.opacity = v; },
  };
}
