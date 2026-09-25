// 琪亚娜猫娘 · 网页 3D 实时预览驱动
// 移植自 kiana-neko-pet 的 src/app.js 姿态状态机（仅保留 idle + 六个小动作），
// 渲染代码 chibi.js / chibi-model.js 与原项目一致，未改动模型本身。
import * as THREE from 'three';
import { createChibi } from './kiana/chibi.js';

const lerp = (a, b, k) => a + (b - a) * k;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function initKianaPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'pan-y'; // 纵向滚动不被拖旋转拦截

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  const avatar = createChibi();
  scene.add(avatar.root);

  const FRAME = avatar.frame; // { fov: 28, pos: [0, 1.47, 6.4], look: [0, 1.32, 0] }
  function layout() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = FRAME.fov;
    // 窄屏（竖屏手机）时把相机拉远一点，保证全身入镜
    const pull = camera.aspect < 0.72 ? 0.72 / camera.aspect : 1;
    camera.position.set(FRAME.pos[0], FRAME.pos[1], FRAME.pos[2] * Math.min(pull, 1.9));
    camera.lookAt(FRAME.look[0], FRAME.look[1], FRAME.look[2]);
    camera.updateProjectionMatrix();
  }
  layout();
  new ResizeObserver(layout).observe(container);

  // ---------- 交互：拖动旋转 + 点击触发动作 ----------
  let userRot = 0, userRotTarget = 0;
  let dragging = false, moved = 0, px = 0;
  const pointer = { x: 0, y: 0, t: -99, inside: false };

  container.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; px = e.clientX;
    container.setPointerCapture(e.pointerId);
  });
  container.addEventListener('pointermove', (e) => {
    const r = container.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
    pointer.t = clock();
    pointer.inside = true;
    if (!dragging) return;
    const dx = e.clientX - px;
    px = e.clientX;
    moved += Math.abs(dx);
    userRotTarget += dx * 0.012;
  });
  container.addEventListener('pointerup', () => {
    dragging = false;
    if (moved < 6) nextAction(true); // 视为点击
  });
  container.addEventListener('pointerleave', () => { pointer.inside = false; });

  // ---------- 姿态状态机（移植自原项目 app.js） ----------
  const ACTIONS = [
    { name: 'pat', dur: 2.2 },
    { name: 'happy', dur: 2.4 },
    { name: 'wave', dur: 2.2 },
    { name: 'tilt', dur: 1.6 },
    { name: 'dance', dur: 4.2 },
    { name: 'stretch', dur: 2.0 },
  ];
  let actIdx = Math.floor(Math.random() * ACTIONS.length);
  let action = null;
  let idleUntil = 1.2; // 开场先 idle 一小会儿

  function nextAction(immediate) {
    actIdx = (actIdx + 1) % ACTIONS.length;
    action = { ...ACTIONS[actIdx], t0: clock() };
    idleUntil = Infinity;
  }

  const S = {
    blinkAt: 2,
    look: { x: 0, y: 0 },
    wander: null,
  };

  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;

  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { threshold: 0.05 })
    .observe(container);

  let last = clock();
  function animate() {
    requestAnimationFrame(animate);
    if (!visible || document.hidden) { last = clock(); return; }
    const t = clock();
    const dt = Math.min(0.05, t - last);
    last = t;

    // 动作调度：idle 几秒 → 下一个动作
    if (!action && t > idleUntil) nextAction(false);
    let p = 0;
    if (action) {
      p = (t - action.t0) / action.dur;
      if (p >= 1) { action = null; p = 0; idleUntil = t + rand(2.5, 5); }
    }
    const name = action ? action.name : 'idle';
    const s = Math.sin(p * Math.PI);

    // 默认姿态（与原项目 idle 一致）
    let eyes = 'open', mouth = 'cat', blush = 0.5, eyeScale = 1;
    let y = 0, rotY = 0, rotZ = Math.sin(t * 0.9) * 0.02, squash = 1;
    let raise = [0, 0], fwd = [0, 0];
    let headRoll = Math.sin(t * 0.7) * 0.03, headPitch = 0, headYawAdd = 0;
    let tailAmp = 0.12, tailSpeed = 2.2, tailPuff = 1;
    let legSwing = 0, breath = 2.2;

    switch (name) {
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
      case 'wave':
        mouth = 'smile';
        raise = [0, 2.3 * Math.min(1, s * 2) + Math.sin(t * 14) * 0.25 * s];
        headRoll = -0.1 * s;
        tailAmp = 0.25; tailSpeed = 4;
        break;
      case 'tilt':
        headRoll = 0.22 * s;
        tailAmp = 0.2;
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
      case 'stretch':
        eyes = 'closed'; mouth = 'o';
        raise = [s * 2.7, s * 2.7];
        squash = 1 + s * 0.06;
        headPitch = -0.2 * s;
        break;
    }

    // 眨眼
    if (t > S.blinkAt) S.blinkAt = t + rand(2, 5.5);
    const blink = eyes === 'open' && (S.blinkAt - t) < 0.13;

    // 视线：指针在预览区里就盯着指针，否则自己乱看
    let tx, ty;
    if (pointer.inside && t - pointer.t < 4) {
      tx = clamp((pointer.x / container.clientWidth - 0.5) * 2.2, -1, 1);
      ty = clamp((pointer.y / container.clientHeight - 0.42) * 2.2, -1, 1);
    } else {
      if (!S.wander || t > S.wander.until) {
        S.wander = { x: rand(-0.5, 0.5), y: rand(-0.2, 0.3), until: t + rand(2, 4) };
      }
      tx = S.wander.x; ty = S.wander.y;
    }
    const kLook = 1 - Math.pow(0.001, dt);
    S.look.x = lerp(S.look.x, tx, kLook);
    S.look.y = lerp(S.look.y, ty, kLook);

    // 拖动旋转平滑
    userRot = lerp(userRot, userRotTarget, 1 - Math.pow(0.0001, dt));
    avatar.root.rotation.y = userRot;

    const kPose = 1 - Math.pow(0.0005, dt);
    avatar.update({
      name, eyes, mouth, blush, eyeScale, blink,
      y, rotY, rotZ, squash, x: 0,
      raise, fwd, headRoll, headPitch, headYaw: headYawAdd,
      lookX: S.look.x, lookY: S.look.y,
      tailAmp, tailSpeed, tailPuff, legSwing, breath,
      snapY: name === 'dance', snapRotY: name === 'dance',
    }, t, dt, kPose);

    renderer.render(scene, camera);
  }
  animate();
}
