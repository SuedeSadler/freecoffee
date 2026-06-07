// ═══════════════════════════════════════════════
//  LUCKY CUP — CONFIG
//  Fill these in after setting up Supabase
// ═══════════════════════════════════════════════

const CONFIG = {
  SUPABASE_URL:  'https://YOUR_PROJECT.supabase.co',
  SUPABASE_KEY:  'YOUR_ANON_KEY',
  WALLETWALLET_KEY: 'ww_live_891098a7b7ab704f915b501a7b886005',
  STAFF_PIN:     '1234',          // change this
  STAMPS_NEEDED: 10,
};

// ── Supabase helpers ─────────────────────────────
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey':        CONFIG.SUPABASE_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        opts.prefer || '',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getCustomer(id) {
  const rows = await sbFetch(`customers?id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows?.[0] || null;
}

async function createCustomer(data) {
  return sbFetch('customers', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify(data),
  });
}

async function updateCustomer(id, data) {
  return sbFetch(`customers?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: JSON.stringify(data),
  });
}

// ── WalletWallet helpers ─────────────────────────
async function createPass(customer, cafeSettings) {
  const stamps     = customer.stamps || 0;
  const needed     = CONFIG.STAMPS_NEEDED;
  const filled     = '✦'.repeat(stamps);
  const empty      = '·'.repeat(needed - stamps);
  const stampStr   = filled + empty;
  const isComplete = stamps >= needed;

  const body = {
    barcodeValue:    customer.id,
    barcodeFormat:   'QR',
    logoText:        cafeSettings.cafe_name,
    organizationName:cafeSettings.cafe_name,
    description:     'Loyalty card',
    primaryFields: [{
      label: 'STAMPS',
      value: stampStr,
      changeMessage: `Stamp added — you now have %@ of ${needed}`,
    }],
    secondaryFields: [
      { label: 'MEMBER',  value: customer.name },
      { label: isComplete ? 'REWARD' : 'TO GO',
        value: isComplete ? 'FREE COFFEE' : `${needed - stamps} more` },
    ],
    backFields: [
      { label: 'How to redeem', value: `Show this pass at ${cafeSettings.cafe_name}. One free coffee when you reach ${needed} stamps.` },
      { label: 'Member ID', value: customer.id },
      { label: 'Notifications', value: ' ', changeMessage: '%@' },
    ],
    colorPreset:      'dark',
    expirationDays:   365,
    sharingProhibited:true,
  };

  // add custom colour if Pro
  if (cafeSettings.accent) body.color = cafeSettings.accent;

  const res = await fetch('https://api.walletwallet.dev/api/pkpass', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${CONFIG.WALLETWALLET_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }

  const serial = res.headers.get('X-Serial-Number');
  const blob   = await res.blob();
  return { blob, serial };
}

async function updatePass(serialNumber, customer, cafeSettings) {
  const stamps     = customer.stamps || 0;
  const needed     = CONFIG.STAMPS_NEEDED;
  const filled     = '✦'.repeat(stamps);
  const empty      = '·'.repeat(needed - stamps);
  const stampStr   = filled + empty;
  const isComplete = stamps >= needed;

  const body = {
    barcodeValue:  customer.id,
    barcodeFormat: 'QR',
    logoText:      cafeSettings.cafe_name,
    primaryFields: [{
      label: 'STAMPS',
      value: stampStr,
      changeMessage: isComplete
        ? `🎉 You've earned a free coffee!`
        : `Stamp added — you now have %@ of ${needed}`,
    }],
    secondaryFields: [
      { label: 'MEMBER',  value: customer.name },
      { label: isComplete ? 'REWARD' : 'TO GO',
        value: isComplete ? 'FREE COFFEE' : `${needed - stamps} more` },
    ],
    backFields: [
      { label: 'How to redeem', value: `Show this pass at ${cafeSettings.cafe_name}.` },
      { label: 'Member ID', value: customer.id },
      {
        label: 'Notifications',
        value: isComplete
          ? `🎉 You've earned a free coffee at ${cafeSettings.cafe_name}!`
          : `${cafeSettings.cafe_name}: stamp added, ${needed - stamps} to go.`,
        changeMessage: '%@',
      },
    ],
    colorPreset: 'dark',
    sharingProhibited: true,
  };

  if (cafeSettings.accent) body.color = cafeSettings.accent;

  const res = await fetch(`https://api.walletwallet.dev/api/pkpass/${serialNumber}`, {
    method: 'PUT',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${CONFIG.WALLETWALLET_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Unique ID generator ──────────────────────────
function genId() {
  return 'CUST-' + Math.random().toString(36).slice(2,8).toUpperCase();
}

// ── Download blob as file ────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
