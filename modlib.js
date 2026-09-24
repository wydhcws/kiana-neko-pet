// 模组库：扫描一个装着若干 MMD 模型的目录，自动整理成「人物 → 模型」的索引。
//
// 目录怎么摆都尽量认：
//   <根>/崩坏3/琪亚娜/琪亚娜—终焉律者/x.pmx   ← 游戏/人物/模型 三层
//   <根>/琪亚娜/琪亚娜夏装/x.pmx              ← 人物/模型 两层
//   <根>/琪亚娜夏装/x.pmx                     ← 全部平铺：按名字前缀把同一人物聚到一起
// 一个模型文件夹里常混着武器、坐骑等道具的 pmx，要把角色本体挑出来。
'use strict';
const fs = require('fs');
const path = require('path');

const PMX = /\.(pmx|pmd)$/i;
// 道具/配件关键词。整名匹配用来判断「剑.pmx」这类；
// 去掉人物名之后再匹配一次，用来判断「琪亚娜大招枪.pmx」这类带人物名的武器
const PROP_WORD = /(剑|刀|枪|弓|镰|武器|盾|翅膀|羽毛|翼|花|鹿|马|坐骑|宠物|背景|舞台|饰品|特效|光效|大招|长柄|法杖|弹幕)/;
// 一眼就不是人物名的目录名（作品名/整理用的分类目录）
const GAME_LIKE = /^(崩坏3|崩坏三|崩坏|星穹铁道|崩坏：星穹铁道|绝区零|原神|尘白禁区|明日方舟|其他|模型|mod|mods|models)$/i;
const MAX_DEPTH = 6;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const ls = (p) => { try { return fs.readdirSync(p).filter((f) => !f.startsWith('.')); } catch { return []; } };

// 从一个文件夹里挑出角色本体的 pmx（可能有多套，比如「短发/长发」「黑裙/白裙」都要保留）
function pickModels(dir, charName) {
  const files = ls(dir).filter((f) => PMX.test(f));
  if (!files.length) return [];
  const items = files.map((f) => ({ file: path.join(dir, f), stem: f.replace(PMX, ''), bytes: size(path.join(dir, f)) }));

  // 体积过滤：道具通常比角色本体小很多，保留不小于最大者一半的
  const bySize = (pool) => {
    const max = Math.max(...pool.map((i) => i.bytes));
    return pool.filter((i) => i.bytes >= max * 0.5);
  };

  // 1) 文件名里带人物名的，基本就是本体（战马.pmx / 鹿1.0.pmx 这类会被排除）
  if (charName) {
    const byName = items.filter((i) => i.stem.includes(charName));
    if (byName.length) {
      // 「琪亚娜大招枪」这种也带人物名，去掉人物名后若剩下武器词，就不算本体
      const real = byName.filter((i) => !PROP_WORD.test(i.stem.split(charName).join('')));
      return bySize(real.length ? real : byName);
    }
  }
  // 2) 没带人物名：先去掉一眼就是道具的，再按体积过滤
  const rest = items.filter((i) => !PROP_WORD.test(i.stem));
  return bySize(rest.length ? rest : items);
}

// 递归找出所有「含 pmx 的文件夹」
function findModelDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    const entries = ls(dir);
    if (entries.some((f) => PMX.test(f))) out.push(dir);
    for (const e of entries) {
      const p = path.join(dir, e);
      if (isDir(p)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// 去掉名字末尾的版本号/修饰，方便比较（「琪亚娜夏装1.0」→「琪亚娜夏装」）
const tidy = (s) => s.replace(/[\s_\-–—·]*v?\d+(\.\d+)*\s*$/i, '').trim();

// 两个字符串的公共前缀长度
function lcpLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// 平铺目录：靠名字的公共前缀把同一人物的多套模型聚到一起
// （「爱莉希雅律者2.0」「爱莉希雅泳装」→ 前缀「爱莉希雅」）
function clusterByPrefix(names, minLen = 2) {
  const sorted = [...names].sort();
  const groups = [];
  let cur = [sorted[0]], prefix = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = lcpLen(prefix, sorted[i]);
    if (n >= minLen) {
      cur.push(sorted[i]);
      prefix = prefix.slice(0, n);
    } else {
      groups.push({ prefix, names: cur });
      cur = [sorted[i]];
      prefix = sorted[i];
    }
  }
  groups.push({ prefix, names: cur });
  const map = new Map();
  for (const g of groups) {
    // 只有一套的就用它自己的名字；多套共享前缀的用前缀当人物名
    const label = g.names.length > 1 ? tidy(g.prefix) || g.prefix : tidy(g.names[0]);
    for (const n of g.names) map.set(n, label);
  }
  return map;
}

// 扫描根目录，返回 [{ game, char, models: [{ label, file }] }]
function scan(root, { knownNames = [] } = {}) {
  if (!isDir(root)) return [];
  const dirs = findModelDirs(root).filter((d) => path.relative(root, d) !== '');
  if (!dirs.length) return [];

  // 每个模型文件夹相对根目录的层级
  const infos = dirs.map((dir) => {
    const seg = path.relative(root, dir).split(path.sep);
    return { dir, seg, own: seg[seg.length - 1], ancestors: seg.slice(0, -1) };
  });

  // 判断整体结构：多数文件夹有几层祖先目录
  const deep = infos.filter((i) => i.ancestors.length >= 2).length;
  const mid = infos.filter((i) => i.ancestors.length === 1).length;
  const mode = deep >= infos.length * 0.6 ? 'game-char' : mid >= infos.length * 0.6 ? 'char' : 'flat';

  // 平铺时才需要靠前缀聚类
  const cluster = mode === 'flat' ? clusterByPrefix(infos.map((i) => i.own)) : null;
  const known = [...knownNames].sort((a, b) => b.length - a.length);
  const knownIn = (s) => known.find((n) => s.includes(n)) || null;

  const groups = new Map();   // key: game|char
  for (const info of infos) {
    let game = null, char = null;
    if (mode === 'game-char') {
      // 第一层若像作品名就当作品，人物取第二层；否则第一层就是人物
      if (GAME_LIKE.test(info.ancestors[0])) { game = info.ancestors[0]; char = info.ancestors[1]; }
      else char = info.ancestors[0];
    } else if (mode === 'char') {
      char = GAME_LIKE.test(info.ancestors[0]) ? null : info.ancestors[0];
    }
    // 结构没给出人物名，就用已知人物名匹配，再退回前缀聚类的结果
    if (!char) char = knownIn(info.own) || (cluster && cluster.get(info.own)) || tidy(info.own);

    const models = pickModels(info.dir, char);
    if (!models.length) continue;
    const key = `${game || ''}|${char}`;
    if (!groups.has(key)) groups.set(key, { game: game || '', char, models: [] });
    const g = groups.get(key);
    for (const m of models) {
      // 一个文件夹只出一套时用文件夹名；出多套（短发/长发、黑裙/白裙）才补上区别
      const label = models.length === 1 || m.stem.includes(info.own) || info.own.includes(m.stem)
        ? info.own : `${info.own} · ${m.stem}`;
      g.models.push({ label, file: m.file });
    }
  }

  const out = [...groups.values()];
  for (const g of out) g.models.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  out.sort((a, b) => (a.game || '').localeCompare(b.game || '', 'zh') || a.char.localeCompare(b.char, 'zh'));
  return out;
}

module.exports = { scan, pickModels, clusterByPrefix };
