// 配音：用微软 Edge 在线语音合成生成台词语音，按文本+音色缓存成 mp3，之后离线也能播
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VOICES = {
  genki: { label: '元气少女（晓伊）', name: 'zh-CN-XiaoyiNeural', pitch: '+10%', rate: '+6%' },
  gentle: { label: '温柔少女（晓晓）', name: 'zh-CN-XiaoxiaoNeural', pitch: '+14%', rate: '+4%' },
  soft: { label: '软萌台湾腔（晓雨）', name: 'zh-TW-HsiaoYuNeural', pitch: '+8%', rate: '+4%' },
};

// 去掉括号里的动作描写、表情符号，让朗读更自然
function clean(text) {
  return text
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/[♪❤💕💖～~]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Voice {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.failUntil = 0;
  }

  fileFor(text, key) {
    const v = VOICES[key] || VOICES.genki;
    const h = crypto.createHash('sha1').update(`${v.name}|${v.pitch}|${v.rate}|${clean(text)}`).digest('hex').slice(0, 20);
    return path.join(this.dir, `${h}.mp3`);
  }

  // 返回缓存好的 mp3 路径；网络不通时返回 null（调用方退回到音效）
  get(text, key, { background = false } = {}) {
    const spoken = clean(text);
    if (!spoken) return Promise.resolve(null);
    const file = this.fileFor(text, key);
    if (fs.existsSync(file)) return Promise.resolve(file);
    if (Date.now() < this.failUntil) return Promise.resolve(null);
    const p = this.pending.get(file);
    if (p && (background || !p.background)) return p.job;
    // 预合成串行排队；当前要说的话直接插队合成
    const job = background
      ? (this.queue = this.queue.then(() => this.synth(spoken, key, file)).catch(() => null))
      : this.synth(spoken, key, file).catch(() => null);
    this.pending.set(file, { job, background });
    job.finally(() => { if (this.pending.get(file)?.job === job) this.pending.delete(file); });
    return job;
  }

  // Edge 服务偶尔会中途断开，失败先重试一次
  async synth(spoken, key, file) {
    try {
      return await this.synthOnce(spoken, key, file);
    } catch {
      return await this.synthOnce(spoken, key, file);
    }
  }

  async synthOnce(spoken, key, file) {
    if (fs.existsSync(file)) return file;
    const v = VOICES[key] || VOICES.genki;
    const tts = new MsEdgeTTS();
    const tmp = fs.mkdtempSync(path.join(this.dir, 'tmp-'));
    try {
      await tts.setMetadata(v.name, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const run = tts.toFile(tmp, spoken, { pitch: v.pitch, rate: v.rate });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('tts timeout')), 8000));
      const { audioFilePath } = await Promise.race([run, timeout]);
      if (fs.statSync(audioFilePath).size < 1000) throw new Error('tts empty');
      fs.renameSync(audioFilePath, file);
      return file;
    } catch (e) {
      // 连不上就歇一会儿再试，别每句话都卡着等
      this.failUntil = Date.now() + 20 * 1000;
      throw e;
    } finally {
      try { tts.close(); } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 后台把所有固定台词提前合成好
  async prefetch(lines, key) {
    for (const l of lines) {
      if (Date.now() < this.failUntil) return;
      await this.get(l, key, { background: true });
    }
  }
}

module.exports = { Voice, VOICES };
