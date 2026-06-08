// api/action.js
// Vercel serverless function — all secrets live here, never in the browser
// Handles: save-settings, get-settings, create-pass, add-stamp, redeem, get-customer

export default async function handler(req, res) {

  // ── CORS ─────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method not allowed' });

  // ── SECRETS (Vercel env vars only — never in browser) ────────────────
  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_KEY     = process.env.SUPABASE_KEY;   // service role key
  const WALLETWALLET_KEY = process.env.WALLETWALLET_KEY;
  const STAFF_PIN        = process.env.STAFF_PIN;
  const STAMPS_NEEDED    = parseInt(process.env.STAMPS_NEEDED || '10');
  // Base URL of your Vercel deployment — used to build the QR code link
  const SITE_URL         = (process.env.SITE_URL || '').replace(/\/$/, '');

  // ── PASS IMAGE GENERATORS ────────────────────────────────────────
  // Generate PNG data URIs directly — no external dependencies,
  // no caching issues, no SVG format rejection from WalletWallet.

  function hexToRgb(hex) {
    const c = hex.replace('#','');
    return [
      parseInt(c.slice(0,2),16),
      parseInt(c.slice(2,4),16),
      parseInt(c.slice(4,6),16),
    ];
  }

  function getLum(hex) {
    const [r,g,b] = hexToRgb(hex).map(c => {
      c /= 255;
      return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
    });
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }

  // Build a minimal valid PNG from raw RGBA pixel data
  function buildPng(width, height, getPixel) {
    // Inflate-store each row (no compression, just stored blocks)
    function adler32(data) {
      let s1 = 1, s2 = 0;
      for (const b of data) { s1 = (s1+b)%65521; s2 = (s2+s1)%65521; }
      return (s2<<16)|s1;
    }
    function crc32(data) {
      let c = 0xFFFFFFFF;
      const t = new Uint32Array(256);
      for (let i=0;i<256;i++){let v=i;for(let k=0;k<8;k++)v=v&1?0xEDB88320^(v>>>1):v>>>1;t[i]=v;}
      for (const b of data) c=t[(c^b)&0xFF]^(c>>>8);
      return (c^0xFFFFFFFF)>>>0;
    }
    function u32be(n){return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255];}
    function u16le(n){return [n&255,(n>>8)&255];}

    const raw = [];
    for (let y=0;y<height;y++){
      raw.push(0); // filter byte
      for (let x=0;x<width;x++){
        const [r,g,b,a]=getPixel(x,y);
        raw.push(r,g,b,a);
      }
    }

    // zlib store (method=8, no compression)
    const zlib = [];
    zlib.push(0x78,0x01); // header
    let off = 0;
    while (off < raw.length) {
      const chunk = raw.slice(off, off+65535);
      const last  = off+chunk.length >= raw.length ? 1 : 0;
      zlib.push(last);
      zlib.push(...u16le(chunk.length));
      zlib.push(...u16le(~chunk.length & 0xFFFF));
      zlib.push(...chunk);
      off += chunk.length;
    }
    const ad = adler32(raw);
    zlib.push(...u32be(ad));

    function chunk(type, data){
      const tc = [...type].map(c=>c.charCodeAt(0));
      const cd = [...data];
      const crc = crc32([...tc,...cd]);
      return [...u32be(cd.length),...tc,...cd,...u32be(crc)];
    }

    const sig   = [137,80,78,71,13,10,26,10];
    const IHDR  = chunk('IHDR',[...u32be(width),...u32be(height),8,2,0,0,0]);
    const IDAT  = chunk('IDAT',zlib);
    const IEND  = chunk('IEND',[]);
    const bytes = new Uint8Array([...sig,...IHDR,...IDAT,...IEND]);
    return Buffer.from(bytes).toString('base64');
  }

  function makeStripDataUri(stamps, needed, accentHex, cafeName, stampIcon) {
    const W = 640, H = 210;
    const [ar,ag,ab] = hexToRgb(accentHex);
    const lum        = getLum(accentHex);
    const onAccent   = lum > 0.35 ? [26,26,26] : [255,255,255];

    // Background: cream #f5ede0
    const bg = [245,237,224];

    // Dot layout
    const dotR    = 14;
    const spacing = Math.floor((W - 40) / needed);
    const startX  = 20 + Math.floor(spacing/2);
    const dotY    = Math.floor(H * 0.62);

    function inDot(x, y, i) {
      const cx = startX + i * spacing;
      const dx = x - cx, dy = y - dotY;
      return dx*dx + dy*dy <= dotR*dotR;
    }

    const png = buildPng(W, H, (x, y) => {
      // Accent top bar (8px)
      if (y < 8) return [...[ar,ag,ab], 255];

      // Check each dot
      for (let i = 0; i < needed; i++) {
        if (inDot(x, y, i)) {
          if (i < stamps) return [...[ar,ag,ab], 255];      // filled
          else            return [...[ar,ag,ab], 46];        // empty (faded)
        }
      }

      // Background
      return [...bg, 255];
    });

    return `data:image/png;base64,${png}`;
  }

  function makeLogoDataUri(accentHex) {
    const W = 120, H = 120;
    const [ar,ag,ab] = hexToRgb(accentHex);
    const lum        = getLum(accentHex);
    const [tr,tg,tb] = lum > 0.35 ? [26,26,26] : [255,255,255];

    const png = buildPng(W, H, (x, y) => {
      // Rounded rect background — approx corner radius 20
      const r = 20;
      const inCorner = (
        (x < r && y < r && (x-r)*(x-r)+(y-r)*(y-r) > r*r) ||
        (x > W-r && y < r && (x-(W-r))*(x-(W-r))+(y-r)*(y-r) > r*r) ||
        (x < r && y > H-r && (x-r)*(x-r)+(y-(H-r))*(y-(H-r)) > r*r) ||
        (x > W-r && y > H-r && (x-(W-r))*(x-(W-r))+(y-(H-r))*(y-(H-r)) > r*r)
      );
      if (inCorner) return [0,0,0,0];
      return [...[ar,ag,ab], 255];
    });

    return `data:image/png;base64,${png}`;
  }

  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });

  // ── SUPABASE HELPERS ──────────────────────────────────────────────────
  async function sbFetch(path, opts = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        opts.prefer || '',
        ...opts.headers,
      },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `supabase ${r.status}`);
    return text ? JSON.parse(text) : null;
  }

  async function getCustomer(id) {
    const rows = await sbFetch(`customers?id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows?.[0] || null;
  }

  async function createCustomerRow(data) {
    return sbFetch('customers', {
      method: 'POST',
      prefer: 'return=representation',
      body:   JSON.stringify(data),
    });
  }

  async function updateCustomerRow(id, data) {
    return sbFetch(`customers?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body:   JSON.stringify(data),
    });
  }

  async function getSettings() {
    const rows = await sbFetch('cafe_settings?id=eq.1&limit=1');
    return rows?.[0] || null;
  }

  // ── WALLETWALLET HELPERS ──────────────────────────────────────────────
  function buildPassBody(customer, s, stamps) {
    const needed     = STAMPS_NEEDED;
    const isComplete = stamps >= needed;
    const stampIcon  = s.stamp || '☕';
    const accent     = s.accent || '#c94f2b';

    // Generate PNG data URIs inline — no caching, no external fetch,
    // guaranteed unique body on every call so WalletWallet always pushes.
    const stripDataUri = makeStripDataUri(stamps, needed, accent, s.cafe_name, stampIcon);
    const logoDataUri  = makeLogoDataUri(accent);

    return {
      barcodeValue:     SITE_URL ? `${SITE_URL}/staff.html?id=${customer.id}` : customer.id,
      barcodeFormat:    'QR',
      logoText:         s.cafe_name,
      organizationName: s.cafe_name,
      description:      'Loyalty card',
      primaryFields: [{
        label: 'MEMBER',
        value: customer.name,
      }],
      secondaryFields: [
        {
          label: 'STAMPS',
          value: `${stamps} of ${needed}`,
          changeMessage: isComplete
            ? `🎉 Free coffee earned at ${s.cafe_name}!`
            : `Stamp added — you now have %@ stamps`,
        },
        {
          label: isComplete ? 'REWARD' : 'TO GO',
          value: isComplete ? 'FREE COFFEE ☕' : `${needed - stamps} more`,
        },
      ],
      backFields: [
        {
          label: 'How to redeem',
          value: `Show this pass at ${s.cafe_name}. One free coffee when you reach ${needed} stamps.`,
        },
        { label: 'Member ID', value: customer.id },
        {
          // Notification anchor — value must change on every update to fire a push.
          // We include a timestamp so it's always unique, even if stamps didn't change.
          label:         'Last update',
          value:         isComplete
            ? `🎉 Free coffee ready! ${Date.now()}-${Math.random().toString(36).slice(2,6)}`
            : `${stamps}/${needed} · ${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          changeMessage: isComplete
            ? `🎉 Free coffee earned at ${s.cafe_name}!`
            : `${s.cafe_name}: stamp added — ${stamps} of ${needed}`,
        },
      ],
      // Pro features — cream background, visual strip, logo
      color:            '#f5ede0',
      expirationDays:   365,
      sharingProhibited:true,
      stripURL:         stripDataUri,
      logoURL:          logoDataUri,
    };
  }

  async function wwPost(path, body, method = 'POST') {
    const r = await fetch(`https://api.walletwallet.dev${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${WALLETWALLET_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (method === 'POST' && path === '/api/pkpass') {
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `walletwallet ${r.status}`);
      }
      const serial = r.headers.get('X-Serial-Number');
      const buffer = await r.arrayBuffer();
      return { serial, buffer };
    }

    const text = await r.text();
    if (!r.ok) throw new Error(text || `walletwallet ${r.status}`);
    return text ? JSON.parse(text) : null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ════════════════════════════════════════════════════════════════════

  try {


    // ── SAVE SETTINGS (setup page — PIN protected) ──────────────
    if (action === 'save-settings') {
      const { pin, cafeName, accent, stamp, mode } = payload || {};
      if (!cafeName)         return res.status(400).json({ error: 'cafeName required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      // true upsert — insert or update in a single Supabase call
      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/cafe_settings`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          id:         1,
          cafe_name:  cafeName.trim(),
          accent:     accent || '#c94f2b',
          stamp:      stamp  || '☕',
          mode:       mode   || 'dark',
          updated_at: new Date().toISOString(),
        }),
      });
      if (!upsertRes.ok) {
        const t = await upsertRes.text();
        throw new Error(t || `supabase upsert ${upsertRes.status}`);
      }

      return res.status(200).json({ success: true });
    }

    // ── TEST UPDATE (temporary — tests WalletWallet PUT directly) ────
    if (action === 'test-update') {
      const { customerId } = payload || {};
      if (!customerId) return res.status(400).json({ error: 'customerId required' });

      const customer = await getCustomer(customerId);
      if (!customer)  return res.status(404).json({ error: 'customer not found' });

      const s = await getSettings();
      const cafeSettings = {
        cafe_name: s?.cafe_name || customer.cafe_name,
        accent:    s?.accent    || customer.accent,
        stamp:     s?.stamp     || '☕',
      };

      const passBody = buildPassBody(customer, cafeSettings, customer.stamps || 0);

      // Log what we're sending
      console.log('[test-update] serial:', customer.serial_number);
      console.log('[test-update] barcodeValue:', passBody.barcodeValue);
      console.log('[test-update] stripURL:', passBody.stripURL);

      const r = await fetch(`https://api.walletwallet.dev/api/pkpass/${customer.serial_number}`, {
        method: 'PUT',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${WALLETWALLET_KEY}`,
        },
        body: JSON.stringify(passBody),
      });

      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }

      return res.status(200).json({
        ww_status:    r.status,
        ww_ok:        r.ok,
        ww_response:  json,
        serial:       customer.serial_number,
        stamps:       customer.stamps,
        barcodeValue: passBody.barcodeValue,
        stripURL:     passBody.stripURL || null,
        logoURL:      passBody.logoURL  || null,
      });
    }

    // ── DEBUG (temporary — remove after confirming SITE_URL works) ───
    if (action === 'debug') {
      return res.status(200).json({
        SITE_URL:      SITE_URL || '(not set)',
        STAMPS_NEEDED: STAMPS_NEEDED,
        has_supabase:  !!SUPABASE_URL,
        has_ww:        !!WALLETWALLET_KEY,
        has_pin:       !!STAFF_PIN,
      });
    }

    // ── VERIFY PIN (staff gate — lightweight PIN check) ────────────
    if (action === 'verify-pin') {
      const { pin } = payload || {};
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });
      return res.status(200).json({ success: true });
    }

    // ── GET SETTINGS (public — signup + staff pages on load) ────────
    if (action === 'get-settings') {
      const s = await getSettings();
      if (!s) return res.status(404).json({ error: 'not configured yet' });

      // safe to return — no secrets in this table
      return res.status(200).json({
        cafeName: s.cafe_name,
        accent:   s.accent,
        stamp:    s.stamp,
        mode:     s.mode,
      });
    }

    // ── CREATE PASS (customer sign-up) ──────────────────────────────
    if (action === 'create-pass') {
      const { id, name, email } = payload || {};
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });

      // load settings from DB — source of truth
      const s = await getSettings();
      if (!s) return res.status(400).json({ error: 'cafe not configured yet' });

      const cafeSettings = { cafe_name: s.cafe_name, accent: s.accent, stamp: s.stamp };
      const passBody     = buildPassBody({ id, name }, cafeSettings, 0);
      const { serial, buffer } = await wwPost('/api/pkpass', passBody);

      await createCustomerRow({
        id,
        name,
        email:         email || null,
        serial_number: serial,
        stamps:        0,
        accent:        s.accent,
        cafe_name:     s.cafe_name,
        mode:          s.mode,
      });

      res.setHeader('Content-Type',        'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'attachment; filename="loyalty-card.pkpass"');
      res.setHeader('X-Serial-Number',     serial);
      return res.send(Buffer.from(buffer));
    }

    // ── ADD STAMP ───────────────────────────────────────────────────
    if (action === 'add-stamp') {
      const { customerId, pin } = payload || {};
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });

      if ((customer.stamps || 0) >= STAMPS_NEEDED) {
        return res.status(400).json({ error: 'already at max stamps — redeem first' });
      }

      const s         = await getSettings();
      const newStamps = (customer.stamps || 0) + 1;
      const cafeSettings = {
        cafe_name: s?.cafe_name || customer.cafe_name,
        accent:    s?.accent    || customer.accent,
        stamp:     s?.stamp     || '☕',
      };

      await wwPost(
        `/api/pkpass/${customer.serial_number}`,
        buildPassBody(customer, cafeSettings, newStamps),
        'PUT',
      );

      await updateCustomerRow(customerId, {
        stamps:   newStamps,
        redeemed: false,
      });

      return res.status(200).json({
        success:   true,
        stamps:    newStamps,
        needed:    STAMPS_NEEDED,
        completed: newStamps >= STAMPS_NEEDED,
      });
    }

    // ── REDEEM ──────────────────────────────────────────────────────
    if (action === 'redeem') {
      const { customerId, pin } = payload || {};
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });

      if ((customer.stamps || 0) < STAMPS_NEEDED) {
        return res.status(400).json({ error: 'not enough stamps to redeem' });
      }

      const s = await getSettings();
      const cafeSettings = {
        cafe_name: s?.cafe_name || customer.cafe_name,
        accent:    s?.accent    || customer.accent,
        stamp:     s?.stamp     || '☕',
      };

      await wwPost(
        `/api/pkpass/${customer.serial_number}`,
        buildPassBody(customer, cafeSettings, 0),
        'PUT',
      );

      await updateCustomerRow(customerId, {
        stamps:          0,
        redeemed:        true,
        last_stamp_date: null,
      });

      return res.status(200).json({ success: true, stamps: 0 });
    }

    // ── GET CUSTOMER (staff lookup — PIN protected) ─────────────────
    if (action === 'get-customer') {
      const { customerId, pin } = payload || {};
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });

      return res.status(200).json({
        id:              customer.id,
        name:            customer.name,
        stamps:          customer.stamps,
        redeemed:        customer.redeemed,
        last_stamp_date: customer.last_stamp_date,
        created_at:      customer.created_at,
        cafe_name:       customer.cafe_name,
      });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });

  } catch (err) {
    console.error('[lucky-cup api]', err);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
}
