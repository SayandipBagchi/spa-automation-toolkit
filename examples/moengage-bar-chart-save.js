/**
 * Worked example: persist a bar chart with "Entire" granularity in MoEngage.
 *
 * The problem
 * -----------
 * MoEngage's Behavior chart editor will not save a bar chart in Entire mode. The
 * "Save analysis" button greys out with "Missing field — Please specify
 * granularity for chart". The API has no such objection: it accepts
 * `chart_type: "column"` with `granularity: "e"` and stores it correctly. The
 * block is frontend validation only.
 *
 * Two things that do not work, and why
 * -----------------------------------
 * 1. Calling the API directly. `fetch(url, {credentials:'include'})` from the
 *    console returns 401 — auth headers are added by middleware that only runs
 *    inside the app's own request path.
 * 2. Setting the state through React. Bar mode and time granularity are mutually
 *    exclusive in the reducer: setting one resets the other. And a state change
 *    made through an internal handler does not set the form's dirty flag, so the
 *    Save button stays disabled anyway.
 *
 * What works
 * ----------
 * Let the app build and send the request, and rewrite the payload on its way out.
 * Save from Daily mode (which passes validation), and swap the two fields in the
 * interceptor.
 *
 * Usage: paste the four src/ files into the console, then this file, then call
 *   await saveBarChartEntire({ dashboardId: '...', chartId: '...' })
 */
'use strict';

async function saveBarChartEntire(opts) {
  const { dashboardId, chartId } = opts;
  if (!dashboardId) throw new Error('dashboardId is required');

  const { installFetchInterceptor, lastIntercepted, restoreFetch } = window.SPAKit;
  const { navigate, buildPath } = window.SPAKit;
  const { clickByText, clickByIcon, waitForText, waitFor } = window.SPAKit;

  // 1. Go to the chart editor without triggering a "Leave site?" dialog.
  if (chartId) {
    navigate(buildPath('/v4/analytics/v2/behavior', { did: dashboardId, chartId }));
    await waitForText('Save analysis', { exact: false, timeout: 15000 });
  }

  // 2. Arm the interceptor before any save can fire.
  const uninstall = installFetchInterceptor({
    match: (url, method) =>
      method === 'PUT' && url.includes('charts') && url.includes(dashboardId),
    transformBody: (payload) => ({
      ...payload,
      chart_type: 'column',   // bar chart
      granularity: 'e',       // Entire
    }),
    debug: true,
    once: true,
  });

  try {
    // 3. Switch to Daily. This is the mode the validator accepts, and clicking a
    //    real control is also what sets the form's dirty flag.
    clickByText('Daily');

    // 4. Wait for the chart to reload. Saving before the data settles sends the
    //    previous payload.
    await waitFor(
      () => !document.querySelector('[class*="loading"], [class*="spinner"]'),
      { timeout: 20000, label: 'chart data to load' }
    );

    // 5. Open the save dropdown. The chevron is a Material Icons ligature inside
    //    a button, with no accessible label to match on.
    clickByIcon('keyboard_arrow_down');
    await waitForText('Save analysis', { timeout: 5000 });
    clickByText('Save analysis');

    // 6. Confirm what actually went over the wire.
    await waitFor(() => lastIntercepted(), { timeout: 10000, label: 'the save request' });
    const sent = JSON.parse(lastIntercepted().modified);

    if (sent.chart_type !== 'column' || sent.granularity !== 'e') {
      throw new Error(
        'Interceptor did not rewrite as expected: ' +
        JSON.stringify({ chart_type: sent.chart_type, granularity: sent.granularity })
      );
    }
    return { ok: true, sent };
  } finally {
    uninstall();
    restoreFetch();
  }
}

/**
 * Known limitation, documented so nobody rediscovers it the hard way.
 *
 * Segment labels are frontend state. The `segmentation[]` array in the save
 * payload contains `filters` only — there is no `label` field, so injecting one
 * does nothing. You can rename tabs in memory through the component's
 * `onSegmentationPayloadChange` prop and they will look right for the session,
 * but they reset on reload. There is no API-side fix from the browser.
 */
function renameSegmentTabsInSession(labels) {
  const { findFiberByText, readHookStates } = window.SPAKit;

  const found = findFiberByText('[1] Segment', 'onSegmentationPayloadChange', 'SPAN');
  if (!found) return 'Segment tab not found';

  const hooks = readHookStates(found.fiber);
  const payload = hooks[0];
  const tabs = hooks[1];
  if (!Array.isArray(tabs)) return 'Unexpected hook shape; inspect with describeChain()';

  const next = tabs.map((tab, i) => ({ ...tab, label: labels[i] || tab.label }));
  found.prop(payload, next);
  return 'Labels set for this session only: ' + next.map((t) => t.label).join(' | ');
}

if (typeof module === 'object' && module.exports) {
  module.exports = { saveBarChartEntire, renameSegmentTabsInSession };
}
