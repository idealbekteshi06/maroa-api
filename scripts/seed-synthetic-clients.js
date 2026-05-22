#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Seed 5 realistic demo businesses with 3 months of performance history.
 *
 * Usage: SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-synthetic-clients.js
 *        node scripts/seed-synthetic-clients.js --dry-run
 */

const { randomUUID } = require('crypto');
const { getSeedConfig, sbInsert, sbUpsert, sbSelect } = require('./lib/seedSupabase');

const DRY_RUN = process.argv.includes('--dry-run');

/** Stable IDs for idempotent re-runs */
const IDS = {
  dental: 'a1000001-0001-4001-8001-000000000001',
  restaurant: 'a1000001-0001-4001-8001-000000000002',
  fitness: 'a1000001-0001-4001-8001-000000000003',
  beauty: 'a1000001-0001-4001-8001-000000000004',
  legal: 'a1000001-0001-4001-8001-000000000005',
};

const CLIENTS = [
  {
    id: IDS.dental,
    business_name: 'SEED_Zurich Smile Studio',
    industry: 'dental',
    location: 'Zurich, Switzerland',
    country: 'CH',
    plan: 'growth',
    daily_budget: 45,
    brand_tone: 'calm, expert, reassuring',
    target_audience: 'Families and professionals seeking preventive dental care',
    marketing_goal: 'Book new patient consultations',
    currency: 'CHF',
  },
  {
    id: IDS.restaurant,
    business_name: 'SEED_Berlin Kiez Kitchen',
    industry: 'restaurant',
    location: 'Berlin, Germany',
    country: 'DE',
    plan: 'agency',
    daily_budget: 60,
    brand_tone: 'warm, energetic, local',
    target_audience: 'Young professionals and weekend brunch crowd',
    marketing_goal: 'Drive reservations and walk-ins',
    currency: 'EUR',
  },
  {
    id: IDS.fitness,
    business_name: 'SEED_Vienna Flow Fitness',
    industry: 'fitness',
    location: 'Vienna, Austria',
    country: 'AT',
    plan: 'growth',
    daily_budget: 35,
    brand_tone: 'motivating, direct, inclusive',
    target_audience: 'Busy adults 28-45 starting strength training',
    marketing_goal: 'Fill trial memberships',
    currency: 'EUR',
  },
  {
    id: IDS.beauty,
    business_name: 'SEED_Munich Glow Salon',
    industry: 'beauty',
    location: 'Munich, Germany',
    country: 'DE',
    plan: 'growth',
    daily_budget: 40,
    brand_tone: 'elegant, friendly, aspirational',
    target_audience: 'Women 25-50 for cuts, color, and skincare',
    marketing_goal: 'Increase booking rate for color services',
    currency: 'EUR',
  },
  {
    id: IDS.legal,
    business_name: 'SEED_Hamburg Clear Counsel',
    industry: 'legal',
    location: 'Hamburg, Germany',
    country: 'DE',
    plan: 'agency',
    daily_budget: 80,
    brand_tone: 'authoritative, clear, trustworthy',
    target_audience: 'SMB owners needing contract and employment advice',
    marketing_goal: 'Generate qualified consultation leads',
    currency: 'EUR',
  },
];

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function dateOnlyDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function mondayWeeksAgo(weeks) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function seedBusiness(client) {
  const biz = {
    id: client.id,
    user_id: client.id,
    email: `seed+${client.industry}@maroa.demo`,
    business_name: client.business_name,
    industry: client.industry,
    location: client.location,
    target_audience: client.target_audience,
    brand_tone: client.brand_tone,
    marketing_goal: client.marketing_goal,
    plan: client.plan,
    daily_budget: client.daily_budget,
    is_active: true,
    onboarding_complete: true,
    country: client.country,
    updated_at: new Date().toISOString(),
  };

  await sbUpsert('businesses', [biz], 'id');

  await sbUpsert(
    'business_profiles',
    [
      {
        user_id: client.id,
        business_name: client.business_name,
        business_type: client.industry,
        primary_language: client.country === 'CH' ? 'German' : 'German',
        audience_description: client.target_audience,
        primary_goal: client.marketing_goal,
        tone_keywords: JSON.stringify(client.brand_tone.split(',').map((s) => s.trim())),
        best_posting_times: 'auto',
      },
    ],
    'user_id'
  );

  await sbUpsert(
    'brand_voice_anchors',
    [
      {
        business_id: client.id,
        anchor: {
          tone_descriptors: client.brand_tone,
          audience_summary: client.target_audience,
          never_say: ['cheap', 'guaranteed results', 'miracle'],
          do_use: ['local', 'trust', 'clear next step'],
          source: 'synthetic_seed',
        },
        source: 'synthetic_seed',
      },
    ],
    'business_id'
  );
}

async function seedContentHistory(businessId, industry) {
  const planId = randomUUID();
  await sbInsert('content_plans', [
    {
      id: planId,
      business_id: businessId,
      plan_date: dateOnlyDaysAgo(0),
      status: 'published',
      analysis: { narrativeArc: 'trust_building', seeded: true },
      autonomy_mode: 'hybrid',
      model_used: 'seed',
    },
  ]);

  for (let day = 0; day < 90; day += 1) {
    const conceptId = randomUUID();
    const assetId = randomUUID();
    const postId = randomUUID();
    const engagementBase = industry === 'fitness' ? 0.04 : industry === 'legal' ? 0.008 : 0.022;
    const impressions = Math.floor(rand(800, 4500));
    const reach = Math.floor(impressions * rand(0.7, 0.95));
    const engagement = Math.floor(reach * rand(engagementBase * 0.6, engagementBase * 1.4));

    await sbInsert('content_concepts', [
      {
        id: conceptId,
        business_id: businessId,
        plan_id: planId,
        platform: day % 7 === 0 ? 'facebook' : 'instagram',
        format: day % 3 === 0 ? '1:1 Feed post' : '9:16 Reel 7-15s',
        status: 'published',
        pillar: pick(['trust', 'offer', 'education', 'community']),
        core_idea: `Day ${90 - day} ${industry} post theme`,
        hook: `Hook for ${industry} day ${day}`,
        funnel_stage: 'tofu',
        created_at: daysAgo(day),
      },
    ]);

    await sbInsert('content_assets', [
      {
        id: assetId,
        business_id: businessId,
        concept_id: conceptId,
        platform: day % 7 === 0 ? 'facebook' : 'instagram',
        caption: `SEED caption ${industry} — day ${90 - day}`,
        hook: `SEED hook ${day}`,
        hashtags: ['#maroa', '#seed', `#${industry}`],
        cta: 'Book now',
        posting_time_local: pick(['09:00', '12:00', '17:00', '19:00']),
        status: 'published',
        published_at: daysAgo(day),
        generated_at: daysAgo(day),
      },
    ]);

    await sbInsert('content_posts', [
      {
        id: postId,
        business_id: businessId,
        asset_id: assetId,
        platform: day % 7 === 0 ? 'facebook' : 'instagram',
        posted_at: daysAgo(day),
        performance_measured_at: daysAgo(day - 1),
      },
    ]);

    await sbInsert('content_performance', [
      {
        business_id: businessId,
        post_id: postId,
        asset_id: assetId,
        platform: day % 7 === 0 ? 'facebook' : 'instagram',
        measured_at: daysAgo(day - 1),
        hours_since_post: 48,
        impressions,
        reach,
        engagement_count: engagement,
        engagement_rate: reach ? engagement / reach : 0,
        vs_account_baseline: rand(0.85, 1.35),
        vs_industry_benchmark: rand(0.9, 1.25),
        classification: engagement / reach > engagementBase ? 'winner' : 'on_target',
      },
    ]);
  }
}

async function seedAds(businessId, industry) {
  const campaignId = randomUUID();
  await sbInsert('ad_campaigns', [
    {
      id: campaignId,
      business_id: businessId,
      business_name: `SEED ${industry}`,
      platform: 'meta',
      status: 'active',
      daily_budget: rand(25, 80),
      total_spend: 0,
      roas: rand(1.8, 3.2),
      objective: 'conversions',
    },
  ]);

  const ctrBase = { dental: 0.009, restaurant: 0.012, fitness: 0.013, beauty: 0.014, legal: 0.007 }[industry] || 0.01;

  for (let day = 0; day < 30; day += 1) {
    const spend = rand(18, 55);
    const impressions = Math.floor(spend * rand(80, 140));
    const clicks = Math.max(1, Math.floor(impressions * rand(ctrBase * 0.7, ctrBase * 1.5)));
    const ctr = clicks / impressions;
    const conversions = Math.max(0, Math.floor(clicks * rand(0.04, 0.12)));
    const roas = rand(1.2, 4.5);

    await sbInsert('ad_performance_logs', [
      {
        campaign_id: campaignId,
        business_id: businessId,
        spend,
        clicks,
        impressions,
        ctr,
        roas,
        cpc: clicks ? spend / clicks : 0,
        conversions,
        logged_at: daysAgo(day),
        recommendation: roas >= 2 ? 'scale' : 'optimize',
      },
    ]);
  }

  await sbUpsert(
    'ad_campaigns',
    [
      {
        id: campaignId,
        business_id: businessId,
        total_spend: 30 * 35,
        roas: 2.4,
        ctr: ctrBase,
      },
    ],
    'id'
  );
}

async function seedCompetitors(businessId, industry, location) {
  const names = {
    dental: ['SEED_Competitor Dental Plus', 'SEED_Competitor City Smile'],
    restaurant: ['SEED_Competitor Bistro Nord', 'SEED_Competitor Street Eats'],
    fitness: ['SEED_Competitor Iron House', 'SEED_Competitor Urban Gym'],
    beauty: ['SEED_Competitor Chic Cuts', 'SEED_Competitor Glow Bar'],
    legal: ['SEED_Competitor Legal Partners', 'SEED_Competitor Harbor Law'],
  }[industry] || ['SEED_Competitor A', 'SEED_Competitor B'];

  for (let i = 0; i < 10; i += 1) {
    await sbInsert('competitor_snapshots', [
      {
        business_id: businessId,
        competitor_name: `${pick(names)} ${i + 1}`,
        competitor_url: `https://example.com/competitor-${industry}-${i}`,
        snapshot_date: dateOnlyDaysAgo(i * 9),
        social_posts: [{ platform: 'instagram', theme: pick(['promo', 'ugc', 'education']) }],
        active_ads: [{ angle: pick(['discount', 'trust', 'speed']), spend_tier: 'medium' }],
        content_themes: [pick(['seasonal', 'reviews', 'founder'])],
      },
    ]);
  }
}

async function seedWeeklyBriefs(businessId) {
  for (let w = 0; w < 12; w += 1) {
    const weekStart = mondayWeeksAgo(w);
    const weekEndDate = new Date(`${weekStart}T12:00:00Z`);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    await sbUpsert(
      'weekly_briefs',
      [
        {
          business_id: businessId,
          week_start: weekStart,
          week_end: weekEndDate.toISOString().slice(0, 10),
          status: w === 0 ? 'delivered' : 'delivered',
          headline: `SEED weekly brief week ${12 - w}`,
          subject_line: `Your marketing week — ${weekStart}`,
          synthesis: { priorities: ['ads', 'content', 'reviews'], seeded: true },
          deliverable: { summary: 'Synthetic brief for demo dashboards.' },
          generated_at: daysAgo(w * 7),
          delivered_at: daysAgo(w * 7),
        },
      ],
      'business_id,week_start'
    );
  }
}

async function main() {
  if (!getSeedConfig().ok && !DRY_RUN) {
    console.error('[seed-synthetic] Need SUPABASE_URL + SUPABASE_KEY');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`[seed-synthetic] would seed ${CLIENTS.length} businesses (90d content, 30d ads each)`);
    CLIENTS.forEach((c) => console.log(`  - ${c.business_name}`));
    return;
  }

  for (const client of CLIENTS) {
    console.log(`[seed-synthetic] ${client.business_name}...`);
    await seedBusiness(client);
    await seedContentHistory(client.id, client.industry);
    await seedAds(client.id, client.industry);
    await seedCompetitors(client.id, client.industry, client.location);
    await seedWeeklyBriefs(client.id);
  }

  const check = await sbSelect('businesses', 'business_name=like.SEED_*&select=id,business_name');
  console.log(`[seed-synthetic] done — ${Array.isArray(check) ? check.length : 0} SEED_ businesses visible`);
}

main().catch((e) => {
  console.error('[seed-synthetic] failed:', e.message);
  process.exit(1);
});
