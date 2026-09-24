// 舞步库 + 编舞：不依赖 VMD，用代码按节拍生成舞蹈姿势
//
// 舞蹈姿势 D（都是可选字段，缺省为 0 = 自然站立）：
//   rR/rL  右/左手臂抬起角度（弧度，0 = 下垂，≈1.35 水平侧平举，≈2.5 举过头顶）
//   fR/fL  手臂向前（正）/ 向后（负）
//   eR/eL  手肘向前弯（0 ~ 2）
//   ezR/ezL 手肘在手臂抬起的平面内往上/往里弯（侧平举时小臂竖起、举高时小臂往头顶收）
//   lean   身体左右倾（正 = 向她的左边，也就是屏幕右边）
//   twist  上身扭转，bend 上身前倾
//   hipX   胯部左右移动（Q 版单位，≈0.1 已经很明显）
//   squat  下蹲程度 0 ~ 1（会屈膝），bounce 身体上提
//   turn   整体转身角度，kR/kL 抬右/左膝 0 ~ 1
//   hRoll / hPitch / hYaw 头部歪、点、转
// 「右」指她自己的右手，在屏幕左侧。

const TAU = Math.PI * 2;
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const pulse = (b) => 0.5 + 0.5 * Math.cos(TAU * b); // 每拍一次，拍点上为 1

// 每个舞步：beats 拍长，energy 能量（副歌挑高的），f(b) 返回姿势（b 为舞步内的拍数 0 ~ beats）
export const MOVES = {
  // 律动：每拍屈膝点头，手臂放松前后摆
  groove: { beats: 4, energy: 1, f: (b) => ({
    squat: 0.14 * pulse(b), bounce: 0.01 * (1 - pulse(b)), hPitch: 0.1 * pulse(b), hRoll: 0.06 * Math.sin(Math.PI * b),
    rR: 0.25, rL: 0.25, fR: 0.35 * Math.sin(Math.PI * b), fL: -0.35 * Math.sin(Math.PI * b), eR: 0.5, eL: 0.5,
    lean: 0.05 * Math.sin(Math.PI * b),
  }) },

  // 左右侧步：两拍一步，手臂反向甩
  sideStep: { beats: 4, energy: 1, f: (b) => {
    const s = Math.sin((Math.PI * b) / 2);
    return {
      hipX: 0.07 * s, lean: -0.08 * s, squat: 0.12 * pulse(b), hPitch: 0.06 * pulse(b),
      rR: 0.45 + 0.3 * Math.max(0, -s), rL: 0.45 + 0.3 * Math.max(0, s), fR: 0.4 * s, fL: -0.4 * s, eR: 0.7, eL: 0.7,
      hRoll: 0.08 * s,
    };
  } },

  // 扭胯：双手叉腰，胯部左右扭
  hipSway: { beats: 4, energy: 1, f: (b) => {
    const s = Math.sin(Math.PI * b);
    return {
      rR: 0.55, rL: 0.55, fR: -0.25, fL: -0.25, eR: 1.6, eL: 1.6,
      hipX: 0.06 * s, lean: -0.1 * s, twist: 0.12 * s, squat: 0.1 * pulse(b), hRoll: 0.12 * s,
    };
  } },

  // 拍手：双手在胸前，每拍合一次
  clap: { beats: 4, energy: 1, f: (b) => {
    const c = pulse(b);
    return {
      rR: 1.0, rL: 1.0, fR: 1.05 + 0.3 * c, fL: 1.05 + 0.3 * c, eR: 0.9, eL: 0.9, ezR: 0.3, ezL: 0.3,
      squat: 0.12 * c, hPitch: 0.08 * c, lean: 0.06 * Math.sin(Math.PI * b), hRoll: 0.08 * Math.sin(Math.PI * b),
    };
  } },

  // 招财猫：手肘弯起、手在脸旁，左右交替招手
  catPaw: { beats: 4, energy: 1, f: (b) => {
    const s = Math.sin(Math.PI * b);
    return {
      rR: 1.1 + 0.2 * Math.max(0, s), rL: 1.1 + 0.2 * Math.max(0, -s), fR: 0.55, fL: 0.55, eR: 0.3, eL: 0.3,
      ezR: 1.7 + 0.3 * Math.max(0, s), ezL: 1.7 + 0.3 * Math.max(0, -s),
      hRoll: 0.15 * s, lean: 0.06 * s, squat: 0.1 * pulse(b), twist: 0.06 * s,
    };
  } },

  // 举手摇摆：双手举高左右晃
  waveUp: { beats: 4, energy: 2, f: (b) => {
    const s = Math.sin((Math.PI * b) / 2);
    return {
      rR: 2.4, rL: 2.4, fR: 0.15 + 0.15 * s, fL: 0.15 - 0.15 * s, eR: 0.35, eL: 0.35,
      lean: 0.14 * s, hipX: -0.04 * s, squat: 0.12 * pulse(b), hRoll: 0.1 * s, hPitch: -0.12,
    };
  } },

  // 波浪手：侧平举，手肘依次起伏
  armWave: { beats: 4, energy: 2, f: (b) => {
    const w = Math.sin(Math.PI * b);
    return {
      rR: 1.45 + 0.3 * w, rL: 1.45 - 0.3 * w, eR: 0.1, eL: 0.1,
      ezR: 0.5 * Math.max(0, Math.sin(Math.PI * b + 1)), ezL: 0.5 * Math.max(0, Math.sin(Math.PI * b - 1)),
      lean: 0.1 * w, hipX: -0.03 * w, squat: 0.1 * pulse(b), hRoll: 0.1 * w,
    };
  } },

  // 指向远方：前两拍右手斜上指，后两拍换左手
  point: { beats: 4, energy: 2, f: (b) => {
    const right = b < 2;
    const hit = ease((b % 2) * 3); // 每两拍开头快速出手
    return {
      rR: right ? 0.3 + 1.9 * hit : 0.4, rL: right ? 0.4 : 0.3 + 1.9 * hit,
      fR: right ? 0.3 : 0.2, fL: right ? 0.2 : 0.3, eR: right ? 0.05 : 1.2, eL: right ? 1.2 : 0.05,
      lean: right ? -0.1 * hit : 0.1 * hit, hYaw: right ? -0.25 * hit : 0.25 * hit, hPitch: -0.1 * hit,
      squat: 0.1 * pulse(b), hipX: right ? 0.04 * hit : -0.04 * hit,
    };
  } },

  // 比心：双手举过头顶弯成心形
  heart: { beats: 4, energy: 2, f: (b) => {
    const s = Math.sin((Math.PI * b) / 2);
    return {
      rR: 2.2, rL: 2.2, fR: 0.3, fL: 0.3, eR: 0.2, eL: 0.2, ezR: 1.25, ezL: 1.25,
      lean: 0.1 * s, hRoll: 0.14 * s, squat: 0.1 * pulse(b), bounce: 0.01 * (1 - pulse(b)),
    };
  } },

  // 抬膝：每拍交替抬膝，反手举起
  kneeUp: { beats: 4, energy: 2, f: (b) => {
    const side = Math.floor(b) % 2 === 0;
    const u = Math.sin(Math.PI * (b % 1));
    return {
      kR: side ? 0.55 * u : 0, kL: side ? 0 : 0.55 * u,
      rR: side ? 0.5 : 0.5 + 1.7 * u, rL: side ? 0.5 + 1.7 * u : 0.5, eR: 0.6, eL: 0.6, fR: 0.2, fL: 0.2,
      // 从正面看，膝盖往前抬是朝着镜头去的看不出来：身体稍微转向抬腿一侧
      lean: side ? 0.05 * u : -0.05 * u, bounce: 0.02 * u, hPitch: -0.06 * u, turn: (side ? -0.35 : 0.35) * u,
    };
  } },

  // 下蹲再起：前两拍蹲下双手交叉在前，后两拍起身双手打开成 V
  squatRise: { beats: 4, energy: 2, f: (b) => {
    const down = b < 2 ? ease(b) : 1 - ease(b - 2);
    const open = b < 2 ? 0 : ease((b - 2) * 1.5);
    return {
      squat: 0.55 * down, bend: 0.25 * down, hPitch: 0.2 * down - 0.15 * open,
      rR: 0.7 * down + 2.3 * open, rL: 0.7 * down + 2.3 * open, fR: 0.9 * down + 0.2 * open, fL: 0.9 * down + 0.2 * open,
      eR: 0.8 * down + 0.1, eL: 0.8 * down + 0.1,
    };
  } },

  // 转圈：两拍转一圈，双手打开
  spin: { beats: 2, energy: 2, f: (b) => ({
    turn: TAU * ease(b / 2), rR: 1.2, rL: 1.2, fR: 0.2, fL: 0.2, eR: 0.4, eL: 0.4,
    squat: 0.08, bounce: 0.03 * Math.sin((Math.PI * b) / 2), hPitch: -0.1,
  }) },

  // 甩头发：前倾再往后甩
  hairFlip: { beats: 2, energy: 2, f: (b) => {
    const d = b < 1 ? ease(b) : 1 - ease(b - 1);
    return {
      bend: 0.35 * d, hPitch: 0.35 * d - 0.2 * (b >= 1 ? Math.sin(Math.PI * (b - 1)) : 0), twist: 0.2 * Math.sin(Math.PI * b),
      rR: 0.5 + 0.4 * d, rL: 0.5 + 0.4 * d, fR: 0.5 * d, fL: 0.5 * d, eR: 0.8, eL: 0.8, squat: 0.2 * d,
    };
  } },

  // 定格：右手高举指天、左手叉腰
  finish: { beats: 4, energy: 2, f: (b) => {
    const hit = ease(b * 2);
    return {
      rR: 0.3 + 2.1 * hit, fR: 0.2, eR: 0.05, rL: 0.55, fL: -0.25, eL: 1.6,
      lean: -0.1 * hit, hipX: 0.05 * hit, hRoll: -0.1 * hit, hYaw: -0.2 * hit, hPitch: -0.12 * hit, squat: 0.05,
    };
  } },
};

const MIRROR_NEG = ['lean', 'twist', 'hipX', 'turn', 'hRoll', 'hYaw'];
export function mirror(p) {
  const o = { ...p };
  [o.rR, o.rL] = [p.rL, p.rR];
  [o.fR, o.fL] = [p.fL, p.fR];
  [o.eR, o.eL] = [p.eL, p.eR];
  [o.ezR, o.ezL] = [p.ezL, p.ezR];
  [o.kR, o.kL] = [p.kL, p.kR];
  for (const k of MIRROR_NEG) if (o[k] != null) o[k] = -o[k];
  return o;
}

const KEYS = ['rR', 'rL', 'fR', 'fL', 'eR', 'eL', 'ezR', 'ezL', 'lean', 'twist', 'bend', 'hipX', 'squat', 'bounce', 'turn', 'kR', 'kL', 'hRoll', 'hPitch', 'hYaw'];
function mix(a, b, w) {
  const o = {};
  for (const k of KEYS) o[k] = (a[k] || 0) * (1 - w) + (b[k] || 0) * w;
  return o;
}

// 简单的确定性随机，同一首歌每次编出来的舞一样
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const CALM = ['groove', 'sideStep', 'hipSway', 'clap', 'catPaw'];
const HYPE = ['waveUp', 'armWave', 'point', 'heart', 'kneeUp', 'squatRise', 'spin', 'hairFlip'];

// 一个 8 拍小节排哪些舞步。kind: 'intro' 前奏/间奏，'verse' 主歌，'chorus' 副歌，'end' 结尾
function planBlock(seed, idx, kind) {
  const r = rng(`${seed}|${idx}|${kind}`);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const flip = r() < 0.5;
  const pool = kind === 'chorus' ? HYPE : CALM;
  const fill = (first) => {
    const out = [];
    let beats = 0, name = first;
    while (beats < 8) {
      const rem = 8 - beats;
      // 放不下就换短的：剩 4 拍以上用律动，剩 2 拍用两拍的舞步
      if (MOVES[name].beats > rem) name = rem >= 4 ? 'groove' : kind === 'chorus' ? 'hairFlip' : 'spin';
      out.push({ name, at: beats, flip: out.length % 2 === 1 ? !flip : flip });
      beats += MOVES[name].beats;
      name = pick(pool);
    }
    return out;
  };
  if (kind === 'end') return [{ name: 'groove', at: 0, flip }, { name: 'finish', at: 4, flip }];
  if (kind === 'intro') return fill(r() < 0.6 ? 'groove' : 'sideStep');
  // 副歌有时用转圈开场
  if (kind === 'chorus' && r() < 0.3) return fill('spin');
  return fill(pick(pool));
}

// 编舞器：给定节拍数和该小节的段落类型，返回当前姿势（相邻舞步之间有 0.35 拍的过渡）
export class Choreographer {
  constructor(seed) {
    this.seed = seed;
    this.blocks = new Map();
  }

  block(idx, kind) {
    const key = `${idx}|${kind}`;
    if (!this.blocks.has(key)) this.blocks.set(key, planBlock(this.seed, idx, kind));
    return this.blocks.get(key);
  }

  moveAt(beat, kindOf) {
    const idx = Math.floor(beat / 8);
    const plan = this.block(idx, kindOf(idx));
    const local = beat - idx * 8;
    let cur = plan[0];
    for (const m of plan) if (m.at <= local) cur = m;
    return { idx, move: cur, b: local - cur.at };
  }

  pose(beat, kindOf) {
    // 开跳前也返回完整的全零姿势（缺字段会让适配器算出 NaN）
    if (beat < 0) return mix({}, {}, 1);
    const { move, b } = this.moveAt(beat, kindOf);
    const p = MOVES[move.name].f(b);
    const here = move.flip ? mirror(p) : p;
    // 舞步开头与上一个舞步的结尾做过渡，避免跳变
    const X = 0.35;
    if (b < X && beat >= X) {
      const prev = this.moveAt(beat - b - 1e-3, kindOf);
      const pp = MOVES[prev.move.name].f(Math.min(prev.b, MOVES[prev.move.name].beats));
      const prevPose = prev.move.flip ? mirror(pp) : pp;
      // 转身角度不参与过渡（转完一圈回到 0，免得反向再转）
      const out = mix(prevPose, here, ease(b / X));
      out.turn = here.turn || 0;
      return out;
    }
    return mix({}, here, 1);
  }

  name(beat, kindOf) {
    return beat < 0 ? null : this.moveAt(beat, kindOf).move.name;
  }
}
