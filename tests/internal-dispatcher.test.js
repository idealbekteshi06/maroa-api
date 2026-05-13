'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dispatcher = require('../lib/internalDispatcher');

// ─── register / unregister ──────────────────────────────────────────────────

test('internalDispatcher: register + dispatch returns handler result', async () => {
  dispatcher._reset();
  dispatcher.register('/webhook/foo', async (body) => ({ echoed: body }));
  const out = await dispatcher.dispatch('/webhook/foo', { x: 1 });
  assert.deepStrictEqual(out, { echoed: { x: 1 } });
});

test('internalDispatcher: dispatch returns _notRegistered when path missing', async () => {
  dispatcher._reset();
  const out = await dispatcher.dispatch('/webhook/nope', {});
  assert.strictEqual(out._notRegistered, true);
});

test('internalDispatcher: register validates path starts with /', () => {
  assert.throws(() => dispatcher.register('webhook/foo', () => {}), /must start with/);
  assert.throws(() => dispatcher.register('', () => {}), /must start with/);
  assert.throws(() => dispatcher.register(123, () => {}), /must start with/);
});

test('internalDispatcher: register validates handler is a function', () => {
  assert.throws(() => dispatcher.register('/foo', 'not a function'), /must be a function/);
  assert.throws(() => dispatcher.register('/foo', null), /must be a function/);
});

test('internalDispatcher: re-registering replaces the previous handler', async () => {
  dispatcher._reset();
  dispatcher.register('/webhook/foo', async () => 'first');
  dispatcher.register('/webhook/foo', async () => 'second');
  const out = await dispatcher.dispatch('/webhook/foo', {});
  assert.strictEqual(out, 'second');
});

test('internalDispatcher: unregister removes the handler', async () => {
  dispatcher._reset();
  dispatcher.register('/webhook/foo', async () => 'x');
  assert.strictEqual(dispatcher.unregister('/webhook/foo'), true);
  const out = await dispatcher.dispatch('/webhook/foo', {});
  assert.strictEqual(out._notRegistered, true);
});

test('internalDispatcher: unregister returns false for unknown path', () => {
  dispatcher._reset();
  assert.strictEqual(dispatcher.unregister('/webhook/never-was'), false);
});

// ─── dispatch behavior ──────────────────────────────────────────────────────

test('internalDispatcher: dispatch propagates handler errors', async () => {
  dispatcher._reset();
  dispatcher.register('/webhook/bad', async () => {
    throw new Error('upstream failed');
  });
  await assert.rejects(dispatcher.dispatch('/webhook/bad', {}), /upstream failed/);
});

test('internalDispatcher: dispatch passes body + meta to handler', async () => {
  dispatcher._reset();
  let seenBody, seenMeta;
  dispatcher.register('/webhook/foo', async (body, meta) => {
    seenBody = body;
    seenMeta = meta;
    return 'ok';
  });
  await dispatcher.dispatch('/webhook/foo', { a: 1 }, { traceId: 'x' });
  assert.deepStrictEqual(seenBody, { a: 1 });
  assert.deepStrictEqual(seenMeta, { traceId: 'x' });
});

// ─── snapshot / introspection ───────────────────────────────────────────────

test('internalDispatcher: snapshot returns registered paths + hit counts', async () => {
  dispatcher._reset();
  dispatcher.register('/webhook/a', async () => 1);
  dispatcher.register('/webhook/b', async () => 2);
  await dispatcher.dispatch('/webhook/a', {});
  await dispatcher.dispatch('/webhook/a', {});
  await dispatcher.dispatch('/webhook/missing', {});
  const snap = dispatcher.snapshot();
  assert.deepStrictEqual(snap.registered.sort(), ['/webhook/a', '/webhook/b']);
  assert.strictEqual(snap.hits, 2);
  assert.strictEqual(snap.misses, 1);
});

test('internalDispatcher: isRegistered returns true/false correctly', () => {
  dispatcher._reset();
  dispatcher.register('/webhook/x', async () => 1);
  assert.strictEqual(dispatcher.isRegistered('/webhook/x'), true);
  assert.strictEqual(dispatcher.isRegistered('/webhook/y'), false);
});

test('internalDispatcher: _reset clears registry + counts', async () => {
  dispatcher.register('/webhook/temp', async () => 1);
  await dispatcher.dispatch('/webhook/temp', {});
  dispatcher._reset();
  const snap = dispatcher.snapshot();
  assert.strictEqual(snap.registered.length, 0);
  assert.strictEqual(snap.hits, 0);
  assert.strictEqual(snap.misses, 0);
});
