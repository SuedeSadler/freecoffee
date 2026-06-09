// api/action.js -- Lucky Cup multi-cafe serverless handler
// All secrets via Vercel env vars -- never in source

export const config = { api: { bodyParser: false } };

import { createClient } from '@supabase/supabase-js';
import { pbkdf2 as _pbkdf2, randomBytes, timingSafeEqual, randomUUID } from 'crypto';
import zlib from 'zlib';

// ── PIN hashing (Node built-in crypto) ───────────────────────────────────────
function hashPin(pin) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    _pbkdf2(pin, salt, 100_000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function checkPin(pin, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = (stored || '').split(':');
    if (!salt || !hash) return resolve(false);
    _pbkdf2(pin, salt, 100_000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else {
        try { resolve(timingSafeEqual(key, Buffer.from(hash, 'hex'))); }
        catch { resolve(false); }
      }
    });
  });
}

// ── Env ───────────────────────────────────────────────────────────────────────
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const WALLETWALLET_KEY = process.env.WALLETWALLET_KEY;
const MASTER_KEY       = process.env.MASTER_KEY;
const STAMPS_NEEDED    = parseInt(process.env.STAMPS_NEEDED || '10', 10);
const SITE_URL         = (process.env.SITE_URL || '').replace(/\/$/, '');

const db = () => createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Body parser ───────────────────────────────────────────────────────────────
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── PNG encoder (zero external deps) ─────────────────────────────────────────
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
  const tb = Buffer.from(type, 'ascii');
  const cb = Buffer.concat([tb, data]);
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
  const rb = Buffer.alloc(4); rb.writeUInt32BE(crc32(cb));
  return Buffer.concat([lb, tb, data, rb]);
}

// getPixel(x, y) => [r, g, b, a]
function makePng(W, H, getPixel) {
  const rowLen = 1 + W * 4;
  const raw = Buffer.alloc(H * rowLen);
  for (let y = 0; y < H; y++) {
    raw[y * rowLen] = 0; // filter byte
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r; raw[o+1] = g; raw[o+2] = b; raw[o+3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// ── Coffee cup stamp renderer ─────────────────────────────────────────────────
// Returns true if pixel (lx, ly) is part of the cup icon.
// lx/ly are relative to the centre of the stamp cell; S is the cell size.
function inCup(lx, ly, S) {
  const s = S / 44;
  const x = lx / s, y = ly / s;

  // Steam -- two vertical wavy columns above rim
  const steamLeft  = x >= 13 && x <= 15 && y >= 2 && y <= 9;
  const steamRight = x >= 19 && x <= 21 && y >= 2 && y <= 9;
  const steam = (steamLeft || steamRight) && (Math.floor(y) % 3 !== 1);

  // Rim -- thick ellipse
  const rimD = ((x - 22) / 11) ** 2 + ((y - 16) / 3.5) ** 2;
  const rim  = rimD <= 1.0 && y >= 12.5;

  // Body -- filled trapezoid
  const bodyTop = 16, bodyBot = 32;
  const inBody  = y >= bodyTop && y <= bodyBot &&
    x >= (11 - (y - bodyTop) * 0.06) &&
    x <= (33 + (y - bodyTop) * 0.06);

  // Handle -- C-ring on right
  const hD     = ((x - 35) / 5) ** 2 + ((y - 25) / 6) ** 2;
  const hInner = ((x - 35) / 3) ** 2 + ((y - 25) / 4) ** 2;
  const handle = hD <= 1.0 && x >= 35 && hInner > 1.0;

  // Saucer -- filled ellipse at bottom
  const sD     = ((x - 22) / 14) ** 2 + ((y - 34) / 3) ** 2;
  const saucer = sD <= 1.0;

  return steam || rim || inBody || handle || saucer;
}

// ── Strip image: 1125x369, 2 rows of 5 cups, or celebration state ────────────
function makeStripDataUri(stamps, needed, accentHex, versionN = 0) {
  const W = 1125, H = 369;
  const [ar, ag, ab] = hexToRgb(accentHex);
  const BG  = [26, 26, 26];  // dark background matches pass color
  const ruleY  = H - 10;
  const vByte  = (versionN % 200) + 28; // invisible corner pixel for cache-busting

  // ── FULL / FREE COFFEE state ──────────────────────────────────────────────
  if (stamps >= needed) {
    const cx = W / 2, cy = (H - 10) / 2;
    const bigS = 180, bigR = 90;
    const inRing = (px, py) => {
      const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      return d >= bigR + 12 && d <= bigR + 28;
    };
    const inDot = (px, py) => {
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const sx = cx + Math.cos(a) * (bigR + 48);
        const sy = cy + Math.sin(a) * (bigR + 48);
        if ((px - sx) ** 2 + (py - sy) ** 2 <= 36) return true;
      }
      return false;
    };
    const buf = makePng(W, H, (px, py) => {
      if (px < 3 && py < 3) return [BG[0], BG[1], vByte, 255];
      if (py >= ruleY) return [ar, ag, ab, 180];
      const dx = px - cx, dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bigR * bigR) {
        return inCup(dx + bigR, dy + bigR, bigS) ? [...BG, 255] : [ar, ag, ab, 255];
      }
      if (inRing(px, py)) return [ar, ag, ab, 160];
      if (inDot(px, py))  return [ar, ag, ab, 200];
      return [...BG, 255];
    });
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  // ── NORMAL stamp grid ────────────────────────────────────────────────────
  const cols = 5, rows = 2;
  const padX = 80, padTop = 24, padBot = 20;
  const gapX = Math.floor((W - padX * 2) / cols);
  const gapY = Math.floor((H - padTop - padBot) / rows);
  const R    = Math.floor(Math.min(gapX, gapY) * 0.44); // 44% of smaller gap
  const S    = R * 2;
  const startX = padX + Math.floor(gapX / 2);
  const startY = padTop + Math.floor(gapY / 2);

  function getStampPixel(px, py, idx) {
    const row = Math.floor(idx / cols), col = idx % cols;
    const cx  = startX + col * gapX, cy = startY + row * gapY;
    const lx  = px - cx, ly = py - cy;
    const d2  = lx * lx + ly * ly;
    if (d2 > R * R) return null;
    if (idx < stamps) {
      // Filled stamp: accent circle with dark cup cut-out
      return inCup(lx + R, ly + R, S) ? [...BG, 255] : [ar, ag, ab, 255];
    } else {
      // Empty slot: faint ring only
      const innerR = R - 4;
      return d2 >= innerR * innerR ? [ar, ag, ab, 75] : null;
    }
  }

  const buf = makePng(W, H, (px, py) => {
    if (px < 3 && py < 3) return [BG[0], BG[1], vByte, 255];
    if (py >= ruleY) return [ar, ag, ab, 180];
    for (let i = 0; i < needed; i++) {
      const hit = getStampPixel(px, py, i);
      if (hit) return hit;
    }
    return [...BG, 255];
  });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// Logo: 160x50 accent rounded rect
function makeLogoDataUri(accentHex) {
  const W = 160, H = 50, r = 8;
  const [ar, ag, ab] = hexToRgb(accentHex);
  const buf = makePng(W, H, (x, y) => {
    const inCorner =
      (x < r   && y < r   && (x-r)**2   + (y-r)**2   > r*r) ||
      (x > W-r && y < r   && (x-(W-r))**2 + (y-r)**2   > r*r) ||
      (x < r   && y > H-r && (x-r)**2   + (y-(H-r))**2 > r*r) ||
      (x > W-r && y > H-r && (x-(W-r))**2 + (y-(H-r))**2 > r*r);
    return inCorner ? [0, 0, 0, 0] : [ar, ag, ab, 255];
  });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// ── WalletWallet helpers ──────────────────────────────────────────────────────
const WW_BASE = 'https://api.walletwallet.dev';
const WW_AUTH = () => ({
  'Authorization': `Bearer ${WALLETWALLET_KEY}`,
  'Content-Type': 'application/json',
});

// Build pass payload -- uses cafe accent for strip AND logo, with push fields
function passPayload({ custId, name, stamps, accent, cafeName, slug, version }) {
  const full      = stamps >= STAMPS_NEEDED;
  const versionN  = version || 1;
  const stripUri  = makeStripDataUri(stamps, STAMPS_NEEDED, accent, versionN);
  const logoUri   = makeLogoDataUri(accent);
  const qrUrl     = `${SITE_URL}/staff.html?cafe=${slug}&id=${custId}`;

  // changeMessage triggers a live push notification to the customer's phone
  // when the pass is updated via PUT. Apple Wallet shows it as a banner.
  const changeMessage = full
    ? `\u2615 Free coffee ready at ${cafeName}!`
    : `Stamp added \u2014 ${stamps} of ${STAMPS_NEEDED} at ${cafeName}`;

  return {
    barcodeValue:     qrUrl,
    barcodeFormat:    'QR',
    logoText:         cafeName,
    organizationName: cafeName,
    description:      `${cafeName} Loyalty Card`,
    colorPro:         '#1a1a1a',
    stripURLPro:      stripUri,
    logoURLPro:       logoUri,

    primaryFields: full
      ? [{ label: 'REWARD', value: '1 FREE COFFEE' }]
      : [],

    secondaryFields: [
      { label: 'MEMBER', value: name },
      {
        label:         'STAMPS',
        value:         full ? `${STAMPS_NEEDED} of ${STAMPS_NEEDED} \u2713` : `${stamps} of ${STAMPS_NEEDED}`,
        changeMessage, // push notification text on stamp update
      },
    ],

    backFields: [
      {
        label: 'How to redeem',
        value: `Show this pass at ${cafeName}. One free coffee when you reach ${STAMPS_NEEDED} stamps.`,
      },
      { label: 'Member ID', value: custId },
      {
        label:         'Last update',
        value:         `${new Date().toISOString()} v${versionN}`,
        changeMessage, // also on back so WalletWallet always sends the push
      },
    ],

    expirationDays:    365,
    sharingProhibited: true,
  };
}

async function wwCreatePass(payload) {
  const res = await fetch(`${WW_BASE}/api/passes`, {
    method: 'POST',
    headers: WW_AUTH(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WalletWallet ${res.status}: ${text}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`WalletWallet bad JSON: ${text}`); }
}

async function wwUpdatePass(serial, payload) {
  const res = await fetch(`${WW_BASE}/api/passes/${serial}`, {
    method: 'PUT',
    headers: WW_AUTH(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WalletWallet update ${res.status}: ${text}`);
  }
}

// serial=null -> create new pass; serial=string -> update + push
async function buildPass({ serial, custId, name, stamps, accent, cafeName, slug, version }) {
  const payload = passPayload({ custId, name, stamps, accent, cafeName, slug, version });
  if (!serial) {
    const data = await wwCreatePass(payload);
    // data = { serialNumber, shareUrl, applePass, googleSaveUrl, ... }
    return { passUrl: data.shareUrl, serialNumber: data.serialNumber };
  } else {
    await wwUpdatePass(serial, payload);
    return { passUrl: null, serialNumber: serial };
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────
function ok(res, data, status = 200) { res.status(status).json({ ok: true, ...data }); }
function err(res, msg, status = 400) { res.status(status).json({ ok: false, error: msg }); }
function randomId() { return `CUST-${Math.random().toString(36).slice(2,8).toUpperCase()}`; }

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ ok: true }); // WW push webhook

  let body = {};
  try { body = await readBody(req); } catch { return err(res, 'Bad JSON', 400); }

  const { action, slug } = body;
  const supa = db();

  // ── create-cafe ───────────────────────────────────────────────────────────
  if (action === 'create-cafe') {
    const { masterKey, cafeName, cafeSlug, accent, stamp, mode, pin } = body;
    if (masterKey !== MASTER_KEY) return err(res, 'Unauthorised', 403);
    if (!cafeName || !cafeSlug || !pin) return err(res, 'Missing fields', 400);
    if (!/^[a-z0-9-]+$/.test(cafeSlug)) return err(res, 'Slug: lowercase, numbers and hyphens only', 400);

    const pinHash = await hashPin(pin);
    const { error } = await supa.from('cafe_settings').insert({
      slug: cafeSlug, cafe_name: cafeName,
      accent: accent || '#c94f2b', stamp: stamp || '\u2615',
      mode: mode || 'dark', pin_hash: pinHash,
    });
    if (error) {
      if (error.code === '23505') return err(res, 'A cafe with that slug already exists', 409);
      return err(res, error.message, 500);
    }
    return ok(res, {
      message:   'Cafe created',
      signupUrl: `${SITE_URL}/signup.html?cafe=${cafeSlug}`,
      staffUrl:  `${SITE_URL}/staff.html?cafe=${cafeSlug}`,
    });
  }

  // ── get-settings ──────────────────────────────────────────────────────────
  if (action === 'get-settings') {
    if (!slug) return err(res, 'slug required', 400);
    const { data, error } = await supa
      .from('cafe_settings')
      .select('cafe_name, accent, stamp, mode, slug')
      .eq('slug', slug).single();
    if (error || !data) return err(res, 'Cafe not found', 404);
    return ok(res, { settings: data });
  }

  // ── create-pass ───────────────────────────────────────────────────────────
  if (action === 'create-pass') {
    const { name, email } = body;
    if (!slug || !name) return err(res, 'slug and name required', 400);

    const { data: cafe, error: cafeErr } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (cafeErr || !cafe) return err(res, 'Cafe not found', 404);

    if (email) {
      const { data: existing } = await supa.from('customers').select('customer_id')
        .eq('cafe_id', cafe.cafe_id).eq('email', email).maybeSingle();
      if (existing) return err(res, 'Email already registered for this cafe', 409);
    }

    const custId = randomId();
    let passResult;
    try {
      passResult = await buildPass({
        serial: null, custId, name, stamps: 0,
        accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version: 1,
      });
    } catch (e) {
      return err(res, `Pass creation failed: ${e.message}`, 500);
    }

    const { passUrl, serialNumber } = passResult;
    if (!passUrl) return err(res, 'Pass created but no share URL returned', 500);

    const { error: insertErr } = await supa.from('customers').insert({
      customer_id:   custId,
      serial:        serialNumber,
      serial_number: serialNumber,
      name,
      email:         email || null,
      stamps:        0,
      cafe_id:       cafe.cafe_id,
      cafe_name:     cafe.cafe_name,
      accent:        cafe.accent,
      mode:          cafe.mode,
    });
    if (insertErr) return err(res, insertErr.message, 500);

    return ok(res, { passUrl, custId });
  }

  // ── verify-pin ────────────────────────────────────────────────────────────
  if (action === 'verify-pin') {
    const { pin } = body;
    if (!slug || !pin) return err(res, 'slug and pin required', 400);
    const { data: cafe } = await supa
      .from('cafe_settings').select('pin_hash').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);
    return ok(res, { verified: true });
  }

  // ── add-stamp ─────────────────────────────────────────────────────────────
  if (action === 'add-stamp') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa.from('customers').select('*')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);
    if (cust.stamps >= STAMPS_NEEDED) return err(res, 'Card full -- redeem first', 400);

    const newStamps = cust.stamps + 1;
    const version   = (cust.version || 1) + 1;

    try {
      // PUT triggers WalletWallet to push a notification to the customer's phone
      await buildPass({
        serial: cust.serial_number || cust.serial,
        custId, name: cust.name, stamps: newStamps,
        accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version,
      });
    } catch (e) {
      return err(res, `Pass update failed: ${e.message}`, 500);
    }

    await supa.from('customers')
      .update({ stamps: newStamps, version, updated_at: new Date().toISOString() })
      .eq('customer_id', custId);

    return ok(res, { stamps: newStamps, full: newStamps >= STAMPS_NEEDED });
  }

  // ── redeem ────────────────────────────────────────────────────────────────
  if (action === 'redeem') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa.from('customers').select('*')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);
    if (cust.stamps < STAMPS_NEEDED) return err(res, 'Not enough stamps to redeem', 400);

    const version = (cust.version || 1) + 1;
    try {
      await buildPass({
        serial: cust.serial_number || cust.serial,
        custId, name: cust.name, stamps: 0,
        accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version,
      });
    } catch (e) {
      return err(res, `Pass update failed: ${e.message}`, 500);
    }

    await supa.from('customers')
      .update({ stamps: 0, redeemed: true, version, updated_at: new Date().toISOString() })
      .eq('customer_id', custId);

    return ok(res, { redeemed: true, stamps: 0 });
  }

  // ── get-customer ──────────────────────────────────────────────────────────
  if (action === 'get-customer') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa.from('customers')
      .select('customer_id, name, email, stamps, created_at, updated_at')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);

    return ok(res, { customer: cust });
  }

  return err(res, `Unknown action: ${action}`, 400);
}
