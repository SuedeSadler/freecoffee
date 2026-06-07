// api/action.js
// Vercel serverless function — all secrets live here, never in the browser
// Handles: create-pass, add-stamp, redeem

export default async function handler(req, res) {

  // ── CORS ───────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method not allowed' });

  // ── SECRETS (from Vercel env vars — never sent to browser) ─────────
  const SUPABASE_URL       = process.env.SUPABASE_URL;
  const SUPABASE_KEY       = process.env.SUPABASE_KEY;         // service role key (not anon)
  const WALLETWALLET_KEY   = process.env.WALLETWALLET_KEY;
  const STAFF_PIN          = process.env.STAFF_PIN;
  const STAMPS_NEEDED      = parseInt(process.env.STAMPS_NEEDED || '10');

  const { action, payload } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });

  // ── SUPABASE HELPERS ───────────────────────────────────────────────
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
      body: JSON.stringify(data),
    });
  }

  async function updateCustomerRow(id, data) {
    return sbFetch(`customers?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: JSON.stringify(data),
    });
  }

  // ── WALLETWALLET HELPERS ───────────────────────────────────────────
  function buildPassBody(customer, cafeSettings, stamps) {
    const needed    = STAMPS_NEEDED;
    const filled    = (cafeSettings.stamp || '☕').repeat(stamps);
    const empty     = '·'.repeat(Math.max(0, needed - stamps));
    const stampStr  = filled + empty;
    const isComplete = stamps >= needed;

    return {
      barcodeValue:     customer.id,
      barcodeFormat:    'QR',
      logoText:         cafeSettings.cafe_name,
      organizationName: cafeSettings.cafe_name,
      description:      'Loyalty card',
      primaryFields: [{
        label: 'STAMPS',
        value: stampStr,
        changeMessage: isComplete
          ? `🎉 Free coffee earned at ${cafeSettings.cafe_name}!`
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
          value: `Show this pass at ${cafeSettings.cafe_name}. One free coffee when you reach ${needed} stamps.`,
        },
        { label: 'Member ID', value: customer.id },
        {
          label:         'Notifications',
          value:         isComplete
            ? `🎉 You've earned a free coffee at ${cafeSettings.cafe_name}!`
            : `${cafeSettings.cafe_name}: ${stamps} of ${needed} stamps.`,
          changeMessage: '%@',
        },
      ],
      colorPreset:       'dark',
      expirationDays:    365,
      sharingProhibited: true,
      ...(cafeSettings.accent ? { color: cafeSettings.accent } : {}),
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
      // returns binary .pkpass
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

  // ══════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ══════════════════════════════════════════════════════════════════

  try {

    // ── CREATE PASS (customer sign-up) ────────────────────────────
    if (action === 'create-pass') {
      const { id, name, email, cafeName, accent, stamp, mode } = payload || {};
      if (!id || !name || !cafeName) return res.status(400).json({ error: 'id, name, cafeName required' });

      const cafeSettings = { cafe_name: cafeName, accent, stamp };
      const passBody     = buildPassBody({ id, name }, cafeSettings, 0);

      const { serial, buffer } = await wwPost('/api/pkpass', passBody);

      // save customer to supabase
      await createCustomerRow({
        id,
        name,
        email: email || null,
        serial_number: serial,
        stamps: 0,
        accent: accent || null,
        cafe_name: cafeName,
        mode: mode || 'dark',
      });

      // stream the .pkpass back to the browser
      res.setHeader('Content-Type',        'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'attachment; filename="loyalty-card.pkpass"');
      res.setHeader('X-Serial-Number',     serial);
      return res.send(Buffer.from(buffer));
    }

    // ── ADD STAMP ─────────────────────────────────────────────────
    if (action === 'add-stamp') {
      const { customerId, pin, cafeName, accent, stamp } = payload || {};
      if (!customerId)         return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN)   return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)           return res.status(404).json({ error: 'customer not found' });

      // daily limit check
      const today = new Date().toISOString().slice(0, 10);
      if (customer.last_stamp_date === today) {
        return res.status(429).json({ error: 'already stamped today' });
      }

      // already at max?
      if ((customer.stamps || 0) >= STAMPS_NEEDED) {
        return res.status(400).json({ error: 'already at max stamps — redeem first' });
      }

      const newStamps    = (customer.stamps || 0) + 1;
      const cafeSettings = {
        cafe_name: cafeName || customer.cafe_name,
        accent:    accent   || customer.accent,
        stamp:     stamp    || '☕',
      };

      // update pass
      await wwPost(
        `/api/pkpass/${customer.serial_number}`,
        buildPassBody(customer, cafeSettings, newStamps),
        'PUT',
      );

      // update DB
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

    // ── REDEEM ───────────────────────────────────────────────────
    if (action === 'redeem') {
      const { customerId, pin, cafeName, accent, stamp } = payload || {};
      if (!customerId)         return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN)   return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)           return res.status(404).json({ error: 'customer not found' });

      if ((customer.stamps || 0) < STAMPS_NEEDED) {
        return res.status(400).json({ error: 'not enough stamps to redeem' });
      }

      const cafeSettings = {
        cafe_name: cafeName || customer.cafe_name,
        accent:    accent   || customer.accent,
        stamp:     stamp    || '☕',
      };

      // reset pass to 0
      await wwPost(
        `/api/pkpass/${customer.serial_number}`,
        buildPassBody(customer, cafeSettings, 0),
        'PUT',
      );

      // reset DB
      await updateCustomerRow(customerId, {
        stamps:          0,
        redeemed:        true,
        last_stamp_date: null,
      });

      return res.status(200).json({ success: true, stamps: 0 });
    }

    // ── GET CUSTOMER (staff lookup) ───────────────────────────────
    if (action === 'get-customer') {
      const { customerId, pin } = payload || {};
      if (!customerId)        return res.status(400).json({ error: 'customerId required' });
      if (pin !== STAFF_PIN)  return res.status(403).json({ error: 'incorrect pin' });

      const customer = await getCustomer(customerId);
      if (!customer)          return res.status(404).json({ error: 'customer not found' });

      // only return safe fields — never expose serial_number to browser
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
