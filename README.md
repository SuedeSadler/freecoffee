# Lucky Cup — Multi-cafe Apple Wallet Loyalty Card

## Setup

### 1. Supabase
Run `schema.sql` in your Supabase SQL editor.

### 2. Vercel environment variables
Set in Vercel → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Service role key (sb_secret_...) |
| `WALLETWALLET_KEY` | WalletWallet Pro API key |
| `MASTER_KEY` | A secret string you choose — used to create new cafes |
| `STAMPS_NEEDED` | `10` |
| `SITE_URL` | Your Vercel URL, no trailing slash |

### 3. Deploy
Push to GitHub and connect to Vercel, or `vercel deploy`.

### 4. Create your first cafe
Visit `/setup` on your deployed site.  
You'll need your `MASTER_KEY` at the final step.

---

## URLs
- `/setup` — create a new cafe (requires MASTER_KEY)
- `/signup?cafe=your-slug` — customer signup page
- `/staff?cafe=your-slug` — staff stamp terminal
- `/staff?cafe=your-slug&id=CUST-XXXXXX` — direct from QR scan

---

## Before go-live checklist
- [ ] Remove `debug` and `test-update` actions from `api/action.js` (already omitted)
- [ ] Re-enable daily stamp limit in `add-stamp` handler
- [ ] Confirm WalletWallet push notifications are working

---

## File structure
```
lucky-cup/
├── api/
│   └── action.js      ← all secrets + business logic
├── config.js          ← public client config (no secrets)
├── setup.html         ← cafe onboarding
├── signup.html        ← customer card signup (?cafe=slug)
├── staff.html         ← staff stamp terminal (?cafe=slug&id=...)
├── schema.sql         ← Supabase schema
├── vercel.json        ← URL rewrites
└── README.md
```

---

## Multi-cafe flow
1. Cafe owner visits `/setup`, fills in details + PIN + MASTER_KEY
2. API creates a row in `cafe_settings` with hashed PIN
3. Owner shares `/signup?cafe=their-slug` with customers
4. Customers sign up → get a `.pkpass` added to Apple Wallet
5. Staff visit `/staff?cafe=their-slug`, enter PIN once per session
6. Staff scan customer QR → card loads → tap "Add Stamp"
7. At 10 stamps: "Redeem Free Coffee" button appears
