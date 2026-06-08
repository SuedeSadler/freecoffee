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
    const filled     = (s.stamp || '☕').repeat(stamps);
    const empty      = '·'.repeat(Math.max(0, needed - stamps));
    const stampStr   = filled + empty;
    const isComplete = stamps >= needed;

    return {
      barcodeValue:     customer.id,
      barcodeFormat:    'QR',
      logoText:         s.cafe_name,
      organizationName: s.cafe_name,
      description:      'Loyalty card',
      primaryFields: [{
        label: 'STAMPS',
        value: stampStr,
        changeMessage: isComplete
          ? `🎉 Free coffee earned at ${s.cafe_name}!`
          : `Stamp added — ${stamps} of ${needed}`,
      }],
      secondaryFields: [
        { label: 'MEMBER', value: customer.name },
        {
          label: isComplete ? 'REWARD' : 'TO GO',
          value: isComplete ? 'FREE COFFEE' : `${needed - stamps} more`,
        },
      ],
      backFields: [
        {
          label: 'How to redeem',
          value: `Show this pass at ${s.cafe_name}. One free coffee when you reach ${needed} stamps.`,
        },
        { label: 'Member ID', value: customer.id },
        {
          label:         'Notifications',
          value:         isComplete
            ? `🎉 You've earned a free coffee at ${s.cafe_name}!`
            : `${s.cafe_name}: ${stamps} of ${needed} stamps.`,
          changeMessage: '%@',
        },
      ],
      colorPreset:       'dark',
      expirationDays:    365,
      sharingProhibited: true,
      ...(s.accent ? { color: s.accent } : {}),
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

      const today = new Date().toISOString().slice(0, 10);
      if (customer.last_stamp_date === today) {
        return res.status(429).json({ error: 'already stamped today' });
      }
      if ((customer.stamps || 0) >= STAMPS_NEEDED) {
        return res.status(400).json({ error: 'already at max stamps — redeem first' });
      }

      const s          = await getSettings();
      const newStamps  = (customer.stamps || 0) + 1;
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
        stamps:          newStamps,
        last_stamp_date: today,
        redeemed:        false,
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
