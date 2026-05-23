# Maroa Frontend

The customer-facing web app for Maroa.ai. Marketing site + product (auth-gated).

Stack: **Next.js 14 (App Router) · React 18 · TypeScript · Tailwind · Supabase Auth · lucide-react**.
Aesthetic: Apple-classic — generous whitespace, restrained palette, soft elevation, native typography.
SEO: server-rendered, JSON-LD Organization schema, sitemap.xml, robots.txt, OG + Twitter meta.

---

## Quick start (local dev)

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_ANON_KEY from your Supabase dashboard
# (Supabase → Settings → API → "anon public" key)

npm install
npm run dev
```

Open http://localhost:3000.

---

## Project layout

```
frontend/
├── app/
│   ├── layout.tsx              Root layout (SEO meta, JSON-LD, fonts)
│   ├── globals.css             Tailwind imports + design tokens
│   ├── sitemap.ts              SEO: dynamic sitemap.xml
│   ├── robots.ts               SEO: robots.txt
│   ├── (marketing)/            Public marketing pages
│   │   ├── layout.tsx          Nav + Footer wrapper
│   │   ├── page.tsx            Landing page (hero, features, social proof, CTA)
│   │   ├── pricing/page.tsx    Pricing (3 plans + FAQ)
│   │   ├── features/page.tsx   Features deep-dive (9 sections)
│   │   └── about/page.tsx      About page
│   ├── (auth)/                 Magic-link auth (Supabase Auth)
│   │   ├── layout.tsx          Two-column auth layout
│   │   ├── login/page.tsx      Log in (email → magic link)
│   │   └── signup/page.tsx     Sign up (email + business name)
│   ├── (dashboard)/            Auth-gated product
│   │   ├── layout.tsx          Sidebar wrapper
│   │   ├── dashboard/page.tsx  KPI cards + today's queue + scorecard
│   │   ├── onboarding/page.tsx 5-step cold-start wizard
│   │   ├── content/page.tsx    (skeleton — wire to /api/content)
│   │   ├── ads/page.tsx        (skeleton — wire to /api/ads/campaigns)
│   │   └── settings/page.tsx   Brand voice, integrations, billing
│   └── auth/callback/route.ts  Magic-link exchange handler
├── components/
│   ├── ui/                     Base primitives (Button, Input, Card)
│   ├── marketing/              Marketing-only (Logo, Nav, Footer)
│   └── dashboard/              Dashboard-only (Sidebar)
├── lib/
│   ├── cn.ts                   Tailwind classnames merge helper
│   └── api/                    Typed API client
│       ├── client.ts           fetch wrapper (auth, errors, tracing)
│       ├── auth.ts             Supabase Auth (magic-link)
│       └── index.ts            High-level API: businesses, content, ads, onboarding
├── public/                     Static assets
├── tailwind.config.ts          Design system (Apple palette, type scale)
├── next.config.js              Security headers + image config + redirects
├── tsconfig.json
└── .env.example                Env var template
```

---

## Pages

### Public (SEO-indexed)

- `/` — Landing page
- `/features` — 9-section feature deep-dive
- `/pricing` — 3 plans + FAQ
- `/about` — Why Maroa exists

### Auth (not indexed)

- `/login` — Magic-link login
- `/signup` — Magic-link signup with business name
- `/auth/callback` — Magic-link exchange route handler

### Dashboard (auth-gated, not indexed)

- `/dashboard` — KPI cards + today's queue
- `/onboarding` — 5-step cold-start wizard
- `/content` — Approve/edit/reject content queue (skeleton)
- `/ads` — Campaign audits + recommendations (skeleton)
- `/settings` — Brand voice, integrations, billing

---

## Design system

**Colors**

- `ink` — Apple-style monochrome (50 → 900, anchored at #1d1d1f primary text)
- `accent` — Apple "Buy" blue (#0071e3 at 500)

**Type scale**

- `display-xl` (5.5rem) — hero
- `display-lg` (4rem) — section headlines
- `display-md` (3rem) — page titles
- `eyebrow` (0.875rem, tracked, uppercase) — section labels

**Shadow**

- `shadow-subtle` — input/card baseline
- `shadow-card` — card hover
- `shadow-lifted` — hero mockups

**Radius**

- `rounded-xl` (14px) — inputs
- `rounded-2xl` (20px) — buttons
- `rounded-3xl` (28px) — cards & hero panels

**Typography**

- System SF Pro / Inter stack with `-apple-system` fallback
- Antialiased, kerned, ligature-on (`ss01`, `cv01`)
- `text-balance` on headings, `text-pretty` on body

---

## Deploy to Vercel

1. Push the `frontend/` directory to its own Git repo (or use Vercel's monorepo support pointing at `/frontend`).
2. Create a new Vercel project. Set the root directory to `frontend/`.
3. Add the env vars from `.env.example` in Vercel → Project Settings → Environment Variables.
4. Deploy.

Vercel auto-detects Next.js 14, builds with `npm run build`, serves with `npm start`.

### Production env vars to set on Vercel

```
NEXT_PUBLIC_SITE_URL              https://maroa.ai (or your custom domain)
NEXT_PUBLIC_API_URL               https://maroa-api-production.up.railway.app
NEXT_PUBLIC_SUPABASE_URL          https://zqhyrbttuqkvmdewiytf.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     <anon key from Supabase>
```

### Domain setup

In Vercel: Add Domain → `maroa.ai`. Update DNS at your registrar:

- A record `@` → `76.76.21.21`
- CNAME `www` → `cname.vercel-dns.com`

---

## Importing into Lovable (alternative deploy)

If you want to use Lovable's builder instead of standalone Vercel:

1. Create a new Lovable project.
2. Paste the contents of `app/(marketing)/page.tsx` into Lovable and ask it to set up a Next.js project around it.
3. Repeat for each page in turn — Lovable will scaffold the rest.
4. Configure env vars in Lovable's project settings (same keys as `.env.example`).

The code here is **standard Next.js 14 App Router** so it works in any host that supports it (Vercel, Netlify, self-hosted Node, Lovable).

---

## What's wired vs. what's skeleton

| Page           | Status       | Notes                                                      |
| -------------- | ------------ | ---------------------------------------------------------- |
| Landing        | ✅ Complete  | Hero, features grid, social proof, CTAs                    |
| Pricing        | ✅ Complete  | 3 plans, FAQ, CTAs                                         |
| Features       | ✅ Complete  | 9-section deep-dive                                        |
| About          | ✅ Complete  |                                                            |
| Login / Signup | ✅ Complete  | Wired to Supabase Auth (magic link)                        |
| Auth callback  | ✅ Complete  | Exchanges code for session                                 |
| Dashboard      | 🟡 Mock data | KPIs + queue use placeholder data                          |
| Onboarding     | ✅ Complete  | 5-step wizard, calls backend `/webhook/cold-start-trigger` |
| Content        | 🔴 Skeleton  | Wire to backend `/api/content`                             |
| Ads            | 🔴 Skeleton  | Wire to backend `/api/ads/campaigns`                       |
| Settings       | 🟡 UI only   | Buttons not yet wired to backend actions                   |

**To finish:** Replace mock data in `dashboard/page.tsx`, `content/page.tsx`, `ads/page.tsx` with real `lib/api` calls. Wire Settings buttons. Add error/loading states.

---

## SEO checklist

- [x] Static + dynamic OG meta per page
- [x] Twitter Card meta
- [x] JSON-LD Organization schema in root layout
- [x] Sitemap.xml (auto)
- [x] Robots.txt with `/dashboard /api /auth` excluded
- [x] Canonical URLs per page
- [x] Mobile-first responsive (320px → 1920px tested)
- [x] Security headers (CSP via Next config + HSTS)
- [ ] favicon, apple-touch-icon, /og-image.png — add to `public/` (1200×630 OG, 192/512 PWA icons)

---

## Mobile-first

Every component is mobile-first. No desktop-only features. Tap targets ≥ 44px. No horizontal scroll. Tested at 320px (iPhone SE) up.

---

## License

Private. © Maroa.ai 2026.
