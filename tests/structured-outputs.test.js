'use strict';

const test = require('node:test');
const assert = require('node:assert');
const so = require('../lib/structuredOutputs');

const ALL = ['adOptimizerAudit', 'leadResponse', 'qualityGateAdvisor', 'complianceRewrite', 'scorecardCommentary'];

// Anthropic structured-outputs constraints: every object schema must set
// additionalProperties:false; numeric min/max and string length constraints
// are unsupported and would 400 the request.
function walk(schema, path, fn) {
  if (!schema || typeof schema !== 'object') return;
  fn(schema, path);
  for (const key of ['properties']) {
    if (schema[key]) for (const [k, v] of Object.entries(schema[key])) walk(v, `${path}.${k}`, fn);
  }
  if (schema.items) walk(schema.items, `${path}[]`, fn);
  for (const branch of schema.anyOf || []) walk(branch, `${path}|anyOf`, fn);
}

test('structuredOutputs: every format is {type:json_schema, schema}', () => {
  for (const name of ALL) {
    const f = so[name];
    assert.ok(f, `${name} exported`);
    assert.strictEqual(f.type, 'json_schema');
    assert.strictEqual(f.schema.type, 'object');
  }
});

test('structuredOutputs: all object schemas close additionalProperties and list required', () => {
  for (const name of ALL) {
    walk(so[name].schema, name, (s, path) => {
      if (s.type === 'object') {
        assert.strictEqual(s.additionalProperties, false, `${path} must set additionalProperties:false`);
        assert.ok(Array.isArray(s.required) && s.required.length, `${path} must list required`);
        for (const r of s.required) {
          assert.ok(s.properties && s.properties[r], `${path}.required "${r}" missing from properties`);
        }
      }
    });
  }
});

test('structuredOutputs: no unsupported numeric/string constraints anywhere', () => {
  const banned = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems'];
  for (const name of ALL) {
    walk(so[name].schema, name, (s, path) => {
      for (const b of banned) assert.ok(!(b in s), `${path} uses unsupported constraint "${b}"`);
    });
  }
});

test('structuredOutputs: decision enums match downstream branch values', () => {
  assert.deepStrictEqual(so.adOptimizerAudit.schema.properties.decision.enum, [
    'scale',
    'pause',
    'keep',
    'optimize',
    'refresh_creative',
  ]);
  assert.deepStrictEqual(so.qualityGateAdvisor.schema.properties.decision.enum, ['ship', 'retry', 'reject']);
});
