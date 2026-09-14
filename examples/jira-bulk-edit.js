/**
 * Worked example: bulk-edit Jira issues from the browser console.
 *
 * The problem
 * -----------
 * Filing or correcting twenty UAT tickets through Jira's modal is slow, and the
 * modal loses Priority, Parent and Labels between issues. Two obstacles get in
 * the way of automating it.
 *
 * First, Atlaskit does not render form controls as `<button>`. A priority
 * dropdown is a styled `<div>` with no `role="button"`, so
 * `querySelector('button')` finds nothing and `el.click()` does nothing. You
 * match on text and dispatch a full pointer sequence instead.
 *
 * Second — and this is the better route where it is available — Jira has a
 * perfectly good REST API, and from inside a logged-in tab your session cookie
 * is already attached. Reach for the DOM only for things the API cannot do.
 *
 * A note on scope: this writes to a tracker other people rely on. Run the dry
 * run first, read the diff, and only then pass `apply: true`.
 *
 * Usage: paste into the console of a logged-in Jira tab.
 */
'use strict';

const JIRA = {
  /** Origin of your Jira site, e.g. 'https://acme.atlassian.net'. */
  base: window.location.origin,
};

/**
 * Call the Jira REST API using the tab's own session.
 *
 * @param {string} path   e.g. '/rest/api/3/issue/ABC-1'
 * @param {Object} [init]
 * @returns {Promise<*>} parsed JSON, or null for 204
 */
async function jira(path, init) {
  const res = await fetch(JIRA.base + path, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      // Jira rejects state-changing calls without this header.
      'X-Atlassian-Token': 'no-check',
    },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`Jira ${init && init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Search issues with JQL.
 *
 * @param {string} jql
 * @param {string[]} [fields]
 * @returns {Promise<Array>}
 */
async function search(jql, fields) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const page = await jira('/rest/api/3/search', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: 100,
        fields: fields || ['summary', 'priority', 'status', 'assignee', 'labels'],
      }),
    });
    out.push(...page.issues);
    startAt += page.issues.length;
    if (startAt >= page.total || page.issues.length === 0) break;
  }
  return out;
}

/**
 * Set the priority on many issues, with a dry run by default.
 *
 * @param {Object}  opts
 * @param {string}  opts.jql       Which issues to touch.
 * @param {string}  opts.priority  Priority name, e.g. 'High'.
 * @param {boolean} [opts.apply=false] false prints the plan and changes nothing.
 * @returns {Promise<{planned: Array, applied: number}>}
 */
async function bulkSetPriority(opts) {
  const issues = await search(opts.jql, ['summary', 'priority']);

  const planned = issues
    .filter((i) => (i.fields.priority && i.fields.priority.name) !== opts.priority)
    .map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      from: i.fields.priority ? i.fields.priority.name : '(none)',
      to: opts.priority,
    }));

  console.table(planned);

  if (!opts.apply) {
    console.log(`Dry run. ${planned.length} issue(s) would change. Pass apply:true to write.`);
    return { planned, applied: 0 };
  }

  let applied = 0;
  for (const row of planned) {
    await jira(`/rest/api/3/issue/${row.key}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { priority: { name: opts.priority } } }),
    });
    applied++;
  }
  console.log(`Applied to ${applied} issue(s).`);
  return { planned, applied };
}

/**
 * Add the same comment to many issues.
 *
 * @param {Object}  opts
 * @param {string}  opts.jql
 * @param {string}  opts.text
 * @param {boolean} [opts.apply=false]
 */
async function bulkComment(opts) {
  const issues = await search(opts.jql, ['summary']);
  if (!opts.apply) {
    console.log(`Dry run. Would comment on ${issues.length} issue(s):`,
      issues.map((i) => i.key).join(', '));
    return { planned: issues.length, applied: 0 };
  }
  let applied = 0;
  for (const issue of issues) {
    await jira(`/rest/api/3/issue/${issue.key}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: opts.text }] }],
        },
      }),
    });
    applied++;
  }
  return { planned: issues.length, applied };
}

/**
 * Set a field the API will not let you set — the DOM fallback.
 *
 * Only worth reaching for when the REST route genuinely does not exist. Jira's
 * dropdowns are non-semantic divs, so this matches on the option's visible text
 * and dispatches a real pointer sequence.
 *
 * @param {string} fieldLabel  e.g. 'Priority'
 * @param {string} optionText  e.g. 'High'
 */
async function setDropdownByText(fieldLabel, optionText) {
  const { findByText, click, waitForText } = window.SPAKit;

  const field = findByText(fieldLabel, { exact: true });
  if (!field) throw new Error(`No field labelled ${fieldLabel}`);

  // The control sits next to the label, not inside it.
  const control = field.parentElement.querySelector('[role="combobox"], [class*="control"]')
    || field.nextElementSibling;
  click(control);

  const option = await waitForText(optionText, { timeout: 5000 });
  click(option);
  return option;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { jira, search, bulkSetPriority, bulkComment, setDropdownByText };
}
