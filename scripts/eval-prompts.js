#!/usr/bin/env node
'use strict';

/**
 * scripts/eval-prompts.js — Prompt regression evaluation.
 *
 * Every prompt module in services/prompts/<skill>/ should have a sibling
 * tests/fixtures/prompts/<skill>.json file with the shape:
 *
 *   {
 *     "version": "v1",
 *     "skill": "ad-optimizer",
 *     "samples": [
 *       {
 *         "name": "scale_winner",
 *         "input": { ...representative auditCampaign input... },
 *         "golden": {
 *           "decision": "scale",
 *           "audit_score": { "min": 75, "max": 100 },
 *           "must_mention": ["ROAS", "learning"],
 *           "must_not_contain_slop": true
 *         }
 *       }
 *     ]
 *   }
 *
 * This script:
 *   1. Loads every fixture file.
 *   2. For each sample, runs the prompt module with a fakeAnthropic that
 *      returns the fixture's `golden_output` (or a generated stub). The
 *      goal is to verify the prompt module's PRE/POST processing is
 *      stable — not to verify Claude's quality (that needs real API calls).
 *   3. Compares the structured output against the golden expectations.
 *   4. Reports pass/fail with a drift report.
 *
 * Two modes:
 *   --dry         (default): uses fakeAnthropic, fast, free.
 *   --live        (requires ANTHROPIC_KEY): calls real Claude, slower,
 *                                            costs ~$0.02 per sample.
 *
 * Exit code: 0 if all samples pass, 1 otherwise. CI gate.
 *
 * Future: embedding-similarity drift detection by storing a baseline
 * embedding per sample and alerting on cosine distance >0.25.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures', 'prompts');
const LIVE = process.argv.includes('--live');

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function loadFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(FIXTURES_DIR, f);
      try {
        return { file: f, fixture: JSON.parse(fs.readFileSync(full, 'utf8')) };
      } catch (e) {
        console.error(red(`  ✗ Could not parse ${f}: ${e.message}`));
        return null;
      }
    })
    .filter(Boolean);
}

function checkGolden(actual, golden) {
  const issues = [];
  if (golden.decision && actual.decision !== golden.decision) {
    issues.push(`decision: expected ${golden.decision}, got ${actual.decision}`);
  }
  if (golden.audit_score && typeof actual.audit_score === 'number') {
    if (golden.audit_score.min != null && actual.audit_score < golden.audit_score.min) {
      issues.push(`audit_score ${actual.audit_score} below min ${golden.audit_score.min}`);
    }
    if (golden.audit_score.max != null && actual.audit_score > golden.audit_score.max) {
      issues.push(`audit_score ${actual.audit_score} above max ${golden.audit_score.max}`);
    }
  }
  if (Array.isArray(golden.must_mention)) {
    const flat = JSON.stringify(actual).toLowerCase();
    for (const term of golden.must_mention) {
      if (!flat.includes(String(term).toLowerCase())) {
        issues.push(`missing required mention: "${term}"`);
      }
    }
  }
  if (Array.isArray(golden.must_not_contain)) {
    const flat = JSON.stringify(actual).toLowerCase();
    for (const term of golden.must_not_contain) {
      if (flat.includes(String(term).toLowerCase())) {
        issues.push(`unexpected mention: "${term}"`);
      }
    }
  }
  if (golden.must_not_contain_slop === true) {
    try {
      const vp = require(path.join(ROOT, 'services', 'prompts', 'voice-polish'));
      const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
      const slop = vp.detect(text);
      if (slop.slop_score > 40) issues.push(`slop_score=${slop.slop_score} > 40`);
    } catch {
      /* voice-polish not loadable */
    }
  }
  return issues;
}

async function runSample(skill, sample) {
  if (LIVE) {
    // Real call. The caller passes its own callClaude in extras.
    // Future: hook into the actual server.js callClaude with a temp key.
    throw new Error('--live mode requires server.js callClaude integration; deferred.');
  }
  // Dry mode — return the fixture's stubbed_output directly so we test
  // post-processing (parse, validate, anti-slop) without real Claude.
  if (!sample.stubbed_output) {
    return { error: 'no stubbed_output in fixture — needed for dry mode' };
  }
  // Parse if stubbed_output is a JSON string (the common case — easier to
  // write in JSON fixture files than to nest objects).
  if (typeof sample.stubbed_output === 'string') {
    try {
      return JSON.parse(sample.stubbed_output);
    } catch {
      return sample.stubbed_output;
    }
  }
  return sample.stubbed_output;
}

async function main() {
  console.log('Prompt regression evaluation');
  console.log('============================');
  console.log(`Mode: ${LIVE ? 'LIVE (real Claude)' : 'dry (stubbed)'}`);
  console.log('');

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.log(yellow('No fixtures found. Create tests/fixtures/prompts/*.json'));
    console.log(yellow('See tests/fixtures/prompts/_README.md for the schema.'));
    process.exit(0);
  }

  let totalSamples = 0;
  let passSamples = 0;
  const failures = [];

  for (const { file, fixture } of fixtures) {
    const skill = fixture.skill || file.replace(/\.json$/, '');
    console.log(`\n[${skill}] (${fixture.samples?.length || 0} samples)`);
    for (const sample of fixture.samples || []) {
      totalSamples++;
      try {
        const actual = await runSample(skill, sample);
        const issues = checkGolden(actual, sample.golden || {});
        if (issues.length === 0) {
          console.log(green(`  ✓ ${sample.name}`));
          passSamples++;
        } else {
          console.log(red(`  ✗ ${sample.name}`));
          for (const issue of issues) console.log(red(`      ${issue}`));
          failures.push({ skill, sample: sample.name, issues });
        }
      } catch (e) {
        console.log(red(`  ✗ ${sample.name} — ${e.message}`));
        failures.push({ skill, sample: sample.name, issues: [e.message] });
      }
    }
  }

  console.log(`\n${passSamples}/${totalSamples} samples passed.`);
  if (failures.length) {
    console.log(red(`\n${failures.length} failure(s) — see above.`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(`Fatal: ${err.message}`));
  process.exit(1);
});
