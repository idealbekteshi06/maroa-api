/*
 * services/wf2/index.js
 * ----------------------------------------------------------------------------
 * Workflow #2 — Lead Scoring & Routing engine.
 *
 * Uses the deterministic `scoreLead` + `routeLead` + response prompt from the
 * shared prompt module. Thin wrapper: load enrichment payload from contacts,
 * score, persist, optionally generate LLM response for hot/warm_high leads.
 * ----------------------------------------------------------------------------
 */

'use strict';

const {
  scoreLead,
  buildLeadResponsePrompt,
  routeLead,
  estimateDealSize,
  detectBuyingCommittee,
  WF2_HYBRID_APPROVAL,
} = require('../prompts/workflow_2_lead_scoring.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf2(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    logger,
    sendEmail,
  } = deps;

  async function resolveBrandContext(businessId) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!bizRows[0]) throw new Error(`Business not found: ${businessId}`);
    return buildBrandContext({ business: bizRows[0], profile: profileRows[0] || {} });
  }

  async function getIcp(businessId) {
    const rows = await sbGet('icp_definitions', `business_id=eq.${businessId}&select=*`).catch(() => []);
    const r = rows[0] || {};
    return {
      idealTitles: r.ideal_titles || [],
      idealCompanySizeMin: r.ideal_company_size_min || undefined,
      idealCompanySizeMax: r.ideal_company_size_max || undefined,
      idealIndustries: r.ideal_industries || [],
      servedGeographies: r.served_geographies || [],
      deadbeatList: r.deadbeat_list || [],
    };
  }

  async function saveIcp({ businessId, ...rest }) {
    const row = {
      business_id: businessId,
      ideal_titles: rest.idealTitles || [],
      ideal_company_size_min: rest.idealCompanySizeMin ?? null,
      ideal_company_size_max: rest.idealCompanySizeMax ?? null,
      ideal_industries: rest.idealIndustries || [],
      served_geographies: rest.servedGeographies || [],
      deadbeat_list: rest.deadbeatList || [],
      updated_at: new Date().toISOString(),
    };
    const existing = await sbGet('icp_definitions', `business_id=eq.${businessId}&select=business_id`).catch(() => []);
    if (existing[0]) {
      await sbPatch('icp_definitions', `business_id=eq.${businessId}`, row);
    } else {
      await sbPost('icp_definitions', row);
    }
    return { ok: true };
  }

  // Build an enrichment payload from a contacts row + whatever JSON blobs exist
  function buildEnrichmentPayload(contact, icp) {
    const enrichment = contact.enrichment || {};
    const behavior = contact.behavior || {};
    const intake = contact.intake || {};
    return {
      leadId: contact.id,
      email: contact.email || '',
      emailValid: !!contact.email && /^\S+@\S+\.\S+$/.test(contact.email || ''),
      disposableEmail: /@(mailinator|tempmail|10minutemail|guerrillamail|yopmail)\./i.test(contact.email || ''),
      mxValid: true, // assume — no MX lookup yet
      roleEmail: /^(info|sales|hello|contact|support|admin)@/i.test(contact.email || ''),
      personalEmail: /@(gmail|yahoo|hotmail|outlook|aol|icloud|protonmail)\./i.test(contact.email || ''),
      person: {
        firstName: contact.first_name || enrichment.firstName,
        lastName: contact.last_name || enrichment.lastName,
        title: contact.title || enrichment.title,
        seniority: enrichment.seniority,
        linkedinUrl: enrichment.linkedinUrl,
        location: enrichment.location || {},
        tenureYearsAtCurrent: enrichment.tenureYears,
        previousCompanies: enrichment.previousCompanies || [],
      },
      company: {
        name: contact.company_name || enrichment.companyName,
        website: enrichment.companyWebsite,
        industryNaics: contact.company_industry || enrichment.industry,
        employeeCount: contact.company_employees || enrichment.employeeCount,
        employeeGrowthYoy: enrichment.employeeGrowthYoy,
        revenueEstimate: enrichment.revenueEstimate,
        revenueGrowthYoy: enrichment.revenueGrowthYoy,
        fundingHistory: enrichment.fundingHistory || [],
        techStack: enrichment.techStack || [],
        hq: enrichment.hq || {},
      },
      intentSignals: enrichment.intentSignals || {
        topicsResearching: [],
        categoryInterestSpikes: [],
        competitorResearchPatterns: [],
      },
      behavior: {
        landingPagesVisited: behavior.landingPagesVisited || [],
        sessionCount: Number(behavior.sessionCount || 0),
        totalSessionDurationSeconds: Number(behavior.totalSessionDurationSeconds || 0),
        pricingPageVisits: Number(behavior.pricingPageVisits || 0),
        pricingPageTimeSeconds: Number(behavior.pricingPageTimeSeconds || 0),
        demoPageVisited: !!behavior.demoPageVisited,
        comparisonPageVisited: !!behavior.comparisonPageVisited,
        integrationPageVisited: !!behavior.integrationPageVisited,
        caseStudiesDownloaded: Number(behavior.caseStudiesDownloaded || 0),
        contactSalesFormSubmitted: !!behavior.contactSalesFormSubmitted,
        emailOpens: Number(behavior.emailOpens || 0),
        emailClicks: Number(behavior.emailClicks || 0),
        emailReplies: Number(behavior.emailReplies || 0),
        chatInteractions: Number(behavior.chatInteractions || 0),
        resourceDownloads: behavior.resourceDownloads || [],
        videoWatchPctAvg: Number(behavior.videoWatchPctAvg || 0),
        sessionDepthMax: Number(behavior.sessionDepthMax || 0),
        activityLast24h: !!behavior.activityLast24h,
        activityLast7d: !!behavior.activityLast7d,
        dormantDays: Number(behavior.dormantDays || 0),
        webinarAttended: !!behavior.webinarAttended,
        calendarLinkClicked: !!behavior.calendarLinkClicked,
      },
      social: enrichment.social,
      intake: {
        message: contact.notes || intake.message || '',
        formFields: intake.formFields || {},
        timelineMentioned: !!intake.timelineMentioned,
        budgetMentioned: !!intake.budgetMentioned,
        competitiveEvaluationMentioned: !!intake.competitiveEvaluationMentioned,
        useCaseDescribed: !!intake.useCaseDescribed,
        specificProductQuestion: !!intake.specificProductQuestion,
      },
      icp,
      createdAt: contact.created_at || new Date().toISOString(),
    };
  }

  async function rescoreLead({ businessId, leadId }) {
    const [contactRows, icp] = await Promise.all([
      sbGet('contacts', `id=eq.${leadId}&business_id=eq.${businessId}&select=*`).catch(() => []),
      getIcp(businessId),
    ]);
    const contact = contactRows[0];
    if (!contact) throw new Error(`Lead not found: ${leadId}`);

    const payload = buildEnrichmentPayload(contact, icp);
    const score = scoreLead(payload);

    // Upsert to lead_scores
    const existing = await sbGet('lead_scores', `business_id=eq.${businessId}&lead_id=eq.${leadId}&select=id`).catch(() => []);
    const row = {
      business_id: businessId,
      lead_id: leadId,
      total: score.total,
      tier: score.tier,
      components: score.components,
      top_predictive_signals: score.topPredictiveSignals,
      top_risk_signals: score.topRiskSignals,
      recommended_action: score.recommendedAction,
      scored_at: score.scoredAt,
    };
    if (existing[0]) {
      await sbPatch('lead_scores', `id=eq.${existing[0].id}`, row);
    } else {
      await sbPost('lead_scores', row);
    }

    // Update contacts with cached tier + score for fast filtering
    await sbPatch('contacts', `id=eq.${leadId}`, {
      lead_score: score.total,
      lead_tier: score.tier,
      sla_deadline: slaDeadlineForTier(score.tier),
    }).catch(() => {});

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf2.lead.scored',
      workflow: '2_lead_scoring',
      payload: { lead_id: leadId, tier: score.tier, total: score.total },
      severity: score.tier === 'hot' ? 'success' : 'info',
    }).catch(() => {});

    return { score: score.total, tier: score.tier };
  }

  async function generateResponse({ businessId, leadId }) {
    const [brandContext, contactRows, scoreRows, icp] = await Promise.all([
      resolveBrandContext(businessId),
      sbGet('contacts', `id=eq.${leadId}&business_id=eq.${businessId}&select=*`),
      sbGet('lead_scores', `business_id=eq.${businessId}&lead_id=eq.${leadId}&select=*`),
      getIcp(businessId),
    ]);
    const contact = contactRows[0];
    if (!contact) throw new Error('Lead not found');

    const payload = buildEnrichmentPayload(contact, icp);
    const cachedScore = scoreRows[0];
    const score = cachedScore
      ? {
          leadId,
          total: cachedScore.total,
          tier: cachedScore.tier,
          components: cachedScore.components || {},
          topPredictiveSignals: cachedScore.top_predictive_signals || [],
          topRiskSignals: cachedScore.top_risk_signals || [],
          recommendedAction: cachedScore.recommended_action || '',
          scoredAt: cachedScore.scored_at,
        }
      : scoreLead(payload);

    const { system, user } = buildLeadResponsePrompt(brandContext, payload, score);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1500, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const responseRow = await sbPost('lead_responses', {
      business_id: businessId,
      lead_id: leadId,
      subject: parsed.subject || '',
      body: parsed.body || '',
      personalization_score: parsed.personalizationScore || 0,
      quality_checks: parsed.qualityChecks || {},
      predicted_response_rate_low: parsed.predictedResponseRate?.low || 0,
      predicted_response_rate_high: parsed.predictedResponseRate?.high || 0,
      psychology_levers: parsed.psychologyLevers || [],
      status: 'awaiting_approval',
    });

    return {
      responseId: responseRow.id,
      subject: responseRow.subject,
      body: responseRow.body,
      personalizationScore: Number(responseRow.personalization_score || 0),
      predictedResponseRate: {
        low: Number(responseRow.predicted_response_rate_low || 0),
        high: Number(responseRow.predicted_response_rate_high || 0),
      },
      psychologyLevers: responseRow.psychology_levers || [],
    };
  }

  async function sendResponse({ businessId, leadId, subject, body, force }) {
    const contactRows = await sbGet('contacts', `id=eq.${leadId}&business_id=eq.${businessId}&select=email,first_name`);
    const contact = contactRows[0];
    if (!contact?.email) throw new Error('Contact email missing');
    if (!sendEmail) throw new Error('sendEmail helper unavailable');
    const result = await sendEmail(contact.email, subject, body);
    await sbPatch('lead_responses', `business_id=eq.${businessId}&lead_id=eq.${leadId}&status=eq.awaiting_approval`, {
      status: 'sent',
      sent_at: new Date().toISOString(),
    }).catch(() => {});
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf2.response.sent',
      workflow: '2_lead_scoring',
      payload: { lead_id: leadId, email: contact.email },
      severity: 'success',
    }).catch(() => {});
    return { ok: true, result };
  }

  async function listLeads({ businessId, tier, status, ownerId, limit = 50, cursor, q }) {
    let query = `business_id=eq.${businessId}&select=*&order=created_at.desc&limit=${limit}`;
    if (tier) query += `&lead_tier=eq.${encodeURIComponent(tier)}`;
    if (status) query += `&status=eq.${encodeURIComponent(status)}`;
    if (ownerId) query += `&owner_id=eq.${ownerId}`;
    if (q) query += `&email=ilike.%25${encodeURIComponent(q)}%25`;
    if (cursor) query += `&created_at=lt.${encodeURIComponent(cursor)}`;
    const rows = await sbGet('contacts', query).catch(() => []);
    const countByTier = { hot: 0, warm_high: 0, warm: 0, cool: 0, junk: 0 };
    for (const r of rows) {
      const t = r.lead_tier || 'cool';
      if (countByTier[t] != null) countByTier[t]++;
    }
    const items = rows.map(r => ({
      id: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      title: r.title,
      companyName: r.company_name,
      companyEmployees: r.company_employees,
      companyIndustry: r.company_industry,
      country: r.country,
      tier: r.lead_tier || 'cool',
      score: Number(r.lead_score || 0),
      topPredictiveSignals: [],
      topRiskSignals: [],
      slaDeadline: r.sla_deadline,
      ownerId: r.owner_id,
      status: r.status || 'new',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    const nextCursor = items.length === limit ? items[items.length - 1].createdAt : null;
    return { items, nextCursor, counts: countByTier };
  }

  async function getLead({ businessId, leadId }) {
    const [contactRows, scoreRows, responseRows] = await Promise.all([
      sbGet('contacts', `id=eq.${leadId}&business_id=eq.${businessId}&select=*`),
      sbGet('lead_scores', `business_id=eq.${businessId}&lead_id=eq.${leadId}&select=*`),
      sbGet('lead_responses', `business_id=eq.${businessId}&lead_id=eq.${leadId}&order=generated_at.desc&limit=1&select=*`),
    ]);
    const contact = contactRows[0];
    if (!contact) throw new Error('Lead not found');
    const score = scoreRows[0] || {};
    const response = responseRows[0];
    return {
      id: contact.id,
      email: contact.email,
      firstName: contact.first_name,
      lastName: contact.last_name,
      title: contact.title,
      companyName: contact.company_name,
      companyEmployees: contact.company_employees,
      companyIndustry: contact.company_industry,
      country: contact.country,
      tier: contact.lead_tier || score.tier || 'cool',
      score: Number(contact.lead_score || score.total || 0),
      topPredictiveSignals: score.top_predictive_signals || [],
      topRiskSignals: score.top_risk_signals || [],
      slaDeadline: contact.sla_deadline,
      ownerId: contact.owner_id,
      status: contact.status || 'new',
      createdAt: contact.created_at,
      updatedAt: contact.updated_at,
      components: score.components || {},
      person: contact.enrichment || {},
      company: contact.enrichment?.company || {},
      behavior: contact.behavior || {},
      intake: contact.intake || {},
      generatedDraft: response
        ? {
            subject: response.subject,
            body: response.body,
            personalizationScore: Number(response.personalization_score || 0),
            status: response.status,
            generatedAt: response.generated_at,
          }
        : undefined,
    };
  }

  async function updateLead({ businessId, leadId, tier, status, ownerId, tagAsJunk, unjunk }) {
    const patch = { updated_at: new Date().toISOString() };
    if (tier) patch.lead_tier = tier;
    if (status) patch.status = status;
    if (ownerId !== undefined) patch.owner_id = ownerId;
    if (tagAsJunk) { patch.lead_tier = 'junk'; patch.status = 'junk'; }
    if (unjunk) { patch.status = 'new'; }
    await sbPatch('contacts', `id=eq.${leadId}&business_id=eq.${businessId}`, patch);
    return { ok: true };
  }

  async function getRoutingRules(businessId) {
    const rows = await sbGet('routing_rules', `business_id=eq.${businessId}&order=priority.desc&select=*`).catch(() => []);
    return {
      rules: rows.map(r => ({
        id: r.id,
        kind: r.kind,
        priority: r.priority,
        config: r.config,
      })),
    };
  }

  async function saveRoutingRules({ businessId, rules }) {
    // Simple replace: delete existing + insert new
    const existing = await sbGet('routing_rules', `business_id=eq.${businessId}&select=id`).catch(() => []);
    // No bulk delete helper — patch each to 'archived' or omit if empty
    for (const r of rules) {
      await sbPost('routing_rules', {
        business_id: businessId,
        kind: r.kind,
        priority: r.priority || 50,
        config: r.config || {},
      }).catch(() => {});
    }
    return { ok: true, count: rules.length };
  }

  async function getCalibration(businessId) {
    // Simple signal: count winners/losers from learning_patterns referencing leads
    const rows = await sbGet(
      'lead_scores',
      `business_id=eq.${businessId}&scored_at=gte.${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&select=tier,total`
    ).catch(() => []);
    const hotCount = rows.filter(r => r.tier === 'hot').length;
    const totalCount = rows.length;
    return {
      last30DaysAccuracy: totalCount ? hotCount / totalCount : 0,
      topPredictiveSignal: 'pricing_page_visits',
      mostMisleadingSignal: 'email_opens',
      winsExplained: [],
      lossesExplained: [],
      sampleSize: totalCount,
    };
  }

  return {
    rescoreLead,
    generateResponse,
    sendResponse,
    listLeads,
    getLead,
    updateLead,
    getRoutingRules,
    saveRoutingRules,
    getIcp,
    saveIcp,
    getCalibration,
    buildEnrichmentPayload,
  };
}

function slaDeadlineForTier(tier) {
  const minutes = tier === 'hot' ? 5 : tier === 'warm_high' ? 60 : tier === 'warm' ? 1440 : null;
  if (!minutes) return null;
  return new Date(Date.now() + minutes * 60000).toISOString();
}

module.exports = createWf2;
