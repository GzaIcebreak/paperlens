/* 译文覆盖层：把译文按原文块的矩形回填，自动适配字号，保持整体排版 */

const SANS = '"Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
const SERIF = '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun","Georgia",serif';

/* ---------- 背景取色：从已渲染的 canvas 上采样，保证遮盖后底色一致 ---------- */
function quant(v) { return (v >> 3) << 3; }

export function sampleBg(canvas, block, scale) {
  try {
    const ctx = canvas.__ctx || (canvas.__ctx = canvas.getContext('2d'));
    const dpr = canvas.width / (canvas.__cssWidth || canvas.width);
    const k = scale * dpr;
    const W = canvas.width, H = canvas.height;
    const pad = Math.max(1, Math.round(1.5 * k));

    const x0 = Math.round(block.x0 * k), y0 = Math.round(block.top * k);
    const x1 = Math.round(block.x1 * k), y1 = Math.round(block.bottom * k);
    // 只读取块外扩一圈的这一小片区域，整页只需每块一次读回
    const rx = Math.max(0, x0 - pad), ry = Math.max(0, y0 - pad);
    const rw = Math.min(W - rx, x1 - x0 + pad * 2);
    const rh = Math.min(H - ry, y1 - y0 + pad * 2);
    if (rw <= 2 || rh <= 2) return '#ffffff';
    const img = ctx.getImageData(rx, ry, rw, rh);
    const at = (x, y) => {
      const px = Math.min(rw - 1, Math.max(0, x - rx));
      const py = Math.min(rh - 1, Math.max(0, y - ry));
      const i = (py * rw + px) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };

    // 取块四周（而不是块内）的点：块内全是原文文字，会把底色带偏
    const pts = [];
    for (const f of [0.2, 0.5, 0.8]) {
      const x = Math.round(x0 + (x1 - x0) * f);
      pts.push([x, y0 - pad], [x, y1 + pad - 1]);
    }
    for (const f of [0.2, 0.5, 0.8]) {
      const y = Math.round(y0 + (y1 - y0) * f);
      pts.push([x0 - pad, y], [x1 + pad - 1, y]);
    }

    // 量化只用于投票分桶，返回的是该桶内像素的真实均值，避免把纯白变成浅灰
    const votes = new Map();
    for (const p of pts) {
      const d = at(p[0], p[1]);
      const key = quant(d[0]) + ',' + quant(d[1]) + ',' + quant(d[2]);
      const v = votes.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      v.n++; v.r += d[0]; v.g += d[1]; v.b += d[2];
      votes.set(key, v);
    }
    let best = null;
    for (const e of votes) if (!best || e[1].n > best.n) best = e[1];
    if (!best || best.n < pts.length * 0.4) return '#ffffff';
    // 深色底也照样沿用，文字会自动转成浅色
    return 'rgb(' + Math.round(best.r / best.n) + ',' + Math.round(best.g / best.n) + ',' + Math.round(best.b / best.n) + ')';
  } catch (e) {
    return '#ffffff';
  }
}

function luminance(css) {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
  if (!m) return 1;
  return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
}

/* ---------- 元素创建与定位 ---------- */
export function createOverlayEl(block) {
  const el = document.createElement('div');
  el.className = 'pl-ov';
  el.dataset.id = block.id;
  if (block.isHeading) el.classList.add('pl-ov-head');
  const inner = document.createElement('div');
  inner.className = 'pl-ov-in';
  el.appendChild(inner);
  return el;
}

/**
 * 定位 + 排版适配
 * @param el  覆盖层元素
 * @param block 版面块（scale=1 坐标）
 * @param scale 当前缩放
 * @param ctx  { bg, extraBelow, fontFamily }
 */
export function layoutOverlay(el, block, scale, ctx) {
  ctx = ctx || {};
  const pad = 0.6 * scale;
  const left = block.x0 * scale - pad;
  const top = block.top * scale - pad * 0.6;
  const width = (block.x1 - block.x0) * scale + pad * 2;
  const height = (block.bottom - block.top) * scale + pad * 1.2;
  const extra = Math.max(0, Math.min((ctx.extraBelow || 0) * scale, height * 0.75));

  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.setProperty('--pl-max-h', (height + extra) + 'px');

  const bg = ctx.bg || '#ffffff';
  el.style.background = bg;
  const dark = luminance(bg) < 0.5;
  el.style.color = dark ? '#f2f2f2' : '#111318';

  const inner = el.firstChild;
  const fam = ctx.fontFamily || (block.serif ? SERIF : SANS);
  inner.style.fontFamily = fam;
  inner.style.fontWeight = block.isHeading ? '600' : '400';

  // 对齐方式：单行且左右都留白 → 居中；多行 → 两端对齐
  let align = 'left';
  if (block.lines.length === 1 && block.colLeft !== undefined) {
    const lgap = block.x0 - block.colLeft;
    const rgap = block.colRight - block.x1;
    if (lgap > block.fh * 1.5 && rgap > block.fh * 1.5 && Math.abs(lgap - rgap) < block.fh * 2) align = 'center';
  } else if (block.lines.length > 1) {
    align = 'justify';
  }
  inner.style.textAlign = align;

  const lh = Math.max(1.12, Math.min(1.5, (block.leading || block.fh * 1.2) / (block.fh || 1)));
  inner.style.lineHeight = String(lh);

  fitText(el, inner, block, scale, height + extra);
}

/** 二分搜索最大可容纳字号 */
function fitText(el, inner, block, scale, maxH) {
  const base = (block.fh || 10) * scale;
  let lo = Math.max(3, base * 0.42);
  let hi = base * 1.06;

  inner.style.fontSize = hi + 'px';
  if (inner.scrollHeight <= maxH + 0.5) {
    el.classList.remove('pl-ov-clip');
    el.style.height = Math.max(parseFloat(el.style.height), Math.min(maxH, inner.scrollHeight)) + 'px';
    return;
  }
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    inner.style.fontSize = mid + 'px';
    if (inner.scrollHeight <= maxH + 0.5) lo = mid; else hi = mid;
  }
  inner.style.fontSize = lo + 'px';
  // 极端情况仍放不下：轻微压缩字间距后允许裁切
  if (inner.scrollHeight > maxH + 1) {
    inner.style.letterSpacing = '-0.02em';
    el.classList.add('pl-ov-clip');
    el.title = block.text;
  } else {
    inner.style.letterSpacing = '';
    el.classList.remove('pl-ov-clip');
  }
  el.style.height = Math.min(maxH, Math.max(parseFloat(el.style.height), inner.scrollHeight)) + 'px';
}

/** 计算块下方可借用的空白高度（不侵占下一个块） */
export function computeExtraBelow(blocks, i) {
  const b = blocks[i];
  let limit = Infinity;
  for (let j = 0; j < blocks.length; j++) {
    if (j === i) continue;
    const o = blocks[j];
    if (o.top < b.bottom) continue;
    const ovX = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0);
    if (ovX <= 0) continue;
    limit = Math.min(limit, o.top - b.bottom);
  }
  if (!isFinite(limit)) limit = b.fh * 1.6;
  return Math.max(0, limit - b.fh * 0.25);
}
