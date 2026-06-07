# Lucky Cup — Loyalty System

Four files. No framework. Drop on any host.

## Files
- `config.js`   — API keys, PIN, stamp count
- `setup.html`  — cafe onboarding (run once)
- `signup.html` — customer sign-up page (public)
- `staff.html`  — staff stamp terminal (staff only)

## Setup (5 minutes)

### 1. Supabase
1. Create project at supabase.com (pick Sydney region for NZ)
2. Run this SQL in the SQL Editor:

```sql
create table customers (
  id               text primary key,
  name             text not null,
  email            text,
  serial_number    text not null,
  stamps           int  default 0,
  redeemed         bool default false,
  mode             text default 'dark',
  accent           text default '#c94f2b',
  cafe_name        text default 'Your Cafe',
  last_stamp_date  date,
  created_at       timestamptz default now()
);
```

3. Settings → API → copy Project URL and anon public key

### 2. config.js
Open config.js and fill in:
```js
SUPABASE_URL:  'https://xxxx.supabase.co',
SUPABASE_KEY:  'eyJhbGc...',
STAFF_PIN:     '1234',   // change this!
```

### 3. Host
Upload all 4 files to:
- Netlify Drop (drag and drop, instant)
- Vercel
- Any static host

### 4. Setup page
Visit setup.html once to configure:
- Dark or light mode
- Brand colour
- Stamp icon
- Staff PIN (saved to localStorage)

### 5. Share
- Give customers the URL to signup.html
- Print a QR code linking to signup.html and put it on the counter
- Bookmark staff.html on the counter device

## How stamping works
1. Customer shows their wallet pass QR
2. Staff scan with phone camera → lands on staff.html?id=CUST-XXXX
3. Staff enter PIN → tap Add Stamp
4. Customer's pass updates live + lock-screen notification fires

## Customisation
- Change STAMPS_NEEDED in config.js (default 10)
- Change STAFF_PIN in config.js or re-run setup.html
- Add more preset colours in setup.html paletteGrid

## Notes
- WalletWallet free tier: 1,000 passes/month
- One stamp per customer per day (anti-abuse)
- Free coffee redeems reset the stamp count to 0
- All settings stored in browser localStorage on the setup device
