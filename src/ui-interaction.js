/**
 * ui-interaction.js
 *
 * Click things that are not buttons, find things that have no test id, and wait
 * for things that arrive late.
 *
 * Why this exists
 * ---------------
 * Two problems keep recurring in enterprise SPAs.
 *
 * First, component libraries render controls as styled `<div>`s with no
 * `role="button"`. Atlaskit is the worst offender: `querySelector('button')`
 * finds nothing for a Jira priority dropdown. You have to match on text or icon
 * ligature instead.
 *
 * Second, `el.click()` fires a single synthetic click with no coordinates.
 * Handlers built on `mousedown`/`mouseup`, or that read `clientX`/`clientY` to
 * position a popover, simply do not respond. A real user generates a sequence,
 * so generate the sequence.
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

  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector || '*'));
  }

  /**
   * Find a visible element by its exact trimmed text.
   *
   * @param {string} text
   * @param {Object} [opts]
   * @param {string} [opts.selector='*']
   * @param {boolean}[opts.exact=true] false does a substring match.
   * @param {boolean}[opts.deepest=true] Prefer the innermost matching element —
   *                 otherwise you get an ancestor whose textContent happens to
   *                 contain the same string, and clicking it misses.
   * @returns {Element|null}
   */
  function findByText(text, opts) {
    var o = opts || {};
    var exact = o.exact !== false;
    var matches = all(o.selector).filter(function (el) {
      if (!isVisible(el)) return false;
      var t = el.textContent.trim();
      return exact ? t === text : t.indexOf(text) !== -1;
    });
    if (matches.length === 0) return null;
    if (o.deepest === false) return matches[0];
    // The deepest match is the one containing no other match.
    return matches.filter(function (el) {
      return !matches.some(function (other) { return other !== el && el.contains(other); });
    })[0] || matches[matches.length - 1];
  }

  /**
   * Find a Material Icons element by its ligature text, e.g. 'keyboard_arrow_down'.
   * Icon buttons rarely carry a usable label, but the ligature is right there in
   * the text node.
   *
   * @param {string} ligature
   * @param {Object} [opts]
   * @param {boolean}[opts.closestButton=true] Return the enclosing button if there is one.
   * @returns {Element|null}
   */
  function findByIcon(ligature, opts) {
    var o = opts || {};
    var el = all('*').find(function (node) {
      return isVisible(node) &&
        node.textContent.trim() === ligature &&
        node.children.length === 0;
    });
    if (!el) return null;
    if (o.closestButton === false) return el;
    return el.closest('button, [role="button"]') || el;
  }

  /**
   * Dispatch a full pointer sequence at an element's centre.
   *
   * Fires pointerdown → mousedown → pointerup → mouseup → click, each with real
   * coordinates. This is what makes non-semantic controls respond.
   *
   * @param {Element} el
   * @param {Object} [opts]
   * @param {number} [opts.offsetX] Pixels from the element's left edge. Defaults to centre.
   * @param {number} [opts.offsetY] Pixels from the element's top edge. Defaults to centre.
   * @param {boolean}[opts.scrollIntoView=true]
   * @returns {Element} the element clicked
   */
  function click(el, opts) {
    if (!el) throw new Error('click: element is null');
    var o = opts || {};
    if (o.scrollIntoView !== false && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    var rect = el.getBoundingClientRect();
    var x = rect.left + (o.offsetX !== undefined ? o.offsetX : rect.width / 2);
    var y = rect.top + (o.offsetY !== undefined ? o.offsetY : rect.height / 2);

    var base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };

    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', base));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0 })));
    }
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
    return el;
  }

  /**
   * Find by text and click in one step.
   *
   * @param {string} text
   * @param {Object} [opts] Passed to both findByText and click.
   * @returns {Element}
   */
  function clickByText(text, opts) {
    var el = findByText(text, opts);
    if (!el) throw new Error('clickByText: no visible element with text: ' + text);
    return click(el, opts);
  }

  /**
   * Find by Material icon ligature and click.
   *
   * @param {string} ligature
   * @param {Object} [opts]
   * @returns {Element}
   */
  function clickByIcon(ligature, opts) {
    var el = findByIcon(ligature, opts);
    if (!el) throw new Error('clickByIcon: no visible icon: ' + ligature);
    return click(el, opts);
  }

  /**
   * Set the value of a controlled React input so React actually notices.
   *
   * Assigning `input.value` directly updates the DOM but not React's internal
   * value tracker, so React sees no change and the component never re-renders.
   * Calling the native setter first defeats the tracker.
   *
   * @param {HTMLInputElement|HTMLTextAreaElement} el
   * @param {string} value
   * @returns {Element}
   */
  function setReactInputValue(el, value) {
    if (!el) throw new Error('setReactInputValue: element is null');
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  }

  /**
   * Poll until a condition holds.
   *
   * @param {Function} predicate () => truthy value to resolve with
   * @param {Object}  [opts]
   * @param {number}  [opts.timeout=10000]
   * @param {number}  [opts.interval=100]
   * @param {string}  [opts.label] Included in the timeout error.
   * @returns {Promise<*>} the predicate's truthy value
   */
  function waitFor(predicate, opts) {
    var o = opts || {};
    var timeout = o.timeout || 10000;
    var interval = o.interval || 100;
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function poll() {
        var value;
        try { value = predicate(); } catch (e) { value = null; }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) {
          return reject(new Error('waitFor: timed out after ' + timeout + 'ms' +
            (o.label ? ' waiting for ' + o.label : '')));
        }
        setTimeout(poll, interval);
      })();
    });
  }

  /**
   * Wait for an element matching a selector to appear and be visible.
   *
   * @param {string} selector
   * @param {Object} [opts] Passed to waitFor.
   * @returns {Promise<Element>}
   */
  function waitForElement(selector, opts) {
    return waitFor(function () {
      var el = document.querySelector(selector);
      return isVisible(el) ? el : null;
    }, Object.assign({ label: selector }, opts));
  }

  /**
   * Wait for an element with given text to appear and be visible.
   *
   * @param {string} text
   * @param {Object} [opts]
   * @returns {Promise<Element>}
   */
  function waitForText(text, opts) {
    return waitFor(function () {
      return findByText(text, opts);
    }, Object.assign({ label: 'text "' + text + '"' }, opts));
  }

  return {
    isVisible: isVisible,
    findByText: findByText,
    findByIcon: findByIcon,
    click: click,
    clickByText: clickByText,
    clickByIcon: clickByIcon,
    setReactInputValue: setReactInputValue,
    waitFor: waitFor,
    waitForElement: waitForElement,
    waitForText: waitForText,
  };
});
