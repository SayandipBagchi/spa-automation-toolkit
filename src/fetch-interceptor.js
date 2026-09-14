/**
 * fetch-interceptor.js
 *
 * Monkey-patches window.fetch so you can rewrite a request body on its way out,
 * while the host application's own auth pipeline still builds the request.
 *
 * Why this exists
 * ---------------
 * SPAs like MoEngage and Jira attach auth headers inside middleware that only runs
 * for app-initiated requests. A hand-rolled `fetch(url, {credentials:'include'})`
 * from the console gets a 401. So instead of making the call yourself, you let the
 * app make it and change the payload in flight.
 *
 * The canonical case: MoEngage's chart editor refuses to save a bar chart with
 * "Entire" granularity because of a frontend validation bug, even though the API
 * accepts `chart_type: "column"` with `granularity: "e"` without complaint. Install
 * the interceptor, save from Daily mode (which passes validation), and rewrite the
 * two fields before they leave the browser.
 *
 * UMD: paste straight into a DevTools console, or `require()` it in Node for tests.
 *
 * @license MIT
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SPAKit = root.SPAKit || {};
    Object.assign(root.SPAKit, api);
    // Convenience globals so console use stays short.
    root.installFetchInterceptor = api.installFetchInterceptor;
    root.restoreFetch = api.restoreFetch;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAVED = '__spakit_savedFetch__';
  var installs = [];

  /**
   * Read a fetch body into a string, whatever shape it arrived in.
   *
   * Request bodies reach an interceptor as a string, a Request object, a
   * ReadableStream, URLSearchParams, FormData or a plain object depending on how
   * the caller built them. Only JSON-ish bodies are rewritable; the rest are
   * returned as null so the caller can pass them through untouched.
   *
   * @param {*} body
   * @returns {Promise<string|null>}
   */
  async function readBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    // Blob, Request, Response and anything else with .text()
    if (typeof body.text === 'function') return await body.text();
    if (typeof FormData !== 'undefined' && body instanceof FormData) return null;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString();
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      var reader = body.getReader();
      var chunks = [];
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
      }
      return new TextDecoder().decode(concat(chunks));
    }
    try {
      return JSON.stringify(body);
    } catch (e) {
      return null;
    }
  }

  function concat(chunks) {
    var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (c) { out.set(c, offset); offset += c.length; });
    return out;
  }

  /**
   * Pull the URL string out of fetch's first argument, which may be a string,
   * a URL, or a Request.
   *
   * @param {string|URL|Request} input
   * @returns {string}
   */
  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input);
  }

  /**
   * Install an interceptor.
   *
   * Interceptors stack: install two and both get a chance to transform, in the
   * order they were installed. Each returns its own uninstall function, and
   * restoreFetch() removes all of them at once.
   *
   * @param {Object}   opts
   * @param {Function} opts.match         (url, method, options) => boolean. Required.
   * @param {Function} [opts.transformBody] (payload, ctx) => newPayload. Return the
   *                   object to send. Return undefined to leave the body untouched.
   *                   Receives the parsed JSON payload; if the body was not JSON,
   *                   this is not called.
   * @param {Function} [opts.transformInit] (init, ctx) => newInit. Lets you add or
   *                   strip headers. Runs after transformBody.
   * @param {Function} [opts.onMatch]     (ctx) => void. Observe without changing.
   * @param {boolean}  [opts.debug=false] Record payloads on window.__spakit_last__.
   * @param {boolean}  [opts.once=false]  Uninstall after the first match.
   * @returns {Function} uninstall
   */
  function installFetchInterceptor(opts) {
    if (!opts || typeof opts.match !== 'function') {
      throw new TypeError('installFetchInterceptor: opts.match must be a function');
    }

    var g = typeof self !== 'undefined' ? self : globalThis;
    if (!g[SAVED]) g[SAVED] = g.fetch;
    var original = g[SAVED];

    var record = { opts: opts, active: true };
    installs.push(record);

    // Patch once; the wrapper walks the install list on every call.
    if (!g.fetch.__spakit__) {
      var patched = async function (input, init) {
        var url = urlOf(input);
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var currentInit = init;
        var currentInput = input;

        for (var i = 0; i < installs.length; i++) {
          var rec = installs[i];
          if (!rec.active) continue;

          var o = rec.opts;
          var hit = false;
          try {
            hit = !!o.match(url, method, currentInit);
          } catch (e) {
            reportError(o, e, 'match');
            continue;
          }
          if (!hit) continue;

          try {
            var raw = await readBody(currentInit && currentInit.body);
            var payload = null;
            if (raw != null) {
              try { payload = JSON.parse(raw); } catch (e) { payload = null; }
            }

            var ctx = {
              url: url,
              method: method,
              rawBody: raw,
              payload: payload,
              init: currentInit,
            };

            if (typeof o.onMatch === 'function') o.onMatch(ctx);

            if (payload != null && typeof o.transformBody === 'function') {
              var next = o.transformBody(payload, ctx);
              if (next !== undefined) {
                currentInit = Object.assign({}, currentInit, { body: JSON.stringify(next) });
                // A Request object carries its own body; once we rewrite, send the
                // URL string instead so our init wins.
                if (currentInput && typeof currentInput !== 'string') currentInput = url;
                if (o.debug) {
                  g.__spakit_last__ = {
                    url: url,
                    method: method,
                    original: raw,
                    modified: currentInit.body,
                    at: new Date().toISOString(),
                  };
                }
              }
            }

            if (typeof o.transformInit === 'function') {
              var nextInit = o.transformInit(currentInit, ctx);
              if (nextInit !== undefined) currentInit = nextInit;
            }

            if (o.once) rec.active = false;
          } catch (e) {
            // An interceptor must never break the host app. Log and pass through.
            reportError(o, e, 'transform');
          }
        }

        return original.call(this, currentInput, currentInit);
      };
      patched.__spakit__ = true;
      g.fetch = patched;
    }

    return function uninstall() {
      record.active = false;
      var ix = installs.indexOf(record);
      if (ix >= 0) installs.splice(ix, 1);
      if (installs.length === 0) restoreFetch();
    };
  }

  function reportError(opts, err, phase) {
    var g = typeof self !== 'undefined' ? self : globalThis;
    g.__spakit_errors__ = g.__spakit_errors__ || [];
    g.__spakit_errors__.push({ phase: phase, message: err && err.message, at: Date.now() });
    if (opts && opts.debug && typeof console !== 'undefined') {
      console.warn('[SPAKit] interceptor ' + phase + ' failed:', err);
    }
  }

  /** Remove every interceptor and put the native fetch back. */
  function restoreFetch() {
    var g = typeof self !== 'undefined' ? self : globalThis;
    installs.length = 0;
    if (g[SAVED]) {
      g.fetch = g[SAVED];
      delete g[SAVED];
      return true;
    }
    return false;
  }

  /** The payloads from the last debug-enabled match, for eyeballing after a save. */
  function lastIntercepted() {
    var g = typeof self !== 'undefined' ? self : globalThis;
    return g.__spakit_last__ || null;
  }

  return {
    installFetchInterceptor: installFetchInterceptor,
    restoreFetch: restoreFetch,
    lastIntercepted: lastIntercepted,
    _readBody: readBody,
    _urlOf: urlOf,
  };
});
