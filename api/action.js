// api/action.js — Lucky Cup serverless function
// All secrets live here. Browser never sees them.
import zlib from 'zlib';

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

  // ── INLINE PNG GENERATOR ─────────────────────────────────────────────
  // Generates strip + logo as base64 data URIs directly — no external
  // URL fetch needed. WalletWallet gets image bytes inline, always works.

  const _zlib = zlib;

  const _CRC = (() => {
    const t=new Uint32Array(256);
    for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;t[i]=c;}
    return t;
  })();

  function _crc(buf){let c=0xFFFFFFFF;for(const b of buf)c=_CRC[(c^b)&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}

  function _png(W,H,gp){
    const rowLen=1+W*4,raw=Buffer.alloc(H*rowLen);
    for(let y=0;y<H;y++){
      raw[y*rowLen]=0;
      for(let x=0;x<W;x++){
        const[r,g,b,a]=gp(x,y),o=y*rowLen+1+x*4;
        raw[o]=r;raw[o+1]=g;raw[o+2]=b;raw[o+3]=a;
      }
    }
    const cmp=_zlib.deflateSync(raw,{level:6});
    function ck(type,data){
      const tb=Buffer.from(type,'ascii'),cb=Buffer.concat([tb,data]);
      const lb=Buffer.alloc(4);lb.writeUInt32BE(data.length);
      const rb=Buffer.alloc(4);rb.writeUInt32BE(_crc(cb));
      return Buffer.concat([lb,tb,data,rb]);
    }
    const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;
    return 'data:image/png;base64,'+Buffer.concat([
      Buffer.from([137,80,78,71,13,10,26,10]),ck('IHDR',ih),ck('IDAT',cmp),ck('IEND',Buffer.alloc(0))
    ]).toString('base64');
  }

  function _rgb(hex){const c=hex.replace('#','');return[parseInt(c.slice(0,2),16),parseInt(c.slice(2,4),16),parseInt(c.slice(4,6),16)];}

  function _cup(lx,ly,S){
    const s=S/44,x=lx/s,y=ly/s;
    const rD=((x-22)/11)**2+((y-16)/3.5)**2;
    const sD=((x-22)/14)**2+((y-34)/3)**2;
    const hD=((x-35)/5)**2+((y-25)/6)**2;
    const hI=((x-35)/3)**2+((y-25)/4)**2;
    return rD<=1.0||(y>=16&&y<=32&&x>=(11-(y-16)*0.06)&&x<=(33+(y-16)*0.06))||(hD<=1.0&&x>=35&&hI>1.0)||sD<=1.0;
  }

  function makeStripDataUri(stamps,needed,accentHex,versionN){
    const W=1125,H=369,[ar,ag,ab]=_rgb(accentHex),bg=[26,26,26];
    const ruleY=H-10,vB=(versionN%200)+28;
    const isComplete=stamps>=needed;

    // ── FREE COFFEE state — large centered cup with celebration ring ──
    if(isComplete){
      const cx=W/2,cy=(H-10)/2;
      const bigS=180,bigR=90;
      function inRing(px,py){const d=Math.sqrt((px-cx)**2+(py-cy)**2);return d>=bigR+12&&d<=bigR+28;}
      function inDot(px,py){
        for(let i=0;i<8;i++){
          const a=i*Math.PI/4,sx=cx+Math.cos(a)*(bigR+48),sy=cy+Math.sin(a)*(bigR+48);
          if((px-sx)**2+(py-sy)**2<=36)return true;
        }
        return false;
      }
      return _png(W,H,(px,py)=>{
        if(px<3&&py<3)return[bg[0],bg[1],vB,255];
        if(py>=ruleY)return[ar,ag,ab,180];
        const dx=px-cx,dy=py-cy,d2=dx*dx+dy*dy;
        if(d2<=bigR*bigR){if(_cup(dx+bigR,dy+bigR,bigS))return[...bg,255];return[ar,ag,ab,255];}
        if(inRing(px,py))return[ar,ag,ab,160];
        if(inDot(px,py))return[ar,ag,ab,200];
        return[...bg,255];
      });
    }

    // ── NORMAL state — 2 rows of 5 stamp cups ────────────────────────
    const cols=5,rows=2,padX=80,padTop=24,padBot=20;
    const gapX=Math.floor((W-padX*2)/cols),gapY=Math.floor((H-padTop-padBot)/rows);
    const R=Math.floor(Math.min(gapX,gapY)*0.44),S=R*2;
    const startX=padX+Math.floor(gapX/2),startY=padTop+Math.floor(gapY/2);
    function gs(px,py,i){
      const row=Math.floor(i/cols),col=i%cols;
      const cx=startX+col*gapX,cy=startY+row*gapY;
      const lx=px-cx,ly=py-cy,d2=lx*lx+ly*ly;
      if(d2>R*R)return null;
      if(i<stamps){if(_cup(lx+R,ly+R,S))return[...bg,255];return[ar,ag,ab,255];}
      else{const iR=R-4;if(d2>=iR*iR)return[ar,ag,ab,140];return null;}
    }
    return _png(W,H,(px,py)=>{
      if(px<3&&py<3)return[bg[0],bg[1],vB,255];
      if(py>=ruleY)return[ar,ag,ab,180];
      for(let i=0;i<needed;i++){const h=gs(px,py,i);if(h)return h;}
      return[...bg,255];
    });
  }

  function makeLogoDataUri(accentHex){
    const W=160,H=50,[ar,ag,ab]=_rgb(accentHex),r=8; // accent colour logo on dark pass
    return _png(W,H,(px,py)=>{
      const ic=(px<r&&py<r&&(px-r)**2+(py-r)**2>r*r)||(px>W-r&&py<r&&(px-(W-r))**2+(py-r)**2>r*r)||(px<r&&py>H-r&&(px-r)**2+(py-(H-r))**2>r*r)||(px>W-r&&py>H-r&&(px-(W-r))**2+(py-(H-r))**2>r*r);
      return ic?[0,0,0,0]:[ar,ag,ab,255];
    });
  }


  // ── WALLETWALLET HELPERS ──────────────────────────────────────────────
  function buildPassBody(customer, s, stamps) {
    const needed     = STAMPS_NEEDED;
    const isComplete = stamps >= needed;
    const accent     = s.accent || '#c94f2b';
    // Generate images inline as data URIs — no external fetch, always works
    const versionN   = Date.now() % 100000;
    const stripUrl   = makeStripDataUri(stamps, needed, accent, versionN);
    const logoUrl    = makeLogoDataUri(accent);

    return {
      barcodeValue:     SITE_URL ? `${SITE_URL}/staff.html?id=${customer.id}` : customer.id,
      barcodeFormat:    'QR',
      logoText:         s.cafe_name,
      organizationName: s.cafe_name,
      description:      'Loyalty card',
      // primaryFields: invisible normally, shows redemption message when complete
      primaryFields: [{
        label: isComplete ? 'REDEEM' : ' ',
        value: isComplete ? '1 FREE COFFEE' : ' ',
      }],
      // secondaryFields: below the strip — name left, stamps right
      secondaryFields: [
        {
          label: 'MEMBER',
          value: customer.name,
        },
        {
          label: 'STAMPS',
          value: isComplete ? '10 of 10 ✓' : `${stamps} of ${needed}`,
          changeMessage: isComplete
            ? `🎉 Free coffee earned at ${s.cafe_name}!`
            : `Stamp added — you now have %@ stamps`,
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
      color:            '#1a1a1a',
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
