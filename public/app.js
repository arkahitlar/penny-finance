import { createDemo, emptyAnalytics } from './demo.js';
import { createExpenseComposer } from './expenseComposer.js';
import { createExpenseManager } from './expenseManager.js';
import { todayInIndia, expenseDate, dateLabel } from './expenseDates.js';
import { buildDemoReport } from './reports.js';
import { calculateInsights } from './insights.js';

const $ = (selector) => document.querySelector(selector);
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const categoryMeta = {
  food_drink: { name: 'Food & drink', color: '#9aab7d', background: '#f0f3e9', icon: '<path d="M5 3v7m3-7v7m-6-7v7a3 3 0 0 0 6 0m-3 3v8M16 3v18m0-18c5 3 5 9 0 9"/>' },
  transport: { name: 'Getting around', color: '#8c9caf', background: '#eef1f6', icon: '<rect x="4" y="4" width="16" height="13" rx="3"/><path d="M4 10h16M8 17l-2 4m10-4 2 4M8 14h.01M16 14h.01M8 4V2m8 2V2"/>' },
  shopping: { name: 'Shopping', color: '#b59aab', background: '#f6eef2', icon: '<path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2"/>' },
  entertainment: { name: 'Entertainment', color: '#b7a483', background: '#f4f0e9', icon: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="m10 9 5 3.5-5 3.5V9ZM8 2l3 3m3-3 3 3"/>' },
  groceries: { name: 'Groceries', color: '#8ea395', background: '#edf3ed', icon: '<path d="M3 8h18l-2 12H5L3 8Zm4 0 4-6m6 6-4-6M9 12v4m6-4v4"/>' },
  bills: { name: 'Bills & utilities', color: '#9c9abb', background: '#f0eff6', icon: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Zm3 5h6M9 11h6m-6 4h3"/>' },
  health: { name: 'Health', color: '#ba9494', background: '#f6eeee', icon: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>' },
  other: { name: 'Other', color: '#99a1a5', background: '#f0f2f3', icon: '<circle cx="12" cy="12" r="9"/><path d="M7 12h.01M12 12h.01M17 12h.01"/>' },
};

let demo = null;
let isSaving = false;
let refreshVersion = 0;
let user = null;
let authConfigured = false;
let activeView = 'today';
let reportsView = null;
let reportsLoading = null;
let sessionVersion = 0;

function money(amount) { return rupees.format(amount); }
function paymentLabel(method) { return ({ cash: 'Cash', credit_card: 'Credit card' })[method] || 'Payment not specified'; }
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
function setStatus(message, error = false) {
  $('#form-status').textContent = message;
  $('#form-status').classList.toggle('error', error);
  $('#expense-input').setAttribute('aria-invalid', String(error));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', signal: AbortSignal.timeout(28000), headers: { ...options.headers, 'Content-Type': 'application/json' } });
  let result;
  try { result = await response.json(); } catch { throw new Error('The server is unavailable. Please try again.'); }
  if (!response.ok || !result.success) {
    const error = new Error(result.error?.message || result.message || 'Something went wrong. Please try again.');
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  return result.data;
}

function renderExpenses(expenses) {
  const container = $('#expense-list');
  container.replaceChildren();
  $('#empty-state').hidden = expenses.length > 0;
  $('#feed-count').textContent = expenses.length;
  for (const expense of expenses) {
    const category = categoryMeta[expense.category] || categoryMeta.other;
    const card = node('article', 'card expense-card');
    card.style.setProperty('--category-bg', category.background);
    card.style.setProperty('--category-color', category.color);
    const top = node('div', 'expense-card-top');
    const icon = node('span', 'expense-icon');
    icon.setAttribute('aria-hidden', 'true');
    // Only static, developer-owned SVG paths are inserted as markup.
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${category.icon}</svg>`;
    const time = node('time', 'expense-time', dateLabel(expenseDate(expense)));
    time.dateTime = expenseDate(expense);
    top.append(icon, time);
    const name = node('h3', 'expense-name', expense.item);
    name.title = expense.item;
    const bottom = node('div', 'expense-card-bottom');
    const categoryLabel = node('span', 'expense-category');
    categoryLabel.append(document.createTextNode(category.name));
    const amountLabel = node('p', 'expense-amount', money(expense.amount));
    amountLabel.classList.toggle('is-long', amountLabel.textContent.length > 9);
    bottom.append(categoryLabel, amountLabel);
    card.append(top, name, bottom, node('p', 'expense-payment', paymentLabel(expense.payment_method)));
    const actions = node('div', 'expense-actions');
    for (const [kind, label] of [['edit', 'Edit'], ['delete', 'Delete']]) {
      const control = node('button', `expense-action expense-action-${kind}`, label);
      control.type = 'button';
      control.setAttribute('aria-label', `${label} ${expense.item}`);
      control.addEventListener('click', () => manager.open(expense, kind));
      actions.append(control);
    }
    card.append(actions);
    container.append(card);
  }
}

function renderAnalytics(analytics) {
  $('#total-spent').textContent = money(analytics.total_spent);
  $('#total-spent').classList.toggle('is-long', money(analytics.total_spent).length > 9);
  $('#expense-count').textContent = plural(analytics.expense_count, 'expense');
  const largest = [...(analytics.expenses || [])].sort((a, b) => b.amount - a.amount)[0];
  $('#leak-total').textContent = largest ? money(largest.amount) : '—';
  $('#leak-total').classList.toggle('is-long', largest && money(largest.amount).length > 9);
  $('#leak-count').textContent = largest ? largest.item : 'No entries for today yet';
  const insight = calculateInsights(analytics, { max: 1 });
  const first = insight.observations[0];
  $('#insight-symbol').textContent = first ? '↗' : '◎';
  $('#insight-label').textContent = 'WHAT CHANGED?';
  $('#insight-title').textContent = first?.title || 'A little more history.';
  $('#insight-description').textContent = first?.text || insight.emptyMessage;
  if ($('#insight-detail-label')) $('#insight-detail-label').textContent = 'Based on your logged expenses';
  if ($('#leak-share')) $('#leak-share').textContent = '';
  if ($('#share-fill')) $('#share-fill').parentElement.hidden = true;
  if ($('#insight-caption')) $('#insight-caption').textContent = 'Open Reports for weekly and monthly patterns.';
  const categoryTotals = new Map();
  for (const group of analytics.groups) categoryTotals.set(group.category, (categoryTotals.get(group.category) || 0) + group.total);
  const list = $('#category-list');
  list.replaceChildren();
  if (!categoryTotals.size) list.append(node('p', 'muted-empty', 'Your categories will appear here.'));
  for (const [key, total] of [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])) {
    const category = categoryMeta[key] || categoryMeta.other;
    const row = node('div', 'category-row');
    row.style.setProperty('--category-color', category.color);
    row.style.setProperty('--category-width', `${analytics.total_spent ? total / analytics.total_spent * 100 : 0}%`);
    const head = node('div', 'category-row-head');
    const name = node('span', 'category-row-name');
    name.append(node('span', 'category-dot'), document.createTextNode(category.name));
    head.append(name, node('span', 'category-value', money(total)));
    const track = node('div', 'category-track');
    track.append(node('div', 'category-fill'));
    row.append(head, track);
    list.append(row);
  }

}

async function refresh() {
  if (!demo && !user) return false;
  const version = ++refreshVersion;
  $('#dashboard').setAttribute('aria-busy', 'true');
  try {
    const report = demo
      ? buildDemoReport(demo.getAllExpenses().expenses, 'day', todayInIndia())
      : await api('/api/reports?period=day');
    if (version !== refreshVersion) return true;
    renderExpenses(report.expenses);
    renderAnalytics(report);
    $('#connection-state').hidden = true;
    return true;
  } catch (error) {
    if (version !== refreshVersion) return false;
    if (error.status === 401) { expireSession(); return false; }
    const setup = error.status === 503;
    $('#connection-message').textContent = setup
      ? 'Your journal is ready. Connect your database and AI key to start, or explore a sample day.'
      : 'Couldn’t refresh your journal. Any entries already shown may be out of date.';
    $('#connection-state').hidden = false;
    return false;
  } finally {
    if (version === refreshVersion) $('#dashboard').setAttribute('aria-busy', 'false');
  }
}

const feedback = node('p', 'journal-feedback');
feedback.setAttribute('role', 'status');
feedback.setAttribute('aria-live', 'polite');
feedback.hidden = true;
$('main').prepend(feedback);

function notifyJournal(message, error = false) {
  feedback.hidden = !message;
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
}
const manager = createExpenseManager({
  mutate: (method, payload) => demo
    ? (method === 'PATCH' ? demo.updateExpense(payload) : demo.deleteExpense(payload))
    : api('/api/expenses', { method, body: JSON.stringify(payload) }),
  onChanged: async ({ kind }) => {
    const okay = activeView === 'reports' ? await reportsView.refresh() : await refresh();
    notifyJournal(kind === 'refresh' ? 'Entries refreshed. Review the latest details before trying again.'
      : `${kind === 'delete' ? 'Expense deleted' : 'Expense updated'}.${okay ? ' Your totals are up to date.' : ' Refresh to load the updated totals.'}`, !okay);
  },
  onUnauthorized: expireSession,
  onOpenChange: open => { isSaving = open; },
});

const composer = createExpenseComposer({
  dialog: $('#expense-dialog'),
  preview: async (text) => demo ? demo.previewExpense(text) : (await api('/api/previewExpense', {
    method: 'POST', body: JSON.stringify({ text }),
  })).draft,
  save: async (draftId, choices, key) => demo ? demo.saveExpense(draftId, choices, key) : (await api('/api/parseExpense', {
    method: 'POST', body: JSON.stringify({ draft_id: draftId, ...choices }), headers: { 'Idempotency-Key': key },
  })).expense,
  onDismissUncertain: async () => {
    const loaded = await refresh();
    setStatus(loaded ? 'Your journal was refreshed. The save may have completed; check Today or Reports before entering the expense again.' : 'The save may have completed. Refresh and check your journal before entering it again.', !loaded);
  },
  onSaved: async (expense) => {
    const savedSession = sessionVersion;
    $('#expense-input').value = '';
    const refreshed = await refresh();
    if (savedSession !== sessionVersion || (!user && !demo)) return;
    setStatus(refreshed
      ? `${expense.item} · ${money(expense.amount)} · ${paymentLabel(expense.payment_method)} added for ${dateLabel(expenseDate(expense))}${demo ? ' in this sample journal' : ''}.${expenseDate(expense) !== todayInIndia() ? ' Find it in Reports.' : ''}`
      : 'Your expense was saved. Refresh the journal to see the updated totals.');
  },
  onUnauthorized: expireSession,
  onOpenChange: (open) => {
    isSaving = open;
    $('#expense-input').readOnly = open;
    $('#submit-button').disabled = open;
    if (!open && (user || demo)) $('#expense-input').focus();
  },
});

$('#expense-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (isSaving) return;
  if (!demo && !user) { expireSession(); return; }
  const input = $('#expense-input');
  const text = input.value.trim();
  if (!text) { setStatus('Start with what you bought and how much it cost.', true); input.focus(); return; }
  setStatus('');
  composer.open(text);
});

$('#retry-button').addEventListener('click', refresh);

async function enterDemo() {
  if (isSaving) return;
  try {
    clearFinancialState();
    demo = createDemo();
    activeView = 'today';
    renderAccount();
    setStatus('');
    await refresh();
  } catch { setStatus('The sample day couldn’t load. Please try again.', true); }
}
$('#demo-button').addEventListener('click', enterDemo);
$('#welcome-demo').addEventListener('click', enterDemo);
$('#exit-demo').addEventListener('click', async () => {
  if (isSaving) return;
  demo = null;
  clearFinancialState();
  activeView = 'today';
  history.replaceState(null, '', location.pathname);
  await loadSession();
  renderAccount();
  if (user) await refresh();
});

function clearFinancialState() {
  refreshVersion++;
  composer.reset();
  manager.reset();
  notifyJournal('');
  $('#expense-input').value = '';
  $('#connection-state').hidden = true;
  renderExpenses([]);
  renderAnalytics(emptyAnalytics());
  reportsView?.clear();
  setStatus('');
}

function renderAccount() {
  const hasJournal = Boolean(user || demo);
  $('#session-loading').hidden = true;
  $('#auth-view').hidden = hasJournal;
  $('#app-nav').hidden = !hasJournal;
  $('#today-view').hidden = !hasJournal || activeView !== 'today';
  $('#reports-view').hidden = !hasJournal || activeView !== 'reports';
  $('#demo-note').hidden = !demo;
  $('#mode-badge').hidden = !demo;
  $('#account-control').hidden = !user;
  $('#input-help').textContent = demo ? 'Sample day. Try an expense in your own words.' : 'Your words. Automatically organised.';
  $('#exit-demo').textContent = user ? 'Back to my journal ↗' : 'Sign in to start my journal ↗';
  $('#demo-button').hidden = Boolean(user);
  if (user) {
    const name = user.name || 'Your account';
    $('#user-name').textContent = name.split(' ')[0];
    $('#user-name').title = user.email;
    $('#user-avatar').textContent = name.charAt(0).toUpperCase();
  } else {
    $('#user-name').textContent = '';
    $('#user-name').removeAttribute('title');
    $('#user-avatar').textContent = '';
  }
  for (const name of ['today', 'reports']) {
    const button = $(`#nav-${name}`);
    button.classList.toggle('is-active', name === activeView);
    if (name === activeView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function expireSession() {
  sessionVersion++;
  user = null;
  demo = null;
  activeView = 'today';
  clearFinancialState();
  renderAccount();
  $('#auth-status').textContent = 'Your session ended. Sign in again to continue.';
}

async function loadSession() {
  const version = ++sessionVersion;
  try {
    const session = await api('/api/auth?action=session');
    if (version !== sessionVersion) return;
    if (!demo && user?.id !== session.user?.id) clearFinancialState();
    user = session.user;
    authConfigured = session.configured;
    $('#auth-status').textContent = authConfigured ? '' : 'Google sign-in is not connected yet. You can explore the sample journal below.';
  } catch {
    if (version !== sessionVersion) return;
    user = null;
    authConfigured = false;
    if (!demo) clearFinancialState();
    $('#auth-status').textContent = 'We couldn’t check your session. Try signing in again in a moment.';
  } finally {
    if (version === sessionVersion) {
      $('#google-signin').disabled = false;
      renderAccount();
    }
  }
}

async function openView(view) {
  if (isSaving || (!user && !demo)) return;
  notifyJournal('');
  activeView = view;
  renderAccount();
  if (view === 'today') { await refresh(); return; }
  try {
    if (!reportsLoading) reportsLoading = import('./reports.js');
    const { createReportsView } = await reportsLoading;
    if (!reportsView) reportsView = createReportsView({ root: $('#reports-view'), request: api, getDemo: () => demo, onUnauthorized: expireSession, onEdit: expense => manager.open(expense, 'edit'), onDelete: expense => manager.open(expense, 'delete') });
    if (activeView === 'reports' && (user || demo)) await reportsView.refresh();
  } catch {
    reportsLoading = null;
    $('#reports-view').replaceChildren(node('p', 'report-load-error', 'Reports couldn’t load. Select Reports again to retry.'));
  }
}

$('#nav-today').addEventListener('click', () => openView('today'));
$('#nav-reports').addEventListener('click', () => openView('reports'));
$('#view-reports-button')?.addEventListener('click', () => openView('reports'));
$('#google-signin').addEventListener('click', async () => {
  if (!authConfigured) {
    $('#google-signin').disabled = true;
    await loadSession();
    if (!authConfigured) return;
  }
  $('#google-signin').disabled = true;
  $('#auth-status').textContent = 'Taking you to Google…';
  location.assign('/api/auth?action=login');
});
$('#signout-button').addEventListener('click', async () => {
  if (isSaving) return;
  $('#signout-button').disabled = true;
  try {
    await api('/api/auth?action=logout', { method: 'POST', body: '{}' });
    sessionVersion++;
    user = null;
    demo = null;
    activeView = 'today';
    clearFinancialState();
    renderAccount();
    $('#auth-status').textContent = 'You’re signed out. Your journal will be here when you return.';
  } catch (error) {
    if (error.status === 401) expireSession();
    else {
      $('#connection-message').textContent = 'Couldn’t sign out. Please try again.';
      $('#connection-state').hidden = false;
      activeView = 'today';
      renderAccount();
    }
  } finally { $('#signout-button').disabled = false; }
});

function updateDate() {
  $('#header-date').textContent = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
}
async function refreshActiveView() {
  updateDate();
  if (isSaving) return;
  if (!demo) await loadSession();
  if (user || demo) await openView(activeView);
}
window.addEventListener('focus', refreshActiveView);
setInterval(() => {
  if (document.visibilityState === 'visible') refreshActiveView();
}, 60000);
updateDate();
const search = new URLSearchParams(location.search);
await loadSession();
if (search.has('auth_error')) {
  $('#auth-status').textContent = 'Sign-in wasn’t completed. Please try again.';
  history.replaceState(null, '', location.pathname);
}
if (search.get('demo') === '1') await enterDemo();
else if (user) await refresh();
