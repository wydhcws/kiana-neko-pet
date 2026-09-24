// 全部音效用 WebAudio 实时合成，不需要任何音频文件
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this._noise = null;
    this.meowVol = 1;   // 有配音时喵叫只做点缀，调小
    this.voiceSrc = null;
    this._voiceToken = 0;
    this._lvl = null;
  }

  // 播放一段配音，返回时长（秒）；播放失败返回 0
  // 整段下载后用 WebAudio 解码播放：<audio> 播放较大的文件会发 Range 请求，自定义 app:// 协议不支持，长句会播不出来
  async playVoice(url) {
    this.stopVoice();
    if (this.muted) return 0;
    const c = this.c;
    const token = this._voiceToken;
    let buf;
    try {
      const res = await fetch(url);
      buf = await c.decodeAudioData(await res.arrayBuffer());
    } catch {
      return 0;
    }
    // 解码期间又有新的话或被静音了，就不播了
    if (token !== this._voiceToken || this.muted) return 0;
    if (!this.voiceBus) {
      this.voiceBus = c.createGain();
      this.voiceBus.gain.value = 1.25;
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = 512;
      this.voiceBus.connect(this.analyser);
      this.voiceBus.connect(this.master);
      this._lvl = new Uint8Array(this.analyser.fftSize);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(this.voiceBus);
    src.onended = () => { if (this.voiceSrc === src) this.voiceSrc = null; };
    src.start();
    this.voiceSrc = src;
    return buf.duration;
  }

  stopVoice() {
    this._voiceToken = (this._voiceToken || 0) + 1;
    if (this.voiceSrc) {
      const src = this.voiceSrc;
      this.voiceSrc = null;
      try { src.stop(); } catch {}
    }
  }

  get voicePlaying() { return !!this.voiceSrc; }

  // 当前配音音量 0~1，用来驱动口型
  voiceLevel() {
    if (!this.voicePlaying || !this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this._lvl);
    let sum = 0;
    for (const v of this._lvl) sum += (v - 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this._lvl.length) / 28);
  }

  get c() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get noiseBuf() {
    if (!this._noise) {
      const c = this.c;
      const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this._noise = b;
    }
    return this._noise;
  }

  // 单个音符：频率可滑动，指数衰减包络
  tone({ type = 'sine', f0, f1 = f0, dur = 0.3, vol = 0.25, at = 0, attack = 0.006, filter }) {
    if (this.muted) return;
    const c = this.c, t = c.currentTime + at;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      o.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noise({ dur = 0.2, vol = 0.2, at = 0, type = 'bandpass', f0 = 1000, f1 = f0, q = 1 }) {
    if (this.muted) return;
    const c = this.c, t = c.currentTime + at;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  // “喵～”：锯齿波 + 共振峰滤波 + 颤音，音高先扬后抑
  meow(pitch = 1, len = 0.55, at = 0) {
    if (this.muted) return;
    const c = this.c, t = c.currentTime + at;
    const base = 560 * pitch;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base * 0.85, t);
    o.frequency.linearRampToValueAtTime(base * 1.55, t + len * 0.3);
    o.frequency.linearRampToValueAtTime(base * 1.1, t + len);
    const vib = c.createOscillator();
    vib.frequency.value = 7.5;
    const vg = c.createGain();
    vg.gain.value = base * 0.035;
    vib.connect(vg); vg.connect(o.frequency);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(650, t);
    lp.frequency.exponentialRampToValueAtTime(3400, t + len * 0.35);
    lp.frequency.exponentialRampToValueAtTime(1000, t + len);
    const pk = c.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 2600 * pitch;
    pk.Q.value = 2;
    pk.gain.value = 8;

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const peak = 0.28 * this.meowVol;
    g.gain.exponentialRampToValueAtTime(peak, t + 0.05);
    g.gain.setValueAtTime(peak, t + len * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(lp); lp.connect(pk); pk.connect(g); g.connect(this.master);
    o.start(t); vib.start(t);
    o.stop(t + len + 0.05); vib.stop(t + len + 0.05);
  }

  // 呼噜呼噜：低频锯齿波被 ~24Hz 调幅
  purr(dur = 1.8) {
    if (this.muted) return;
    const c = this.c, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 46;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const am = c.createGain();
    am.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.frequency.value = 24;
    const lg = c.createGain();
    lg.gain.value = 0.5;
    lfo.connect(lg); lg.connect(am.gain);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.25);
    g.gain.setValueAtTime(0.5, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(am); am.connect(g); g.connect(this.master);
    o.start(t); lfo.start(t);
    o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  }

  bell() {
    const partials = [1, 2.76, 5.4, 8.93];
    for (const [k, at] of [[1, 0], [1.02, 0.11]]) {
      partials.forEach((p, i) => this.tone({ f0: 1750 * k * p, dur: 0.9 / (i + 1), vol: 0.12 / (i + 1), at }));
    }
  }

  sparkle() {
    [1319, 1568, 1976, 2349, 2637].forEach((f, i) => {
      this.tone({ f0: f, dur: 0.4, vol: 0.09, at: i * 0.055 });
      this.tone({ type: 'triangle', f0: f * 2, dur: 0.25, vol: 0.03, at: i * 0.055 });
    });
  }

  heart() {
    this.tone({ f0: 880, f1: 1320, dur: 0.18, vol: 0.14 });
    this.tone({ f0: 1320, f1: 1760, dur: 0.25, vol: 0.12, at: 0.1 });
  }

  pop() { this.tone({ f0: 900, f1: 180, dur: 0.1, vol: 0.3 }); }

  boing() {
    this.tone({ f0: 180, f1: 620, dur: 0.22, vol: 0.28 });
    this.tone({ type: 'triangle', f0: 620, f1: 300, dur: 0.25, vol: 0.12, at: 0.18 });
  }

  whoosh() { this.noise({ dur: 0.35, vol: 0.18, f0: 400, f1: 2400, q: 2 }); }

  thud() {
    this.tone({ f0: 160, f1: 60, dur: 0.18, vol: 0.35 });
    this.noise({ dur: 0.08, vol: 0.1, type: 'lowpass', f0: 800 });
  }

  munch() {
    for (let i = 0; i < 4; i++) this.noise({ dur: 0.07, vol: 0.22, f0: 1300 + Math.random() * 600, q: 1.5, at: i * 0.2 });
  }

  chime() {
    [1047, 1319, 1568, 2093].forEach((f, i) => {
      this.tone({ type: 'triangle', f0: f, dur: 1.1, vol: 0.14, at: i * 0.16 });
      this.tone({ f0: f * 2, dur: 0.6, vol: 0.04, at: i * 0.16 });
    });
  }

  snore() {
    this.noise({ dur: 1.1, vol: 0.05, type: 'lowpass', f0: 250, f1: 700, q: 3 });
    this.noise({ dur: 0.9, vol: 0.035, type: 'lowpass', f0: 700, f1: 220, q: 3, at: 1.2 });
  }

  hiss() { this.noise({ dur: 0.45, vol: 0.12, type: 'highpass', f0: 3000, f1: 5000 }); }

  // 打字时的“叽叽喳喳”声，同一个字符总是同一个音高
  blip(ch) {
    if (/[\s，。！？、…～~!?,.\-—♪❤]/.test(ch)) return;
    const h = (ch.codePointAt(0) * 2654435761) >>> 0;
    this.tone({ type: 'square', f0: 620 + (h % 360), dur: 0.05, vol: 0.035, filter: 2400 });
  }

  // 跳舞用的小段原创旋律（约 4 秒）
  tune() {
    if (this.muted) return;
    const beat = 0.2;
    const mel = [76, 79, 81, 79, 76, 74, 72, 74, 76, 79, 84, 83, 81, 79, 76, 0, 77, 76, 74, 72];
    const bass = [48, 43, 45, 41, 43];
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    mel.forEach((m, i) => {
      if (m) this.tone({ type: 'square', f0: hz(m), dur: beat * 0.9, vol: 0.06, at: i * beat, filter: 3000 });
      if (i % 2 === 0) this.noise({ dur: 0.04, vol: 0.05, type: 'highpass', f0: 7000, at: i * beat });
    });
    bass.forEach((m, i) => this.tone({ type: 'triangle', f0: hz(m), dur: beat * 3.8, vol: 0.16, at: i * beat * 4 }));
    this.tone({ type: 'square', f0: hz(84), dur: 0.5, vol: 0.06, at: mel.length * beat, filter: 3000 });
  }
}
