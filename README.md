# Lucky Cup — Loyalty System

## Files
```
config.js        ← safe client config (no secrets)
setup.html       ← cafe onboarding (run once)
signup.html      ← customer sign-up (public URL)
staff.html       ← staff stamp terminal (staff only)
api/action.js    ← Vercel serverless function (all secrets live here)
vercel.json      ← Vercel config
```

## Vercel Environment Variables
Add these in Vercel → Settings → Environment Variables:

| Variable           | Value                                      |
|--------------------|--------------------------------------------|
| SUPABASE_URL       | https://xxxx.supabase.co                   |
| SUPABASE_KEY       | your SERVICE ROLE key (not anon)           |
| WALLETWALLET_KEY   | ww_live_...                                |
| STAFF_PIN          | your 4-digit PIN                           |
| STAMPS_NEEDED      | 10                                         |

⚠️  Use the SERVICE ROLE key in Vercel (not the anon key).
    The service role key is only ever used server-side in api/action.js.
    The anon key is not needed at all — the API function handles all DB calls.

## Supabase Setup
Run this SQL in Supabase → SQL Editor:

```sql
-- Cafe settings table (one row per deployment)
create table cafe_settings (
  id         int  primary key default 1,
  cafe_name  text not null,
  accent     text default '#c94f2b',
  stamp      text default '☕',
  mode       text default 'dark',
  updated_at timestamptz default now()
);

-- Enforce single row
create unique index cafe_settings_single on cafe_settings ((true));

-- Lock it down (service role bypasses RLS)
alter table cafe_settings enable row level security;

-- Customers table
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

-- lock down the table (service role key bypasses RLS)
alter table customers enable row level security;
```

With RLS enabled and no policies, only the service role key
(used server-side in api/action.js) can read or write.
The browser never touches Supabase directly.

## Deploy
1. Push to GitHub
2. Import repo in Vercel
3. Add environment variables
4. Deploy

## First Use
1. Visit /setup.html → walk through 4 steps
2. Settings saved to localStorage on that device
3. Give customers the URL to /signup.html
4. Staff bookmark /staff.html

## Security Model
- Browser holds: nothing sensitive
- api/action.js holds: Supabase service key, WalletWallet key, staff PIN
- PIN is verified server-side on every stamp/redeem/lookup
- Daily stamp limit enforced server-side
- serial_number never sent to browser
