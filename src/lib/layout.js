/* 版面分析：把 pdf.js 的 textContent.items 还原成「栏 → 行 → 段落块」
 * 输出的 block 带有精确矩形，译文按同一矩形回填即可保持排版。
 * 所有坐标均为 scale=1 的 viewport 坐标（左上角原点，单位 pt）。 */

import { Util } from '../../vendor/pdfjs/pdf.mjs';

const ANGLE_TOL = 0.06;      // 视为水平文本的弧度阈值
const SPACE_GAP = 0.20;      // 超过 fh 的该比例即补空格
const WIDE_GAP = 1.6;        // 超过则视为表格列间距

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
}

function overlap1d(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/* ---------- 1. 原子（字符串片段） ---------- */
function buildAtoms(items, viewport, styles) {
  const atoms = [];
  const rotated = [];
  for (const item of items) {
    if (item.type) continue;                 // marked content
    if (!item.str || !item.str.trim()) continue;
    const tr = Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(tr[1], tr[0]);
    const fh = Math.hypot(tr[2], tr[3]) || item.height || 10;
    const w = (item.width || 0) * viewport.scale;
    const a = {
      str: item.str,
      x: tr[4],
      y: tr[5],                              // 基线 y
      w,
      fh,
      font: item.fontName || '',
      ff: (styles && styles[item.fontName] && styles[item.fontName].fontFamily) || '',
      eol: !!item.hasEOL
    };
    if (Math.abs(angle) > ANGLE_TOL) { a.angle = angle; rotated.push(a); continue; }
    atoms.push(a);
  }
  return { atoms, rotated };
}

/* ---------- 2. 分栏 ----------
 * 用「原子覆盖计数」而不是行覆盖：通栏标题只贡献少量原子，
 * 因此栏间白槽依然是低覆盖区，能在有通栏标题的双栏论文上正确切栏。 */
function detectColumns(atoms, pageWidth) {
  if (atoms.length < 40) return [];
  const BIN = 2;
  const n = Math.ceil(pageWidth / BIN) + 1;
  const cov = new Float32Array(n);
  for (const a of atoms) {
    const s = Math.max(0, Math.floor(a.x / BIN));
    const e = Math.min(n - 1, Math.ceil((a.x + a.w) / BIN));
    for (let i = s; i <= e; i++) cov[i] += 1;
  }

  const lo = Math.floor(pageWidth * 0.10 / BIN);
  const hi = Math.floor(pageWidth * 0.90 / BIN);
  const inner = [];
  for (let i = lo; i <= hi; i++) if (cov[i] > 0) inner.push(cov[i]);
  if (inner.length < 20) return [];

  const idx = (x) => Math.max(0, Math.min(n - 1, Math.floor(x / BIN)));
  const medianRange = (x0, x1) => {
    const a = [];
    for (let i = idx(x0); i <= idx(x1); i++) a.push(cov[i]);
    return percentile(a, 0.5);
  };

  /* 在 targetX 附近找「山谷」：谷底显著低于两侧局部中位数才算白槽。
   * 用局部对比而非全局阈值，页面里有通栏表格/大图时依然能切出栏。 */
  const findGutter = (targetX, tolX) => {
    const s = idx(targetX - tolX), e = idx(targetX + tolX);
    let bi = -1, bv = Infinity;
    for (let i = s; i <= e; i++) if (cov[i] < bv) { bv = cov[i]; bi = i; }
    if (bi < 0) return null;
    const cx = bi * BIN;
    const L = medianRange(cx - pageWidth * 0.14, cx - pageWidth * 0.03);
    const R = medianRange(cx + pageWidth * 0.03, cx + pageWidth * 0.14);
    const side = Math.min(L, R);
    if (!side || bv > side * 0.55) return null;
    const thr = side * 0.6;
    let i0 = bi, i1 = bi;
    while (i0 > lo && cov[i0 - 1] <= thr) i0--;
    while (i1 < hi && cov[i1 + 1] <= thr) i1++;
    const w = (i1 - i0 + 1) * BIN;
    if (w < pageWidth * 0.012) return null;
    return { x0: i0 * BIN, x1: (i1 + 1) * BIN, cx: ((i0 + i1 + 1) / 2) * BIN, w };
  };

  // 校验：各栏文本量均衡，且横跨白槽的原子很少（真正的白槽只会被通栏标题穿过）
  const validate = (gs) => {
    const bounds = [0].concat(gs.map(g => g.cx), [pageWidth]);
    const counts = new Array(bounds.length - 1).fill(0);
    let spanning = 0;
    for (const a of atoms) {
      const c = a.x + a.w / 2;
      for (let i = 0; i < counts.length; i++) {
        if (c >= bounds[i] && c < bounds[i + 1]) { counts[i]++; break; }
      }
      for (const g of gs) if (a.x < g.x0 - 1 && a.x + a.w > g.x1 + 1) { spanning++; break; }
    }
    const minShare = gs.length === 1 ? 0.18 : 0.12;
    if (counts.some(c => c < atoms.length * minShare)) return false;
    if (spanning > atoms.length * 0.12) return false;
    return true;
  };

  const g2 = findGutter(pageWidth / 2, pageWidth * 0.13);
  if (g2 && validate([g2])) return [g2];

  const a = findGutter(pageWidth / 3, pageWidth * 0.08);
  const b = findGutter(pageWidth * 2 / 3, pageWidth * 0.08);
  if (a && b && a.x1 < b.x0 && validate([a, b])) return [a, b];

  return [];
}

function assignColumn(a, gutters) {
  if (!gutters.length) return 0;
  for (const g of gutters) {
    if (a.x < g.x0 - 1 && a.x + a.w > g.x1 + 1) return -1;   // 跨栏（通栏标题/大图）
  }
  const c = a.x + a.w / 2;
  let idx = 0;
  for (const g of gutters) { if (c > g.cx) idx++; }
  return idx;
}

/* ---------- 3. 成行 ---------- */
function buildLines(atoms, col) {
  const sorted = atoms.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  let cur = null;
  for (const a of sorted) {
    if (cur) {
      const fh = Math.max(cur.fh, a.fh);
      if (Math.abs(a.y - cur.y) <= fh * 0.5) {
        cur.atoms.push(a);
        cur.fh = Math.max(cur.fh, a.fh);
        cur.y = (cur.y * (cur.atoms.length - 1) + a.y) / cur.atoms.length;
        continue;
      }
    }
    cur = { atoms: [a], y: a.y, fh: a.fh, col };
    lines.push(cur);
  }
  for (const l of lines) finalizeLine(l);
  return lines;
}

function finalizeLine(l) {
  l.atoms.sort((a, b) => a.x - b.x);
  const fhs = l.atoms.map(a => a.fh);
  l.fh = median(fhs) || l.fh;
  l.x0 = Math.min.apply(null, l.atoms.map(a => a.x));
  l.x1 = Math.max.apply(null, l.atoms.map(a => a.x + a.w));
  l.top = Math.min.apply(null, l.atoms.map(a => a.y - a.fh * 0.86));
  l.bottom = Math.max.apply(null, l.atoms.map(a => a.y + a.fh * 0.26));
  l.baseline = median(l.atoms.map(a => a.y));

  let text = '';
  let prev = null;
  for (const a of l.atoms) {
    if (prev) {
      const gap = a.x - (prev.x + prev.w);
      const unit = Math.max(prev.fh, a.fh) || 10;
      const endsSpace = /\s$/.test(text);
      const startsSpace = /^\s/.test(a.str);
      if (!endsSpace && !startsSpace && gap > unit * SPACE_GAP) {
        text += (gap > unit * WIDE_GAP) ? '   ' : ' ';
      }
    }
    text += a.str;
    prev = a;
  }
  l.text = text.replace(/\s+$/, '');
  l.hasEOL = l.atoms[l.atoms.length - 1].eol;
}

/* ---------- 4. 成段 ---------- */
const LIST_RE = /^\s*(?:\(?\d{1,3}[.)]\s|[•·▪◦‣∙*]\s|[-–—]\s|\(?[a-z][.)]\s|[IVXivx]{1,4}[.)]\s)/;
const HEAD_RE = /^\s*(?:\d{1,2}(?:\.\d{1,2})*\.?\s+\S|[A-Z][A-Z\s]{3,}$|(?:Abstract|ABSTRACT|Introduction|Conclusion|References|Acknowledg))/;

function groupBlocks(lines, colRight, pageIndex) {
  const blocks = [];
  let cur = null;
  const push = () => { if (cur) { finalizeBlock(cur); blocks.push(cur); cur = null; } };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!cur) { cur = newBlock(line, pageIndex); continue; }
    const prev = cur.lines[cur.lines.length - 1];
    const fh = Math.max(prev.fh, line.fh) || 10;
    const gap = line.top - prev.bottom;

    const fhOk = Math.min(prev.fh, line.fh) / Math.max(prev.fh, line.fh) > 0.82;
    const gapOk = gap <= fh * 0.85 && gap > -fh * 0.6;
    const ov = overlap1d(cur.x0, cur.x1, line.x0, line.x1);
    const ovOk = ov >= Math.min(cur.x1 - cur.x0, line.x1 - line.x0) * 0.30;
    const prevFull = prev.x1 >= colRight - fh * 2.5;      // 上一行排满 → 段未结束
    let indented = line.x0 - cur.x0 > fh * 0.8;           // 首行缩进 → 新段
    // 悬挂缩进（参考文献、编号列表）：本行之后还有同样左边界的续行，说明是同一段的延续
    if (indented && cur.hang !== undefined && Math.abs(line.x0 - cur.hang) < fh * 0.4) {
      indented = false;
    } else if (indented && cur.lines.length === 1) {
      const next = lines[li + 1];
      if (next && Math.abs(next.x0 - line.x0) < fh * 0.4 && next.top - line.bottom <= fh * 0.85) {
        indented = false;
        cur.hang = line.x0;
      }
    }
    const listStart = LIST_RE.test(line.text);

    if (fhOk && gapOk && ovOk && prevFull && !indented && !listStart) {
      cur.lines.push(line);
      cur.x0 = Math.min(cur.x0, line.x0);
      cur.x1 = Math.max(cur.x1, line.x1);
    } else {
      push();
      cur = newBlock(line, pageIndex);
    }
  }
  push();
  return blocks;
}

function newBlock(line, pageIndex) {
  return { lines: [line], x0: line.x0, x1: line.x1, col: line.col, page: pageIndex };
}

function finalizeBlock(b) {
  b.top = Math.min.apply(null, b.lines.map(l => l.top));
  b.bottom = Math.max.apply(null, b.lines.map(l => l.bottom));
  b.x0 = Math.min.apply(null, b.lines.map(l => l.x0));
  b.x1 = Math.max.apply(null, b.lines.map(l => l.x1));
  b.fh = median(b.lines.map(l => l.fh));
  b.width = b.x1 - b.x0;
  b.height = b.bottom - b.top;
  const gaps = [];
  for (let i = 1; i < b.lines.length; i++) gaps.push(b.lines[i].top - b.lines[i - 1].top);
  b.leading = gaps.length ? median(gaps) : b.fh * 1.2;

  let text = '';
  b.lines.forEach((l, i) => {
    const t = l.text;
    if (i === 0) { text = t; return; }
    if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(t)) text = text.slice(0, -1) + t;      // 断词连字符
    else if (/[一-鿿]$/.test(text) && /^[一-鿿]/.test(t)) text += t;    // 中文不加空格
    else text += ' ' + t;
  });
  b.text = text.replace(/[ \t]{2,}/g, '  ').trim();
  b.isHeading = b.lines.length <= 2 && HEAD_RE.test(b.text) && b.text.length < 120;

  // 原文字体是否衬线体（用于译文选用宋体/黑体）
  let serif = 0, total = 0;
  for (const l of b.lines) for (const a of l.atoms) {
    if (!a.ff) continue;
    total++;
    if (/serif/i.test(a.ff) && !/sans/i.test(a.ff)) serif++;
  }
  b.serif = total > 0 && serif / total > 0.5;
}

/* ---------- 5. 阅读顺序 ---------- */
function orderBlocks(blocks) {
  const full = blocks.filter(b => b.col === -1).sort((a, b) => a.top - b.top);
  const cols = blocks.filter(b => b.col !== -1);
  const out = [];
  let cursor = -Infinity;
  const take = (yTop) => {
    const seg = cols.filter(b => !b._used && b.top >= cursor && b.top < yTop);
    seg.sort((a, b) => (a.col - b.col) || (a.top - b.top) || (a.x0 - b.x0));
    seg.forEach(b => { b._used = true; out.push(b); });
  };
  for (const f of full) { take(f.top); out.push(f); cursor = Math.max(cursor, f.bottom - 1); }
  take(Infinity);
  cols.forEach(b => { delete b._used; });
  return out;
}

/* ---------- 6. 是否需要翻译 ---------- */
const CJK_RE = /[぀-ヿ一-鿿가-힯]/g;

export function classifyBlock(b, pageHeight) {
  const t = (b.text || '').trim();
  if (t.length < 3) return 'skip';

  // 页眉页脚 / 页码 / 行号
  const single = b.lines.length === 1;
  if (single && t.length < 80 && (b.top < pageHeight * 0.055 || b.bottom > pageHeight * 0.95)) return 'skip';
  if (/^[\divxlcIVXLC\s.,:;|/\-–—]+$/.test(t)) return 'skip';

  const cjk = (t.match(CJK_RE) || []).length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const words = t.split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w)).length;

  // 公式 / 纯符号 / 数字表格
  if ((letters + cjk) / t.length < 0.45) return 'skip';
  if (cjk / Math.max(1, letters + cjk) > 0.35) return 'cjk';   // 源文已是中日韩
  // 单词块（表格单元、图例）不翻译——缺上下文容易译错；但 Abstract 这类单词标题保留
  if (words < 2 && cjk === 0 && !(b.isHeading && letters >= 4)) return 'skip';

  // 参考文献条目
  if (/^\[?\d{1,3}[\].]\s*\S/.test(t) && /\b(19|20)\d{2}\b/.test(t) && t.length > 60) return 'ref';
  return 'text';
}

/* ---------- 入口 ---------- */
export function analyzePage(textContent, viewport, pageIndex) {
  const { atoms, rotated } = buildAtoms(textContent.items, viewport, textContent.styles);
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;
  const gutters = detectColumns(atoms, pageWidth);

  const buckets = new Map();
  for (const a of atoms) {
    const c = assignColumn(a, gutters);
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(a);
  }

  let blocks = [];
  const allLines = [];
  for (const entry of buckets) {
    const col = entry[0];
    const lines = buildLines(entry[1], col);
    allLines.push.apply(allLines, lines);
    const colRight = percentile(lines.map(l => l.x1), 0.92);
    const colLeft = percentile(lines.map(l => l.x0), 0.08);
    const bs = groupBlocks(lines, colRight, pageIndex);
    bs.forEach(b => { b.colLeft = colLeft; b.colRight = colRight; });
    blocks = blocks.concat(bs);
  }
  blocks = orderBlocks(blocks);
  blocks.forEach((b, i) => {
    b.index = i;
    b.id = pageIndex + ':' + i;
    b.kind = classifyBlock(b, pageHeight);
  });

  return {
    blocks,
    lines: allLines,
    rotated,
    width: pageWidth,
    height: pageHeight,
    columns: gutters.length + 1
  };
}

export function pageToText(blocks) {
  return blocks.map(b => b.text).filter(Boolean).join('\n\n');
}
