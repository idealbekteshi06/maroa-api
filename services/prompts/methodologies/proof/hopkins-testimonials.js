'use strict';

/**
 * Hopkins Testimonials — specific, dated, photographic.
 *
 * Source: Claude Hopkins, "Scientific Advertising" (1923).
 *
 * Hopkins's rule on testimonials: vague praise is worthless. A good
 * testimonial has a name, a date, a place, a specific number, and ideally
 * a photo. "Mary smiled" beats "customers love us". "Mary saved 4 hours
 * last Tuesday" beats both.
 *
 * Manipulation_risk = 1. The framework is about NOT faking proof.
 */

const { makeFix, applicability } = require('../_helpers');

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const fixes = [];
  const hasTestimonial = /"|'.*'|—\s*\w+\s+[A-Z]/.test(draft) || /\b(says|told us|review)\b/i.test(draft);
  if (!hasTestimonial) return { score: 0.3, fixes, reasoning: 'no testimonial detected' };

  // If testimonial present, check Hopkins criteria
  const hasName = /—\s*[A-Z]\w+/.test(draft) || /[A-Z]\w+ [A-Z]\.|[A-Z]\w+ [A-Z]\w+/.test(draft);
  const hasNumber = /\d/.test(draft);
  const hasDate = /\b(last (week|month|year)|in \d{4}|\d{1,2}\/\d{1,2})\b/i.test(draft);
  const hasPhoto = /\b(photo|image|pictured|shown)\b/i.test(draft);

  if (!hasName)
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Hopkins: testimonial without attribution',
        suggestion: 'Add a full name + city or company.',
      })
    );
  if (!hasNumber)
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Hopkins: testimonial without a specific number',
        suggestion: 'Add the concrete result (hours saved, $ earned, %).',
      })
    );
  if (!hasDate)
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Hopkins: testimonial without a date',
        suggestion: 'Add when this happened — "last Tuesday", "in March 2026".',
      })
    );

  const present = [hasName, hasNumber, hasDate, hasPhoto].filter(Boolean).length;
  return {
    score: present / 4,
    fixes,
    reasoning: `Hopkins: name${hasName} number${hasNumber} date${hasDate} photo${hasPhoto}`,
  };
}

function generateFromSpec({ customerName, location, specificResult, date }) {
  return {
    structure: 'Specific + dated + attributed testimonial',
    prompt_segments: [
      `When using a testimonial, format: "${specificResult || '[concrete result with a number]'}." — ${customerName || '[full name]'}, ${location || '[city / company]'}, ${date || '[date]'}.`,
      'Vague praise ("great product!") is worthless. Use specifics or omit.',
    ],
  };
}

module.exports = {
  id: 'hopkins-testimonials',
  name: 'Hopkins Testimonials (specific, dated, photographic)',
  category: 'proof',
  source_citation: 'Claude Hopkins, "Scientific Advertising" (1923)',
  applicability: applicability({}),
  invariants: [
    { id: 'attribution', rule: 'Testimonials must have full attribution', kind: 'must_have' },
    { id: 'specific', rule: 'Testimonials must contain a specific number or moment', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
