/**
 * spa-navigation.js
 *
 * Move between routes in a React Router SPA without tripping the browser's
 * "Leave site?" dialog.
 *
 * Why this exists
 * ---------------
 * Setting `window.location.href` is a document navigation. If the app has an
 * unsaved-changes guard on `beforeunload` — and any editor worth automating does —
 * the browser throws up a modal. A modal blocks every subsequent automation
 * command, and in a driven browser it can wedge the whole session.
 *
 * The fix is to navigate the way the router itself does: push onto the history
 * stack, then tell the router to re-read it. No document unload, no dialog.
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
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Navigate to a path within the SPA.
   *
   * @param {string} path  Path with query string, e.g. '/analytics/behavior?did=1&chartId=2'
   * @param {Object} [state={}] History state object the router will see.
   * @returns {string} the resulting location
   */
  function navigate(path, state) {
    window.history.pushState(state || {}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: state || {} }));
    return window.location.pathname + window.location.search;
  }

  /**
   * Replace the current entry instead of pushing a new one. Use this when you
   * are stepping through many routes and do not want to stuff the back button.
   *
   * @param {string} path
   * @param {Object} [state={}]
   * @returns {string}
   */
  function replace(path, state) {
    window.history.replaceState(state || {}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: state || {} }));
    return window.location.pathname + window.location.search;
  }

  /**
   * Build a path from a template and params, URL-encoding each value.
   *
   * @param {string} template e.g. '/v4/analytics/v2/behavior'
   * @param {Object} params   e.g. { did: 'abc', chartId: 'def' }
   * @returns {string}
   */
  function buildPath(template, params) {
    var qs = Object.keys(params || {})
      .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      })
      .join('&');
    return qs ? template + '?' + qs : template;
  }

  /**
   * Navigate, then wait until the route has actually changed and the DOM has
   * settled. Routers re-render asynchronously, so acting immediately after a
   * pushState usually means acting against the previous screen.
   *
   * @param {string} path
   * @param {Object}  [opts]
   * @param {Function}[opts.until] () => boolean. Resolve when this returns true.
   *                  Defaults to "the location matches the path we asked for".
   * @param {number}  [opts.timeout=10000]
   * @param {number}  [opts.interval=100]
   * @returns {Promise<string>} the settled location
   */
  function navigateAndWait(path, opts) {
    var o = opts || {};
    var timeout = o.timeout || 10000;
    var interval = o.interval || 100;
    var expected = path.split('?')[0];

    navigate(path, o.state);

    return new Promise(function (resolve, reject) {
      var started = Date.now();
      var timer = setInterval(function () {
        var ok;
        try {
          ok = typeof o.until === 'function'
            ? !!o.until()
            : window.location.pathname === expected;
        } catch (e) {
          ok = false;
        }
        if (ok) {
          clearInterval(timer);
          resolve(window.location.pathname + window.location.search);
          return;
        }
        if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error('navigateAndWait: timed out after ' + timeout + 'ms at ' + window.location.pathname));
        }
      }, interval);
    });
  }

  /**
   * Temporarily remove beforeunload guards.
   *
   * A last resort for when you genuinely must do a full page load and the app
   * insists on confirming. Returns a restore function — call it, because leaving
   * the guard off means a real user in that tab can lose real work.
   *
   * @returns {Function} restore
   */
  function suppressUnloadPrompt() {
    var saved = window.onbeforeunload;
    window.onbeforeunload = null;
    var blocker = function (e) {
      e.stopImmediatePropagation();
      delete e.returnValue;
    };
    window.addEventListener('beforeunload', blocker, true);
    return function restore() {
      window.removeEventListener('beforeunload', blocker, true);
      window.onbeforeunload = saved;
    };
  }

  return {
    navigate: navigate,
    replace: replace,
    buildPath: buildPath,
    navigateAndWait: navigateAndWait,
    suppressUnloadPrompt: suppressUnloadPrompt,
  };
});
