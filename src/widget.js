// Draws the home-screen widget as a PNG, with no dependencies.
// A tiny RGB canvas, anti-aliased text from a pre-rendered Inter atlas, and a PNG encoder.
import { FONT, FONT_SCALE } from "./font.js";

const PALETTES = {
  dark: {
    bg: [25, 25, 25], text: [230, 230, 228], muted: [155, 155, 152], empty: [42, 42, 42],
    c: { purple: "#9d68d3", blue: "#447acb", green: "#4f9768", brown: "#a27763", pink: "#d15796", red: "#df5452", yellow: "#cb9433", gray: "#9b9b98", orange: "#dc8c47", default: "#7d7a75", none: "#4a4a4a" },
  },
  light: {
    bg: [255, 255, 255], text: [55, 53, 47], muted: [120, 119, 116], empty: [241, 241, 239],
    c: { purple: "#9065b0", blue: "#337ea9", green: "#448361", brown: "#9f6b53", pink: "#c14c8a", red: "#d44c47", yellow: "#cb912f", gray: "#787774", orange: "#d9730d", default: "#a5a29a", none: "#c7c6c2" },
  },
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));

// ---------- canvas ----------
class Canvas {
  constructor(w, h, bg) {
    this.w = w; this.h = h; this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  blend(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3, p = this.px;
    if (a >= 1) { p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; return; }
    p[i] = p[i] + (rgb[0] - p[i]) * a; p[i + 1] = p[i + 1] + (rgb[1] - p[i + 1]) * a; p[i + 2] = p[i + 2] + (rgb[2] - p[i + 2]) * a;
  }
  // Rounded rectangle with a soft (anti-aliased) edge.
  rect(x, y, w, h, rgb, r = 0) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    r = Math.min(r, w / 2, h / 2);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let a = 1;
      if (r > 0) {
        const cx = xx < r ? r : xx >= w - r ? w - r : null;
        const cy = yy < r ? r : yy >= h - r ? h - r : null;
        if (cx !== null && cy !== null) {
          const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
          a = Math.max(0, Math.min(1, r - d + 0.5));
        }
      }
      this.blend(x + xx, y + yy, rgb, a);
    }
  }
  outline(x, y, w, h, rgb, r, t) {
    // draw ring by painting outer rect then restoring inner region is costly; draw 4 edges instead
    this.rect(x, y, w, t, rgb, 0); this.rect(x, y + h - t, w, t, rgb, 0);
    this.rect(x, y, t, h, rgb, 0); this.rect(x + w - t, y, t, h, rgb, 0);
  }
}

// ---------- text ----------
const glyphCache = {};
function glyph(font, ch) {
  const key = font + ch;
  if (glyphCache[key]) return glyphCache[key];
  const g = FONT[font].g[ch] || FONT[font].g["?"];
  const [adv, xo, yo, w, h, b64] = g;
  const bin = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null;
  return (glyphCache[key] = { adv, xo, yo, w, h, bin });
}
function textWidth(str, font) { let w = 0; for (const ch of str) w += glyph(font, ch).adv; return w; }
function fitText(str, font, max) {
  if (textWidth(str, font) <= max) return str;
  while (str.length > 1 && textWidth(str + "…".replace("…", "..."), font) > max) str = str.slice(0, -1);
  return str + "...";
}
// x, baseline y
function text(cv, str, x, y, font, rgb, align = "left") {
  if (align !== "left") { const w = textWidth(str, font); x -= align === "right" ? w : w / 2; }
  let pen = x;
  for (const ch of str) {
    const g = glyph(font, ch);
    if (g.bin) {
      const gx = Math.round(pen + g.xo), gy = Math.round(y + g.yo);
      for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) {
        const a = g.bin[yy * g.w + xx];
        if (a) cv.blend(gx + xx, gy + yy, rgb, a / 255);
      }
    }
    pen += g.adv;
  }
}

// ---------- PNG ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function encodePNG(cv) {
  const raw = new Uint8Array((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) { raw[y * (cv.w * 3 + 1)] = 0; raw.set(cv.px.subarray(y * cv.w * 3, (y + 1) * cv.w * 3), y * (cv.w * 3 + 1) + 1); }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, cv.w); dv.setUint32(4, cv.h); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- the widget ----------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmt = (h) => String(Math.round(h * 10) / 10);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// data: same shape as /api/data. today: "YYYY-MM-DD" in the user's time zone.
// ratio = width / height of the widget on the phone (any shape works); size is the older preset name.
// Layout is in design units (longest side = 900); pixels are drawn at FONT_SCALE (2x) for sharpness.
function layout(data, { today, theme = "dark", size = "wide", ratio }) {
  const P = PALETTES[theme] || PALETTES.dark;
  const S = FONT_SCALE;
  const color = {};
  for (const c of data.classes) color[c.name] = hex(P.c[c.color] || P.c.none);
  const byDate = Object.fromEntries(data.days.map((d) => [d.date, d]));
  const [ty, tm, td] = today.split("-").map(Number);
  const y = ty, m = tm - 1;
  const nDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const first = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const rows = Math.ceil((first + nDays) / 7);

  const t = new Date(Date.UTC(ty, tm - 1, td));
  const mon = new Date(t); mon.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const week = {};
  for (let k = 0; k < 7; k++) {
    const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + k);
    const r = byDate[iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())];
    if (r) for (const [c, v] of Object.entries(r.hours)) week[c] = (week[c] || 0) + v;
  }
  const weekTotal = sum(week);
  const monthHours = [];
  for (let d = 1; d <= nDays; d++) monthHours.push(byDate[iso(y, m, d)]?.hours || {});
  const maxDay = Math.max(1, ...monthHours.map(sum));

  // Canvas shape
  let R = Number(ratio);
  if (!(R > 0)) R = size === "square" ? 1 : 2;
  R = Math.max(0.45, Math.min(4.5, R));
  const Wd = R >= 1 ? 900 : 900 * R, Hd = R >= 1 ? 900 / R : 900;
  // Record drawing operations in design units; the PNG and SVG backends replay them.
  const ops = [];
  const box = (x, yy, w, h, rgb, r = 0) => ops.push(["rect", x, yy, w, h, rgb, r]);
  const ring = (x, yy, w, h, rgb, th) => ops.push(["ring", x, yy, w, h, rgb, th]);
  const write = (str, x, yy, font, rgb, align = "left") => ops.push(["text", str, x, yy, font, rgb, align]);
  const widthOf = (str, font) => textWidth(str, font) / S;
  const fit = (str, font, max) => fitText(str, font, max * S);

  const pad = Math.max(16, Math.min(28, Math.min(Wd, Hd) * 0.07));
  const tiny = Hd < 260; // very short widget: drop the big title
  // header
  if (!tiny) {
    write(MONTHS[m], pad, pad + 34, "t", P.text);
    write("CHRONOS", Wd - pad, pad + 20, "s", P.muted, "right");
  }
  const landscape = R >= 1.35;
  const top = tiny ? pad : pad + 56;
  const gap = 6, dowH = 22;

  // calendar size
  let cell, calX = pad, calY = top + dowH, wx, wy, ww, wh;
  if (landscape) {
    const availH = Hd - calY - pad;
    cell = Math.min((availH - gap * (rows - 1)) / rows, ((Wd - 2 * pad) * 0.5 - gap * 6) / 7);
    const calW = cell * 7 + gap * 6;
    wx = calX + calW + Math.max(24, pad * 1.4); wy = top - 2; ww = Wd - wx - pad; wh = Hd - wy - pad;
  } else {
    const availH = (Hd - calY - pad) * 0.6;
    cell = Math.min((availH - gap * (rows - 1)) / rows, (Wd - 2 * pad - gap * 6) / 7);
    wx = pad; wy = calY + rows * (cell + gap) + 14; ww = Wd - 2 * pad; wh = Hd - wy - pad;
  }
  cell = Math.max(10, cell);
  if (!landscape) calX = pad + Math.max(0, (Wd - 2 * pad - (cell * 7 + gap * 6)) / 2); // centre the calendar when stacked
  const radius = Math.max(3, cell * 0.16);
  const numFont = cell >= 34 ? "s" : null;
  ["M", "T", "W", "T", "F", "S", "S"].forEach((l, i) => write(l, calX + i * (cell + gap) + cell / 2, calY - 7, "s", P.muted, "center"));
  for (let d = 1; d <= nDays; d++) {
    const idx = first + d - 1, cx = calX + (idx % 7) * (cell + gap), cy = calY + Math.floor(idx / 7) * (cell + gap);
    const h = monthHours[d - 1], tot = sum(h);
    let fill = P.empty;
    if (tot > 0) {
      const topC = Object.entries(h).sort((a, b) => b[1] - a[1])[0][0];
      fill = mix(color[topC] || hex(P.c.none), P.empty, 0.35 + 0.65 * (tot / maxDay));
    }
    box(cx, cy, cell, cell, fill, radius);
    if (d === td) ring(cx - 3, cy - 3, cell + 6, cell + 6, P.text, 2);
    if (numFont) {
      const lum = (0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2]) / 255;
      write(String(d), cx + cell * 0.14, cy + 18, numFont, tot === 0 ? P.muted : lum > 0.62 ? [55, 53, 47] : [255, 255, 255]);
    }
  }

  // this week
  if (wh >= 30 && ww >= 120) {
    write("This week", wx, wy + 22, "b", P.text);
    write(`${fmt(weekTotal)} h`, wx + ww, wy + 22, "b", P.text, "right");
    const entries = Object.entries(week).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const rowH = 36;
    const rowsAvail = Math.max(0, Math.floor((wh - 44) / rowH));
    const maxW = Math.max(1, ...entries.map(([, v]) => v));
    const labelW = Math.min(170, Math.max(90, ...entries.map(([c]) => widthOf(c, "m") + 26)), ww * 0.42);
    if (!entries.length && rowsAvail > 0) write("No hours logged yet this week.", wx, wy + 66, "m", P.muted);
    const shown = entries.length > rowsAvail ? Math.max(0, rowsAvail - 1) : entries.length;
    entries.slice(0, shown).forEach(([c, v], i) => {
      const ry = wy + 44 + i * rowH;
      box(wx, ry + 6, 12, 12, color[c] || hex(P.c.none), 3);
      write(fit(c, "m", labelW - 24), wx + 20, ry + 19, "m", P.text);
      const bx = wx + labelW + 10, bw = Math.max(20, ww - labelW - 78);
      box(bx, ry + 4, bw, 16, P.empty, 5);
      box(bx, ry + 4, Math.max(6, (bw * v) / maxW), 16, color[c] || hex(P.c.none), 5);
      write(`${fmt(v)}h`, wx + ww, ry + 19, "m", P.muted, "right");
    });
    if (entries.length > shown && rowsAvail > 0) write(`+${entries.length - shown} more`, wx, wy + 44 + shown * rowH + 16, "s", P.muted);
  }
  return { Wd, Hd, bg: P.bg, ops };
}

export async function renderWidget(data, opts) {
  const S = FONT_SCALE;
  const L = layout(data, opts);
  const cv = new Canvas(Math.round(L.Wd * S), Math.round(L.Hd * S), L.bg);
  for (const op of L.ops) {
    if (op[0] === "rect") { const [, x, y, w, h, rgb, r] = op; cv.rect(x * S, y * S, w * S, h * S, rgb, r * S); }
    else if (op[0] === "ring") { const [, x, y, w, h, rgb, th] = op; cv.outline(Math.round(x * S), Math.round(y * S), Math.round(w * S), Math.round(h * S), rgb, 0, Math.round(th * S)); }
    else { const [, str, x, y, font, rgb, align] = op; text(cv, str, x * S, y * S, font, rgb, align); }
  }
  return encodePNG(cv);
}

// Vector version: stays sharp at any size. Text uses the phone's own sans-serif font.
const SVG_FONT = { s: [20, 500], m: [24, 500], b: [26, 600], t: [40, 600] };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
export function renderWidgetSVG(data, opts) {
  const L = layout(data, opts);
  const W = Math.round(L.Wd), H = Math.round(L.Hd);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${rgbStr(L.bg)}"/>`];
  for (const op of L.ops) {
    if (op[0] === "rect") { const [, x, y, w, h, rgb, r] = op; out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(r || 0).toFixed(1)}" fill="${rgbStr(rgb)}"/>`); }
    else if (op[0] === "ring") { const [, x, y, w, h, rgb, th] = op; out.push(`<rect x="${(x + th / 2).toFixed(1)}" y="${(y + th / 2).toFixed(1)}" width="${(w - th).toFixed(1)}" height="${(h - th).toFixed(1)}" fill="none" stroke="${rgbStr(rgb)}" stroke-width="${th}"/>`); }
    else {
      const [, str, x, y, font, rgb, align] = op; const [size, weight] = SVG_FONT[font];
      const anchor = align === "right" ? "end" : align === "center" ? "middle" : "start";
      out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Roboto, Inter, sans-serif" font-size="${size}" font-weight="${weight}" fill="${rgbStr(rgb)}" text-anchor="${anchor}">${esc(str)}</text>`);
    }
  }
  out.push("</svg>");
  return out.join("");
}
