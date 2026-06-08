// api/image.js
// Generates PNG images for the wallet pass.
// Pure Node.js — uses only built-in zlib, zero external dependencies.

import zlib from 'zlib';

export default function handler(req, res) {
  const { type, stamps, needed, accent, name } = req.query;

  const accentHex = decodeURIComponent(accent || '#c94f2b');
  const cafeName  = decodeURIComponent(name   || 'Cafe');
  const stampsNum = parseInt(stamps || '0');
  const neededNum = parseInt(needed || '10');

  try {
    let buf;
    if      (type === 'strip') buf = makeStrip(stampsNum, neededNum, accentHex);
    else if (type === 'logo')  buf = makeLogo(accentHex);
    else return res.status(400).send('type must be strip or logo');

    res.setHeader('Content-Type',  'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[image]', e.message);
    return res.status(500).send(e.message);
  }
}

// ── PNG ENCODER ───────────────────────────────────────────────────

// CRC32 table (self-contained, no deps)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const combined  = Buffer.concat([typeBytes, data]);
  const crc       = crc32(combined);
  const lenBuf    = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const crcBuf    = Buffer.alloc(4); crcBuf.writeUInt32BE(crc);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function makePng(width, height, getPixel) {
  // Build raw scanlines (filter byte 0 = None, then RGBA)
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const off = y * (1 + width * 4) + 1 + x * 4;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8-bit RGBA

  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const IHDR = pngChunk('IHDR', ihdrData);
  const IDAT = pngChunk('IDAT', compressed);
  const IEND = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, IHDR, IDAT, IEND]);
}

// ── COLOUR HELPERS ────────────────────────────────────────────────

function hexToRgb(hex) {
  const c = hex.replace('#','');
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

function getLum(hex) {
  return hexToRgb(hex).reduce((s,c,i) => {
    c /= 255;
    return s + (c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)) * [0.2126,0.7152,0.0722][i];
  }, 0);
}

// ── STRIP IMAGE ───────────────────────────────────────────────────
// 1024×312px — store-card strip, cream bg, accent dots

function makeStrip(stamps, needed, accentHex) {
  const W = 1024, H = 312;
  const [ar,ag,ab] = hexToRgb(accentHex);
  const bg = [245,237,224];

  const dotR   = 18;
  const gap    = Math.min(60, Math.floor((W - 80) / needed));
  const totalW = (needed - 1) * gap;
  const startX = Math.floor((W - totalW) / 2);
  const dotY   = Math.floor(H * 0.60);

  function inDot(x, y, i) {
    const cx = startX + i * gap;
    return (x-cx)*(x-cx)+(y-dotY)*(y-dotY) <= dotR*dotR;
  }

  return makePng(W, H, (x, y) => {
    if (y < 10)                   return [ar,ag,ab,255];   // accent bar
    for (let i=0;i<needed;i++) {
      if (inDot(x,y,i))           return i < stamps
                                    ? [ar,ag,ab,255]       // filled dot
                                    : [ar,ag,ab,50];       // empty dot
    }
    return [...bg,255];                                    // cream bg
  });
}

// ── LOGO IMAGE ────────────────────────────────────────────────────
// 160×50px — solid accent rounded rect (cafe name rendered by WalletWallet's logoText)

function makeLogo(accentHex) {
  const W = 160, H = 50;
  const [ar,ag,ab] = hexToRgb(accentHex);
  const r = 8;

  return makePng(W, H, (x, y) => {
    const inCorner =
      (x<r   && y<r   && (x-r)*(x-r)+(y-r)*(y-r)>r*r) ||
      (x>W-r && y<r   && (x-(W-r))*(x-(W-r))+(y-r)*(y-r)>r*r) ||
      (x<r   && y>H-r && (x-r)*(x-r)+(y-(H-r))*(y-(H-r))>r*r) ||
      (x>W-r && y>H-r && (x-(W-r))*(x-(W-r))+(y-(H-r))*(y-(H-r))>r*r);
    return inCorner ? [0,0,0,0] : [ar,ag,ab,255];
  });
}
