/* ============================================================
   MOSHFORGE — Datamosh Video Studio v2.0
   Codec-level datamoshing simulation on canvas.
   Simulates: I-frame suppression / P-frame smearing /
   macroblock displacement / chroma bleed — fully local.
   v2: echo trails . wave warp . mirror maze . databend burst .
       strobe hold . mosh bomb . presets persistence . mobile UI
   ============================================================ */
"use strict";

/* ---------------- utilities ---------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function fmtTC(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------------- global state ---------------- */
const video = $("srcvideo");
const screen_ = $("screen");
const sctx = screen_.getContext("2d", { willReadFrequently: true });

const S = {
  master: 0.70,
  kfInterval: 12,
  seed: 1337,
  frameCount: 0,
  segment: 0,
  framesSinceKF: 0,
  moshPower: 0,
  history: [],
  histMax: 28,
  rand: mulberry32(1337),
  resScale: 0.75,
  speed: 1,
  frameStep: 1,
  loop: "loop",
  direction: 1,
  hasSource: false,
  lastTick: performance.now(),
  fps: 0, fpsN: 0, fpsLast: performance.now(),
  buf: document.createElement("canvas"),
  bctx: null,
  bw: 0, bh: 0,
  blockMap: new Map(),
  echoBuf: null,
  lastOut: null,
  bombT: 0,
  bombRestore: null,
  audioCtx: null, audioSrc: null, audioDest: null,
  recording: false, recorder: null, recChunks: [], recStart: 0,
  lastBlob: null,
  forceKF: false,
};

/* ============================================================
   EFFECT REGISTRY
   ============================================================ */
const FX = [
  {
    id: "smear", name: "SLICE SMEAR", tag: "P-FRAME",
    desc: "Horizontal bands copied from stale reference frames - the classic motion-vector echo.",
    params: {
      count:    { label: "Slices",        min: 1, max: 60, step: 1,   def: 18 },
      strength: { label: "Smear length",  min: 2, max: 200, step: 1,  def: 60 },
      drift:    { label: "Temporal drift",min: 0, max: 1,  step: .01, def: .55 },
      gravity:  { label: "Gravity pull",  min: 0, max: 1,  step: .01, def: .25 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const hist = S.history; if (hist.length < 2) return;
      const n = Math.max(1, Math.round(p.count * m));
      for (let i = 0; i < n; i++) {
        const idx = Math.min(hist.length - 1,
          Math.floor(Math.pow(rand(), 1 + p.drift * 3) * hist.length));
        const src = new Uint32Array(hist[hist.length - 1 - idx].data.buffer);
        const y = (rand() * h) | 0;
        const sh = Math.max(1, Math.round(lerp(2, p.strength, rand()) * Math.max(m, .15)));
        const dir = rand() < 0.5 ? -1 : 1;
        const dy = dir * Math.max(1, (sh * (0.3 + p.gravity)) | 0);
        const xoff = ((rand() - .5) * 48 * m) | 0;
        for (let yy = 0; yy < sh; yy++) {
          const sy = clamp(y + yy, 0, h - 1);
          let dyRow = sy + dy;
          if (p.gravity > 0.05 && dir > 0) dyRow = clamp(y + ((yy + S.framesSinceKF * p.gravity * 4) | 0) % Math.max(sh,1) + dy, 0, h - 1);
          dyRow = clamp(dyRow, 0, h - 1);
          const sx = clamp(xoff, -w + 1, w - 1);
          if (sx >= 0) {
            d.set(src.subarray(sy * w + sx, sy * w + w), dyRow * w);
            if (sx > 0) d.set(src.subarray(sy * w, sy * w + sx), dyRow * w + (w - sx));
          } else {
            d.set(src.subarray(sy * w, sy * w + w + sx), dyRow * w - sx);
            d.set(src.subarray(sy * w + w + sx, sy * w + w), dyRow * w);
          }
        }
      }
    },
  },
  {
    id: "displace", name: "BLOCK DISPLACE", tag: "MACROBLOCK",
    desc: "Macroblocks re-referenced from wrong motion vectors. Decisions persist within a segment, like a broken P-frame chain.",
    params: {
      size:    { label: "Block size",   min: 8,  max: 96, step: 4,   def: 32 },
      density: { label: "Corruption %", min: 0,  max: 1,  step: .01, def: .35 },
      search:  { label: "Search range", min: 8,  max: 220, step: 2,  def: 90 },
      ttl:     { label: "Persist (fr)", min: 1,  max: 120, step: 1,  def: 40 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const hist = S.history; if (hist.length < 2) return;
      const bs = Math.max(8, p.size | 0);
      const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
      const blocks = gw * gh;
      const maxNew = Math.max(1, Math.round(blocks * p.density * m * 0.12));
      for (const [k, v] of S.blockMap) {
        if (S.frameCount - v.born > v.ttl) S.blockMap.delete(k);
      }
      for (let i = 0; i < maxNew; i++) {
        const b = (rand() * blocks) | 0;
        if (S.blockMap.has(b)) continue;
        const depth = 1 + ((rand() * rand() * (hist.length - 1)) | 0);
        S.blockMap.set(b, {
          born: S.frameCount,
          ttl: Math.round(p.ttl * (0.4 + rand() * 0.6)),
          depth,
          dx: ((rand() - .5) * 2 * p.search * m) | 0,
          dy: ((rand() - .5) * 2 * p.search * m) | 0,
          stretch: rand() < 0.18 * m,
        });
      }
      for (const [b, v] of S.blockMap) {
        const srcIdx = clamp(hist.length - 1 - v.depth, 0, hist.length - 1);
        const src = new Uint32Array(hist[srcIdx].data.buffer);
        const bx = (b % gw) * bs, by = ((b / gw) | 0) * bs;
        const x0 = clamp(bx + v.dx, 0, w - 1), y0 = clamp(by + v.dy, 0, h - 1);
        const cw = Math.min(bs, w - Math.max(bx, x0)), ch = Math.min(bs, h - Math.max(by, y0));
        if (cw <= 0 || ch <= 0) continue;
        if (!v.stretch) {
          for (let yy = 0; yy < ch; yy++)
            d.set(src.subarray((y0 + yy) * w + x0, (y0 + yy) * w + x0 + cw), (by + yy) * w + bx);
        } else {
          const vert = v.dx * v.dx < v.dy * v.dy;
          for (let yy = 0; yy < ch; yy++) {
            const sy = vert ? clamp(y0, 0, h - 1) : clamp(y0 + yy, 0, h - 1);
            const sx0 = vert ? clamp(x0 + ((rand() * 3) | 0) - 1, 0, w - 1) : x0;
            d.set(src.subarray(sy * w + sx0, sy * w + sx0 + cw), (by + yy) * w + bx);
          }
        }
      }
    },
  },
  {
    id: "chroma", name: "CHROMA BLEED", tag: "RGB SPLIT",
    desc: "Channel separation + sub-pixel jitter - color fringing like a torn keyframe.",
    params: {
      amount:  { label: "Split distance", min: 0, max: 60, step: 1,  def: 12 },
      jitter:  { label: "Jitter",         min: 0, max: 1,  step: .01,def: .3 },
      rotate:  { label: "Channel rotate", min: 0, max: 1,  step: .01,def: .2 },
      roll:    { label: "V-hold roll",    min: 0, max: 1,  step: .01,def: .15 },
    },
    apply(img, w, h, p, m, rand) {
      const data = img.data;
      const d = new Uint32Array(data.buffer);
      const src = new Uint32Array(d);
      const off = Math.round(p.amount * m);
      if (off <= 0 && p.jitter * m < 0.05) return;
      const jx = p.jitter > 0 ? ((rand() - .5) * p.jitter * 24 * m) | 0 : 0;
      const rot = p.rotate * m;
      const roll = p.roll * m;
      let rollRow = -1, rollSrc = 0, rollAmt = 0;
      if (roll > 0 && rand() < roll) {
        rollRow = (rand() * h * 0.7) | 0;
        rollSrc = (rand() * h) | 0;
        rollAmt = 4 + ((rand() * 20 * m) | 0);
      }
      for (let y = 0; y < h; y++) {
        const inRoll = rollRow >= 0 && y >= rollRow && y < rollRow + rollAmt;
        const rOff = clamp(off + jx, -w + 1, w - 1);
        const bOff = clamp(-off + jx, -w + 1, w - 1);
        const row = y * w;
        const srow = inRoll ? (rollSrc + (y - rollRow)) * w : row;
        for (let x = 0; x < w; x++) {
          let v = src[srow + x];
          let r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
          const rx = clamp(x + rOff, 0, w - 1);
          const bx = clamp(x + bOff, 0, w - 1);
          r = (src[srow + rx] & 255) * (1 - rot) + g * rot;
          b = ((src[srow + bx] >>> 16) & 255) * (1 - rot) + g * rot;
          if (rot > 0.02) {
            g = lerp((v >>> 8) & 255, (src[srow + clamp(x - rOff, 0, w - 1)] >>> 16) & 255, rot * 0.6);
          }
          d[row + x] = 0xff000000 | (clamp(b, 0, 255) << 16) | (clamp(g, 0, 255) << 8) | clamp(r, 0, 255);
        }
      }
    },
  },
  {
    id: "pixelsort", name: "PIXEL SORT", tag: "GLITCH",
    desc: "Luminance-thresholded row sorting. Classic glitch-aesthetic sorting applied to the corrupted frame.",
    params: {
      threshold: { label: "Luma threshold", min: 0, max: 1,  step: .01, def: .62 },
      coverage:  { label: "Row coverage",   min: 0, max: 1,  step: .01, def: .35 },
      maxLen:    { label: "Max run length", min: 4, max: 400, step: 4,  def: 140 },
      mode:      { label: "Sort order", min: 0, max: 1, step: 1, def: 0 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const thr = (p.threshold * 255) | 0;
      const cover = p.coverage * m;
      const maxLen = p.maxLen | 0;
      const desc = p.mode >= 0.5;
      for (let y = 0; y < h; y++) {
        if (rand() > cover) continue;
        const row = y * w;
        let x = 0;
        while (x < w) {
          let v = d[row + x];
          let lum = (v & 255) * 0.299 + ((v >>> 8) & 255) * 0.587 + ((v >>> 16) & 255) * 0.114;
          if (lum < thr) { x++; continue; }
          let x0 = x;
          while (x < w && x - x0 < maxLen) {
            v = d[row + x];
            lum = (v & 255) * 0.299 + ((v >>> 8) & 255) * 0.587 + ((v >>> 16) & 255) * 0.114;
            if (lum < thr) break;
            x++;
          }
          const len = x - x0;
          if (len >= 4) {
            const arr = new Uint32Array(len);
            for (let i = 0; i < len; i++) arr[i] = d[row + x0 + i];
            const lums = new Float32Array(len);
            for (let i = 0; i < len; i++) {
              const q = arr[i];
              lums[i] = (q & 255) * 0.299 + ((q >>> 8) & 255) * 0.587 + ((q >>> 16) & 255) * 0.114;
            }
            const idx = new Uint16Array(len);
            for (let i = 0; i < len; i++) idx[i] = i;
            if (desc) {
              for (let i = 1; i < len; i++) { const key = lums[idx[i]]; const kv = idx[i]; let j = i - 1;
                while (j >= 0 && lums[idx[j]] < key) { idx[j + 1] = idx[j]; j--; } idx[j + 1] = kv; }
            } else {
              for (let i = 1; i < len; i++) { const key = lums[idx[i]]; const kv = idx[i]; let j = i - 1;
                while (j >= 0 && lums[idx[j]] > key) { idx[j + 1] = idx[j]; j--; } idx[j + 1] = kv; }
            }
            for (let i = 0; i < len; i++) d[row + x0 + i] = arr[idx[i]];
          }
        }
      }
    },
  },
  {
    id: "crush", name: "COLOR CRUSH", tag: "BIT DEPTH",
    desc: "Bit-depth collapse, channel rotation and quantized banding from a damaged DC coefficient stream.",
    params: {
      bits:    { label: "Bit depth",     min: 1, max: 8,  step: 1,   def: 5 },
      band:    { label: "Banding rows",  min: 0, max: 1,  step: .01, def: .3 },
      solar:   { label: "Solarize",      min: 0, max: 1,  step: .01, def: 0 },
      chanrot: { label: "Channel swap",  min: 0, max: 1,  step: .01, def: .25 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const bits = clamp(Math.round(lerp(8, p.bits, m)), 1, 8);
      const shift = 8 - bits;
      const band = p.band * m;
      const chanrot = p.chanrot * m;
      const solar = p.solar * m;
      let bandRow = -1, bandBits = 8;
      if (band > 0 && rand() < band) {
        bandRow = (rand() * h) | 0;
        bandBits = 1 + ((rand() * (bits - 1)) | 0);
      }
      const bsh = 8 - (bandRow >= 0 ? bandBits : bits);
      for (let y = 0; y < h; y++) {
        const sh = (bandRow >= 0 && y >= bandRow && y < bandRow + 20 + rand() * 60) ? bsh : shift;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          let v = d[i];
          let r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
          if (solar > 0.01) {
            if (r > 128) r = 255 - r;
            if (solar > 0.5 && g > 110) g = 255 - g;
            if (solar > 0.8 && b > 140) b = 255 - b;
          }
          r = (r >> sh) << sh; g = (g >> sh) << sh; b = (b >> sh) << sh;
          if (chanrot > 0.02) {
            const blk = ((x >> 4) + (y >> 4)) & 3;
            if (rand() < chanrot * 0.12) {
              if (blk === 0) { const t = r; r = g; g = b; b = t; }
              else if (blk === 1) { const t = r; r = b; b = g; g = t; }
              else if (blk === 2) { const t = g; g = b; b = r; r = t; }
            }
          }
          d[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
    },
  },
  {
    id: "grain", name: "TAPE NOISE", tag: "SIGNAL",
    desc: "Analog dropouts, sync-line jitter and sensor grain over the corrupted signal.",
    params: {
      amount: { label: "Grain",        min: 0, max: 1, step: .01, def: .18 },
      dropout:{ label: "Dropout lines",min: 0, max: 1, step: .01, def: .3 },
      scan:   { label: "Scanlines",    min: 0, max: 1, step: .01, def: .2 },
      tear:   { label: "Sync tear",    min: 0, max: 1, step: .01, def: .2 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const amt = p.amount * m * 42;
      const dropP = p.dropout * m;
      const scan = p.scan * m;
      const tearP = p.tear * m;
      let tearY = -1, tearDx = 0, tearH = 0;
      if (tearP > 0 && rand() < tearP * 0.35) {
        tearY = (rand() * h) | 0; tearH = 1 + ((rand() * 6) | 0);
        tearDx = ((rand() - .5) * 90 * m) | 0;
      }
      const n = (w * h) | 0;
      const grainN = (n * clamp(p.amount * m, 0, 1) * 0.5) | 0;
      for (let i = 0; i < grainN; i++) {
        const idx = (rand() * n) | 0;
        let v = d[idx];
        let r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
        const nz = (rand() - 0.5) * amt;
        r = clamp(r + nz, 0, 255); g = clamp(g + nz, 0, 255); b = clamp(b + nz, 0, 255);
        d[idx] = 0xff000000 | (b << 16) | (g << 8) | r;
      }
      for (let y = 0; y < h; y++) {
        const row = y * w;
        if (scan > 0.01 && (y & 1) === 0) {
          const dark = 1 - scan * 0.35;
          for (let x = 0; x < w; x++) {
            const i = row + x; let v = d[i];
            d[i] = 0xff000000 |
              ((((v >>> 16) & 255) * dark) << 16) | ((((v >>> 8) & 255) * dark) << 8) | ((v & 255) * dark);
          }
        }
        if (dropP > 0 && rand() < dropP * 0.05) {
          const black = rand() < 0.5;
          for (let x = 0; x < w; x++) {
            const i = row + x;
            d[i] = black ? 0xff000000 : (0xff000000 | (((rand() * 255) | 0) << 16) | (((rand() * 255) | 0) << 8) | ((rand() * 255) | 0));
          }
        }
        if (tearY >= 0 && y >= tearY && y < tearY + tearH) {
          const rowCopy = new Uint32Array(d.subarray(row, row + w));
          const off = tearDx;
          for (let x = 0; x < w; x++) {
            const sx = clamp(x - off, 0, w - 1);
            d[row + x] = rowCopy[sx];
          }
        }
      }
    },
  },
  /* ---------- v2 effects ---------- */
  {
    id: "echo", name: "ECHO TRAILS", tag: "GHOST",
    desc: "Accumulating phosphor buffer - motion decays slowly like a damaged LCD panel hold. Trails melt into everything.",
    params: {
      decay: { label: "Decay",        min: .5, max: .97, step: .01, def: .88 },
      gain:  { label: "Trail gain",   min: 0,  max: 1,   step: .01, def: .6 },
      mix:   { label: "Screen blend", min: 0,  max: 1,   step: .01, def: .65 },
    },
    apply(img, w, h, p, m, rand) {
      void rand;
      const n = w * h;
      if (!S.echoBuf || S.echoBuf.length !== n * 3) S.echoBuf = new Float32Array(n * 3);
      const e = S.echoBuf, data = img.data;
      const dec = lerp(0.5, p.decay, m);
      const gain = p.gain * m;
      const mix = p.mix * m;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = data[j], g = data[j + 1], b = data[j + 2];
        const k = i * 3;
        e[k]     = Math.max(e[k]     * dec, r * gain);
        e[k + 1] = Math.max(e[k + 1] * dec, g * gain);
        e[k + 2] = Math.max(e[k + 2] * dec, b * gain);
        const er = e[k], eg = e[k + 1], eb = e[k + 2];
        const sr = 255 - (255 - r) * (255 - er) / 255;
        const sg = 255 - (255 - g) * (255 - eg) / 255;
        const sb = 255 - (255 - b) * (255 - eb) / 255;
        data[j]     = r + (sr - r) * mix;
        data[j + 1] = g + (sg - g) * mix;
        data[j + 2] = b + (sb - b) * mix;
      }
    },
  },
  {
    id: "warp", name: "WAVE WARP", tag: "SIGNAL",
    desc: "Continuous sinusoidal row displacement + sync chaos - the VHS tracking-error look, alive and breathing.",
    params: {
      amp:   { label: "Amplitude",  min: 0,   max: 90, step: 1,   def: 22 },
      freq:  { label: "Frequency",  min: .01, max: .5, step: .01, def: .08 },
      speed: { label: "Drift speed",min: 0,   max: 3,  step: .05, def: .6 },
      chaos: { label: "Chaos",      min: 0,   max: 1,  step: .01, def: .25 },
    },
    apply(img, w, h, p, m, rand) {
      const d = new Uint32Array(img.data.buffer);
      const src = new Uint32Array(d);
      const t = S.frameCount * p.speed * 0.15;
      const amp = p.amp * m;
      const chaosP = p.chaos * m;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let off = (Math.sin(y * p.freq + t) * 0.6 + Math.sin(y * p.freq * 2.7 + t * 1.7) * 0.4) * amp;
        if (chaosP > 0.02 && rand() < chaosP * 0.05) off += (rand() - .5) * amp * 3;
        const so = clamp(off | 0, -w + 1, w - 1);
        if (so === 0) continue;
        if (so > 0) {
          d.set(src.subarray(row, row + w - so), row + so);
          d.set(src.subarray(row + w - so, row + w), row);
        } else {
          d.set(src.subarray(row - so, row + w), row);
          d.set(src.subarray(row, row - so), row + w + so);
        }
      }
    },
  },
  {
    id: "kaleido", name: "MIRROR MAZE", tag: "GEOMETRY",
    desc: "Living mirror-fold: the frame reflects across slow-drifting axes with a breathing zoom pulse.",
    params: {
      strength: { label: "Fold mix",     min: 0, max: 1,  step: .01, def: .7 },
      spin:     { label: "Axis drift",   min: 0, max: 1,  step: .01, def: .4 },
      pulse:    { label: "Zoom pulse",   min: 0, max: 1,  step: .01, def: .3 },
      quad:     { label: "Quad fold",    min: 0, max: 1,  step: .01, def: .5 },
    },
    apply(img, w, h, p, m, rand) {
      void rand;
      const mix = p.strength * m;
      if (mix <= 0.02) return;
      const d = new Uint32Array(img.data.buffer);
      const src = new Uint32Array(d);
      const t = S.frameCount;
      const fx = (Math.sin(t * 0.008 * (0.2 + p.spin)) * 0.35 + 0.5) * w;
      const fy = (Math.cos(t * 0.006 * (0.2 + p.spin)) * 0.35 + 0.5) * h;
      const quad = p.quad * m;
      const zBase = 1 + p.pulse * m * 0.25 * Math.sin(t * 0.045);
      const w2 = w / 2, h2 = h / 2;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sy = y < fy ? y : 2 * fy - y;
        if (quad > 0.5 && y >= h2) sy = h - 1 - y;
        sy = clamp(sy | 0, 0, h - 1);
        if (zBase !== 1) sy = clamp((((sy - h2) / zBase) + h2) | 0, 0, h - 1);
        for (let x = 0; x < w; x++) {
          let sx = x < fx ? x : 2 * fx - x;
          if (quad > 0.5 && x >= w2) sx = w - 1 - x;
          sx = clamp(sx | 0, 0, w - 1);
          if (zBase !== 1) sx = clamp((((sx - w2) / zBase) + w2) | 0, 0, w - 1);
          const v = src[sy * w + sx];
          if (mix >= 0.98) { d[row + x] = v; continue; }
          const cur = d[row + x];
          const inv = 1 - mix;
          const r = ((cur & 255) * inv + (v & 255) * mix) | 0;
          const g = (((cur >>> 8) & 255) * inv + ((v >>> 8) & 255) * mix) | 0;
          const b = (((cur >>> 16) & 255) * inv + ((v >>> 16) & 255) * mix) | 0;
          d[row + x] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
    },
  },
  {
    id: "burst", name: "DATABEND BURST", tag: "BURST",
    desc: "Violent corruption seizures: random regions get re-decoded from deep frame history with inverted channels.",
    params: {
      rate:   { label: "Seizure rate", min: 0,   max: 1,   step: .01, def: .3 },
      size:   { label: "Blast size",   min: 10,  max: 300, step: 5,   def: 90 },
      count:  { label: "Blasts",       min: 1,   max: 10,  step: 1,   def: 3 },
      invert: { label: "Inversion",    min: 0,   max: 1,   step: .01, def: .4 },
    },
    apply(img, w, h, p, m, rand) {
      const hist = S.history; if (hist.length < 2) return;
      const d = new Uint32Array(img.data.buffer);
      if (rand() > p.rate * m * 0.22) return;
      const n = Math.max(1, Math.round(p.count * m));
      const maxSz = Math.max(8, p.size * m) | 0;
      for (let i = 0; i < n; i++) {
        const depth = 1 + ((rand() * rand() * (hist.length - 1)) | 0);
        const src = new Uint32Array(hist[hist.length - 1 - depth].data.buffer);
        const bw = (8 + rand() * maxSz) | 0, bh = (8 + rand() * maxSz * 0.6) | 0;
        const bx = (rand() * (w - bw)) | 0, by = (rand() * (h - bh)) | 0;
        const inv = rand() < p.invert * m;
        for (let yy = 0; yy < bh; yy++) {
          const srow = (by + yy) * w;
          if (!inv) {
            d.set(src.subarray(srow + bx, srow + bx + bw), srow + bx);
          } else {
            for (let x = 0; x < bw; x++) {
              const v = src[srow + bx + x];
              const r = 255 - (v & 255), g = 255 - ((v >>> 8) & 255), b = 255 - ((v >>> 16) & 255);
              d[srow + bx + x] = 0xff000000 | (b << 16) | (g << 8) | r;
            }
          }
        }
      }
    },
  },
  {
    id: "strobe", name: "STROBE HOLD", tag: "TIMING",
    desc: "Holds corrupted frames so melt patterns strobe instead of flow. Engine-level: skips processing on held frames.",
    params: {
      hold: { label: "Hold length", min: 0, max: 1, step: .01, def: .4 },
    },
    apply() { /* handled at engine level in processFrame */ },
  },
];

for (const fx of FX) {
  fx.on = true;
  fx.p = {};
  for (const k in fx.params) fx.p[k] = fx.params[k].def;
}
const fxById = id => FX.find(f => f.id === id);

/* ============================================================
   ENGINE CORE
   ============================================================ */
function reseed() {
  S.rand = mulberry32((S.seed + S.segment * 7919) >>> 0);
}

function newSegment() {
  S.segment++;
  S.framesSinceKF = 0;
  S.blockMap.clear();
  S.history.length = 0;
  S.echoBuf = null;
  S.lastOut = null;
  reseed();
  S.kfFlash = 6;
}

function sizeBuffer() {
  if (!S.hasSource) return;
  let vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.min(S.resScale, 1280 / vw);
  S.bw = Math.max(160, Math.round(vw * scale));
  S.bh = Math.max(90, Math.round(vh * scale));
  S.buf.width = S.bw; S.buf.height = S.bh;
  S.bctx = S.buf.getContext("2d", { willReadFrequently: true });
  screen_.width = S.bw; screen_.height = S.bh;
  S.echoBuf = null; S.lastOut = null;
  const wrap = $("viewport-wrap");
  const aw = wrap.clientWidth - 28, ah = wrap.clientHeight - 28;
  const ar = S.bw / S.bh;
  let cw = aw, ch = cw / ar;
  if (ch > ah) { ch = ah; cw = ch * ar; }
  const vp = $("viewport");
  vp.style.width = cw + "px"; vp.style.height = ch + "px";
  newSegment();
}

function pushHistory(img) {
  const copy = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  S.history.push(copy);
  if (S.history.length > S.histMax) S.history.shift();
}

function processFrame() {
  const b = S.bctx, w = S.bw, h = S.bh;
  b.drawImage(video, 0, 0, w, h);
  let img = b.getImageData(0, 0, w, h);

  if (S.bombT > 0) {
    S.bombT--;
    if (S.bombT === 0 && S.bombRestore) {
      S.master = S.bombRestore.master;
      S.kfInterval = S.bombRestore.kfInterval;
      $("master").value = Math.round(S.master * 100);
      $("o_master").textContent = Math.round(S.master * 100) + "%";
      $("kfinterval").value = S.kfInterval;
      $("o_kf").textContent = S.kfInterval + " fr";
      syncRackUI();
      toast("💣 bomb detonated - I-frame reset");
    }
  }

  const isKF = S.forceKF ||
    (S.kfInterval > 0 && S.framesSinceKF >= S.kfInterval) ||
    S.framesSinceKF === 0;
  S.forceKF = false;

  if (isKF) {
    if (S.history.length > 0) S.segment++;
    S.framesSinceKF = 0;
    S.blockMap.clear();
    reseed();
    S.kfFlash = 6;
    S.history.length = 0;
    pushHistory(img);
    S.moshPower = 0;
    S.lastOut = null;
    sctx.putImageData(img, 0, 0);
    S.frameCount++;
    S.framesSinceKF++;
    return;
  }

  pushHistory(img);
  const prog = S.kfInterval > 0 ? S.framesSinceKF / S.kfInterval : 1;
  S.moshPower = clamp(Math.pow(prog, 0.6), 0, 1);
  const m = S.master * (0.35 + 0.65 * S.moshPower) * (S.bombT > 0 ? 1.35 : 1);

  const stb = fxById("strobe");
  if (stb && stb.on && S.lastOut) {
    const hold = Math.max(1, Math.round(lerp(1, 5, stb.p.hold)));
    if (S.framesSinceKF % hold !== 0) {
      sctx.putImageData(S.lastOut, 0, 0);
      S.frameCount++;
      S.framesSinceKF++;
      return;
    }
  }

  for (const fx of FX) {
    if (!fx.on) continue;
    if (fx.id === "strobe") continue;
    fx.apply(img, w, h, fx.p, m, S.rand);
  }
  if (stb && stb.on) {
    S.lastOut = new ImageData(new Uint8ClampedArray(img.data), w, h);
  } else if (S.lastOut) {
    S.lastOut = null;
  }
  sctx.putImageData(img, 0, 0);
  S.frameCount++;
  S.framesSinceKF++;
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  S.fpsN++;
  if (now - S.fpsLast >= 500) {
    S.fps = Math.round(S.fpsN * 1000 / (now - S.fpsLast));
    S.fpsN = 0; S.fpsLast = now;
    $("stFps").textContent = S.fps + " fps";
  }

  if (S.hasSource && !video.paused && !video.ended) {
    if (S.frameCount % S.frameStep === 0) processFrame();
    else S.frameCount++;
    updateHUD();
  } else if (S.hasSource && video.ended) {
    handleEnded();
  }
  updateScrub();
  updateRecTimer();
}

function updateHUD() {
  $("stFrame").textContent = S.frameCount;
  $("stHist").textContent = S.history.length;
  $("stMosh").textContent = Math.round(S.moshPower * 100) + "%";
  $("masterFill").style.width = Math.round(S.moshPower * 100) + "%";
  const hud = $("hud");
  let html = `SEG ${String(S.segment).padStart(3, "0")} . FR ${S.framesSinceKF}`;
  if (S.kfFlash > 0) { html += ` . <span class="kf">◉ I-FRAME</span>`; S.kfFlash--; }
  if (S.bombT > 0) html += ` . <span class="rec">💣 BOMB ${S.bombT}</span>`;
  if (S.recording) html += ` . <span class="rec">● REC</span>`;
  hud.innerHTML = html;
}

function handleEnded() {
  if (S.loop === "loop") { video.currentTime = 0; video.play(); }
  else if (S.loop === "bounce") {
    video.currentTime = Math.max(0, video.duration - 0.05);
    video.play();
  } else {
    setPlayIcon(false);
  }
}

/* ---------------- scrub / timecode ---------------- */
function updateScrub() {
  if (!S.hasSource) return;
  const p = (video.currentTime / video.duration) * 100 || 0;
  $("scrubFill").style.width = p + "%";
  $("scrubHead").style.left = p + "%";
  $("tcCur").textContent = fmtTC(video.currentTime);
  $("tcDur").textContent = fmtTC(video.duration);
}

function buildKfMarks() {
  const box = $("kfmarks");
  box.innerHTML = "";
  if (!S.hasSource || S.kfInterval <= 0 || !video.duration) return;
  const segSec = S.kfInterval / 30 / S.speed;
  const total = video.duration;
  const n = Math.min(400, Math.floor(total / segSec));
  for (let i = 1; i < n; i++) {
    const el = document.createElement("i");
    el.style.left = (i * segSec / total * 100) + "%";
    box.appendChild(el);
  }
}

const scrub = $("scrub");
let scrubbing = false;
function seekFromEvent(e) {
  if (!S.hasSource || !video.duration) return;
  const r = scrub.getBoundingClientRect();
  const x = clamp((e.clientX ?? e.touches?.[0]?.clientX) - r.left, 0, r.width);
  video.currentTime = (x / r.width) * video.duration;
  newSegment();
}
scrub.addEventListener("pointerdown", e => { scrubbing = true; scrub.setPointerCapture(e.pointerId); seekFromEvent(e); });
scrub.addEventListener("pointermove", e => { if (scrubbing) seekFromEvent(e); });
scrub.addEventListener("pointerup", () => scrubbing = false);

/* ---------------- transport ---------------- */
function setPlayIcon(playing) {
  $("icoPlay").style.display = playing ? "none" : "block";
  $("icoPause").style.display = playing ? "block" : "none";
}
$("btnPlay").onclick = () => {
  if (!S.hasSource) return;
  if (video.paused) { video.play(); setPlayIcon(true); }
  else { video.pause(); setPlayIcon(false); }
};
$("btnRestart").onclick = () => { if (!S.hasSource) return; video.currentTime = 0; newSegment(); video.play(); setPlayIcon(true); };
$("btnBack").onclick = () => { if (!S.hasSource) return; video.currentTime = Math.max(0, video.currentTime - 1); newSegment(); };
$("btnFwd").onclick = () => { if (!S.hasSource) return; video.currentTime = Math.min(video.duration, video.currentTime + 1); newSegment(); };
video.addEventListener("play", () => setPlayIcon(true));
video.addEventListener("pause", () => setPlayIcon(false));

/* ---------------- mosh bomb ---------------- */
$("btnBomb").onclick = triggerBomb;
function triggerBomb() {
  if (S.bombT > 0) return;
  if (!S.hasSource) { toast("Load a source first"); return; }
  S.bombRestore = { master: S.master, kfInterval: S.kfInterval };
  S.master = 1; S.kfInterval = 0;
  S.bombT = Math.round(60 * (S.speed || 1));
  toast("💣 MOSH BOMB armed - 2s of chaos");
}

/* ---------------- source loading ---------------- */
function loadSource(url, name) {
  video.src = url;
  video.loop = false;
  video.addEventListener("loadedmetadata", function onmd() {
    video.removeEventListener("loadedmetadata", onmd);
    S.hasSource = true;
    $("nogfx").style.display = "none";
    sizeBuffer();
    const si = $("srcinfo");
    si.style.display = "block";
    si.innerHTML =
      `<b>${name}</b><br>` +
      `${video.videoWidth}×${video.videoHeight} · ${fmtTC(video.duration)}<br>` +
      `processing @ ${S.bw}×${S.bh}`;
    buildKfMarks();
    video.play();
    setPlayIcon(true);
  }, { once: false });
}

const dz = $("dropzone"), fi = $("fileInput");
dz.onclick = () => fi.click();
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", e => {
  e.preventDefault(); dz.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("video/")) loadSource(URL.createObjectURL(f), f.name);
  else if (f) toast("Not a video file");
});
fi.onchange = () => {
  const f = fi.files[0];
  if (f) loadSource(URL.createObjectURL(f), f.name);
};

/* demo clip: procedurally rendered 6s clip, recorded to webm in-browser */
$("btnDemo").onclick = () => {
  const c = document.createElement("canvas");
  c.width = 1280; c.height = 720;
  const x = c.getContext("2d");
  const stream = c.captureStream(30);
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: "video/webm" });
  } catch (e) {
    rec = new MediaRecorder(stream);
  }
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => loadSource(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })), "demo-clip.webm");
  const t0 = performance.now();
  function draw() {
    const t = (performance.now() - t0) / 1000;
    if (t > 6) { rec.stop(); return; }
    const g = x.createLinearGradient(0, 0, 1280, 720);
    g.addColorStop(0, `hsl(${(t * 40) % 360},70%,18%)`);
    g.addColorStop(1, `hsl(${(t * 40 + 140) % 360},70%,8%)`);
    x.fillStyle = g; x.fillRect(0, 0, 1280, 720);
    for (let i = 0; i < 26; i++) {
      const px = 640 + Math.sin(t * (0.6 + i * 0.13) + i) * (80 + i * 18);
      const py = 360 + Math.cos(t * (0.8 + i * 0.11) + i * 2) * (60 + i * 12);
      x.fillStyle = `hsla(${(i * 29 + t * 90) % 360},90%,${45 + 25 * Math.sin(t + i)}%,.75)`;
      x.beginPath(); x.arc(px, py, 14 + i * 2.2, 0, 7); x.fill();
    }
    x.fillStyle = "rgba(255,255,255,.9)";
    x.font = "900 110px Inter, sans-serif";
    x.fillText("MOSH", 60 + Math.sin(t * 2) * 30, 640);
    x.font = "700 34px Inter, sans-serif";
    x.fillStyle = "rgba(255,255,255,.5)";
    x.fillText("demo source · " + t.toFixed(1) + "s", 64, 90);
    requestAnimationFrame(draw);
  }
  rec.start();
  draw();
  $("btnDemo").textContent = "Rendering demo…";
  setTimeout(() => $("btnDemo").textContent = "Load demo clip", 7000);
};

/* ---------------- audio toggle ---------------- */
let muted = false;
$("btnMute").onclick = () => {
  muted = !muted;
  video.muted = muted;
  $("btnMute").textContent = muted ? "🔇 Muted" : "🔊 Audio";
};

/* ---------------- header controls ---------------- */
$("resScale").onchange = e => { S.resScale = parseFloat(e.target.value); sizeBuffer(); };
$("speed").oninput = e => {
  S.speed = parseFloat(e.target.value);
  video.playbackRate = S.speed;
  $("o_speed").textContent = S.speed.toFixed(2) + "×";
  buildKfMarks();
};
$("framestep").oninput = e => {
  S.frameStep = parseInt(e.target.value);
  $("o_step").textContent = S.frameStep;
};
segWire($("loopSeg"), v => { S.loop = v; });

function segWire(el, cb) {
  el.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    el.querySelectorAll("button").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel");
    cb(b.dataset.v);
  });
}

/* master + keyframe + seed */
$("master").oninput = e => {
  S.master = parseInt(e.target.value) / 100;
  $("o_master").textContent = e.target.value + "%";
};
$("kfinterval").oninput = e => {
  S.kfInterval = parseInt(e.target.value);
  $("o_kf").textContent = S.kfInterval + " fr";
  buildKfMarks();
};
$("seed").onchange = e => {
  S.seed = (parseInt(e.target.value) || 0) >>> 0;
  $("o_seed").textContent = S.seed;
  newSegment();
};
$("btnSeed").onclick = () => {
  S.seed = (Math.random() * 1e6) | 0;
  $("seed").value = S.seed;
  $("o_seed").textContent = S.seed;
  newSegment();
};
$("btnKeyframe").onclick = () => { S.forceKF = true; };
$("btnClearHist").onclick = () => { S.history.length = 0; S.blockMap.clear(); S.echoBuf = null; S.lastOut = null; };

/* focus mode */
function toggleFocus() {
  document.body.classList.toggle("focus");
  setTimeout(sizeBuffer, 320);
}
$("btnFocus").onclick = toggleFocus;

/* ---------------- randomize / reset ---------------- */
function randomizeFx(fx) {
  for (const k in fx.params) {
    const d = fx.params[k];
    fx.p[k] = d.min + Math.random() * (d.max - d.min);
    if (d.step >= 1) fx.p[k] = Math.round(fx.p[k]);
  }
}
$("btnShuffle").onclick = () => {
  for (const fx of FX) {
    fx.on = Math.random() < 0.85;
    randomizeFx(fx);
  }
  S.seed = (Math.random() * 1e6) | 0;
  $("seed").value = S.seed; $("o_seed").textContent = S.seed;
  S.master = 0.4 + Math.random() * 0.6;
  $("master").value = Math.round(S.master * 100);
  $("o_master").textContent = Math.round(S.master * 100) + "%";
  S.kfInterval = 4 + ((Math.random() * 60) | 0);
  $("kfinterval").value = S.kfInterval;
  $("o_kf").textContent = S.kfInterval + " fr";
  syncRackUI(); buildKfMarks(); newSegment();
  toast("🎲 parameters randomized");
};
$("btnResetFx").onclick = () => {
  for (const fx of FX) { fx.on = true; for (const k in fx.params) fx.p[k] = fx.params[k].def; }
  S.master = 0.7; $("master").value = 70; $("o_master").textContent = "70%";
  S.kfInterval = 12; $("kfinterval").value = 12; $("o_kf").textContent = "12 fr";
  syncRackUI(); buildKfMarks(); newSegment();
};

/* ---------------- session clock ---------------- */
const bootT = Date.now();
setInterval(() => {
  const s = ((Date.now() - bootT) / 1000) | 0;
  $("clock").textContent =
    `${String((s / 3600) | 0).padStart(2, "0")}:${String(((s / 60) | 0) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}, 1000);

window.addEventListener("resize", () => { if (S.hasSource) sizeBuffer(); });

/* ---------------- keyboard shortcuts ---------------- */
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  switch (e.key.toLowerCase()) {
    case " ": e.preventDefault(); $("btnPlay").click(); break;
    case "r": $("btnShuffle").click(); break;
    case "k": $("btnKeyframe").click(); break;
    case "b": triggerBomb(); break;
    case "s": $("btnSnapshot").click(); break;
    case "e": $("btnExport").click(); break;
    case "f": toggleFocus(); break;
  }
});

/* ---------------- mobile drawers ---------------- */
$("mbSource").onclick = () => {
  $("colRight").classList.remove("drawer-open");
  $("colLeft").classList.toggle("drawer-open");
};
$("mbFx").onclick = () => {
  $("colLeft").classList.remove("drawer-open");
  $("colRight").classList.toggle("drawer-open");
};
$("closeLeft").onclick = () => $("colLeft").classList.remove("drawer-open");
$("closeRight").onclick = () => $("colRight").classList.remove("drawer-open");
$("mbSnap").onclick = () => $("btnSnapshot").click();
$("mbBomb").onclick = () => triggerBomb();
$("mbExport").onclick = () => $("btnExport").click();


/* ---------------- mobile layout enforcer ----------------
   Inline-style backstop: even if the stylesheet is partially
   dropped (old WebView, delivery corruption), the phone layout
   must never collapse to the desktop grid. */
function enforceMobileLayout() {
  const phone = Math.min(screen.width, screen.height) / (window.devicePixelRatio || 1) <= 480;
  if (!phone) return;
  const main = $("main");
  main.style.setProperty("display", "block", "important");
  main.style.setProperty("position", "relative", "important");
  document.querySelectorAll("#main .col").forEach(c => {
    c.style.setProperty("position", "fixed", "important");
    c.style.setProperty("z-index", "40", "important");
  });
  const bar = $("mobilebar");
  if (bar) bar.style.setProperty("display", "flex", "important");
  const app = $("app");
  if (app) {
    [...app.children].forEach(k => k.style.setProperty("min-width", "0", "important"));
    if (document.documentElement.scrollWidth > innerWidth + 8) {
      app.style.setProperty("width", "100vw", "important");
    }
  }
}
enforceMobileLayout();
window.addEventListener("resize", enforceMobileLayout);

loop();

/* ============================================================
   EFFECT RACK UI
   ============================================================ */
const rack = $("rack");
FX.forEach((fx, i) => {
  const el = document.createElement("div");
  el.className = "fx on" + (i < 2 ? " open" : "");
  el.dataset.fx = fx.id;
  let controls = "";
  for (const k in fx.params) {
    const p = fx.params[k];
    controls += `
      <div class="ctl">
        <div class="ctl-row"><label>${p.label}</label><output id="out_${fx.id}_${k}">${p.def}</output></div>
        <input type="range" data-fx="${fx.id}" data-k="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}">
      </div>`;
  }
  el.innerHTML = `
    <div class="fx-head">
      <span class="fx-dot"></span>
      <span class="fx-name">${fx.name}</span>
      <button class="fx-dice" title="Randomize this effect" data-dice="${fx.id}">🎲</button>
      <span class="fx-tag">${fx.tag}</span>
      <span class="fx-arrow">▶</span>
    </div>
    <div class="fx-body"><div class="fx-desc">${fx.desc}</div>${controls}</div>`;
  rack.appendChild(el);
});

rack.addEventListener("click", e => {
  const dice = e.target.closest(".fx-dice");
  if (dice) {
    e.stopPropagation();
    const fx = fxById(dice.dataset.dice);
    randomizeFx(fx);
    syncRackUI();
    newSegment();
    toast("🎲 " + fx.name + " randomized");
    return;
  }
  const dot = e.target.closest(".fx-dot");
  if (dot) {
    const box = dot.closest(".fx");
    const fx = fxById(box.dataset.fx);
    fx.on = !fx.on;
    box.classList.toggle("on", fx.on);
    return;
  }
  const head = e.target.closest(".fx-head");
  if (head) head.parentElement.classList.toggle("open");
});

rack.addEventListener("input", e => {
  const t = e.target;
  if (t.type !== "range") return;
  const fx = fxById(t.dataset.fx);
  const v = parseFloat(t.value);
  fx.p[t.dataset.k] = v;
  $("out_" + fx.id + "_" + t.dataset.k).textContent =
    Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 100) / 100);
});

function syncRackUI() {
  for (const fx of FX) {
    const box = rack.querySelector(`.fx[data-fx="${fx.id}"]`);
    box.classList.toggle("on", fx.on);
    for (const k in fx.params) {
      const inp = box.querySelector(`input[data-k="${k}"]`);
      if (inp) {
        inp.value = fx.p[k];
        const v = fx.p[k];
        $("out_" + fx.id + "_" + k).textContent =
          Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 100) / 100);
      }
    }
  }
}

/* ============================================================
   PRESETS
   ============================================================ */
const BASE_PRESETS = [
  {
    name: "🔥 Classic Mosh", master: .75, kf: 12,
    fx: { smear: { count: 22, strength: 90, drift: .6, gravity: .4 }, displace: { size: 32, density: .4, search: 100, ttl: 50 }, chroma: { amount: 10, jitter: .3, rotate: .1, roll: .2 }, pixelsort: { threshold: .6, coverage: .12, maxLen: 100, mode: 0 }, crush: { bits: 5, band: .2, solar: 0, chanrot: .1 }, grain: { amount: .12, dropout: .25, scan: .12, tear: .2 } }
  },
  {
    name: "🌊 Deep Smear", master: .85, kf: 30,
    fx: { smear: { count: 40, strength: 160, drift: .85, gravity: .7 }, displace: { size: 48, density: .25, search: 140, ttl: 90 }, chroma: { amount: 5, jitter: .15, rotate: .05, roll: .3 }, pixelsort: { threshold: .7, coverage: .06, maxLen: 220, mode: 0 }, crush: { bits: 6, band: .15, solar: 0, chanrot: .05 }, grain: { amount: .08, dropout: .2, scan: .1, tear: .35 } }
  },
  {
    name: "⚡ RGB Storm", master: .8, kf: 6,
    fx: { smear: { count: 12, strength: 40, drift: .4, gravity: .1 }, displace: { size: 16, density: .5, search: 70, ttl: 20 }, chroma: { amount: 34, jitter: .8, rotate: .7, roll: .4 }, pixelsort: { threshold: .5, coverage: .3, maxLen: 80, mode: 1 }, crush: { bits: 4, band: .5, solar: .3, chanrot: .6 }, grain: { amount: .25, dropout: .5, scan: .3, tear: .5 } }
  },
  {
    name: "🫠 Pixel Melt", master: .7, kf: 20,
    fx: { smear: { count: 30, strength: 120, drift: .7, gravity: .8 }, displace: { size: 24, density: .45, search: 60, ttl: 70 }, chroma: { amount: 6, jitter: .2, rotate: .3, roll: .1 }, pixelsort: { threshold: .55, coverage: .55, maxLen: 180, mode: 0 }, crush: { bits: 5, band: .35, solar: .15, chanrot: .2 }, grain: { amount: .1, dropout: .3, scan: .15, tear: .1 } }
  },
  {
    name: "📼 VHS Decay", master: .6, kf: 45,
    fx: { smear: { count: 18, strength: 70, drift: .5, gravity: .2 }, displace: { size: 40, density: .2, search: 110, ttl: 120 }, chroma: { amount: 14, jitter: .5, rotate: .1, roll: .6 }, pixelsort: { threshold: .65, coverage: .05, maxLen: 120, mode: 0 }, crush: { bits: 4, band: .55, solar: .4, chanrot: .15 }, grain: { amount: .3, dropout: .6, scan: .55, tear: .7 } }
  },
  {
    name: "👻 Ghost Frame", master: .65, kf: 60,
    fx: { smear: { count: 50, strength: 200, drift: .95, gravity: .5 }, displace: { size: 64, density: .15, search: 180, ttl: 110 }, chroma: { amount: 4, jitter: .1, rotate: .05, roll: .5 }, pixelsort: { threshold: .75, coverage: .04, maxLen: 300, mode: 0 }, crush: { bits: 6, band: .1, solar: 0, chanrot: .05 }, grain: { amount: .15, dropout: .4, scan: .25, tear: .4 } }
  },
  {
    name: "🧊 Clean Signal", master: 0, kf: 12,
    fx: { smear: { count: 0, strength: 2, drift: 0, gravity: 0 }, displace: { size: 32, density: 0, search: 8, ttl: 1 }, chroma: { amount: 0, jitter: 0, rotate: 0, roll: 0 }, pixelsort: { threshold: 1, coverage: 0, maxLen: 4, mode: 0 }, crush: { bits: 8, band: 0, solar: 0, chanrot: 0 }, grain: { amount: 0, dropout: 0, scan: 0, tear: 0 } }
  },
  {
    name: "👁 Phantom Echo", master: .7, kf: 26,
    fx: { smear: { count: 14, strength: 60, drift: .6, gravity: .3 }, displace: { size: 32, density: .25, search: 80, ttl: 60 }, chroma: { amount: 8, jitter: .2, rotate: .15, roll: .2 }, pixelsort: { threshold: .6, coverage: .1, maxLen: 120, mode: 0 }, crush: { bits: 6, band: .1, solar: 0, chanrot: .1 }, grain: { amount: .1, dropout: .2, scan: .1, tear: .2 }, echo: { decay: .93, gain: .65, mix: .75 }, warp: { amp: 14, freq: .05, speed: .4, chaos: .1 }, kaleido: { strength: 0, spin: .3, pulse: 0, quad: 0 }, burst: { rate: .1, size: 60, count: 2, invert: .3 }, strobe: { hold: 0 } }
  },
  {
    name: "🌀 Mirror Melt", master: .75, kf: 16,
    fx: { smear: { count: 20, strength: 80, drift: .55, gravity: .45 }, displace: { size: 40, density: .35, search: 90, ttl: 50 }, chroma: { amount: 12, jitter: .35, rotate: .25, roll: .15 }, pixelsort: { threshold: .6, coverage: .2, maxLen: 140, mode: 0 }, crush: { bits: 5, band: .25, solar: .1, chanrot: .2 }, grain: { amount: .12, dropout: .3, scan: .15, tear: .25 }, echo: { decay: .85, gain: .5, mix: .5 }, warp: { amp: 10, freq: .07, speed: .5, chaos: .15 }, kaleido: { strength: .8, spin: .5, pulse: .5, quad: .7 }, burst: { rate: .2, size: 80, count: 2, invert: .3 }, strobe: { hold: 0 } }
  },
  {
    name: "💥 Bend Storm", master: .9, kf: 8,
    fx: { smear: { count: 26, strength: 70, drift: .5, gravity: .3 }, displace: { size: 24, density: .5, search: 110, ttl: 30 }, chroma: { amount: 20, jitter: .6, rotate: .4, roll: .4 }, pixelsort: { threshold: .5, coverage: .35, maxLen: 90, mode: 1 }, crush: { bits: 4, band: .4, solar: .25, chanrot: .4 }, grain: { amount: .2, dropout: .45, scan: .25, tear: .5 }, echo: { decay: .8, gain: .45, mix: .45 }, warp: { amp: 34, freq: .12, speed: 1.4, chaos: .6 }, kaleido: { strength: .35, spin: .7, pulse: .4, quad: 0 }, burst: { rate: .55, size: 140, count: 5, invert: .6 }, strobe: { hold: .35 } }
  },
];

const LS_KEY = "moshforge.presets.v2";
function loadUserPresets() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveUserPresets(arr) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) { /* storage full/blocked */ }
}

let PRESETS = BASE_PRESETS.concat(loadUserPresets());

const presetBar = $("presets");
function renderPresetChips() {
  presetBar.querySelectorAll(".chip.preset").forEach(x => x.remove());
  PRESETS.forEach((pr, i) => {
    const b = document.createElement("button");
    b.className = "chip preset" + (i === 0 ? " active" : "");
    b.textContent = pr.name;
    b.onclick = () => {
      presetBar.querySelectorAll(".chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      applyPreset(pr);
    };
    if (i >= BASE_PRESETS.length) {
      let lp;
      b.addEventListener("touchstart", () => { lp = setTimeout(() => {
        if (confirm(`Delete preset "${pr.name}"?`)) {
          PRESETS.splice(i, 1);
          saveUserPresets(PRESETS.slice(BASE_PRESETS.length));
          renderPresetChips();
        }
      }, 700); }, { passive: true });
      b.addEventListener("touchend", () => clearTimeout(lp));
    }
    presetBar.insertBefore(b, $("btnSavePreset"));
  });
}
renderPresetChips();

function applyPreset(pr) {
  for (const fx of FX) {
    fx.on = true;
    const cfg = pr.fx[fx.id] || {};
    for (const k in fx.params) if (k in cfg) fx.p[k] = cfg[k];
  }
  S.master = pr.master;
  $("master").value = Math.round(pr.master * 100);
  $("o_master").textContent = Math.round(pr.master * 100) + "%";
  S.kfInterval = pr.kf;
  $("kfinterval").value = pr.kf;
  $("o_kf").textContent = pr.kf + " fr";
  syncRackUI(); buildKfMarks(); newSegment();
}

$("btnSavePreset").onclick = () => {
  const name = prompt("Preset name:", "🎨 My Mosh");
  if (!name) return;
  const fxCfg = {};
  for (const fx of FX) { fxCfg[fx.id] = Object.assign({}, fx.p); };
  const pr = { name, master: S.master, kf: S.kfInterval, fx: fxCfg };
  const user = loadUserPresets();
  user.push(pr);
  saveUserPresets(user);
  PRESETS = BASE_PRESETS.concat(user);
  renderPresetChips();
  toast("💾 preset saved");
};

$("btnExportPresets").onclick = () => {
  const blob = new Blob([JSON.stringify(PRESETS, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "moshforge_presets.json";
  a.click();
};

$("btnImportPresets").onclick = () => $("presetFile").click();
$("presetFile").onchange = () => {
  const f = $("presetFile").files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const arr = JSON.parse(r.result);
      if (!Array.isArray(arr)) throw new Error("not an array");
      const good = arr.filter(pr => pr && pr.name && pr.fx);
      saveUserPresets(good);
      PRESETS = BASE_PRESETS.concat(loadUserPresets());
      renderPresetChips();
      toast(`⬆ imported ${good.length} presets`);
    } catch (e) {
      toast("Import failed: invalid JSON");
    }
  };
  r.readAsText(f);
};

/* ============================================================
   EXPORT - canvas captureStream + MediaRecorder
   ============================================================ */
let captureFps = 30;
segWire($("fpsSeg"), v => { captureFps = parseInt(v); updateStatLine();
 });

const codecSel = $("codec"), bitrateSel = $("bitrate");
function pickMime() {
  const want = codecSel.value === "vp9"
    ? ["video/webm;codecs=vp9", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/webm;codecs=vp8", "video/webm"];
  for (const m of want) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}
function updateStatLine() {
  $("stCodec").textContent =
    `${codecSel.value.toUpperCase()} · ${captureFps}fps · ${bitrateSel.value} Mbps`;
}
codecSel.onchange = updateStatLine;
bitrateSel.oninput = () => { $("o_bitrate").textContent = bitrateSel.value; updateStatLine(); };

function getAudioTrack() {
  if (muted || !S.hasSource) return null;
  try {
    if (!S.audioCtx) {
      S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      S.audioSrc = S.audioCtx.createMediaElementSource(video);
      S.audioSrc.connect(S.audioCtx.destination);
    }
    if (S.audioCtx.state === "suspended") S.audioCtx.resume();
    if (!S.audioDest) {
      S.audioDest = S.audioCtx.createMediaStreamDestination();
      S.audioSrc.connect(S.audioDest);
    }
    return S.audioDest.stream.getAudioTracks()[0] || null;
  } catch (e) { return null; }
}

$("btnExport").onclick = () => {
  if (!S.hasSource) { dz.click(); return; }
  if (S.recording) return;
  const stream = screen_.captureStream(captureFps);
  const at = getAudioTrack();
  if (at) stream.addTrack(at);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: parseInt(bitrateSel.value) * 1e6,
  });
  S.recChunks = [];
  rec.ondataavailable = e => { if (e.data.size) S.recChunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(S.recChunks, { type: "video/webm" });
    S.lastBlob = blob;
    const url = URL.createObjectURL(blob);
    const a = $("dlLink");
    a.href = url;
    a.download = `moshforge_${S.seed}_seg${S.segment}.webm`;
    a.textContent = `⬇ Download ${(blob.size / 1e6).toFixed(1)} MB mosh.webm`;
    $("dlrow").style.display = "flex";
    $("btnStopRec").style.display = "none";
    $("recstat").style.display = "none";
    $("btnExport").disabled = false;
    S.recording = false;
    let canShare = false;
    try {
      canShare = !!(navigator.canShare && S.lastBlob &&
        navigator.canShare({ files: [new File([S.lastBlob], "moshforge.webm", { type: "video/webm" })] }));
    } catch (e) { canShare = false; }
    $("btnShare").style.display = canShare ? "flex" : "none";
    toast("✅ export ready");
  };
  rec.start(250);
  S.recorder = rec;
  S.recording = true;
  S.recStart = performance.now();
  $("recstat").style.display = "flex";
  $("btnStopRec").style.display = "block";
  $("btnExport").disabled = true;
  $("dlrow").style.display = "none";
  if (video.paused) { video.play(); setPlayIcon(true); }
};

$("btnShare").onclick = async () => {
  if (!S.lastBlob) return;
  try {
    const file = new File([S.lastBlob], `moshforge_${S.seed}.webm`, { type: "video/webm" });
    await navigator.share({ files: [file], title: "MOSHFORGE export" });
  } catch (e) { /* user cancelled or unsupported */ }
};

$("btnStopRec").onclick = () => { if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop(); };

function updateRecTimer() {
  if (!S.recording) return;
  $("recTime").textContent = ((performance.now() - S.recStart) / 1000).toFixed(1) + "s";
}

/* snapshot */
$("btnSnapshot").onclick = () => {
  if (!S.hasSource) return;
  screen_.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `moshforge_frame_${S.frameCount}.png`;
    a.click();
    toast("📸 frame saved");
  }, "image/png");
};

/* touch devices: default to lower processing res for smooth fps */
if (matchMedia("(pointer: coarse)").matches) {
  S.resScale = 0.5;
  $("resScale").value = "0.5";
}

updateStatLine();
/* build tag - visible proof of which build is running */
const BUILD = "v2.0.4 \u00b7 2026-09-19";
const bt = $("buildTag");
if (bt) bt.textContent = BUILD;
