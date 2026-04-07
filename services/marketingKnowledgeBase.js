'use strict';

/**
 * Marketing Knowledge Base — 15 expert frameworks stored as vectors in Pinecone.
 *
 * Usage from server.js:
 *   const { getRelevantSkills, getAllSkillKnowledge } = require('./services/marketingKnowledgeBase');
 *   const skills = await getRelevantSkills(getEmbedding, pineconeQuery, taskType, businessType, goal);
 *
 * Usage from injection script:
 *   const { injectAllSkills } = require('./services/marketingKnowledgeBase');
 *   await injectAllSkills(getEmbeddingFn, pineconeUpsertFn);
 */

// ── Inject all 15 skill vectors into Pinecone ───────────────────────────────
async function injectAllSkills(getEmbedding, pineconeUpsert) {
  const skills = getAllSkillKnowledge();
  console.log(`Injecting ${skills.length} marketing skill vectors into Pinecone...`);

  for (const skill of skills) {
    try {
      const embedding = await getEmbedding(skill.content.slice(0, 8000));
      await pineconeUpsert([{
        id: `skill_${skill.id}`,
        values: embedding,
        metadata: {
          type: 'marketing_skill',
          skill_name: skill.name,
          skill_category: skill.category,
          task_types: skill.taskTypes.join(','),
          content: skill.content.slice(0, 30000)
        }
      }]);
      console.log(`  ✓ ${skill.name}`);
    } catch (err) {
      console.error(`  ✗ ${skill.name}: ${err.message}`);
    }
  }
  console.log('Marketing skills injection complete.');
}

// ── Retrieve relevant skills from Pinecone ───────────────────────────────────
async function getRelevantSkills(getEmbedding, pineconeQuery, taskType, businessType, goal, topK = 2) {
  try {
    const query = `${taskType} ${businessType || 'local business'} ${goal || 'marketing'} strategy`;
    const vector = await getEmbedding(query);
    const result = await pineconeQuery(vector, { type: { $eq: 'marketing_skill' } }, topK);
    const matches = (result.matches || []).filter(m => m.score > 0.5 && m.metadata?.content);
    return matches.map(m => ({
      name: m.metadata.skill_name,
      content: m.metadata.content,
      score: m.score
    }));
  } catch {
    return [];
  }
}

// ── All 15 marketing skill frameworks ────────────────────────────────────────
function getAllSkillKnowledge() {
  return [
    {
      id: 'ad_creative_frameworks',
      name: 'Ad Creative Frameworks',
      category: 'advertising',
      taskTypes: ['paid_ad', 'ad_copy', 'social_post'],
      content: `AD CREATIVE EXPERT FRAMEWORKS:

PLATFORM SPECS:
- Google RSA: Headline max 30 chars (up to 15), Description max 90 chars (up to 4)
- Meta Feed: Primary text 125 chars visible, Headline 40 chars, Description 30 chars
- Meta Story: Full screen, text overlay max 20% of image, 15-second video
- LinkedIn: Headline 70 chars, Description 100 chars, Primary text 600 chars
- TikTok: Caption 2,200 chars, on-screen text brief and punchy

PRIMARY TEXT FORMULAS:
PAS (Problem-Agitate-Solve): [Problem] / [Agitate pain] / [Solution] / [CTA]
BAB (Before-After-Bridge): [Current pain] / [Desired state] / [Your product as bridge]
Social Proof Lead: ["Impressive quote"] / [What you do] / [CTA]

HEADLINE FORMULAS:
- "[Number] [People] [Outcome] with [Product]"
- "The [Adjective] Way to [Achieve Outcome]"
- "[Achieve Outcome] Without [Pain Point]"
- "Stop [Pain]. Start [Pleasure]."

PERFORMANCE RULES:
- Hook in first 3 seconds (video) or first line (text)
- One message per ad — never try to say everything
- Match creative to audience awareness stage
- Always include social proof when available
- CTA must match objective: awareness → "Learn More", conversion → "Buy Now"
- Local businesses: always name the city in ad copy`
    },

    {
      id: 'social_content_strategy',
      name: 'Social Content Strategy',
      category: 'social_media',
      taskTypes: ['social_post', 'content_calendar', 'instagram', 'facebook'],
      content: `SOCIAL CONTENT EXPERT FRAMEWORKS:

PLATFORM POSTING STRATEGY:
- Instagram: 1-2 feed posts + Stories daily, Reels 3-5x/week
- Facebook: 1-2x/day, native video outperforms links
- TikTok: 1-4x/day, trends matter, hook in first 2 seconds
- LinkedIn: 3-5x/week, carousels get 3x engagement

CONTENT PILLARS (3-5 pillars):
- Educational (30%): How-tos, tips, industry knowledge
- Behind the scenes (20%): Process, team, authentic moments
- Social proof (20%): Reviews, results, testimonials
- Promotional (10%): Offers, products, services
- Engagement (20%): Questions, polls, community

HOOKS THAT STOP THE SCROLL:
- "Did you know [surprising fact]?"
- "Stop doing [common mistake]"
- "We tried [thing] for 30 days — here's what happened"
- "[Number] things [business type] owners wish they knew sooner"

LOCAL BUSINESS SOCIAL RULES:
- Tag the city/neighborhood in every post
- Use local hashtags: #[city] #[neighborhood]
- Post at peak times: 7-9am, 12-2pm, 6-9pm
- Stories: show the real business
- Always respond to comments within 2 hours`
    },

    {
      id: 'copywriting_principles',
      name: 'Copywriting Principles & Frameworks',
      category: 'content',
      taskTypes: ['social_post', 'paid_ad', 'email', 'landing_page'],
      content: `EXPERT COPYWRITING FRAMEWORKS:

CORE PRINCIPLES:
- Clarity over cleverness
- Benefits over features: features = what it does, benefits = what it means for customer
- Specificity: "Cut from 4 hours to 15 minutes" beats "Save time"
- Customer language: mirror how customers describe their problem
- One idea per section
- Active not passive voice
- Remove qualifiers: "almost", "very", "really" — cut them

HEADLINE FORMULAS:
- Outcome: "[Achieve outcome] without [pain point]"
- Problem: "Never [unpleasant event] again"
- Proof: "[Number] [people] use [product] to [outcome]"
- Contrast: "Stop [pain]. Start [pleasure]."

LOCAL BUSINESS WRITING:
- Lead with the neighborhood or city
- Use "you" and "your"
- Reference local landmarks, events, seasons
- Use the language customers actually speak
- Short sentences. Local audiences scan, not read.
- Every copy: "Why should I care? Why now? Why you?"`
    },

    {
      id: 'email_sequence_strategy',
      name: 'Email Sequence Strategy',
      category: 'email',
      taskTypes: ['email', 'email_sequence', 'newsletter'],
      content: `EMAIL SEQUENCE EXPERT FRAMEWORKS:

CORE PRINCIPLES:
- One email, one job: single purpose and one CTA
- Value before ask: build trust before selling
- Relevance over volume

WELCOME SEQUENCE (7 emails):
1 (Immediate): Welcome + deliver promise + next action
2 (Day 1-2): Quick win in 10 minutes
3 (Day 3-4): Story — why you built this
4 (Day 5-6): Social proof — case study
5 (Day 7-8): Overcome main objection
6 (Day 9-11): Core feature highlight
7 (Day 12-14): Conversion — clear offer + risk reversal

SUBJECT LINE FORMULAS:
- "[Name], [specific thing] is ready"
- "Quick question about [topic]"
- "[Number] ways to [outcome] this week"

LOCAL BUSINESS EMAIL RULES:
- Send Tuesday-Thursday 9-11am local time
- Max 200 words
- One offer per email
- Write in customer's primary language
- Mobile-first: big CTA button`
    },

    {
      id: 'paid_ads_strategy',
      name: 'Paid Ads Strategy',
      category: 'advertising',
      taskTypes: ['paid_ad', 'meta_ads', 'google_ads', 'campaign'],
      content: `PAID ADS EXPERT FRAMEWORKS:

PLATFORM SELECTION:
- Google Ads: high-intent search
- Meta: demand generation, visual products, local awareness
- LinkedIn: B2B, decision-makers
- TikTok: brand awareness, 18-34 demographic

BUDGET ALLOCATION:
- Testing (month 1): 70% awareness, 30% conversion
- Scaling: 30% awareness, 50% conversion, 20% retargeting
- Mature: 20% awareness, 40% conversion, 40% retargeting

META ADS:
- Audience: 500K-2M for cold traffic
- Test 3+ creatives per ad set
- Let ads run 3-5 days before judging
- Video: hook in 3 seconds, value in 15, CTA at end
- Local radius: 5-15km around location

GOOGLE ADS:
- RSA: 5-8 headlines, 2-4 descriptions
- Always add negative keywords before launch
- Must add location extension for local business

BUDGET GUIDANCE:
- Under €100/mo: Facebook only, awareness
- €100-300: Facebook + retargeting
- €300-500: Facebook + Google Brand
- €500+: Full funnel

LOCAL AD COPY RULES:
- Name the city: "Prishtina's #1 [service]"
- Include specific offer
- Phone number if service business
- Social proof: "500+ happy clients in [city]"`
    },

    {
      id: 'marketing_psychology',
      name: 'Marketing Psychology Principles',
      category: 'psychology',
      taskTypes: ['social_post', 'paid_ad', 'email', 'landing_page', 'general'],
      content: `MARKETING PSYCHOLOGY FRAMEWORKS:

SOCIAL PROOF: "500+ businesses trust us", star ratings, user photos
SCARCITY: "Offer ends Friday", "Only 3 spots left"
LOSS AVERSION: "Don't miss out", "Every day without X costs you Y"
ANCHORING: Show higher price first then discounted
RECIPROCITY: Give value first, free tip before selling
AUTHORITY: Years in business, certifications, specific numbers
LIKING: Real team photos, conversational language, shared local identity

JOBS TO BE DONE:
People don't buy products — they hire them to get a job done.
- Gym member wants confidence, not exercise
- Restaurant customer wants experience, not food
Frame product around outcome, not feature.`
    },

    {
      id: 'launch_strategy',
      name: 'Product Launch Strategy',
      category: 'launch',
      taskTypes: ['launch', 'campaign', 'announcement', 'content_calendar'],
      content: `LAUNCH STRATEGY FRAMEWORKS:

PRE-LAUNCH (2-4 weeks): Tease, build waitlist, behind-scenes, solve problems free
LAUNCH DAY: Email list first, post all channels, go live, reply to every comment
POST-LAUNCH (2 weeks): Share social proof, post results, address objections

LOCAL BUSINESS CONTENT CALENDAR:
Week 1: Awareness — what problem you solve
Week 2: Education — how you solve it
Week 3: Social proof — results and testimonials
Week 4: Offer — launch promotion with deadline

RELAUNCH: Every new offer = mini-launch. New season = new campaign angle.`
    },

    {
      id: 'churn_prevention',
      name: 'Churn Prevention & Retention',
      category: 'retention',
      taskTypes: ['email', 'retention', 'customer_success'],
      content: `CHURN PREVENTION FRAMEWORKS:

SAVE OFFERS BY REASON:
- "Too expensive" → 20-30% discount or downgrade
- "Not using it" → Pause + tutorial
- "Missing feature" → Roadmap preview
- "Switching" → Match if possible

RETENTION TRIGGERS:
- Day 3 no login → Quick start email
- Day 7 → Personal outreach
- Day 21 low usage → Feature highlight
- Before renewal → Value recap

DUNNING (failed payment):
Day 0: Friendly notice
Day 3: Update payment link
Day 7: Access at risk
Day 14: Final notice`
    },

    {
      id: 'onboarding_cro',
      name: 'Onboarding & Activation Strategy',
      category: 'conversion',
      taskTypes: ['onboarding', 'activation', 'user_journey'],
      content: `ONBOARDING CRO FRAMEWORKS:

ACTIVATION = moment user first experiences core value. Everything drives here.

PRINCIPLES:
- Show value before asking for info
- Progress bar increases completion 20-30%
- Celebrate micro-wins
- Pre-fill wherever possible
- Mobile-first

EMPTY STATE: Never show blank dashboard — show example data, guide, or social proof.

ACTIVATION EMAILS (first 7 days):
Day 0: Welcome + one action
Day 1: Did you complete it?
Day 2: Quick win in 5 minutes
Day 3: Similar business success story
Day 5: Key feature highlight
Day 7: Personal check-in`
    },

    {
      id: 'pricing_strategy',
      name: 'Pricing & Packaging Strategy',
      category: 'pricing',
      taskTypes: ['pricing', 'packaging', 'upgrade'],
      content: `PRICING FRAMEWORKS:

THREE-TIER STRUCTURE:
- Tier 1 (Starter): entry point, limited features
- Tier 2 (Pro): HERO TIER — "Most Popular" badge, 3-4x Tier 1 price, 5-6x value
- Tier 3 (Agency): power users, highest margin

TACTICS:
- €29 not €30 (charm pricing)
- Show monthly even if annual
- "Less than €1/day"
- ROI: "Pays for itself with one new client"

UPGRADE TRIGGERS:
- User hits limit
- Tries premium feature
- Achieves success
- 30 days before renewal`
    },

    {
      id: 'cold_email_strategy',
      name: 'Cold Email Strategy',
      category: 'outreach',
      taskTypes: ['cold_email', 'outreach', 'prospecting'],
      content: `COLD EMAIL FRAMEWORKS:

STRUCTURE (50-125 words):
Line 1: Personalized observation (1 sentence)
Line 2: What you do for them (1 sentence)
Line 3: Specific proof (1 sentence)
Line 4: Single clear ask (1 sentence)

FOLLOW-UP (5 emails, 3 weeks):
1: Full pitch (Day 1)
2: Brief bump (Day 4)
3: Different angle (Day 8)
4: Case study (Day 13)
5: Breakup email (Day 18)

LOCAL OUTREACH:
- Reference their city, neighborhood
- Mention something specific (their Instagram, a review)
- Keep it conversational`
    },

    {
      id: 'content_strategy',
      name: 'Content Strategy Framework',
      category: 'content',
      taskTypes: ['content_calendar', 'blog', 'content_strategy'],
      content: `CONTENT STRATEGY FRAMEWORKS:

AWARENESS STAGES:
- Unaware → educational content
- Problem-aware → comparison content
- Solution-aware → differentiation content
- Product-aware → proof content
- Most aware → offer content

LOCAL BUSINESS PILLARS:
1. Local expertise: "[City] guide to [topic]"
2. Behind the scenes
3. Customer results
4. Educational tips
5. Promotional offers

CALENDAR RHYTHM:
Mon: Educational tip
Wed: Customer story
Fri: Promotional offer
Daily: Stories (behind scenes, polls)
Weekly: One Reel or TikTok

SEO LOCAL:
- "[Service] in [City]" in every page title
- GMB: post 3x/week, respond to all reviews
- Neighborhood names, landmarks as keywords`
    },

    {
      id: 'referral_program',
      name: 'Referral Program Strategy',
      category: 'growth',
      taskTypes: ['referral', 'word_of_mouth', 'growth'],
      content: `REFERRAL FRAMEWORKS:

TIMING: Ask after success moment, positive review, plan upgrade, 90 days active use.
STRUCTURE: Double-sided rewards outperform single by 2-3x.

LOCAL TACTICS:
- "Bring a friend" — both get discount
- Google review incentive
- WhatsApp referral to 3 friends
- Cross-referral with complementary local business`
    },

    {
      id: 'page_cro',
      name: 'Page Conversion Rate Optimization',
      category: 'conversion',
      taskTypes: ['landing_page', 'homepage', 'conversion'],
      content: `PAGE CRO FRAMEWORKS:

ABOVE THE FOLD:
- Headline: specific outcome customer wants
- Subheadline: how you deliver it
- CTA: action verb + benefit, high contrast
- Social proof near CTA

PAGE ORDER:
1. Hero + CTA + proof
2. Problem agitation
3. Solution introduction
4. How it works (3 steps)
5. Features → benefits
6. Testimonials
7. FAQ / objections
8. Final CTA with urgency

CTA RULES:
- First person: "Start My Free Trial"
- Benefit-driven: "Get More Clients"
- Remove risk: "No credit card required"
- One primary CTA per page

LOCAL LANDING PAGE:
- City in headline
- Real photos (no stock)
- Local phone number
- Google Maps embed
- Local reviews`
    },

    {
      id: 'competitor_strategy',
      name: 'Competitive Positioning',
      category: 'positioning',
      taskTypes: ['competitor', 'positioning', 'differentiation'],
      content: `COMPETITIVE POSITIONING FRAMEWORKS:

DIFFERENTIATION:
- Find where competitors are weak or silent
- Own a niche: geography, industry, customer size
- Position opposite: if they're complex, be simple
- Be specific: "marketing for Prishtina restaurants" beats "marketing for businesses"

POSITIONING STATEMENT:
"For [customer] who [problem], [product] is [category] that [benefit]. Unlike [alternative], we [differentiator]."

LOCAL ADVANTAGE:
- You understand local market, language, culture
- You're accessible: local support, local team
- "X businesses in [city] trust us"
- International tools don't understand local dynamics — you do`
    }
  ];
}

module.exports = { injectAllSkills, getRelevantSkills, getAllSkillKnowledge };
