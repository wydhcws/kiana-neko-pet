// AI 台词与聊天：调用 DeepSeek（OpenAI 兼容接口）。key 只在主进程里用，不会进页面
const fs = require('fs');
const path = require('path');
const { net, safeStorage } = require('electron');

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat'; // 非思考模式，响应快

const FORMS = {
  chibi: 'Q 版猫娘形态（白发蓝瞳，有猫耳、猫尾和铃铛）',
  flamescion: '薪炎律者形态（身披红色火焰披风）',
  finality: '终焉律者形态（白紫色礼装，长辫子）',
  diva: '崩坏的歌姬形态（黑色短裙打歌服，喜欢唱歌）',
  custom: '换了一身新衣服',
};

// 琪亚娜的人设（原版，一字未动）。默认角色就走这条，保证原有效果不变
function personaKiana(ctx) {
  return [
    '你是桌面宠物「琪亚娜」，一个以《崩坏3》琪亚娜·卡斯兰娜为灵感的原创同人角色，住在舰长（用户）的电脑桌面上。',
    '性格：元气、乐观、有点小迷糊、贪吃（最爱汉堡、炸鸡、小鱼干），自称「本小姐」或「我」，自诩「天才美少女」「最强女武神」，嘴硬心软、偶尔傲娇。',
    '朋友：芽衣（温柔，会做便当）、布洛妮娅（爱打游戏，话少）、姬子老师（严格又关心人）。',
    `你现在是${FORMS[ctx.form] || FORMS.chibi}。`,
    '说话方式：简体中文口语，称呼用户「舰长」，句尾常带「喵」但不必每句都有；活泼可爱，可以用「～」「！」。不要用 emoji、不要用 markdown、不要写动作描写以外的旁白（动作描写用全角括号，最多一处）。',
    '分寸：你是 AI 扮演的桌宠，被认真问到时要坦白这一点；不讨论色情、暴力等不适合的话题，遇到就用角色口吻岔开；舰长情绪低落或提到身体、心理危机时，温柔地关心，并建议寻求身边的人或专业人士帮助。',
    '只输出 JSON：{"text": "台词", "emotion": "happy|shy|angry|sad|surprised|normal 之一"}。',
  ].join('\n');
}

// 换成别的角色时的人设。没写进 characters.js 的角色不瞎编设定，
// 让模型按它自己对该角色的了解来演。
function personaOther(ctx, p) {
  const wear = ctx.form === 'custom' ? '' : `你现在是${FORMS[ctx.form] || FORMS.chibi}。`;
  return [
    `你是桌面宠物，扮演${p.world}里的「${p.name}」，住在${p.you}（用户）的电脑桌面上。`,
    p.traits
      ? `性格：${p.traits}`
      : `请按你了解的${p.world}角色「${p.name}」来扮演：保持她原本的性格、说话方式和与${p.you}的关系。如果你对这个角色了解不多，就演成一个性格温和、乐于陪伴的桌宠，不要编造具体的身世设定。`,
    p.friends ? `朋友：${p.friends}` : '',
    wear,
    `说话方式：简体中文口语，称呼用户「${p.you}」，自称「${p.self}」${p.tic ? `，句尾常带「${p.tic}」但不必每句都有` : ''}。`
      + '不要用 emoji、不要用 markdown、不要写动作描写以外的旁白（动作描写用全角括号，最多一处）。',
    `分寸：你是 AI 扮演的桌宠，被认真问到时要坦白这一点；不讨论色情、暴力等不适合的话题，遇到就用角色口吻岔开；${p.you}情绪低落或提到身体、心理危机时，温柔地关心，并建议寻求身边的人或专业人士帮助。`,
    '只输出 JSON：{"text": "台词", "emotion": "happy|shy|angry|sad|surprised|normal 之一"}。',
  ].filter(Boolean).join('\n');
}

function persona(ctx) {
  const p = ctx.character;
  // 没指定角色、或就是琪亚娜 → 完全走原版
  if (!p || p.name === '琪亚娜') return personaKiana(ctx);
  return personaOther(ctx, p);
}

// 玩家称呼：默认「舰长」（琪亚娜原样），换角色后按该作品的叫法
const you = (ctx) => (ctx.character && ctx.character.you) || '舰长';

function describe(ctx) {
  const parts = [`现在是${ctx.time}（${ctx.weekday}）`];
  if (ctx.holiday) parts.push(`今天是${ctx.holiday}`);
  if (ctx.workMinutes >= 30) parts.push(`${you(ctx)}已经连续用电脑约 ${ctx.workMinutes} 分钟`);
  if (ctx.song) parts.push(`${you(ctx)}正在听《${ctx.song.title}》${ctx.song.artist ? `（${ctx.song.artist}）` : ''}`);
  if (ctx.recent && ctx.recent.length) parts.push(`刚才：${ctx.recent.join('、')}`);
  parts.push(`好感度 ${ctx.affection}`);
  return parts.join('；');
}

class AI {
  constructor(dir) {
    this.dir = dir;
    this.keyFile = path.join(dir, 'deepseek.key');
    this.historyFile = path.join(dir, 'chat-history.json');
    this.history = [];
    this.recentIdle = [];
    try { this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')).slice(-16); } catch {}
    this.key = this.loadKey();
  }

  // 优先用环境变量；用过一次就加密存到本地（系统钥匙串加密），开机自启时没有环境变量也能用
  loadKey() {
    const env = (process.env.DEEPSEEK_API_KEY || '').trim();
    if (env) {
      try {
        if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(this.keyFile, safeStorage.encryptString(env));
      } catch {}
      return env;
    }
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(fs.readFileSync(this.keyFile)).trim();
    } catch {}
    return '';
  }

  clearKey() {
    this.key = '';
    try { fs.rmSync(this.keyFile, { force: true }); } catch {}
  }

  get ready() { return !!this.key; }

  async complete(messages, opts) {
    const out = await this.request(messages, opts);
    const text = String(out.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) throw new Error('empty');
    return { text, emotion: out.emotion || 'normal' };
  }

  // 发请求并解析 JSON 输出
  async request(messages, { maxTokens = 160, temperature = 1.1, timeout = 9000 } = {}) {
    if (!this.key) throw new Error('no key');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await net.fetch(ENDPOINT, {
        method: 'POST',
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, response_format: { type: 'json_object' } }),
      });
      if (!res.ok) throw new Error(`deepseek ${res.status}`);
      const d = await res.json();
      const raw = d.choices?.[0]?.message?.content || '';
      try { return JSON.parse(raw); } catch { return { text: raw, emotion: 'normal' }; }
    } finally {
      clearTimeout(timer);
    }
  }

  // 一句闲聊（不超过 35 字），避免和最近说过的重复
  async idle(ctx) {
    const avoid = this.recentIdle.length ? `\n最近说过（不要重复这些意思）：${this.recentIdle.join(' / ')}` : '';
    const r = await this.complete([
      { role: 'system', content: persona(ctx) },
      { role: 'user', content: `【情境】${describe(ctx)}\n请主动对${you(ctx)}说一句自然的闲聊，不超过 35 个字，可以结合情境，也可以聊你自己的日常。${avoid}` },
    ], { maxTokens: 100 });
    this.recentIdle = [...this.recentIdle, r.text].slice(-8);
    return r;
  }

  // 聊天：带最近几轮记忆，回复不超过 50 字
  async chat(text, ctx) {
    const msgs = [
      { role: 'system', content: `${persona(ctx)}\n回复不超过 50 个字，像聊天一样自然，不要每次都反问。` },
      ...this.history.slice(-12),
      { role: 'user', content: `【情境】${describe(ctx)}\n${you(ctx)}说：${text}` },
    ];
    const r = await this.complete(msgs, { maxTokens: 220, temperature: 1.0 });
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify(r) });
    this.history = this.history.slice(-16);
    try { fs.writeFileSync(this.historyFile, JSON.stringify(this.history)); } catch {}
    return r;
  }

  // 估计歌曲 BPM（舞步模式用），结果缓存在本地
  async bpm(title, artist) {
    const file = path.join(this.dir, 'bpm-cache.json');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const key = `${title}|${artist || ''}`;
    if (cache[key]) return cache[key];
    const out = await this.request([
      { role: 'system', content: '你是音乐资料助手。只输出 JSON：{"bpm": 数字, "sure": true 或 false}。' },
      { role: 'user', content: `歌曲《${title}》${artist ? `，歌手 ${artist}` : ''}的速度（BPM）是多少？知道就给准确值；不知道就按曲名和歌手推测曲风给一个估计值，并把 sure 设为 false。` },
    ], { maxTokens: 40, temperature: 0.2 });
    const bpm = Number(out.bpm);
    if (!(bpm >= 40 && bpm <= 240)) throw new Error('bad bpm');
    cache[key] = { bpm, sure: !!out.sure };
    try { fs.writeFileSync(file, JSON.stringify(cache)); } catch {}
    return cache[key];
  }

  clearHistory() {
    this.history = [];
    try { fs.rmSync(this.historyFile, { force: true }); } catch {}
  }
}

module.exports = { AI };
