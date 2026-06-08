// api/action.js — Lucky Cup serverless function
// All secrets live here. Browser never sees them.

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method not allowed' });

  // ── PARSE BODY ────────────────────────────────────────────────────────
  let action, payload;
  try {
    const raw = await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end',  () => resolve(d));
      req.on('error', reject);
    });
    const body = JSON.parse(raw || '{}');
    action  = body.action;
    payload = body.payload || {};
  } catch (e) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (!action) return res.status(400).json({ error: 'action required' });

  // ── SECRETS ───────────────────────────────────────────────────────────
  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_KEY     = process.env.SUPABASE_KEY;
  const WALLETWALLET_KEY = process.env.WALLETWALLET_KEY;
  const STAFF_PIN        = process.env.STAFF_PIN;
  const STAMPS_NEEDED    = parseInt(process.env.STAMPS_NEEDED || '10');
  const SITE_URL         = (process.env.SITE_URL || '').replace(/\/$/, '');

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

  // ── IMAGE URL HELPER ──────────────────────────────────────────────────
  function imageUrl(type, params = {}) {
    if (!SITE_URL) return null;
    const qs = new URLSearchParams({ type, ...params }).toString();
    return `${SITE_URL}/api/image?${qs}`;
  }

  // ── WALLETWALLET HELPERS ──────────────────────────────────────────────
  function buildPassBody(customer, s, stamps) {
    const needed     = STAMPS_NEEDED;
    const isComplete = stamps >= needed;
    const accent     = s.accent || '#c94f2b';
    const bust       = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    const stripUrl = imageUrl('strip', {
      stamps, needed, accent, name: s.cafe_name, v: bust,
    });
    const logoUrl = imageUrl('logo', { accent, name: s.cafe_name });

    return {
      barcodeValue:     SITE_URL ? `${SITE_URL}/staff.html?id=${customer.id}` : customer.id,
      barcodeFormat:    'QR',
      logoText:         s.cafe_name,
      organizationName: s.cafe_name,
      description:      'Loyalty card',
      // headerFields: top-right corner — always visible, never overlaps strip
      headerFields: [{
        label: 'MEMBER',
        value: customer.name,
      }],
      // primaryFields: sits ON TOP of strip image — keep empty/minimal
      // so it doesn't overlay the stamps. A zero-width space keeps
      // Apple happy (requires at least one primary field with a value).
      primaryFields: [{
        label: ' ',
        value: ' ',
      }],
      // secondaryFields: rendered BELOW the strip — stamp count + reward
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
          label:         'Last update',
          value:         isComplete
            ? `🎉 Free coffee ready! ${Date.now()}-${Math.random().toString(36).slice(2,6)}`
            : `${stamps}/${needed} · ${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          changeMessage: isComplete
            ? `🎉 Free coffee earned at ${s.cafe_name}!`
            : `${s.cafe_name}: stamp added — ${stamps} of ${needed}`,
        },
      ],
      color:            '#f5ede0',
      expirationDays:   365,
      sharingProhibited:true,
      ...(stripUrl ? { stripURL: stripUrl } : {}),
      ...(logoUrl  ? { logoURL:  logoUrl  } : {}),
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

  // ════════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ════════════════════════════════════════════════════════════════════════

  try {

    // ── DEBUG ──────────────────────────────────────────────────────────
    if (action === 'debug') {
      return res.status(200).json({
        SITE_URL:     SITE_URL || '(not set)',
        STAMPS_NEEDED,
        has_supabase: !!SUPABASE_URL,
        has_ww:       !!WALLETWALLET_KEY,
        has_pin:      !!STAFF_PIN,
      });
    }

    // ── TEST UPDATE ────────────────────────────────────────────────────
    if (action === 'test-update') {
      const { customerId } = payload;
      if (!customerId) return res.status(400).json({ error: 'customerId required' });
      const customer = await getCustomer(customerId);
      if (!customer)  return res.status(404).json({ error: 'customer not found' });
      const s = await getSettings();
      const passBody = buildPassBody(customer, s, customer.stamps || 0);
      const r = await fetch(`https://api.walletwallet.dev/api/pkpass/${customer.serial_number}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WALLETWALLET_KEY}` },
        body: JSON.stringify(passBody),
      });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return res.status(200).json({ ww_status: r.status, ww_ok: r.ok, ww_response: json, serial: customer.serial_number, stamps: customer.stamps, stripURL: passBody.stripURL || null });
    }

    // ── VERIFY PIN ─────────────────────────────────────────────────────
    if (action === 'verify-pin') {
      const { pin } = payload;
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });
      return res.status(200).json({ success: true });
    }

    // ── SAVE SETTINGS ──────────────────────────────────────────────────
    if (action === 'save-settings') {
      const { pin, cafeName, accent, stamp, mode } = payload;
      if (!cafeName)         return res.status(400).json({ error: 'cafeName required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const r = await fetch(`${SUPABASE_URL}/rest/v1/cafe_settings`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          id: 1, cafe_name: cafeName.trim(), accent: accent || '#c94f2b',
          stamp: stamp || '☕', mode: mode || 'dark', updated_at: new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(await r.text() || `supabase ${r.status}`);
      return res.status(200).json({ success: true });
    }

    // ── GET SETTINGS ───────────────────────────────────────────────────
    if (action === 'get-settings') {
      const s = await getSettings();
      if (!s) return res.status(404).json({ error: 'not configured yet' });
      return res.status(200).json({ cafeName: s.cafe_name, accent: s.accent, stamp: s.stamp, mode: s.mode });
    }

    // ── CREATE PASS ────────────────────────────────────────────────────
    if (action === 'create-pass') {
      const { id, name, email } = payload;
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });

      const s = await getSettings();
      if (!s) return res.status(400).json({ error: 'cafe not configured yet' });

      const passBody        = buildPassBody({ id, name }, s, 0);
      const { serial, buffer } = await wwPost('/api/pkpass', passBody);

      await createCustomerRow({
        id, name, email: email || null,
        serial_number: serial, stamps: 0,
        accent: s.accent, cafe_name: s.cafe_name, mode: s.mode,
      });

      res.setHeader('Content-Type',        'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'attachment; filename="loyalty-card.pkpass"');
      res.setHeader('X-Serial-Number',     serial);
      return res.send(Buffer.from(buffer));
    }

    // ── ADD STAMP ──────────────────────────────────────────────────────
    if (action === 'add-stamp') {
      const { customerId, pin } = payload;
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });
      if ((customer.stamps || 0) >= STAMPS_NEEDED)
        return res.status(400).json({ error: 'already at max stamps — redeem first' });

      const s         = await getSettings();
      const newStamps = (customer.stamps || 0) + 1;
      const cafeSettings = {
        cafe_name: s?.cafe_name || customer.cafe_name,
        accent:    s?.accent    || customer.accent,
        stamp:     s?.stamp     || '☕',
      };

      await wwPost(`/api/pkpass/${customer.serial_number}`, buildPassBody(customer, cafeSettings, newStamps), 'PUT');
      await updateCustomerRow(customerId, { stamps: newStamps, redeemed: false });

      return res.status(200).json({
        success: true, stamps: newStamps, needed: STAMPS_NEEDED,
        completed: newStamps >= STAMPS_NEEDED,
      });
    }

    // ── REDEEM ─────────────────────────────────────────────────────────
    if (action === 'redeem') {
      const { customerId, pin } = payload;
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });
      if ((customer.stamps || 0) < STAMPS_NEEDED)
        return res.status(400).json({ error: 'not enough stamps to redeem' });

      const s = await getSettings();
      const cafeSettings = { cafe_name: s?.cafe_name || customer.cafe_name, accent: s?.accent || customer.accent, stamp: s?.stamp || '☕' };

      await wwPost(`/api/pkpass/${customer.serial_number}`, buildPassBody(customer, cafeSettings, 0), 'PUT');
      await updateCustomerRow(customerId, { stamps: 0, redeemed: true, last_stamp_date: null });

      return res.status(200).json({ success: true, stamps: 0 });
    }

    // ── GET CUSTOMER ───────────────────────────────────────────────────
    if (action === 'get-customer') {
      const { customerId, pin } = payload;
      if (!customerId)       return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN) return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)         return res.status(404).json({ error: 'customer not found' });

      return res.status(200).json({
        id:         customer.id,
        name:       customer.name,
        stamps:     customer.stamps,
        redeemed:   customer.redeemed,
        created_at: customer.created_at,
        cafe_name:  customer.cafe_name,
      });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });

  } catch (err) {
    console.error('[lucky-cup api]', err.message);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
}
