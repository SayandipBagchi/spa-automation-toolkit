# SPA Automation Toolkit

Browser-side JavaScript for automating configuration changes in React single-page
applications — specifically for the case where the API supports what you need and
the UI will not let you do it.

Zero dependencies. Paste a file into a DevTools console, or `require()` it in Node.

```
npm test    # 22 tests, no dependencies, Node 14+
```

## The problem

Enterprise SaaS — analytics dashboards, issue trackers, wikis — ships as React
SPAs with validation bugs, missing bulk operations, and controls that are disabled
for reasons the backend does not share. The underlying API accepts what you want
to do. The frontend is what is stopping you.

The reflex is to drive the DOM with a headless browser. That is usually the wrong
tool: you end up re-implementing SSO and MFA, and you still lose to non-semantic
components. The approach here is the opposite — run inside the user's own
logged-in session, and be deliberate about side effects.

## Modules

| Module | What it does |
|---|---|
| [`src/fetch-interceptor.js`](src/fetch-interceptor.js) | Patch `window.fetch` to rewrite a JSON request body on its way out, while the app's own auth pipeline still builds the request. Handles `ReadableStream`, `Request`, `URLSearchParams` and object bodies. Interceptors stack, each returns an uninstall, and a throwing transform can never break the host app. |
| [`src/react-fiber-traversal.js`](src/react-fiber-traversal.js) | Walk React's Fiber tree from any DOM node in a minified production build. Find components by prop, read hook-state chains, call internal handlers, and print the component chain when you need to look around. |
| [`src/spa-navigation.js`](src/spa-navigation.js) | Move between routes via `pushState` + `PopStateEvent`, so an unsaved-changes guard never raises a "Leave site?" modal. Includes a settle-aware `navigateAndWait`. |
| [`src/ui-interaction.js`](src/ui-interaction.js) | Full `pointerdown → mousedown → pointerup → mouseup → click` sequences with real coordinates, element lookup by text or Material Icons ligature, React-aware input setting, and polling helpers. |

## Quick start

```javascript
// Rewrite two fields on the way out, and let the app's own save button do the rest.
const uninstall = installFetchInterceptor({
  match: (url, method) => url.includes('/api/charts/') && method === 'PUT',
  transformBody: (payload) => ({
    ...payload,
    chart_type: 'column',
    granularity: 'e',
  }),
  debug: true,
  once: true,
});

// ... click Save in the UI ...

SPAKit.lastIntercepted();   // { original, modified, url, method, at }
uninstall();
```

Each module attaches to a `window.SPAKit` namespace when pasted into a console,
and exports the same functions under CommonJS when required.

## Worked examples

Both are anonymised, and both encode a specific thing that does not work and why.

- [`examples/moengage-bar-chart-save.js`](examples/moengage-bar-chart-save.js) —
  persisting a bar chart with Entire granularity past a frontend validation bug,
  end to end: navigate, arm the interceptor, drive the real save control, then
  assert on what actually went over the wire.
- [`examples/jira-bulk-edit.js`](examples/jira-bulk-edit.js) — bulk priority
  changes and comments against Jira's REST API from a logged-in tab, with a dry
  run that prints the diff before anything is written, plus a DOM fallback for
  the fields the API will not take.

## Where this came from

Built across roughly six sessions of production work at a fintech: automating
analytics dashboards, UAT bug triage, and wiki publishing for a team of about 25
to 30 analysts, PMs and UAT engineers. Every pattern below is here because
something simpler failed first.

### 1. MoEngage — a chart the UI refused to save

The Behavior chart editor greys out "Save analysis" for a bar chart in Entire
mode: *"Missing field — Please specify granularity for chart"*. The API stores
`chart_type: "column"` with `granularity: "e"` quite happily.

Setting it through React does not work either, because bar mode and time
granularity are mutually exclusive in the reducer — setting one resets the other —
and a programmatic state change never sets the form's dirty flag, so Save stays
disabled regardless.

What worked: save from Daily mode, which passes validation, and rewrite the two
fields in the interceptor.

### 2. Jira — filing and correcting UAT tickets in bulk

Filing 18 tickets through the modal is slow, and it loses Priority, Parent and
Labels between issues. Atlaskit renders priority dropdowns as styled `<div>`s, so
`querySelector('button')` returns nothing and `el.click()` is ignored.

What worked: the REST API for anything it supports, running on the tab's own
session cookie, with coordinate-based pointer sequences reserved for fields the
API will not take. Result across one session: 18 tickets created, 5 updated with
comments, priorities corrected across 16, all bulk-assigned.

### 3. Confluence — publishing a PRD programmatically

Draft pages are permanently version 1. `PUT` with `version: {number: 2}` returns
409. Large pages also exceed what a single console call can carry.

What worked: `version: {number: 1}` always, chunked assembly across
`window.__part1__`, `window.__part2__`, and Confluence storage-format XHTML with
`&amp;`, `&lt;`, `&gt;` escaped properly.

### 4. SharePoint — reading a DOCX with no libraries

SharePoint's CSP blocks every external script, so JSZip and mammoth.js are out,
and the Word iframe is cross-origin.

What worked: byte-scan the archive for `PK\x03\x04` signatures, decompress
`word/document.xml` with the native `DecompressionStream('deflate-raw')`, and
fetch the binary through SharePoint's own REST endpoints so session cookies come
along. Extracted 4,765 characters of structured UAT feedback with no dependencies.

## Lessons that cost the most to learn

1. **Direct `fetch()` from the console returns 401.** Auth headers come from
   middleware that only runs for app-initiated requests. Intercept; do not
   originate.
2. **React state changes do not enable Save buttons.** Calling an internal handler
   updates state without setting `isDirty`. You need one genuine UI interaction.
3. **Jira does not use semantic HTML for form controls.** Priority dropdowns are
   `<div>`s. Match on text; dispatch a full pointer sequence with coordinates.
4. **SharePoint CSP blocks all external scripts.** Native `DecompressionStream` is
   the only path to DOCX contents.
5. **Confluence draft pages are always version 1.** Sending version 2 returns 409.
6. **Fiber keys are per-page-load.** Never hardcode `__reactFiber$abc123`; always
   discover the key with `Object.keys().find()`.
7. **`window.location.href` triggers `beforeunload`.** In a driven browser a modal
   blocks every subsequent command. Use `pushState` + `PopStateEvent`.

## Repo layout

```
spa-automation-toolkit/
├── src/
│   ├── fetch-interceptor.js       intercept and rewrite outgoing requests
│   ├── react-fiber-traversal.js   find components, read hooks, call handlers
│   ├── spa-navigation.js          route changes without unload prompts
│   └── ui-interaction.js          clicks, lookup, React inputs, polling
├── examples/
│   ├── moengage-bar-chart-save.js worked end-to-end save past a validation bug
│   └── jira-bulk-edit.js          REST bulk ops with a dry run, plus DOM fallback
├── test/run-tests.js              22 tests, dependency-free
└── package.json, LICENSE, README.md
```

## Compatibility

- React 16+ (Fiber architecture)
- Any browser with ES2017+ and a DevTools console
- Verified against MoEngage Analytics, Atlassian Jira, Atlassian Confluence,
  Microsoft SharePoint
- The patterns are framework-agnostic at the browser level

## Scope and caution

These tools write to systems other people depend on. The examples dry-run by
default and print a diff before applying, and that is the intended shape: look at
what would change, then change it. `restoreFetch()` when you are done — leaving a
patched `fetch` in a tab a colleague is using is a genuinely bad afternoon.

Nothing here bypasses authentication or authorisation. Everything runs as you,
with the permissions you already have, in a session you already opened.

## License

MIT — see [LICENSE](LICENSE).
