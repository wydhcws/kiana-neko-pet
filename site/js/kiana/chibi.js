// Q 版猫娘适配器：把通用姿态参数 P 应用到程序化模型上
import * as THREE from 'three';
import { buildKiana } from './chibi-model.js';

const lerp = (a, b, k) => a + (b - a) * k;

export function createChibi() {
  const K = buildKiana();
  const root = new THREE.Group();
  root.add(K.root);
  root.add(new THREE.HemisphereLight(0xffffff, 0xd6ccff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(2.5, 4, 5);
  root.add(key);
  const rim = new THREE.DirectionalLight(0xb8d4ff, 0.8);
  rim.position.set(-3, 2, -3);
  root.add(rim);

  let earTwitch = null;
  const v = new THREE.Vector3();

  return {
    kind: 'chibi',
    root,
    unit: 1,
    hasCatParts: true,
    frame: { fov: 28, pos: [0, 1.47, 6.4], look: [0, 1.32, 0] },

    hit(ray) {
      const h = ray.intersectObjects(K.hittables, false)[0];
      return h ? h.object.userData.part : null;
    },
    headAnchor: () => K.head.getWorldPosition(v).add(new THREE.Vector3(0, 0.25, 0)),
    mouthAnchor: () => K.mouth.getWorldPosition(v),

    update(P, t, dt, k) {
      K.setEyes(P.eyes);
      K.setMouth(P.mouth);
      for (const e of K.eyes) e.scale.set(P.eyeScale, P.eyeScale * (P.blink ? 0.12 : 1), 1);
      K.setBlush(P.blush);

      const hp = K.headPivot;
      hp.rotation.y = lerp(hp.rotation.y, P.lookX * 0.4 + P.headYaw, k);
      hp.rotation.x = lerp(hp.rotation.x, P.lookY * 0.3 + P.headPitch, k);
      hp.rotation.z = lerp(hp.rotation.z, P.headRoll - P.lookX * 0.06, k);
      K.eyes.forEach((e) => {
        e.position.x = e.userData.baseX + P.lookX * 0.022;
        e.position.y = -0.04 - P.lookY * 0.016;
      });

      // 身体
      K.char.position.y = lerp(K.char.position.y, P.y, P.snapY ? 1 : k);
      K.char.position.x = lerp(K.char.position.x, P.x || 0, k);
      K.char.rotation.y = P.snapRotY ? P.rotY : lerp(K.char.rotation.y, P.rotY, k);
      K.char.rotation.z = lerp(K.char.rotation.z, P.rotZ, k);
      const br = Math.sin(t * P.breath) * 0.012;
      const sq = P.squash;
      K.body.scale.set(1 + (1 - sq) * 0.5, sq + br, 1 + (1 - sq) * 0.5);
      K.shadow.scale.setScalar(1 - K.char.position.y * 0.8);
      K.shadow.material.opacity = 1 - K.char.position.y * 1.5;

      K.arms.forEach((arm, i) => {
        const sgn = i === 0 ? -1 : 1;
        arm.rotation.z = lerp(arm.rotation.z, sgn * (0.28 + P.raise[i] + Math.sin(t * P.breath) * 0.02), k);
        arm.rotation.x = lerp(arm.rotation.x, -P.fwd[i], k);
      });
      K.legs.forEach((leg, i) => {
        leg.rotation.x = lerp(leg.rotation.x, (i === 0 ? 1 : -1) * P.legSwing, k);
      });

      // 尾巴
      K.tail.forEach((seg, i) => {
        seg.rotation.z = seg.userData.base + Math.sin(t * P.tailSpeed - i * 0.38) * P.tailAmp * 0.7;
        seg.rotation.x = Math.sin(t * P.tailSpeed * 0.7 - i * 0.3) * P.tailAmp * 0.5;
        seg.scale.setScalar(lerp(seg.scale.x, P.tailPuff, k));
      });

      // 耳朵抽动
      if (!earTwitch && Math.random() < dt / 4) earTwitch = { i: Math.random() < 0.5 ? 0 : 1, t0: t };
      K.ears.forEach((ear, i) => {
        let flick = 0;
        if (earTwitch && earTwitch.i === i) {
          const q = (t - earTwitch.t0) / 0.28;
          if (q >= 1) earTwitch = null;
          else flick = Math.sin(q * Math.PI);
        }
        if (P.name === 'ear') flick = Math.abs(Math.sin(t * 20));
        const droop = P.name === 'sleep' ? 0.35 : P.name === 'shake' || P.name === 'drag' ? -0.2 : 0;
        const sgn = i === 0 ? -1 : 1;
        ear.rotation.x = -flick * 0.45 + droop * 0.3;
        ear.rotation.z = -sgn * (0.38 + droop + flick * 0.15);
      });

      // 呆毛和长发轻轻摆动
      K.ahoge.rotation.z = Math.sin(t * 3.1) * 0.1 + (P.name === 'jump' || P.name === 'dance' ? Math.sin(t * 20) * 0.15 : 0);
      K.ahoge.rotation.x = Math.sin(t * 2.3) * 0.06;
      K.strands.forEach((g, i) => {
        const sgn = i === 0 ? -1 : 1;
        g.rotation.z = sgn * 0.1 + Math.sin(t * 1.6 + i) * 0.03 - K.char.rotation.z * 0.5;
      });

      // 铃铛随动作晃
      K.bell.position.x = Math.sin(t * 3) * 0.006 + K.char.rotation.z * -0.1;
    },
  };
}
