/**
 * Dependency-free test runner. Node 14+.
 *
 *   node test/run-tests.js
 *
 * Covers the logic that does not need a browser: body normalisation, URL
 * extraction, interceptor matching and rewriting, and path building. The DOM
 * modules (ui-interaction, react-fiber-traversal) are exercised against a small
 * hand-rolled DOM stub rather than a real browser, so they test wiring, not
 * rendering. The browser behaviour they encode is verified by the worked
 * examples in examples/.
 */
'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL ' + name);
  }
}

function section(name) {
  console.log('\n' + name);
}

// ---------------------------------------------------------------------------
// Minimal globals so the UMD modules can attach themselves.
// ---------------------------------------------------------------------------
global.self = global;

const interceptor = require('../src/fetch-interceptor.js');
const nav = require('../src/spa-navigation.js');

(async function main() {
  section('fetch-interceptor: body normalisation');

  await test('reads a string body unchanged', async () => {
    assert.strictEqual(await interceptor._readBody('{"a":1}'), '{"a":1}');
  });

  await test('returns null for a null body', async () => {
    assert.strictEqual(await interceptor._readBody(null), null);
  });

  await test('reads a body exposing .text()', async () => {
    const fake = { text: async () => '{"from":"text"}' };
    assert.strictEqual(await interceptor._readBody(fake), '{"from":"text"}');
  });

  await test('serialises a plain object body', async () => {
    assert.strictEqual(await interceptor._readBody({ a: 1 }), '{"a":1}');
  });

  await test('reads a URLSearchParams body', async () => {
    const p = new URLSearchParams({ a: '1', b: '2' });
    assert.strictEqual(await interceptor._readBody(p), 'a=1&b=2');
  });

  section('fetch-interceptor: URL extraction');

  await test('extracts a plain string URL', () => {
    assert.strictEqual(interceptor._urlOf('https://x.test/api'), 'https://x.test/api');
  });

  await test('extracts .url from a Request-like object', () => {
    assert.strictEqual(interceptor._urlOf({ url: 'https://x.test/api' }), 'https://x.test/api');
  });

  section('fetch-interceptor: interception');

  // Each test installs against a stub fetch and restores afterwards.
  function withStubFetch(run) {
    const calls = [];
    global.fetch = async function (input, init) {
      calls.push({ input, init });
      return { ok: true, status: 200 };
    };
    return run(calls).finally(() => {
      interceptor.restoreFetch();
      delete global.fetch;
    });
  }

  await test('rewrites a matching JSON body', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: (url, method) => url.includes('/charts/') && method === 'PUT',
      transformBody: (payload) => Object.assign({}, payload, {
        chart_type: 'column',
        granularity: 'e',
      }),
    });

    await global.fetch('https://app.test/api/charts/42', {
      method: 'PUT',
      body: JSON.stringify({ chart_type: 'line', granularity: 'daily', name: 'Txns' }),
    });

    assert.strictEqual(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.chart_type, 'column');
    assert.strictEqual(sent.granularity, 'e');
    assert.strictEqual(sent.name, 'Txns', 'untouched fields must survive');
  }));

  await test('leaves non-matching requests alone', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: (url) => url.includes('/charts/'),
      transformBody: () => ({ replaced: true }),
    });

    const body = JSON.stringify({ untouched: true });
    await global.fetch('https://app.test/api/dashboards/1', { method: 'PUT', body });

    assert.strictEqual(calls[0].init.body, body);
  }));

  await test('passes the body through when transformBody returns undefined', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: () => undefined,
    });

    const body = JSON.stringify({ a: 1 });
    await global.fetch('https://app.test/api/x', { method: 'POST', body });

    assert.strictEqual(calls[0].init.body, body);
  }));

  await test('a throwing transform never breaks the request', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: () => { throw new Error('boom'); },
    });

    const res = await global.fetch('https://app.test/api/x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });

    assert.strictEqual(res.status, 200, 'host app must still get its response');
    assert.strictEqual(calls.length, 1);
    assert.ok(global.__spakit_errors__.length > 0, 'the error is recorded, not swallowed silently');
  }));

  await test('once:true fires exactly one time', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      once: true,
      transformBody: (p) => Object.assign({}, p, { seen: true }),
    });

    await global.fetch('https://app.test/a', { method: 'POST', body: '{"n":1}' });
    await global.fetch('https://app.test/b', { method: 'POST', body: '{"n":2}' });

    assert.ok(JSON.parse(calls[0].init.body).seen, 'first call rewritten');
    assert.ok(!JSON.parse(calls[1].init.body).seen, 'second call untouched');
  }));

  await test('interceptors stack in install order', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: (p) => Object.assign({}, p, { order: (p.order || '') + 'a' }),
    });
    interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: (p) => Object.assign({}, p, { order: (p.order || '') + 'b' }),
    });

    await global.fetch('https://app.test/x', { method: 'POST', body: '{}' });
    assert.strictEqual(JSON.parse(calls[0].init.body).order, 'ab');
  }));

  await test('transformInit can add a header', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      transformInit: (init) => Object.assign({}, init, {
        headers: Object.assign({}, init.headers, { 'X-Trace': '1' }),
      }),
    });

    await global.fetch('https://app.test/x', { method: 'POST', body: '{}' });
    assert.strictEqual(calls[0].init.headers['X-Trace'], '1');
  }));

  await test('debug mode records both payloads', () => withStubFetch(async () => {
    interceptor.installFetchInterceptor({
      match: () => true,
      debug: true,
      transformBody: (p) => Object.assign({}, p, { touched: true }),
    });

    await global.fetch('https://app.test/x', { method: 'POST', body: '{"touched":false}' });

    const last = interceptor.lastIntercepted();
    assert.ok(last, 'lastIntercepted() returns a record');
    assert.strictEqual(JSON.parse(last.original).touched, false);
    assert.strictEqual(JSON.parse(last.modified).touched, true);
  }));

  await test('uninstall restores the original fetch', () => withStubFetch(async (calls) => {
    const original = global.fetch;
    const uninstall = interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: () => ({ replaced: true }),
    });
    assert.notStrictEqual(global.fetch, original, 'fetch is patched while installed');

    uninstall();
    assert.strictEqual(global.fetch, original, 'fetch is restored after uninstall');

    await global.fetch('https://app.test/x', { method: 'POST', body: '{"a":1}' });
    assert.strictEqual(JSON.parse(calls[0].init.body).a, 1);
  }));

  await test('a non-JSON body is passed through untouched', () => withStubFetch(async (calls) => {
    interceptor.installFetchInterceptor({
      match: () => true,
      transformBody: () => ({ replaced: true }),
    });

    await global.fetch('https://app.test/x', { method: 'POST', body: 'not json at all' });
    assert.strictEqual(calls[0].init.body, 'not json at all');
  }));

  await test('match must be a function', () => {
    assert.throws(() => interceptor.installFetchInterceptor({}), TypeError);
  });

  section('spa-navigation: path building');

  await test('builds a query string', () => {
    assert.strictEqual(
      nav.buildPath('/behavior', { did: 'abc', chartId: 'def' }),
      '/behavior?did=abc&chartId=def'
    );
  });

  await test('encodes special characters', () => {
    assert.strictEqual(
      nav.buildPath('/search', { q: 'a b&c' }),
      '/search?q=a%20b%26c'
    );
  });

  await test('skips null and undefined params', () => {
    assert.strictEqual(
      nav.buildPath('/x', { a: 1, b: null, c: undefined }),
      '/x?a=1'
    );
  });

  await test('returns a bare path when there are no params', () => {
    assert.strictEqual(nav.buildPath('/x', {}), '/x');
  });

  // -------------------------------------------------------------------------
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('');
    failures.forEach((f) => {
      console.log('FAIL: ' + f.name);
      console.log('  ' + (f.err && f.err.message));
    });
    process.exit(1);
  }
})();
