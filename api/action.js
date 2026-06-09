// api/action.js -- Lucky Cup multi-cafe serverless handler
// All secrets via Vercel env vars -- never in source

export const config = { api: { bodyParser: false } };

import { createClient } from '@supabase/supabase-js';
import { pbkdf2 as _pbkdf2, randomBytes, timingSafeEqual } from 'crypto';
import zlib from 'zlib';

// PIN hashing -- Node built-in crypto, no external packages needed
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

// Env
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const WALLETWALLET_KEY = process.env.WALLETWALLET_KEY;
const MASTER_KEY       = process.env.MASTER_KEY;
const STAMPS_NEEDED    = parseInt(process.env.STAMPS_NEEDED || '10', 10);
const SITE_URL         = (process.env.SITE_URL || '').replace(/\/$/, '');

const db = () => createClient(SUPABASE_URL, SUPABASE_KEY);

// Body parser
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

// PNG helpers (no external deps)
function crc32(buf) {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  let c = -1;
  for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function pngChunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii');
  const dBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const cBuf = u32be(crc32(Buffer.concat([tBuf, dBuf])));
  return Buffer.concat([u32be(dBuf.length), tBuf, dBuf, cBuf]);
}

function makePng(w, h, rows) {
  const raw = rows.flatMap(row => [Buffer.from([0]), row]);
  const compressed = zlib.deflateSync(Buffer.concat(raw));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
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

// Strip image: 1125x369, 2 rows of 5 stamps, or celebration at 10/10
function makeStripPng(stamps, accent, version = 0) {
  const W = 1125, H = 369;
  const [ar, ag, ab] = hexToRgb(accent);
  const full = stamps >= STAMPS_NEEDED;
  const rows = [];

  function dist(x, y, cx, cy) { return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2); }

  if (full) {
    const cx = W / 2, cy = H / 2;
    const haloR = 130, dotR = 12, dotOrbit = 160;
    const cupW = 120, cupH = 100;
    for (let y = 0; y < H; y++) {
      const row = Buffer.alloc(W * 4);
      for (let x = 0; x < W; x++) {
        let r = 26, g = 26, b = 26, a = 255;
        const d = dist(x, y, cx, cy);
        if (d >= haloR - 6 && d <= haloR + 6) {
          const alpha = Math.max(0, 1 - Math.abs(d - haloR) / 6);
          r = ar; g = ag; b = ab; a = Math.round(200 * alpha);
        }
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          if (dist(x, y, cx + Math.cos(angle) * dotOrbit, cy + Math.sin(angle) * dotOrbit) <= dotR) {
            r = ar; g = ag; b = ab; a = 255;
          }
        }
        const cupX = cx - cupW / 2, cupY = cy - cupH / 2 + 10;
        if (x >= cupX && x <= cupX + cupW && y >= cupY && y <= cupY + cupH) {
          r = ar; g = ag; b = ab; a = 255;
          if (dist(x, y, cx, cupY + 10) <= 28) { r = 26; g = 26; b = 26; a = 255; }
        }
        if (dist(x, y, cx + cupW / 2 + 14, cy + 10) >= 14 &&
            dist(x, y, cx + cupW / 2 + 14, cy + 10) <= 22 &&
            x >= cx + cupW / 2 && y >= cy && y <= cy + 40) {
          r = ar; g = ag; b = ab; a = 255;
        }
        row.writeUInt8(r, x*4); row.writeUInt8(g, x*4+1);
        row.writeUInt8(b, x*4+2); row.writeUInt8(a, x*4+3);
      }
      rows.push(row);
    }
  } else {
    const cols = 5, cellW = W / cols, cellH = H / 2;
    const radius = 60, inner = 24;
    for (let y = 0; y < H; y++) {
      const row = Buffer.alloc(W * 4);
      for (let x = 0; x < W; x++) {
        let r = 26, g = 26, b = 26, a = 255;
        const col = Math.floor(x / cellW);
        const rowIdx = Math.floor(y / cellH);
        const idx = rowIdx * cols + col;
        const cx = col * cellW + cellW / 2;
        const cy = rowIdx * cellH + cellH / 2;
        const d = dist(x, y, cx, cy);
        if (idx < stamps) {
          if (d <= radius) {
            r = ar; g = ag; b = ab; a = 255;
            if (d <= inner) { r = 26; g = 26; b = 26; a = 255; }
          }
        } else {
          if (d >= radius - 4 && d <= radius) {
            r = ar; g = ag; b = ab;
            a = Math.round(140 + 115 * (1 - (d - (radius - 4)) / 4));
          }
        }
        row.writeUInt8(r, x*4); row.writeUInt8(g, x*4+1);
        row.writeUInt8(b, x*4+2); row.writeUInt8(a, x*4+3);
      }
      if (y === 0) {
        const vv = version % 255;
        row.writeUInt8(vv, 0); row.writeUInt8(vv, 1);
        row.writeUInt8(vv, 2); row.writeUInt8(255, 3);
      }
      rows.push(row);
    }
  }
  return makePng(W, H, rows);
}

function makeLogoPng() {
  const W = 160, H = 50;
  const rows = [];
  for (let y = 0; y < H; y++) rows.push(Buffer.alloc(W * 4));
  return makePng(W, H, rows);
}

// WalletWallet
async function wwFetch(path, body) {
  const res = await fetch(`https://api.walletwallet.io${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': WALLETWALLET_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function buildPass({ serial, custId, name, stamps, accent, cafeName, slug, version }) {
  const full = stamps >= STAMPS_NEEDED;
  const stripB64 = makeStripPng(stamps, accent, version).toString('base64');
  const logoB64  = makeLogoPng().toString('base64');
  const qrUrl    = `${SITE_URL}/staff.html?cafe=${slug}&id=${custId}`;

  return wwFetch('/v1/passes/create', {
    serialNumber: serial,
    passType: 'generic',
    teamId: 'auto',
    backgroundColor: 'rgb(26,26,26)',
    labelColor: 'rgb(180,180,180)',
    foregroundColor: 'rgb(255,255,255)',
    logoText: cafeName,
    organizationName: cafeName,
    description: `${cafeName} Loyalty Card`,
    stripBase64: stripB64,
    logoBase64: logoB64,
    barcodes: [{ message: qrUrl, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' }],
    primaryFields: full
      ? [{ key: 'reward', label: '', value: 'REDEEM / 1 FREE COFFEE' }]
      : [{ key: 'spacer', label: '', value: '' }],
    secondaryFields: [
      { key: 'member', label: 'MEMBER', value: name },
      { key: 'stamps', label: 'STAMPS', value: `${stamps} of ${STAMPS_NEEDED}` },
    ],
    backFields: [
      { key: 'cafe',   label: 'CAFE',    value: cafeName },
      { key: 'ts',     label: 'UPDATED', value: new Date().toISOString() },
      { key: 'anchor', label: '',         value: `v${version}-${Date.now()}` },
    ],
    webServiceURL: `${SITE_URL}/api/action`,
    authenticationToken: serial,
  });
}

// Response helpers
function ok(res, data, status = 200) { res.status(status).json({ ok: true, ...data }); }
function err(res, msg, status = 400) { res.status(status).json({ ok: false, error: msg }); }
function randomId() { return `CUST-${Math.random().toString(36).slice(2,8).toUpperCase()}`; }

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // WalletWallet push webhook -- GET requests
  if (req.method === 'GET') return res.status(200).json({ ok: true });

  let body = {};
  try { body = await readBody(req); } catch { return err(res, 'Bad JSON', 400); }

  const { action, slug } = body;
  const supa = db();

  // create-cafe
  if (action === 'create-cafe') {
    const { masterKey, cafeName, cafeSlug, accent, stamp, mode, pin } = body;
    if (masterKey !== MASTER_KEY) return err(res, 'Unauthorised', 403);
    if (!cafeName || !cafeSlug || !pin) return err(res, 'Missing fields', 400);
    if (!/^[a-z0-9-]+$/.test(cafeSlug)) return err(res, 'Slug: lowercase letters, numbers and hyphens only', 400);

    const pinHash = await hashPin(pin);
    const { error } = await supa.from('cafe_settings').insert({
      slug: cafeSlug,
      cafe_name: cafeName,
      accent: accent || '#c94f2b',
      stamp: stamp || '\u2615',
      mode: mode || 'dark',
      pin_hash: pinHash,
    });
    if (error) {
      if (error.code === '23505') return err(res, 'A cafe with that slug already exists', 409);
      return err(res, error.message, 500);
    }
    return ok(res, {
      message: 'Cafe created',
      signupUrl: `${SITE_URL}/signup.html?cafe=${cafeSlug}`,
      staffUrl:  `${SITE_URL}/staff.html?cafe=${cafeSlug}`,
    });
  }

  // get-settings
  if (action === 'get-settings') {
    if (!slug) return err(res, 'slug required', 400);
    const { data, error } = await supa
      .from('cafe_settings')
      .select('cafe_name, accent, stamp, mode, slug')
      .eq('slug', slug)
      .single();
    if (error || !data) return err(res, 'Cafe not found', 404);
    return ok(res, { settings: data });
  }

  // create-pass
  if (action === 'create-pass') {
    const { name, email } = body;
    if (!slug || !name) return err(res, 'slug and name required', 400);

    const { data: cafe, error: cafeErr } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (cafeErr || !cafe) return err(res, 'Cafe not found', 404);

    if (email) {
      const { data: existing } = await supa
        .from('customers').select('customer_id')
        .eq('cafe_id', cafe.cafe_id).eq('email', email).maybeSingle();
      if (existing) return err(res, 'Email already registered for this cafe', 409);
    }

    const custId = randomId();
    const serial = crypto.randomUUID();
    const passResult = await buildPass({
      serial, custId, name, stamps: 0,
      accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version: 1,
    });

    const passUrl = passResult.passUrl || passResult.downloadUrl;
    if (!passUrl) return err(res, `Pass creation failed: ${JSON.stringify(passResult)}`, 500);

    const { error: insertErr } = await supa.from('customers').insert({
      customer_id: custId, serial, name,
      email: email || null, stamps: 0, cafe_id: cafe.cafe_id,
    });
    if (insertErr) return err(res, insertErr.message, 500);

    return ok(res, { passUrl, custId });
  }

  // verify-pin
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

  // add-stamp
  if (action === 'add-stamp') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa
      .from('customers').select('*')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);
    if (cust.stamps >= STAMPS_NEEDED) return err(res, 'Card full -- redeem first', 400);

    const newStamps = cust.stamps + 1;
    const version = (cust.version || 1) + 1;

    await buildPass({
      serial: cust.serial, custId, name: cust.name, stamps: newStamps,
      accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version,
    });
    await supa.from('customers')
      .update({ stamps: newStamps, version, updated_at: new Date().toISOString() })
      .eq('customer_id', custId);

    return ok(res, { stamps: newStamps, full: newStamps >= STAMPS_NEEDED });
  }

  // redeem
  if (action === 'redeem') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa
      .from('customers').select('*')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);
    if (cust.stamps < STAMPS_NEEDED) return err(res, 'Not enough stamps to redeem', 400);

    const version = (cust.version || 1) + 1;
    await buildPass({
      serial: cust.serial, custId, name: cust.name, stamps: 0,
      accent: cafe.accent, cafeName: cafe.cafe_name, slug: cafe.slug, version,
    });
    await supa.from('customers')
      .update({ stamps: 0, version, updated_at: new Date().toISOString() })
      .eq('customer_id', custId);

    return ok(res, { redeemed: true, stamps: 0 });
  }

  // get-customer
  if (action === 'get-customer') {
    const { custId, pin } = body;
    if (!slug || !custId || !pin) return err(res, 'slug, custId, pin required', 400);

    const { data: cafe } = await supa
      .from('cafe_settings').select('*').eq('slug', slug).single();
    if (!cafe) return err(res, 'Cafe not found', 404);
    const valid = await checkPin(pin, cafe.pin_hash);
    if (!valid) return err(res, 'Wrong PIN', 403);

    const { data: cust } = await supa
      .from('customers')
      .select('customer_id, name, email, stamps, created_at, updated_at')
      .eq('customer_id', custId).eq('cafe_id', cafe.cafe_id).single();
    if (!cust) return err(res, 'Customer not found', 404);

    return ok(res, { customer: cust });
  }

  return err(res, `Unknown action: ${action}`, 400);
}
