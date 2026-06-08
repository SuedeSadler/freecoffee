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

// ── COFFEE CUP STAMP ──────────────────────────────────────────────
// Returns true if pixel (lx, ly) is part of the coffee cup icon
// within a local bounding box of size S×S centred at (0,0).
function inCup(lx, ly, S) {
  const s = S / 44; // scale factor (designed at 44px)
  const x = lx / s;
  const y = ly / s;
  const W = 44, H = 44;

  // Steam — two wavy lines above cup
  const steamLeft  = x >= 13 && x <= 15 && y >= 2  && y <= 9;
  const steamRight = x >= 19 && x <= 21 && y >= 2  && y <= 9;
  const steam = (steamLeft || steamRight) && (Math.floor(y) % 3 !== 1);

  // Rim — thick ellipse across top of cup body
  const rimCx = 22, rimCy = 16, rimRx = 11, rimRy = 3.5;
  const rimD = ((x-rimCx)/rimRx)**2 + ((y-rimCy)/rimRy)**2;
  const rim = rimD <= 1.0 && y >= rimCy - rimRy;

  // Cup body — filled trapezoid
  const bodyTop = 16, bodyBot = 32;
  if (y >= bodyTop && y <= bodyBot) {
    const t     = (y - bodyTop) / (bodyBot - bodyTop);
    const left  = 11 + t * 1.5;
    const right = 33 - t * 1.5;
    if (x >= left && x <= right) {
      // Body is solid (stamp style)
      if (y <= bodyBot) return true;
    }
  }

  // Handle — C shape on right side
  const hCx = 35, hCy = 25, hRx = 5, hRy = 6;
  const hD  = ((x-hCx)/hRx)**2 + ((y-hCy)/hRy)**2;
  const handle = hD <= 1.0 && x >= hCx;
  // hollow handle interior
  const hInner = ((x-hCx)/(hRx-2))**2 + ((y-hCy)/(hRy-2))**2;
  const handleRing = handle && hInner > 1.0;

  // Saucer — filled ellipse at bottom
  const sCx = 22, sCy = 34, sRx = 14, sRy = 3;
  const sD  = ((x-sCx)/sRx)**2 + ((y-sCy)/sRy)**2;
  const saucer = sD <= 1.0;

  return steam || rim || (y >= 16 && y <= 32 && x >= 11 - (y-16)*0.06 && x <= 33 + (y-16)*0.06) || handleRing || saucer;
}

// ── STRIP IMAGE ───────────────────────────────────────────────────
// Apple Wallet strip: 1125×432px @3x (375×144pt)

function makeStrip(stamps, needed, accentHex) {
  const W = 1125, H = 432;
  const [ar,ag,ab] = hexToRgb(accentHex);
  const bg  = [245,237,224]; // cream
  const lum = getLum(accentHex);

  // Stamp size and layout
  const S      = 72;  // stamp icon bounding box
  const gap    = Math.floor((W - 80) / needed);
  const totalW = (needed - 1) * gap;
  const startX = Math.floor((W - totalW) / 2);
  const stampY = Math.floor(H * 0.62); // vertical centre of stamp row

  // Bottom accent rule
  const ruleY = H - 14;

  function getStamp(px, py, i) {
    const cx  = startX + i * gap;
    const cy  = stampY;
    const lx  = px - cx;
    const ly  = py - cy;
    const half = S / 2;

    // Outer circle boundary
    const dist2 = lx*lx + ly*ly;
    const R     = half;

    if (dist2 > R*R) return null;

    const filled = i < stamps;

    if (filled) {
      // Filled stamp: solid accent circle with cream cup cut-out
      if (inCup(lx + half, ly + half, S)) {
        // Cup shape: render in cream (punched out of accent)
        return [...bg, 255];
      }
      return [ar,ag,ab,255];
    } else {
      // Empty stamp: faint accent circle outline only
      const innerR = R - 4;
      if (dist2 >= innerR*innerR) return [ar,ag,ab,90]; // thin ring
      return null; // transparent interior — shows bg
    }
  }

  return makePng(W, H, (px, py) => {
    // Bottom rule
    if (py >= ruleY) return [ar,ag,ab,255];

    // Stamps
    for (let i = 0; i < needed; i++) {
      const hit = getStamp(px, py, i);
      if (hit) return hit;
    }

    return [...bg, 255];
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
