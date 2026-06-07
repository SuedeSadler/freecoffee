// ═══════════════════════════════════════════════════
//  LUCKY CUP — CLIENT CONFIG
//  Safe to expose — no secrets here.
//  All sensitive operations go through /api/action
// ═══════════════════════════════════════════════════

const CONFIG = {
  API_URL:       '/api/action',   // Vercel serverless function
  STAMPS_NEEDED: 10,
};

// ── API helper ──────────────────────────────────────
async function apiCall(action, payload = {}) {
  const res = await fetch(CONFIG.API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, payload }),
  });

  // create-pass returns a binary .pkpass, not JSON
  if (action === 'create-pass') {
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    const serial = res.headers.get('X-Serial-Number');
    const blob   = await res.blob();
    return { blob, serial };
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Unique ID generator ─────────────────────────────
function genId() {
  return 'CUST-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Download blob ───────────────────────────────────
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
