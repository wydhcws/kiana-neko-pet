// 歌词：先找本地 .lrc，再查公开歌词库 LRCLIB（lrclib.net），结果缓存到本地
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');

// 解析 LRC：支持一行多个时间戳，丢掉 [ar:] 这类元信息
function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: +m[1] * 60 + +m[2], text: words });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

const CACHE_V = 2;
const norm = (s) => (s || '').toLowerCase().replace(/[\s​()（）\[\]【】'"“”‘’.,，。!?！？\-_&/]+/g, '');

class Lyrics {
  constructor(cacheDir, localDir) {
    this.cacheDir = cacheDir;
    this.localDir = localDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    this.pending = new Map();
  }

  // 本地文件名只要包含歌名（忽略大小写和标点）就算匹配，同时包含歌手的优先
  findLocal(title, artist) {
    let files;
    try { files = fs.readdirSync(this.localDir).filter((f) => /\.lrc$/i.test(f)); } catch { return null; }
    const t = norm(title), a = norm(artist);
    if (!t) return null;
    const hits = files.filter((f) => norm(f.replace(/\.lrc$/i, '')).includes(t));
    const best = hits.find((f) => a && norm(f).includes(a)) || hits[0];
    if (!best) return null;
    try { return fs.readFileSync(path.join(this.localDir, best), 'utf8'); } catch { return null; }
  }

  async fetchJson(url) {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'kiana-neko-pet/1.0' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lrclib ${res.status}`);
    // LRCLIB 偶尔会带未转义的控制字符，先清掉再解析
    return JSON.parse((await res.text()).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
  }

  async fromLrclib({ title, artist, album, duration }) {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) q.set('album_name', album);
    if (duration) q.set('duration', String(Math.round(duration)));
    let d = await this.fetchJson(`https://lrclib.net/api/get?${q}`);
    if (!d || !(d.syncedLyrics || d.plainLyrics)) {
      // 精确匹配不到就搜索，挑时长最接近且带时间轴的
      const list = (await this.fetchJson(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`)) || [];
      // 搜索是模糊匹配，会返回别的歌手：必须歌手对得上，或者时长相差 3 秒以内（多半是同一首的翻唱）
      const names = (artist || '').split(/[&,，、/;]+|\s+(?:feat\.?|ft\.?|x)\s+/i).map(norm).filter(Boolean);
      const sameArtist = (x) => names.some((n) => norm(x.artistName).includes(n) || n.includes(norm(x.artistName)));
      const closeDur = (x) => duration && Math.abs((x.duration || 0) - duration) <= 3;
      const scored = list
        .filter((x) => (x.syncedLyrics || x.plainLyrics) && (sameArtist(x) || (x.syncedLyrics && closeDur(x))))
        .map((x) => ({ x, s: (x.syncedLyrics ? 0 : 100) + Math.abs((x.duration || 0) - (duration || x.duration || 0)) }))
        .sort((p, q2) => p.s - q2.s);
      d = scored[0] && scored[0].s < 110 ? scored[0].x : d;
    }
    // 还没有带时间轴的：歌手对不上时只按歌名搜，时长相差 3 秒以内的多半是同一首（翻唱常用同一伴奏）。
    // 只用于中文歌名：英文歌名重名太多（如 Green Green Grass，不同歌手的两首歌时长只差 1 秒），容易套错
    if (!(d && d.syncedLyrics) && duration && /[\u3400-\u9fff]/.test(title)) {
      const list = (await this.fetchJson(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title })}`)) || [];
      const same = list
        .filter((x) => x.syncedLyrics && norm(x.trackName) === norm(title) && Math.abs((x.duration || 0) - duration) <= 3)
        .sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration))[0];
      if (same) d = { syncedLyrics: same.syncedLyrics, plainLyrics: (d && d.plainLyrics) || same.plainLyrics };
    }
    if (!d) return null;
    return { synced: d.syncedLyrics || null, plain: d.plainLyrics || null };
  }

  // 返回 { lines: [{t, text}], synced: bool, source }，找不到返回 { lines: [] }
  get(song) {
    // 同名同歌手的不同版本（比如现场版）时长不同、时间轴也不同，按时长分开缓存
    const key = crypto.createHash('sha1').update(`${norm(song.title)}|${norm(song.artist)}|${Math.round(song.duration || 0)}`).digest('hex').slice(0, 20);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.load(song, key).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  async load(song, key) {
    const local = this.findLocal(song.title, song.artist);
    if (local) {
      const lines = parseLrc(local);
      if (lines.length) return { lines, synced: true, source: 'local' };
    }
    const file = path.join(this.cacheDir, `${key}.json`);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    // 没找到的结果只缓存一天，之后再试；查找规则升级过（v2 加了按歌名+时长兜底），旧的没时间轴的结果重查一次
    const stale = cached && !cached.synced && (cached.v !== CACHE_V || (!cached.plain && Date.now() - cached.at > 86400e3));
    if (!cached || stale) {
      try {
        const r = (await this.fromLrclib(song)) || { synced: null, plain: null };
        cached = { ...r, at: Date.now(), v: CACHE_V };
        fs.writeFileSync(file, JSON.stringify(cached));
      } catch {
        if (!cached) return { lines: [], synced: false, source: 'offline' };
      }
    }
    if (cached.synced) return { lines: parseLrc(cached.synced), synced: true, source: 'lrclib' };
    if (cached.plain) {
      return { lines: cached.plain.split(/\r?\n/).filter((l) => l.trim()).map((text) => ({ t: -1, text })), synced: false, source: 'lrclib' };
    }
    return { lines: [], synced: false, source: 'none' };
  }
}

module.exports = { Lyrics, parseLrc };
