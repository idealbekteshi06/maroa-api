'use strict';

/**
 * routes/research.js — customer-research analyzer endpoint.
 *
 * Public endpoint:
 *   POST /api/research/analyze   — extract JTBD / pain / triggers from reviews
 *
 * Carved from server.js per the routes/waitlist.js pattern.
 */

function register({ app, getProfile, callClaude, pCity, claudeBiz, sbPost, storeInsight, log }) {
  app.post('/api/research/analyze', async (req, res) => {
    const { userId, reviews, feedback } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Analyzing customer insights' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const reviewText = Array.isArray(reviews)
          ? reviews.join('\n')
          : feedback || 'No reviews provided — analyze based on typical customers for this business type';
        const result = await callClaude(
          `You are a customer research expert analyzing ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nCurrent audience: ${p.audience_description}\nReviews/feedback:\n${reviewText}\n\nExtract:\n1. JOBS TO BE DONE (functional, emotional, social)\n2. Top 3 PAIN POINTS with emotional language\n3. TRIGGER EVENTS\n4. DESIRED OUTCOMES in customer words\n5. KEY PHRASES to use in marketing\n\nReturn ONLY valid JSON:\n{"jobs_to_be_done":["string"],"pain_points":["string"],"trigger_events":["string"],"desired_outcomes":["string"],"key_phrases":["string"],"improved_audience_description":"string","content_recommendations":["string"]}`,
          'research',
          1500,
          claudeBiz(userId)
        );
        await sbPost('customer_insights', {
          user_id: userId,
          source: reviews ? 'reviews' : 'ai_analysis',
          insight_type: 'full_analysis',
          content: JSON.stringify(result),
          actionable_suggestion: (result.content_recommendations || []).join('; '),
        });
        storeInsight(
          userId,
          'research',
          'customer',
          'top_pain_points',
          (result.pain_points || []).slice(0, 3).join('; ')
        );
        storeInsight(
          userId,
          'research',
          'customer',
          'customer_language',
          (result.key_phrases || []).slice(0, 5).join('; ')
        );
        storeInsight(
          userId,
          'research',
          'customer',
          'trigger_events',
          (result.trigger_events || []).slice(0, 3).join('; ')
        );
        log('/api/research/analyze', `✅ Customer insights for ${p.business_name}`);
      } catch (err) {
        console.error('[research]', err.message);
      }
    });
  });
}

module.exports = { register };
