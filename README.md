# SPA Automation Toolkit

A collection of browser-side JavaScript utilities for automating configuration changes in React Single Page Applications — especially when the UI won't let you. Born out of real production work automating analytics dashboards, bug-tracking workflows, and wiki publishing at the fintech company.

> Build effort: 2–3 hrs per session, ongoing across many sessions
> Internal-team users: ~25–30 analytics, PM, UAT engineers
> Stack: Vanilla JavaScript ES2017+, zero dependencies

## The Problem

Modern SaaS platforms — analytics dashboards, project management tools, wikis — are built as React SPAs. They often have validation bugs, missing features, or restrictive UIs that prevent legitimate configurations. The underlying APIs support what's needed, but the frontend blocks it. This toolkit provides battle-tested patterns for working around those limitations without waiting for vendor fixes.

## Use Cases Solved

### 1. MoEngage Analytics — Dashboard Automation

**Problem:** MoEngage's Behavior chart editor wouldn't save bar-chart configurations. The "Save analysis" button was permanently disabled in bar-chart mode due to a UI validation bug ("Missing field — Please specify granularity"), even though the API accepted `chart_type: "column"` and `granularity: "e"` just fine.

**What was built:**

- A **fetch interceptor** sitting between the MoEngage frontend and its API, rewriting `chart_type` and `granularity` on outgoing PUT requests while letting the app's own auth headers pass through untouched
- **SPA navigation** using `pushState` + `PopStateEvent` to move between chart editors without triggering "Leave site?" dialogs that blocked automation
- **React Fiber traversal** to inspect the component hierarchy (`L → Fe → Wt → _r`), read hook states containing chart config, and call internal handlers like `onSegmentationPayloadChange` to rename segment labels in memory

**Outcome:** Automated creation and configuration of behaviour charts across multiple dashboards — including Transactions, App Activity, and user segmentation modules — with event-based segmentation ("App Active and Txn Active", "App Active but Txn Inactive", "Txn Active but App Inactive") that the UI couldn't persist natively.

### 2. Jira — Batch Ticket Creation & UAT Bug Filing

**Problem:** Filing 18+ UAT bug tickets manually through Jira's modal is painfully slow. The form's custom component library doesn't use standard `<button>` elements (Jira renders priority dropdowns as styled `<div>`s with no `role="button"`), so standard DOM queries fail. Cross-session state loss meant re-entering Priority, Parent Epic, and Labels from scratch.

**What was built:**

- UI interaction utilities that dispatch full `mousedown → mouseup → click` event sequences with coordinates — the only reliable way to interact with Jira's custom components
- **Coordinate-based click patterns** for Jira's non-semantic dropdowns where `querySelector('button')` returns nothing
- Reusable Jira REST API scripts for bulk ops: ticket creation, priority correction, assignment, status transitions — all running from the browser console with the session's own auth context

**Outcome:** Created 18 tickets, updated 5 existing ones with comments, bulk-corrected priorities across 16 tickets, and bulk-assigned all to a team member — work that would have taken hours done in minutes.

### 3. Confluence — PRD Publishing via REST API

**Problem:** Confluence draft pages have a quirk: their version number is permanently 1. Incrementing to 2 on a PUT returns HTTP 409. The standard "publish from the editor" workflow didn't support the programmatic content assembly needed (building large PRD pages from structured data with proper Confluence storage-format XHTML).

**What was built:**

- **Synchronous XHR patterns** (`XMLHttpRequest` with `async: false`) that work reliably inside browser-console JS tools — avoiding async/await issues in restricted execution contexts
- A **chunked content assembly strategy** (`window.__part1__`, `window.__part2__`, etc.) for building large Confluence pages exceeding single-call character limits
- **Confluence storage format reference** covering tables, headings, links, and special-character escaping (`&amp;`, `&lt;`, `&gt;`)

**Outcome:** Published a complete PRD (anonymised internal payment product) to Confluence programmatically, including session rules tables, analytics event specifications (9 new events with attributes and triggers), push notification templates, and in-app communication copy — all properly formatted in Confluence's XHTML storage format.

### 4. SharePoint — DOCX Extraction Without Libraries

**Problem:** Needed to extract feedback text from a SharePoint-hosted Word document to create Jira tickets. SharePoint's CSP blocks external CDN scripts (JSZip, mammoth.js, etc.), and the Word iframe is cross-origin so direct DOM access fails.

**What was built:**

- A **manual ZIP parser** using native browser APIs — byte-scanning for `PK\x03\x04` signatures to locate entries in the DOCX archive, then using the native `DecompressionStream('deflate-raw')` API to decompress `word/document.xml`
- **SharePoint REST API integration** for file discovery (`GetFileById`) and binary download (`GetFileByServerRelativePath/$value`) — all from the browser's own JS context to inherit SharePoint's session cookies

**Outcome:** Extracted **4,765 characters** of structured UAT feedback from a SharePoint DOCX, parsed into individual bug reports, and fed into the Jira batch creation pipeline — all without any external dependencies.

## Technical Patterns

The toolkit distils these use cases into four reusable modules:

| Module | What it does |
|---|---|
| `src/fetch-interceptor.js` | Monkey-patches `window.fetch` to intercept matching requests and transform their JSON body before sending. Handles `ReadableStream` bodies, provides a `restore()`, optionally exposes original/modified payloads for debugging |
| `src/react-fiber-traversal.js` | Walk React's internal Fiber tree from any DOM element. Find components by prop name, read hook-state chains (`memoizedState.next.memoizedState...`), call internal handlers. Works with React 16+ across minified production builds |
| `src/spa-navigation.js` | Navigate within React Router SPAs using `history.pushState` + `PopStateEvent`, completely bypassing `beforeunload` confirmation dialogs |
| `src/ui-interaction.js` | Simulate realistic user interactions with full `mousedown → mouseup → click` event sequences, element lookup by text content or Material Icon ligature, DOM polling with configurable timeout |

## Quick Start

```javascript
// Intercept a PUT request and override two fields before it reaches the server
installFetchInterceptor({
  match: (url, method) => url.includes('/api/charts/') && method === 'PUT',
  transformBody: (payload) => ({
    ...payload,
    chart_type: 'column',
    granularity: 'entire',
  }),
  debug: true,
});
```

## Key Lessons Learned (from 6+ sessions of real-world automation)

1. **Direct `fetch()` calls from the console return 401** — SPAs like MoEngage and Jira inject auth headers via middleware that only runs for app-initiated requests. Always use the interceptor pattern to let the app's own auth pipeline handle authentication.
2. **React state changes don't enable Save buttons** — calling an internal handler updates component state but doesn't set the form's `isDirty` flag. You need a genuine UI action (clicking a mode toggle) to trigger it.
3. **Jira doesn't use semantic HTML for form controls** — priority dropdowns are styled `<div>`s, not `<button>`s. `querySelector('button')` returns nothing. Coordinate-based clicks are the only reliable approach.
4. **SharePoint CSP blocks all external scripts** — can't load JSZip, mammoth.js, or any CDN library. Native `DecompressionStream` is the only path for DOCX extraction.
5. **Confluence draft pages are always version 1** — sending `version: { number: 2 }` on a PUT to a draft page returns 409. Always use `version: { number: 1 }`.
6. **Fiber keys are dynamic** — never hardcode `__reactFiber$abc123`. The suffix changes per page load. Always search with `Object.keys().find()`.

## Compatibility

- React 16+ (Fiber architecture)
- Chrome, Firefox, Edge (any browser with ES2017+ and DevTools console)
- Tested against: MoEngage Analytics, Atlassian Jira, Atlassian Confluence, Microsoft SharePoint
- Patterns are framework-agnostic at the browser level

---

