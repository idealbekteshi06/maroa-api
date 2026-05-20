'use strict';

/**
 * routes/ideas.js — marketing ideas engine endpoints.
 *
 * Public endpoints:
 *   POST  /api/ideas/generate    — fire-and-forget Claude-generated ideas
 *   GET   /api/ideas/:userId     — list recent ideas
 *   PATCH /api/ideas/:ideaId     — update an idea
 *
 * Carved from server.js per the routes/waitlist.js pattern.
 */

function register({
  app,
  getProfile,
  callClaude,
  pCity,
  claudeBiz,
  sbGet,
  sbPost,
  sbPatch,
  storeInsight,
  checkOrchestrationIdempotency,
  recordOrchestrationTaskRun,
  extractJSON,
  logError,
  log,
  safePublicError,
}) {
  app.post('/api/ideas/generate', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Generating 10 marketing ideas' });
    setImmediate(async () => {
      try {
        if (await checkOrchestrationIdempotency(userId, 'ideas_generate')) {
          log('/api/ideas/generate', `skip idempotent userId=${userId}`);
          return;
        }
        const p = await getProfile(userId);
        if (!p) {
          log('/api/ideas/generate', `ABORT: no profile found for userId=${userId}`);
          await logError(userId, 'ideas-generate', 'No profile found for userId=' + userId).catch(() => {});
          return;
        }
        log('/api/ideas/generate', `Profile found: ${p.business_name} (${p.business_type})`);

        // P1-8 (audit 2026-05-20): Past-ideas grounding — the AI gets smarter
        // every run by seeing what we already suggested. Stops it from
        // pitching the same "host an event!" idea every Monday.
        let pastIdeasBlock = '';
        try {
          const recent = await sbGet(
            'marketing_ideas',
            `user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=15&select=idea,status`,
          );
          if (Array.isArray(recent) && recent.length) {
            const titles = recent
              .map((r, i) => `${i + 1}. ${(r.idea || '').slice(0, 140)}${r.status ? ` (${r.status})` : ''}`)
              .join('\n');
            pastIdeasBlock = `\nIDEAS WE ALREADY SUGGESTED (do not repeat — generate fresh angles):\n${titles}\n\n`;
          }
        } catch {
          /* soft-fail */
        }

        let result = await callClaude(
          `${pastIdeasBlock}You are a marketing strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nBudget: ${p.monthly_budget}\nGoal: ${p.primary_goal}\nLanguage: ${p.primary_language}\n\nGenerate 5 SPECIFIC marketing ideas ranked by impact. Keep each idea brief (1-2 sentences each). Do NOT duplicate anything in the "already suggested" list above; reach for unexplored angles.\n\nReturn ONLY valid JSON array (no markdown, no code fences):\n[{"idea":"string","category":"string","priority":"high|medium|low","estimated_impact":"string","how_to_execute":"3 brief steps","budget_required":"string","time_to_results":"string"}]`,
          'idea',
          4000,
          claudeBiz(userId)
        );
        log(
          '/api/ideas/generate',
          `Claude returned: type=${typeof result}, isArray=${Array.isArray(result)}, hasRaw=${!!result?._raw}, keys=${Object.keys(result || {}).slice(0, 5)}`
        );
        if (result?._raw) {
          const parsed = extractJSON(result._raw);
          if (parsed) {
            log('/api/ideas/generate', `Re-parsed _raw: type=${typeof parsed}, isArray=${Array.isArray(parsed)}`);
            result = parsed;
          }
        }
        const ideas = Array.isArray(result) ? result : Array.isArray(result?.ideas) ? result.ideas : [];
        if (!ideas.length) {
          const sample = JSON.stringify(result).slice(0, 400);
          log('/api/ideas/generate', `No ideas parsed — result: ${sample}`);
          try {
            await sbPost('errors', {
              business_id: userId,
              workflow_name: 'ideas-generate-parse',
              error_message: 'No ideas parsed: ' + sample,
            });
          } catch {
            /* soft-fail */
          }
          return;
        }
        for (const idea of ideas.slice(0, 10)) {
          if (!idea?.idea || typeof idea.idea !== 'string') continue;
          await sbPost('marketing_ideas', {
            user_id: userId,
            idea: idea.idea,
            category: idea.category || 'general',
            priority: idea.priority || 'medium',
            estimated_impact: idea.estimated_impact || '',
            how_to_execute: idea.how_to_execute || '',
            budget_required: idea.budget_required || '',
            time_to_results: idea.time_to_results || '',
          }).catch(() => {});
        }
        const topIdeas = ideas
          .filter((i) => i.priority === 'high')
          .slice(0, 3)
          .map((i) => i.idea)
          .join('; ');
        storeInsight(userId, 'ideas', 'strategy', 'top_priority_ideas', topIdeas || ideas[0]?.idea || '');
        await recordOrchestrationTaskRun(userId, 'ideas_generate');
        log('/api/ideas/generate', `✅ ${ideas.length} marketing ideas generated`);
      } catch (err) {
        const msg = err?.message || String(err);
        console.error('[ideas] ERROR:', msg);
        log('/api/ideas/generate', `CAUGHT ERROR: ${msg.slice(0, 200)}`);
        try {
          await sbPost('errors', {
            business_id: userId,
            workflow_name: 'ideas-generate',
            error_message: msg.slice(0, 500),
          });
        } catch {
          /* soft-fail */
        }
      }
    });
  });

  app.get('/api/ideas/:userId', async (req, res) => {
    try {
      if (req.params.userId !== req.user?.id) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot read another user' } });
      }
      const r = await sbGet(
        'marketing_ideas',
        `user_id=eq.${encodeURIComponent(req.params.userId)}&order=created_at.desc&limit=20`,
      );
      res.json({ ideas: r });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });

  app.patch('/api/ideas/:ideaId', async (req, res) => {
    try {
      // Ownership: only patch ideas this user owns. Filter by id AND user_id
      // so PostgREST returns nothing for cross-user attempts.
      if (!req.user?.id) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in first' } });
      }
      await sbPatch(
        'marketing_ideas',
        `id=eq.${encodeURIComponent(req.params.ideaId)}&user_id=eq.${encodeURIComponent(req.user.id)}`,
        req.body,
      );
      res.json({ updated: true });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });
}

module.exports = { register };
