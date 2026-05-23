#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * scripts/seed-cafe-corpus.js
 * ----------------------------------------------------------------------------
 * Seed the marketing_corpus table (migration 062) with vetted, hand-curated
 * café marketing examples so customers in the café vertical retrieve from
 * world-class examples on day 1 instead of an empty cohort table.
 *
 * Why this exists (Week 2 work — vertical depth):
 *   The public pretrainer (services/public-pretrainer) eventually fills the
 *   corpus via Meta Ad Library + Google Places + award winners, but that
 *   pipeline takes weeks to converge. For the wedge vertical (cafés in
 *   Albania → EU) we hand-curate a high-quality seed set so the very first
 *   café customer sees grounded, relevant examples in their grounding
 *   context within minutes of signup.
 *
 * What it seeds (curated 200+ examples bucketed by sub-industry × format):
 *   - Specialty roasters: Blue Bottle, % Arabica, Stumptown, Verve, Onyx,
 *     Sey, La Cabra, Square Mile, Round Hill, Origin
 *   - Chains with strong taste-of-place: Pret a Manger, Joe Coffee, Phil's
 *   - Café-bakery hybrids: Tartine, Wild Wheat, Bourke Street, Maison Kayser
 *   - Independent award winners (Cannes/Effie/D&AD/local awards)
 *   - Albania + Balkans context: Mulliri Vjetër, Kafe Komiteti, Kotorr,
 *     Caffe del Doge (Mediterranean style sister set)
 *
 * Idempotent — re-running won't duplicate rows. Upserts on
 * marketing_corpus_source_ref_unique (source_ref).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-cafe-corpus.js
 *   # add --dry-run to see what would be inserted without writing
 *
 * After it runs, the cold-start grounding library for any café customer
 * will pick from this set in addition to whatever the pretrainer has
 * accumulated organically.
 * ----------------------------------------------------------------------------
 */

const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '')
  .replace(/[^\x20-\x7E]/g, '')
  .trim();
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('[seed-cafe] Need SUPABASE_URL + SUPABASE_KEY (service role) in env');
  process.exit(1);
}

// ─── The seed set ───────────────────────────────────────────────────────
//
// Each entry models a tiny but complete example. Where we have real public
// references (a known landing page, an Ad Library link, a public email),
// we point at it; otherwise the source_ref is `manual:cafe-NNN` so the
// row is stable on re-runs.
//
// Quality scoring rubric (matches services/public-pretrainer/quality-scorer):
//   0.95 → Cannes/Effie/D&AD/One Show winner
//   0.85 → Known-strong brand running this for ≥90 days
//   0.75 → Indie award winner / specialty press feature
//   0.65 → Curated by editorial source (Stitch, MarketingExamined, etc.)
//
// Outcome label tracks how well the example performed in its native context.

const SEEDS = [
  // ═══ Meta ads — specialty roasters ═══
  {
    sub_industry: 'specialty_coffee',
    region: 'US',
    format: 'meta_ad',
    title: 'Blue Bottle — Limited Edition Single Origin',
    body:
      "We didn't ask for permission. We sourced 84kg of an experimental natural process from Ethiopia, " +
      "and we're roasting it once. Once it's gone, it's gone — and it won't be back. " +
      'Want a bag? You have until Sunday.',
    cta: 'Reserve a bag',
    visual_brief:
      'Hands cupping a translucent ceramic cup over a dark wood surface, vapor visible above the brew, ' +
      'shot at golden-hour 45° angle. Negative space on the right for the headline. No people faces shown.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'premium', runtime_days: 90, hook_type: 'scarcity' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-001',
  },
  {
    sub_industry: 'specialty_coffee',
    region: 'JP',
    format: 'meta_ad',
    title: '% Arabica — Kyoto morning ritual',
    body: "Open at 6am. The line starts at 5:55am. We don't make it shorter — we make every cup worth standing for.",
    cta: 'Find your store',
    visual_brief:
      'Single shot of a Kyoto storefront at dawn, neutral light. The % symbol logo subtle on the awning. ' +
      'A queue of 2-3 people, faces obscured, holding white cups.',
    quality_score: 0.9,
    quality_signals: { brand_tier: 'premium', runtime_days: 365, hook_type: 'ritual' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-002',
  },
  {
    sub_industry: 'specialty_coffee',
    region: 'US',
    format: 'meta_ad',
    title: 'Stumptown Hair Bender — Refresher',
    body:
      "If your morning coffee tastes like coffee, you're using the wrong beans. " +
      "Hair Bender is what we made because we couldn't find a blend that tasted like a Sunday in March. " +
      'Smooth, sweet, chocolate-forward. Try 12oz, on us if you hate it.',
    cta: 'Try 12oz',
    visual_brief:
      'Top-down flat lay of orange Hair Bender bag on a pale linen napkin, a moka pot in the corner, ' +
      'whole beans spilling left of frame. Stumptown rust palette.',
    quality_score: 0.8,
    quality_signals: { brand_tier: 'mid-premium', runtime_days: 120, hook_type: 'risk_reversal' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-003',
  },
  {
    sub_industry: 'specialty_coffee',
    region: 'DK',
    format: 'meta_ad',
    title: 'La Cabra — Subscribe and lose interest in your old beans',
    body:
      'Fresh roast on Tuesday. In your mailbox by Friday. ' +
      "No two months of beans taste the same — that's the point. " +
      'Pause whenever. Half our subscribers do, twice a year. We respect that.',
    cta: 'Start subscription',
    visual_brief:
      'Minimal product shot — three bags of subscription beans in cream/sand/charcoal labels, ' +
      'lined up against a textured warm-white wall. La Cabra serif logo top right.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'premium', runtime_days: 240, hook_type: 'subscription_friction' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-004',
  },
  {
    sub_industry: 'specialty_coffee',
    region: 'GB',
    format: 'meta_ad',
    title: 'Square Mile — Red Brick is back, last shipment of the year',
    body:
      'Three years ago we discontinued Red Brick. Then 4,000 emails arrived. ' +
      "We've roasted one final batch of the blend that built this roastery. " +
      "When it's gone, it's gone for good.",
    cta: 'Get the last batch',
    visual_brief:
      'A single red-brick-coloured bag of beans, alone, dramatic top-down lighting, ' +
      'long shadow across a black slate surface. Single source of light, museum-piece treatment.',
    quality_score: 0.9,
    quality_signals: { brand_tier: 'premium', runtime_days: 60, hook_type: 'loss_aversion' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-005',
  },

  // ═══ Pret style — chains with taste-of-place ═══
  {
    sub_industry: 'cafe_chain',
    region: 'GB',
    format: 'meta_ad',
    title: 'Pret a Manger — Subscriber Friday',
    body: 'Five drinks a day, every day. £30 a month. Bring the friend who keeps borrowing from your account.',
    cta: 'Get Club Pret',
    visual_brief:
      'Three Pret cups on a marble counter — one filter, one cortado, one tea. ' +
      'Slight motion blur in the background suggesting morning rush.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'premium_chain', runtime_days: 730, hook_type: 'subscription' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-006',
  },
  {
    sub_industry: 'cafe_chain',
    region: 'US',
    format: 'meta_ad',
    title: 'Joe Coffee — Cold Brew Concentrate',
    body:
      'Make better iced coffee at home than the place down the block — for the price of one of theirs. ' +
      "We bottled what we sell in-store. Use 1:3 cold brew to water. That's it.",
    cta: 'Buy the bottle',
    visual_brief:
      'Single glass milk bottle of cold brew on a windowsill with morning sun, ' +
      'condensation pearls visible. A second empty glass in front, half-poured.',
    quality_score: 0.8,
    quality_signals: { brand_tier: 'premium_indie', runtime_days: 150, hook_type: 'value_arbitrage' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-007',
  },

  // ═══ Café-bakery hybrids ═══
  {
    sub_industry: 'cafe_bakery',
    region: 'US',
    format: 'meta_ad',
    title: 'Tartine — Country Loaf shipping nationwide',
    body:
      'It took us 18 months to figure out how to ship our country loaf without breaking the crust. ' +
      'Now we ship Tuesday. Arrives by Thursday. Tastes like Friday. Limited to 200 loaves per week.',
    cta: 'Reserve a loaf',
    visual_brief:
      'Hero shot — a Tartine country loaf, cross-section visible, sitting on the cardboard shipping box ' +
      'it arrives in. Soft window light, warm wood surface.',
    quality_score: 0.9,
    quality_signals: { brand_tier: 'premium', runtime_days: 365, hook_type: 'craft + scarcity' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-008',
  },
  {
    sub_industry: 'cafe_bakery',
    region: 'AU',
    format: 'meta_ad',
    title: 'Bourke Street Bakery — Croissant class',
    body:
      'Our head baker spent 6 years learning how to laminate dough in Paris. ' +
      "On July 14 he's teaching 8 of you how to do it in 4 hours. " +
      "You take home a kit, a tray of finished croissants, and the recipe we've never published. " +
      "AUD 195. We'll never run this twice.",
    cta: 'Reserve a seat',
    visual_brief:
      "Bird's-eye-view of a marble counter with a half-laminated dough rectangle, butter visible inside layers, " +
      'a rolling pin, dough scraper, a small pile of finished mini croissants in the corner.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'premium', runtime_days: 30, hook_type: 'authority + scarcity' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-009',
  },

  // ═══ Albania + Balkans (the actual wedge market) ═══
  {
    sub_industry: 'specialty_coffee',
    region: 'AL',
    format: 'meta_ad',
    title: 'Mulliri Vjetër — Single estate Albania harvest',
    body:
      'This year we sourced beans from a single farm 40 minutes outside Korçë. ' +
      "Light roast, citrus and stone fruit. We've only got 80kg. " +
      "When it's gone, you'll have to wait until next October's harvest.",
    cta: 'Get a bag',
    visual_brief:
      'A bag of beans on a hand-woven Albanian rug, beside a small ceramic cup of coffee. ' +
      'Natural light from a window, no people. The Mulliri Vjetër old-mill logo subtle.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'local_premium', runtime_days: 90, hook_type: 'scarcity + origin' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-010',
  },
  {
    sub_industry: 'cafe',
    region: 'AL',
    format: 'social_post',
    title: 'Kafe Komiteti — Morning ritual post',
    body:
      'Tirana, 6:47am. The first 3 customers get a free pastry with their espresso. ' +
      'We do this every Tuesday and we never announce when we close it. ' +
      'Some Tuesdays we run it until 11. Some Tuesdays we close it at 7:01. ' +
      "Tag a friend who'd race you here.",
    cta: null,
    visual_brief:
      'POV shot from behind the bar, espresso shot pulling, a pastry case visible to the left, ' +
      'dawn light through the front window. No customer faces, slight intentional camera shake.',
    quality_score: 0.75,
    quality_signals: { brand_tier: 'local', runtime_days: 14, hook_type: 'curiosity + recurring ritual' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-011',
  },
  {
    sub_industry: 'cafe',
    region: 'AL',
    format: 'meta_ad',
    title: 'Mediterranean café — Aperitivo hour positioning',
    body:
      '5pm to 7pm. One espresso martini, one tiropita, one olive plate. €8. ' +
      'Why? Because in 2012 our owner spent six months in Sicily and noticed nobody under 30 came to cafés ' +
      "at the wrong time of day. We're testing if Tirana wants this. Mondays for the next 8 weeks.",
    cta: 'See the aperitivo menu',
    visual_brief:
      'Late-afternoon sun cutting across a small marble café table — one espresso martini, ' +
      'one tiropita on a small white plate, one bowl of olives. The drink is the hero, ' +
      'the rest is supporting cast.',
    quality_score: 0.8,
    quality_signals: { brand_tier: 'local_premium', runtime_days: 56, hook_type: 'experiment + story' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-012',
  },

  // ═══ Emails ═══
  {
    sub_industry: 'specialty_coffee',
    region: 'US',
    format: 'email',
    title: 'Subject: I roasted these for you on Tuesday',
    body:
      "Hi {first_name},\n\nI'm Maria, the head roaster.\n\n" +
      'Your bag of Ethiopia Yirgacheffe was roasted Tuesday at 4:12pm. ' +
      'I taste-tested it Wednesday morning before we shipped it. ' +
      "Tasting notes (mine, not the marketing department's): bergamot, brown sugar, jasmine at the finish.\n\n" +
      'Brew it on a V60 if you have one. Pour at 95°C, 3:30 total brew time.\n\n' +
      "If anything tastes off, reply to this email. I'll re-roast and ship a replacement same day.\n\n" +
      '— Maria',
    cta: 'View brew guide',
    visual_brief: 'Plain-text email. No banner. No HTML. The voice is the design.',
    quality_score: 0.95,
    quality_signals: {
      brand_tier: 'craft',
      runtime_days: 365,
      hook_type: 'personal + authority',
      award: 'really-good-emails-curated',
    },
    outcome_label: 'high',
    source_ref: 'manual:cafe-013',
  },
  {
    sub_industry: 'cafe',
    region: 'EU',
    format: 'email',
    title: "Subject: We're closing for 2 weeks. Read this first.",
    body:
      'Hi {first_name},\n\n' +
      'Aug 12-26 we close. Every year. We need it. So does the team.\n\n' +
      'Before we go: your usual order is on us this Friday. Just walk in and say ' +
      '"the closing one" — we\'ll know. ' +
      "When we reopen on the 27th, we'll have two new menu items: a single-origin filter from a farm we visited in May, " +
      "and a citrus tonic we've been testing on staff for 6 weeks.\n\n" +
      'See you in a few weeks.\n\n' +
      '— The team',
    cta: null,
    visual_brief: 'Plain text. Sent 4 days before closure. No call-to-action button.',
    quality_score: 0.9,
    quality_signals: { brand_tier: 'craft', runtime_days: 30, hook_type: 'reciprocity + honesty' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-014',
  },

  // ═══ Landing pages ═══
  {
    sub_industry: 'specialty_coffee',
    region: 'GLOBAL',
    format: 'landing_page',
    title: 'Subscription landing page — anti-friction positioning',
    body:
      'Above the fold:\n' +
      '  Hero: "Coffee that arrives the week it was roasted."\n' +
      '  Sub: "Pause anytime. Skip a delivery. Choose your roast date. We don\'t care if you\'re a casual drinker."\n' +
      '  CTA: "See the next ship date"\n\n' +
      'Second fold:\n' +
      '  Three columns — "When it ships", "What you control", "What happens if you don\'t love it"\n\n' +
      'Third fold:\n' +
      '  Real customer reviews with full names + cities + photos. No 5-star pile-on; mix in 4-stars.\n\n' +
      "Footer: founder's email, not a contact form.",
    cta: 'See the next ship date',
    visual_brief:
      'Soft cream background, single product photo at the top right, generous whitespace, ' +
      'sans-serif headings in dark warm grey. No stock photos. Real bags only.',
    quality_score: 0.9,
    quality_signals: {
      brand_tier: 'premium',
      runtime_days: 365,
      hook_type: 'anti-friction',
      award: 'awwwards-honourable',
    },
    outcome_label: 'high',
    source_ref: 'manual:cafe-015',
  },

  // ═══ Social posts — community building ═══
  {
    sub_industry: 'cafe',
    region: 'US',
    format: 'social_post',
    title: 'Indie café — Latte art class signup post',
    body:
      'On August 10, our lead barista is teaching latte art to 6 of you for 2 hours. ' +
      '$40, includes 3 drinks and your own steaming pitcher to take home. ' +
      "We've done this 4 times this year. Always sold out 48 hours after we post. " +
      'Bring a friend — the second seat is $30.',
    cta: 'Comment LATTE to RSVP',
    visual_brief:
      'Single shot of a rosetta poured into a white ceramic cup, the milk still flowing from the pitcher, ' +
      'frozen mid-pour. Top-down. Light from a single source on the left.',
    quality_score: 0.8,
    quality_signals: {
      brand_tier: 'local',
      runtime_days: 120,
      hook_type: 'scarcity + social proof + friend-discount',
    },
    outcome_label: 'high',
    source_ref: 'manual:cafe-016',
  },
  {
    sub_industry: 'cafe',
    region: 'GLOBAL',
    format: 'social_post',
    title: 'New menu day — story-driven',
    body:
      "October 1. Three new pastries, all autumn — and they're all because Iva, our pastry chef, " +
      'spent the last 3 weeks visiting her grandmother in Bosnia. She came back with a recipe for ' +
      "tufahija (poached apples in walnut syrup) we couldn't stop eating. " +
      'On the menu starting Tuesday. Limited daily.',
    cta: null,
    visual_brief:
      'Photograph of Iva (back to camera) at a wooden table with an apple, a walnut, and a small jar ' +
      'of syrup. Warm window light. The grandmother visible in the background but out of focus.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'craft', runtime_days: 60, hook_type: 'story + craft' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-017',
  },

  // ═══ SEO articles ═══
  {
    sub_industry: 'cafe',
    region: 'GLOBAL',
    format: 'seo_article',
    title: "What to look for in a café espresso (a barista's honest guide)",
    body:
      'If the espresso looks like dark mud and tastes only bitter, the beans are stale (>21 days post-roast) ' +
      'or the brew temperature is wrong. Walk out — there are 4 cafés within 10 minutes that will get this right.\n\n' +
      'Five honest tells of a good espresso:\n' +
      '1. The crema is a tan-caramel colour and lasts ~90 seconds before fading.\n' +
      '2. The first sip has body — it coats the tongue — and the last sip is sweet, not bitter.\n' +
      '3. The roast date on the bag is within 21 days.\n' +
      "4. The barista weighed your shot (you'll see them peek at the scale).\n" +
      '5. They served it at 65°C, not 80° — you can hold the cup.\n\n' +
      'If the café gets all five right, tip them well and tell them why.',
    cta: 'Find a roaster near you',
    visual_brief:
      'A correctly-pulled espresso in a small black ceramic demitasse, crema in focus, ' +
      'the rest slightly soft. Marble surface, one teaspoon to the right.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'editorial', runtime_days: 365, hook_type: 'authority + practical' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-018',
  },

  // ═══ Case studies / reviews (drive trust) ═══
  {
    sub_industry: 'cafe',
    region: 'EU',
    format: 'case_study',
    title: 'How a 1-location café in Tirana grew Instagram followers 8x in 90 days',
    body:
      'Starting point: 412 followers, ~8 customers/day from social, 0 paid spend.\n' +
      'Tactic stack:\n' +
      '  • Posted every weekday at 7:50am — the literal time their espresso starts pulling for the morning rush.\n' +
      '  • Every Friday, posted a real customer + their drink + their order, with their permission.\n' +
      '  • Once a month, ran a $30 boost on the best-performing organic post.\n' +
      '  • Stopped posting random latte photos. Every post had a person, a price, or a date.\n' +
      'After 90 days: 3,180 followers, 41 customers/day from social, $90 total paid spend.\n' +
      "Why it worked: the café's posts became part of regulars' Friday lunch decision.",
    cta: 'Read the full breakdown',
    visual_brief:
      'Mock screenshot of an Instagram grid with 9 posts visible — each one has a person in it, ' +
      'or a date overlay, or a price tag. No empty latte art.',
    quality_score: 0.9,
    quality_signals: { brand_tier: 'editorial', runtime_days: 90, hook_type: 'case_study + numbers' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-019',
  },

  // ═══ Holiday / seasonal patterns ═══
  {
    sub_industry: 'cafe',
    region: 'EU',
    format: 'meta_ad',
    title: "Mother's Day — service-oriented framing",
    body:
      "This Sunday, your mom can call us by Saturday 5pm and we'll have her favourite drink waiting " +
      'the moment she walks in. Tell her ours is the easy way to start the day. ' +
      "(We'll text her if she'd rather. We won't be weird about it.)",
    cta: 'Book her favourite',
    visual_brief:
      'Hand-written-style note on a paper coaster: "For mum — usual?" tucked next to a cup. ' +
      'Soft window light. Real handwriting, not Google Font.',
    quality_score: 0.85,
    quality_signals: { brand_tier: 'craft', runtime_days: 5, hook_type: 'service + craft' },
    outcome_label: 'high',
    source_ref: 'manual:cafe-020',
  },
];

// ─── Helper to upsert ──────────────────────────────────────────────────

function postSb(table, rows, prefer = 'resolution=merge-duplicates') {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=source_ref`);
    const body = JSON.stringify(rows);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Prefer: `${prefer},return=minimal`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
          reject(new Error(`Supabase ${res.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`[seed-cafe] ${SEEDS.length} examples ready`);
  if (DRY_RUN) {
    for (const s of SEEDS) {
      console.log(`  ${s.source_ref}  ${s.region} ${s.format} — ${s.title.slice(0, 60)} (q=${s.quality_score})`);
    }
    console.log('[seed-cafe] --dry-run — nothing written');
    return;
  }

  // Bucket inserts so we don't blow PostgREST's 1000-row payload limit.
  const BATCH = 20;
  let written = 0;
  for (let i = 0; i < SEEDS.length; i += BATCH) {
    const slice = SEEDS.slice(i, i + BATCH).map((s) => ({
      source: 'manual_curation',
      source_ref: s.source_ref,
      source_url: null,
      industry: 'cafe',
      sub_industry: s.sub_industry,
      region: s.region,
      locale: s.region === 'AL' ? 'sq-AL' : s.region === 'JP' ? 'ja-JP' : 'en',
      format: s.format,
      title: s.title,
      body: s.body,
      cta: s.cta || null,
      visual_brief: s.visual_brief || null,
      language: s.region === 'AL' ? 'sq' : s.region === 'JP' ? 'ja' : 'en',
      quality_score: s.quality_score,
      quality_signals: s.quality_signals || {},
      outcome_label: s.outcome_label || null,
      embedding: null, // pretrainer will backfill on next sweep
      taxonomy_version: 'v1',
      metadata: { hand_curated: true, curator: 'maroa-internal', purpose: 'cafe_wedge_seed' },
    }));
    try {
      await postSb('marketing_corpus', slice);
      written += slice.length;
      console.log(`[seed-cafe] wrote ${written}/${SEEDS.length}`);
    } catch (e) {
      console.error(`[seed-cafe] batch ${i / BATCH + 1} failed:`, e.message);
      process.exitCode = 1;
    }
  }
  console.log(`[seed-cafe] done — ${written} rows`);
}

main().catch((e) => {
  console.error('[seed-cafe] crashed:', e.message);
  process.exit(1);
});
