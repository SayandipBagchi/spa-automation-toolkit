/**
 * react-fiber-traversal.js
 *
 * Walk React's internal Fiber tree from a DOM element to find components, read
 * hook state, and call internal handlers — in minified production builds where
 * you have no component names to go on.
 *
 * Why this exists
 * ---------------
 * Sometimes the state you need to change has no UI control, or the control is
 * disabled by a validation bug. The state is sitting in a hook on some ancestor
 * component and the handler that updates it is sitting in props. Fiber traversal
 * is how you reach both.
 *
 * The rule that matters: the Fiber key on a DOM node is suffixed with a random
 * string that changes per page load (`__reactFiber$a1b2c3`). Never hardcode it.
 * Always discover it with Object.keys().
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

  var MAX_DEPTH = 40;

  /**
   * Find the Fiber node attached to a DOM element.
   *
   * React 16 and 17 use `__reactInternalInstance$<hash>`; React 17+ and 18 use
   * `__reactFiber$<hash>`. The hash is regenerated on every page load.
   *
   * @param {Element} el
   * @returns {Object|null}
   */
  function getFiber(el) {
    if (!el) return null;
    var key = Object.keys(el).find(function (k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    return key ? el[key] : null;
  }

  /**
   * Walk up from a Fiber node through `.return`, yielding each ancestor.
   *
   * @param {Object} fiber
   * @param {number} [maxDepth=40]
   * @returns {Object[]}
   */
  function ancestors(fiber, maxDepth) {
    var limit = maxDepth || MAX_DEPTH;
    var out = [];
    var node = fiber;
    var depth = 0;
    while (node && depth < limit) {
      out.push(node);
      node = node.return;
      depth++;
    }
    return out;
  }

  /**
   * Every visible element on the page, as traversal candidates.
   *
   * `offsetParent === null` filters out display:none subtrees, which is usually
   * what you want: the component you are looking for is the one being rendered.
   *
   * @returns {Element[]}
   */
  function visibleElements() {
    return Array.prototype.slice
      .call(document.querySelectorAll('*'))
      .filter(function (el) { return el.offsetParent !== null; });
  }

  /**
   * Find the first Fiber carrying a named prop.
   *
   * This is the workhorse. You know the app calls something like
   * `onSegmentationPayloadChange` because you saw it in the React DevTools props
   * panel; this finds the component that owns it so you can call it yourself.
   *
   * @param {string}  propName
   * @param {Element} [startEl] Search up from this element only. Omit to sweep
   *                  every visible element, which is slower but needs no anchor.
   * @returns {{fiber: Object, element: Element, prop: *}|null}
   */
  function findFiberWithProp(propName, startEl) {
    var candidates = startEl ? [startEl] : visibleElements();
    for (var i = 0; i < candidates.length; i++) {
      var fiber = getFiber(candidates[i]);
      if (!fiber) continue;
      var chain = ancestors(fiber);
      for (var j = 0; j < chain.length; j++) {
        var props = chain[j].pendingProps || chain[j].memoizedProps;
        if (props && props[propName] !== undefined) {
          return { fiber: chain[j], element: candidates[i], prop: props[propName] };
        }
      }
    }
    return null;
  }

  /**
   * Find a Fiber by the text its element renders, then walk up to the component
   * that owns a given prop. Useful when you can see the label on screen.
   *
   * @param {string} text     Exact trimmed textContent to match.
   * @param {string} propName Prop to look for on ancestors.
   * @param {string} [tagName] Restrict to a tag, e.g. 'SPAN'.
   * @returns {{fiber: Object, element: Element, prop: *}|null}
   */
  function findFiberByText(text, propName, tagName) {
    var el = visibleElements().find(function (node) {
      if (tagName && node.tagName !== tagName.toUpperCase()) return false;
      return node.textContent.trim() === text;
    });
    if (!el) return null;
    return findFiberWithProp(propName, el);
  }

  /**
   * Read a component's hook state as an array, in declaration order.
   *
   * React stores hooks as a linked list on `memoizedState`, chained by `.next`.
   * Hook #0 is the first useState in the component, #1 the second, and so on —
   * which is why hook indexes shift the moment someone adds a hook above yours.
   * Read the values and identify yours by shape, not by index alone.
   *
   * @param {Object} fiber
   * @param {number} [limit=32]
   * @returns {Array} the memoizedState of each hook, in order
   */
  function readHookStates(fiber, limit) {
    var max = limit || 32;
    var out = [];
    if (!fiber) return out;
    var hook = fiber.memoizedState;
    var i = 0;
    while (hook && i < max) {
      out.push(hook.memoizedState);
      hook = hook.next;
      i++;
    }
    return out;
  }

  /**
   * Read one hook's state by index.
   *
   * @param {Object} fiber
   * @param {number} index
   * @returns {*}
   */
  function readHookState(fiber, index) {
    return readHookStates(fiber, index + 1)[index];
  }

  /**
   * Find a hook whose state satisfies a predicate — index-independent, so it
   * survives the app adding a hook above the one you care about.
   *
   * @param {Object}   fiber
   * @param {Function} predicate (state, index) => boolean
   * @returns {{index: number, state: *}|null}
   */
  function findHookState(fiber, predicate) {
    var states = readHookStates(fiber);
    for (var i = 0; i < states.length; i++) {
      var ok = false;
      try { ok = !!predicate(states[i], i); } catch (e) { ok = false; }
      if (ok) return { index: i, state: states[i] };
    }
    return null;
  }

  /**
   * Call a handler found in a component's props.
   *
   * Worth knowing before you rely on this: updating state through an internal
   * handler does NOT set the form's dirty flag. A Save button gated on isDirty
   * stays disabled. You still need one genuine UI interaction to flip it — see
   * ui-interaction.js.
   *
   * @param {string} propName
   * @param {Array}  args
   * @param {Element} [startEl]
   * @returns {*} the handler's return value
   */
  function callProp(propName, args, startEl) {
    var found = findFiberWithProp(propName, startEl);
    if (!found) throw new Error('No fiber found carrying prop: ' + propName);
    if (typeof found.prop !== 'function') {
      throw new TypeError('Prop ' + propName + ' is not a function');
    }
    return found.prop.apply(null, args || []);
  }

  /**
   * Describe the component chain above an element, for orientation.
   *
   * Minified builds give you names like `L`, `Fe`, `Wt`, `_r`. They are unstable
   * across vendor releases, so use this to look around, not to write down.
   *
   * @param {Element} el
   * @param {number}  [maxDepth=15]
   * @returns {Array<{depth:number,name:string,props:string[],hooks:number}>}
   */
  function describeChain(el, maxDepth) {
    var fiber = getFiber(el);
    if (!fiber) return [];
    return ancestors(fiber, maxDepth || 15).map(function (node, i) {
      var t = node.type;
      var name = typeof t === 'string'
        ? t
        : (t && (t.displayName || t.name)) || '(anonymous)';
      var props = node.pendingProps || node.memoizedProps || {};
      return {
        depth: i,
        name: name,
        props: Object.keys(props).slice(0, 20),
        hooks: readHookStates(node).length,
      };
    });
  }

  return {
    getFiber: getFiber,
    ancestors: ancestors,
    visibleElements: visibleElements,
    findFiberWithProp: findFiberWithProp,
    findFiberByText: findFiberByText,
    readHookStates: readHookStates,
    readHookState: readHookState,
    findHookState: findHookState,
    callProp: callProp,
    describeChain: describeChain,
  };
});
