// api/image.js
// Generates SVG images for the wallet pass on the fly.
// Used by api/action.js to build stripURL, logoURL, iconURL.
//
// Endpoints (via query params):
//   ?type=strip&stamps=4&needed=10&accent=%23c94f2b&name=My+Cafe&stamp=☕
//   ?type=logo&name=My+Cafe&accent=%23c94f2b
//   ?type=icon&accent=%23c94f2b

export default function handler(req, res) {
  const { type, stamps, needed, accent, name, stamp } = req.query;

  const accentColor  = decodeURIComponent(accent  || '#c94f2b');
  const cafeName     = decodeURIComponent(name    || 'Cafe');
  const stampIcon    = decodeURIComponent(stamp   || '●');
  const stampsNum    = parseInt(stamps  || '0');
  const neededNum    = parseInt(needed  || '10');

  // Derive readable text colour from accent (dark or light)
  const textOnAccent = getLuminance(accentColor) > 0.35 ? '#1a1a1a' : '#ffffff';

  let svg;

  // ── STRIP IMAGE ──────────────────────────────────────────────────
  // 1024×336px — WalletWallet recommended strip size
  // Cream background, accent dots for filled stamps
  if (type === 'strip') {
    const W = 1024;
    const H = 336;

    const dotRadius   = 22;
    const dotSpacing  = 62;
    const totalWidth  = neededNum * dotSpacing - (dotSpacing - dotRadius * 2);
    const startX      = (W - totalWidth) / 2 + dotRadius;
    const dotY        = H / 2 + 20;

    let dots = '';
    for (let i = 0; i < neededNum; i++) {
      const cx      = startX + i * dotSpacing;
      const filled  = i < stampsNum;
      const opacity = filled ? '1' : '0.18';
      dots += `
        <circle
          cx="${cx}" cy="${dotY}" r="${dotRadius}"
          fill="${filled ? accentColor : accentColor}"
          opacity="${opacity}"
        />`;
      if (filled) {
        // inner tick / stamp icon (Unicode rendered as text)
        dots += `
        <text
          x="${cx}" y="${dotY + 1}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="20" font-family="system-ui, -apple-system, sans-serif"
          fill="${textOnAccent}" opacity="0.9"
        >${stampIcon === '●' ? '' : stampIcon}</text>`;
      }
    }

    // stamp count label
    const remaining  = neededNum - stampsNum;
    const statusText = stampsNum >= neededNum
      ? '🎉 free coffee earned!'
      : `${stampsNum} of ${neededNum} stamps${remaining === 1 ? ' — one more to go!' : ''}`;

    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- cream background -->
  <rect width="${W}" height="${H}" fill="#f5ede0"/>

  <!-- subtle grid texture -->
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="${accentColor}" stroke-width="0.4" opacity="0.15"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>

  <!-- accent top bar -->
  <rect width="${W}" height="6" fill="${accentColor}"/>

  <!-- cafe name -->
  <text
    x="${W / 2}" y="68"
    text-anchor="middle"
    font-size="28" font-weight="600" letter-spacing="6"
    font-family="system-ui, -apple-system, sans-serif"
    fill="${accentColor}" opacity="0.9"
  >${cafeName.toUpperCase()}</text>

  <!-- stamp dots -->
  ${dots}

  <!-- status text -->
  <text
    x="${W / 2}" y="${H - 36}"
    text-anchor="middle"
    font-size="22" letter-spacing="2"
    font-family="system-ui, -apple-system, sans-serif"
    fill="#8a7055" opacity="0.8"
  >${statusText}</text>
</svg>`;
  }

  // ── LOGO IMAGE ───────────────────────────────────────────────────
  // 480×150px — initials + cafe name on accent background
  else if (type === 'logo') {
    const W = 480;
    const H = 150;
    const initials = cafeName
      .split(' ')
      .map(w => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${accentColor}" rx="12"/>
  <!-- initials badge -->
  <rect x="20" y="25" width="100" height="100" rx="10" fill="${textOnAccent}" opacity="0.15"/>
  <text
    x="70" y="85"
    text-anchor="middle" dominant-baseline="middle"
    font-size="44" font-weight="700"
    font-family="system-ui, -apple-system, sans-serif"
    fill="${textOnAccent}"
  >${initials}</text>
  <!-- cafe name -->
  <text
    x="138" y="62"
    font-size="26" font-weight="600" letter-spacing="1"
    font-family="system-ui, -apple-system, sans-serif"
    fill="${textOnAccent}"
  >${cafeName}</text>
  <text
    x="138" y="96"
    font-size="18" letter-spacing="4"
    font-family="system-ui, -apple-system, sans-serif"
    fill="${textOnAccent}" opacity="0.65"
  >LOYALTY</text>
</svg>`;
  }

  // ── ICON IMAGE ───────────────────────────────────────────────────
  // 87×87px — used for lock-screen notification icon
  else if (type === 'icon') {
    const initials = cafeName
      .split(' ')
      .map(w => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="87" height="87" viewBox="0 0 87 87">
  <rect width="87" height="87" fill="${accentColor}" rx="20"/>
  <text
    x="43.5" y="43.5"
    text-anchor="middle" dominant-baseline="middle"
    font-size="36" font-weight="700"
    font-family="system-ui, -apple-system, sans-serif"
    fill="${textOnAccent}"
  >${initials}</text>
</svg>`;
  }

  else {
    return res.status(400).send('type must be strip, logo, or icon');
  }

  // Return SVG — WalletWallet accepts SVG data URIs but we serve it
  // as a URL so it must be publicly accessible and return image/svg+xml
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).send(svg);
}

// ── HELPERS ────────────────────────────────────────────────────────
function getLuminance(hex) {
  // Returns relative luminance 0-1 for a hex colour
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return 0;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
