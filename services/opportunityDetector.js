'use strict';

const { detectCountry, getUpcomingHolidays } = require('./countryIntelligence');

function scorePriority(label) {
  if (label === 'high') return 3;
  if (label === 'medium') return 2;
  return 1;
}

function detectPostingGap(profile) {
  const days = Number(profile?.days_since_last_post || 0);
  if (days >= 7) {
    return {
      type: 'posting_gap',
      priority: 'high',
      message: `No posts for ${days} days. Publish today to recover consistency.`,
      action: 'Generate and schedule 3 posts'
    };
  }
  if (days >= 3) {
    return {
      type: 'posting_gap',
      priority: 'medium',
      message: `Posting cadence is slowing (${days} days since last post).`,
      action: 'Publish one engagement post'
    };
  }
  return null;
}

function detectUpcomingHolidayOpportunity(profile) {
  const countryCode = detectCountry(profile || {});
  const holidays = getUpcomingHolidays(countryCode, 10);
  if (!holidays.length) return null;
  const nextHoliday = holidays[0];
  return {
    type: 'seasonal_window',
    priority: nextHoliday.daysUntil <= 3 ? 'high' : 'medium',
    message: `${nextHoliday.name} is in ${nextHoliday.daysUntil} day(s).`,
    action: 'Create a holiday-themed campaign'
  };
}

function detectCompetitorMove(profile) {
  const hasCompetitorSpike = Boolean(profile?.competitor_spike);
  if (!hasCompetitorSpike) return null;
  return {
    type: 'competitor_move',
    priority: 'high',
    message: 'Competitor activity spike detected in your market.',
    action: 'Launch counter-positioning content and one ad test'
  };
}

function detectIncompleteProfile(profile) {
  const checks = ['business_name', 'business_type', 'primary_goal', 'monthly_budget', 'audience_description'];
  const missing = checks.filter(k => !profile?.[k]);
  if (!missing.length) return null;
  return {
    type: 'profile_gap',
    priority: 'medium',
    message: `Profile missing ${missing.length} key field(s): ${missing.join(', ')}`,
    action: 'Complete onboarding profile fields'
  };
}

async function detectOpportunities(userId, profile) {
  if (!userId) throw new Error('userId is required');
  const opportunities = [];

  const postingGap = detectPostingGap(profile);
  if (postingGap) opportunities.push(postingGap);

  const holiday = detectUpcomingHolidayOpportunity(profile);
  if (holiday) opportunities.push(holiday);

  const competitorMove = detectCompetitorMove(profile);
  if (competitorMove) opportunities.push(competitorMove);

  const incomplete = detectIncompleteProfile(profile);
  if (incomplete) opportunities.push(incomplete);

  return opportunities.sort((a, b) => scorePriority(b.priority) - scorePriority(a.priority));
}

module.exports = {
  detectOpportunities
};
