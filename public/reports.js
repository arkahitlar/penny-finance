import { calculateInsights } from './insights.js';

const INDIA_OFFSET = 330 * 60 * 1000;
const DAY = 86400000;
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthDate = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const categories = {
  food_drink: ['Food & drink', '#96a77d'], transport: ['Getting around', '#91a3b8'],
  shopping: ['Shopping', '#b697aa'], entertainment: ['Entertainment', '#b6a17a'],
  groceries: ['Groceries', '#88a492'], bills: ['Bills & utilities', '#9c99b8'],
  health: ['Health', '#b98f8f'], other: ['Other', '#96a0a5'],
};
function money(value) { return currency.format(value); }
function todayKey(now = new Date()) { return new Date(new Date(now).valueOf() + INDIA_OFFSET).toISOString().slice(0, 10); }
function dateValue(key) { return new Date(`${key}T00:00:00Z`); }
function dateKey(value) { return new Date(value).toISOString().slice(0, 10); }
function shiftDay(key, count) { return dateKey(dateValue(key).valueOf() + count * DAY); }
function periodBounds(period, anchor) {
  const date = dateValue(anchor);
  if (period === 'week') {
    const start = shiftDay(anchor, -((date.getUTCDay() + 6) % 7));
    return { start, end: shiftDay(start, 6) };
  }
  if (period === 'month') {
    return { start: dateKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)), end: dateKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)) };
  }
  return { start: anchor, end: anchor };
}
function movePeriod(period, anchor, direction) {
  const bounds = periodBounds(period, anchor);
  if (period === 'day') return shiftDay(bounds.start, direction);
  if (period === 'week') return shiftDay(bounds.start, direction * 7);
  const date = dateValue(bounds.start);
  return dateKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1));
}
function dateCount(start, end) { return Math.max(0, Math.round((dateValue(end) - dateValue(start)) / DAY) + 1); }
function isReportDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > todayKey()) return false;
  const date = dateValue(value);
  return Number.isFinite(date.valueOf()) && dateKey(date) === value;
}
function periodLabel(period, start, end) {
  if (period === 'month') return monthDate.format(dateValue(start));
  if (period === 'day') return longDate.format(dateValue(start));
  return `${shortDate.format(dateValue(start))} – ${shortDate.format(dateValue(end))} ${dateValue(end).getUTCFullYear()}`;
}
function createNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(className, text, label) {
  const element = createNode('button', className, text);
  element.type = 'button';
  if (label) element.setAttribute('aria-label', label);
  return element;
}
function categoryInfo(category) { return categories[category] || categories.other; }
function rounded(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function expenseDay(expense) { return expense.expense_date || todayKey(expense.created_at); }
function sumPaise(expenses) { return expenses.reduce((sum, expense) => sum + Math.round(expense.amount * 100), 0); }
function aggregateCategories(expenses) {
  const groups = new Map();
  for (const expense of expenses) {
    const group = groups.get(expense.category) || { category: expense.category, count: 0, paise: 0 };
    group.count++;
    group.paise += Math.round(expense.amount * 100);
    groups.set(expense.category, group);
  }
  return [...groups.values()].map(({ category, count, paise }) => ({ category, count, total: paise / 100 }));
}

// The preview uses only its actual in-memory expenses, including an empty past.
export function buildDemoReport(allExpenses, period = 'week', anchor = todayKey(), now = new Date(), paymentMethod = 'all') {
  allExpenses = allExpenses.filter((expense) => paymentMethod === 'all' || expense.payment_method === paymentMethod);
  const today = todayKey(now);
  const { start, end } = periodBounds(period, anchor);
  const elapsedEnd = end < today ? end : today;
  const daysElapsed = dateCount(start, elapsedEnd);
  const within = (expenses, from, through) => expenses.filter((expense) => {
    const key = expenseDay(expense);
    return key >= from && key <= through;
  });
  const expenses = within(allExpenses, start, elapsedEnd).sort((a, b) => expenseDay(b).localeCompare(expenseDay(a)) || b.created_at.localeCompare(a.created_at));
  const series = Array.from({ length: daysElapsed }, (_, index) => ({ date: shiftDay(start, index), total: 0 }));
  const seriesByDay = new Map(series.map((entry) => [entry.date, entry]));
  const totalPaise = sumPaise(expenses);
  for (const expense of expenses) {
    const amountPaise = Math.round(expense.amount * 100);
    const daily = seriesByDay.get(expenseDay(expense));
    daily.total = (Math.round(daily.total * 100) + amountPaise) / 100;
  }
  const prior = periodBounds(period, movePeriod(period, anchor, -1));
  const matchedDays = Math.min(daysElapsed, dateCount(prior.start, prior.end));
  const previousEnd = shiftDay(prior.start, matchedDays - 1);
  const previousExpenses = within(allExpenses, prior.start, previousEnd);
  const currentExpenses = within(expenses, start, shiftDay(start, matchedDays - 1));
  const previousPaise = sumPaise(previousExpenses);
  const matchedCurrentPaise = sumPaise(currentExpenses);
  return {
    payment_method: paymentMethod, period, start_date: start, end_date: end, timezone: 'Asia/Kolkata', currency: 'INR',
    total_spent: totalPaise / 100, expense_count: expenses.length,
    average_daily_spend: daysElapsed ? rounded(totalPaise / 100 / daysElapsed) : 0, days_elapsed: daysElapsed,
    groups: aggregateCategories(expenses),
    series, expenses,
    comparison: { start_date: prior.start, end_date: previousEnd, days_elapsed: matchedDays, total_spent: previousPaise / 100,
      current_total_spent: matchedCurrentPaise / 100,
      groups: aggregateCategories(previousExpenses), current_groups: aggregateCategories(currentExpenses),
      change_percent: previousPaise ? rounded((matchedCurrentPaise - previousPaise) / previousPaise * 100) : null },
  };
}

export function reportCsv(data) {
  const escape = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [['Expense date (IST)', 'Recorded at (IST)', 'Item', 'Category', 'Payment method', 'Amount (INR)']];
  for (const expense of data.expenses) {
    rows.push([expenseDay(expense), new Date(new Date(expense.created_at).valueOf() + INDIA_OFFSET).toISOString().replace('T', ' ').slice(0, 19), expense.item,
      categoryInfo(expense.category)[0], ({ cash: 'Cash', credit_card: 'Credit card' })[expense.payment_method] || 'Not specified', expense.amount.toFixed(2)]);
  }
  return '\uFEFF' + rows.map((row) => row.map(escape).join(',')).join('\r\n');
}

export function createReportsView({ root, request, getDemo, onUnauthorized, onEdit, onDelete }) {
  let period = 'week';
  let paymentMethod = 'all';
  let anchor = todayKey();
  let followCurrent = true;
  let version = 0;
  let data = null;
  let loading = false;
  let stale = true;
  let exporting = false;
  let exportVersion = 0;
  let csvController = null;
  let entryButtons = [];

  const heading = createNode('div', 'reports-heading');
  const headingCopy = createNode('div');
  headingCopy.append(createNode('p', 'eyebrow', 'YOUR MONEY, IN PERSPECTIVE'), createNode('h1', '', 'Notice your patterns.'));
  const headingNote = createNode('p', 'reports-heading-note', 'Your entries. Your dates. A clearer picture.');
  heading.append(headingCopy, headingNote);

  const toolbar = createNode('div', 'reports-toolbar');
  const segments = createNode('div', 'reports-segments');
  segments.setAttribute('role', 'group');
  segments.setAttribute('aria-label', 'Report period');
  const segmentButtons = new Map();
  for (const [key, label] of [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]) {
    const control = button('reports-segment', label);
    control.addEventListener('click', () => { period = key; refresh(); });
    segmentButtons.set(key, control);
    segments.append(control);
  }
  const navigation = createNode('div', 'reports-period-nav');
  const previous = button('reports-arrow', '←', 'Previous week');
  const periodText = createNode('span', 'reports-period-label');
  const next = button('reports-arrow', '→', 'Next week');
  navigation.append(previous, periodText, next);
  function navigate(direction) {
    const candidate = movePeriod(period, anchor, direction);
    if (!isReportDate(candidate)) return;
    anchor = candidate;
    followCurrent = periodBounds(period, anchor).start === periodBounds(period, todayKey()).start;
    refresh();
  }
  previous.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));
  const actions = createNode('div', 'reports-actions');
  const refreshButton = button('reports-button', '↻ Refresh', 'Refresh report');
  refreshButton.addEventListener('click', () => refresh());
  const downloadButton = button('reports-button reports-download', '↓ Download CSV');
  downloadButton.addEventListener('click', download);
  actions.append(refreshButton, downloadButton);
  toolbar.append(segments, navigation, actions);

  const paymentFilters = createNode('div', 'reports-payment-filters');
  paymentFilters.append(createNode('span', '', 'Paid with'));
  const paymentSegments = createNode('div', 'reports-segments');
  paymentSegments.setAttribute('role', 'group');
  paymentSegments.setAttribute('aria-label', 'Payment method');
  const paymentButtons = new Map();
  for (const [key, label] of [['all', 'All'], ['cash', 'Cash'], ['credit_card', 'Credit card']]) {
    const control = button('reports-segment', label);
    control.addEventListener('click', () => { paymentMethod = key; refresh(); });
    paymentButtons.set(key, control);
    paymentSegments.append(control);
  }
  paymentFilters.append(paymentSegments);
  const filters = createNode('div', 'reports-filters');
  const dateField = createNode('label', 'reports-date-field');
  dateField.append(createNode('span', '', 'Report date'));
  const dateInput = createNode('input', 'reports-date-input');
  dateInput.type = 'date';
  dateInput.min = '1900-01-01';
  dateInput.max = todayKey();
  dateInput.value = anchor;
  dateInput.addEventListener('change', () => {
    if (!isReportDate(dateInput.value)) {
      status.classList.add('reports-error');
      status.textContent = 'Choose a valid report date between 1 January 1900 and today.';
      dateInput.value = anchor;
      return;
    }
    anchor = dateInput.value;
    followCurrent = anchor === todayKey();
    refresh();
  });
  dateField.append(dateInput);
  filters.append(paymentFilters, dateField);

  const status = createNode('p', 'reports-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = createNode('div', 'reports-content');
  content.append(createNode('div', 'reports-initial', 'Choose a period to see where your money went.'));
  root.replaceChildren(heading, toolbar, filters, status, content);

  function updateControls() {
    for (const [key, control] of paymentButtons) control.setAttribute('aria-pressed', String(key === paymentMethod));
    for (const [key, control] of segmentButtons) control.setAttribute('aria-pressed', String(key === period));
    const { start, end } = periodBounds(period, anchor);
    periodText.textContent = periodLabel(period, start, end);
    previous.setAttribute('aria-label', `Previous ${period}`);
    next.setAttribute('aria-label', `Next ${period}`);
    previous.disabled = movePeriod(period, anchor, -1) < '1900-01-01';
    next.disabled = movePeriod(period, anchor, 1) > todayKey();
    dateInput.max = todayKey();
    dateInput.value = anchor;
    refreshButton.disabled = loading;
    refreshButton.textContent = loading ? 'Refreshing…' : '↻ Refresh';
    downloadButton.disabled = loading || stale || !data || exporting;
    downloadButton.textContent = exporting ? 'Downloading…' : '↓ Download CSV';
    content.setAttribute('aria-busy', String(loading));
    content.classList.toggle('reports-stale', stale && Boolean(data));
    for (const control of entryButtons) control.disabled = loading || stale;
  }

  async function refresh() {
    if (followCurrent) anchor = todayKey();
    const currentVersion = ++version;
    csvController?.abort();
    loading = true;
    stale = true;
    status.classList.remove('reports-error');
    status.textContent = data ? 'Updating report. Previous figures remain below until it is ready.' : 'Gathering your spending…';
    updateControls();
    try {
      const demo = getDemo();
      const result = demo ? buildDemoReport((demo.getAllExpenses?.() || demo.getExpenses()).expenses, period, anchor, new Date(), paymentMethod)
        : await request(`/api/reports?${new URLSearchParams({ period, date: anchor, payment_method: paymentMethod })}`);
      if (currentVersion !== version) return false;
      data = result;
      stale = false;
      render(result);
      status.textContent = demo ? 'Sample report · Changes stay in this tab’s memory.' : `Updated just now · India Standard Time · ${result.end_date >= todayKey() ? 'Current period includes today so far.' : 'Completed period.'}`;
      return true;
    } catch (error) {
      if (currentVersion !== version) return false;
      if (error.status === 401) { clear(); onUnauthorized?.(); return false; }
      status.classList.add('reports-error');
      status.textContent = `${error.message || 'The report could not be loaded.'}${data ? ' Figures below are from the last successful report. Refresh to try again.' : ' Refresh to try again.'}`;
      if (!data) {
        content.replaceChildren(createNode('div', 'reports-initial', 'Your report will appear here once the connection is restored.'));
      }
      return false;
    } finally {
      if (currentVersion === version) { loading = false; updateControls(); }
    }
  }

  function render(result) {
    entryButtons = [];
    const fragment = document.createDocumentFragment();
    const rangeNote = createNode('p', 'reports-range-note', `${periodLabel(result.period, result.start_date, result.end_date)} · ${({ all: 'All payments', cash: 'Cash', credit_card: 'Credit card' })[result.payment_method || 'all']} · ${result.days_elapsed} ${result.days_elapsed === 1 ? 'day' : 'days'} included`);
    fragment.append(rangeNote);
    const metrics = createNode('div', 'reports-metrics');
    const comparison = result.comparison;
    const change = comparison?.change_percent;
    let changeText = 'No spending recorded in the previous period.';
    if (typeof change === 'number') {
      changeText = change === 0 ? 'Unchanged from the previous period' : `${change < 0 ? '↓' : '↑'} ${Math.abs(change).toLocaleString('en-IN', { maximumFractionDigits: 1 })}% ${change < 0 ? 'less' : 'more'} than the previous period`;
    }
    const totalCard = metric('Total spent', money(result.total_spent), `${result.expense_count} ${result.expense_count === 1 ? 'purchase' : 'purchases'} logged`);
    const comparisonNote = createNode('p', 'reports-comparison', changeText);
    totalCard.append(comparisonNote);
    if (comparison) {
      const previousLabel = comparison.days_elapsed === 1 ? 'same 1 day' : `same ${comparison.days_elapsed} days`;
      totalCard.append(createNode('p', 'reports-metric-detail', `${money(comparison.total_spent)} previously · ${previousLabel}`));
      if (comparison.days_elapsed < result.days_elapsed) totalCard.append(createNode('p', 'reports-metric-detail', `Compared with the first ${comparison.days_elapsed} days of this period (${money(comparison.current_total_spent)}).`));
    }
    const averageCard = metric('Daily average', money(result.average_daily_spend), `Across ${result.days_elapsed} ${result.days_elapsed === 1 ? 'calendar day' : 'calendar days'}`);
    averageCard.append(createNode('p', 'reports-metric-detail reports-average-note', 'Includes calendar days with no entries. Based only on logged spending.'));
    metrics.append(totalCard, averageCard);
    fragment.append(metrics);

    const insights = calculateInsights(result);
    const insight = createNode('section', 'reports-insights');
    insight.append(createNode('h2', '', 'What changed?'), createNode('p', 'reports-insights-note', insights.note));
    const insightList = createNode('div', 'reports-insight-list');
    if (!insights.observations.length) insightList.append(createNode('p', 'reports-insights-empty', insights.emptyMessage));
    for (const observation of insights.observations) {
      const card = createNode('article', 'reports-insight');
      card.append(createNode('h3', '', observation.title), createNode('p', '', observation.text));
      insightList.append(card);
    }
    insight.append(insightList);
    fragment.append(insight);

    const grid = createNode('div', 'reports-chart-grid');
    grid.append(renderChart(result), renderCategories(result));
    fragment.append(grid);
    fragment.append(renderPurchases(result));
    content.replaceChildren(fragment);
  }

  function metric(label, value, note) {
    const card = createNode('article', 'card reports-metric');
    card.append(createNode('h2', '', label), createNode('p', 'reports-metric-value', value), createNode('p', 'reports-metric-note', note));
    return card;
  }

  function renderChart(result) {
    const card = createNode('article', 'card reports-chart-card');
    const head = createNode('div', 'reports-card-heading');
    head.append(createNode('h2', '', 'Your spending rhythm'));
    head.append(createNode('span', 'reports-heading-unit', 'Logged spending'));
    card.append(head);
    const maximum = Math.max(1, ...result.series.map((entry) => entry.total));
    const scale = createNode('div', 'reports-chart-scale');
    scale.append(createNode('span', '', money(maximum === 1 && !result.total_spent ? 0 : maximum)), createNode('span', '', 'INR / day'));
    card.append(scale);
    const chart = createNode('div', 'reports-chart');
    chart.setAttribute('aria-hidden', 'true');
    chart.style.setProperty('--report-days', Math.max(1, result.series.length));
    for (const [index, entry] of result.series.entries()) {
      const column = createNode('div', 'reports-chart-column');
      column.title = `${shortDate.format(dateValue(entry.date))}: ${money(entry.total)} logged`;
      const track = createNode('div', 'reports-chart-track');
      const bar = createNode('div', 'reports-chart-bar');
      bar.style.height = `${entry.total / maximum * 100}%`;
      if (entry.total) bar.classList.add('has-spending');
      track.append(bar);
      const showLabel = result.series.length <= 7 || index === 0 || index === result.series.length - 1 || (index + 1) % 7 === 0;
      const label = createNode('span', 'reports-chart-date', showLabel ? (result.series.length === 1 ? shortDate.format(dateValue(entry.date)) : String(dateValue(entry.date).getUTCDate())) : '');
      column.append(track, label);
      chart.append(column);
    }
    card.append(chart);
    if (!result.expense_count) card.append(createNode('p', 'reports-chart-empty', 'No spending recorded in this period.'));
    const details = createNode('details', 'reports-chart-details');
    details.append(createNode('summary', '', 'View daily amounts'));
    const table = createNode('table', 'reports-daily-table');
    const caption = createNode('caption', 'sr-only', 'Daily logged spending in Indian rupees');
    const headRow = createNode('tr');
    for (const text of ['Day', 'Total']) { const cell = createNode('th', '', text); cell.scope = 'col'; headRow.append(cell); }
    const tableHead = createNode('thead'); tableHead.append(headRow);
    const tableBody = createNode('tbody');
    for (const entry of result.series) {
      const row = createNode('tr');
      row.append(createNode('td', '', shortDate.format(dateValue(entry.date))), createNode('td', '', money(entry.total)));
      tableBody.append(row);
    }
    table.append(caption, tableHead, tableBody); details.append(table); card.append(details);
    return card;
  }

  function renderCategories(result) {
    const card = createNode('article', 'card reports-categories-card');
    const head = createNode('div', 'reports-card-heading');
    head.append(createNode('h2', '', 'Where it went'), createNode('span', 'reports-heading-unit', 'Share of spending'));
    card.append(head);
    const totals = new Map();
    for (const group of result.groups) totals.set(group.category, (totals.get(group.category) || 0) + group.total);
    if (!totals.size) card.append(createNode('p', 'reports-category-empty', 'Your categories will take shape as you log expenses.'));
    const list = createNode('ul', 'reports-category-list');
    for (const [category, total] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
      const [name, color] = categoryInfo(category);
      const row = createNode('li', 'reports-category');
      row.style.setProperty('--report-category-color', color);
      const head = createNode('div', 'reports-category-head');
      const label = createNode('span', 'reports-category-name');
      const dot = createNode('span', 'reports-category-dot'); dot.setAttribute('aria-hidden', 'true');
      label.append(dot, document.createTextNode(name));
      const amount = createNode('span', 'reports-category-amount', money(total));
      head.append(label, amount);
      const track = createNode('div', 'reports-category-track');
      const fill = createNode('div');
      fill.style.width = `${Math.min(100, result.total_spent ? total / result.total_spent * 100 : 0)}%`;
      track.setAttribute('aria-hidden', 'true');
      track.append(fill); row.append(head, track); list.append(row);
    }
    card.append(list);
    return card;
  }

  function renderPurchases(result) {
    const section = createNode('section', 'card reports-purchases');
    const head = createNode('div', 'reports-card-heading');
    head.append(createNode('h2', '', 'Every entry'), createNode('span', 'reports-heading-unit', `${result.expense_count} ${result.expense_count === 1 ? 'purchase' : 'purchases'} · Expense dates in IST`));
    section.append(head);
    if (!result.expenses.length) {
      const empty = createNode('div', 'reports-purchases-empty');
      empty.append(createNode('span', '', '◎'), createNode('h3', '', 'A clean page.'), createNode('p', '', 'There are no recorded expenses in this period. Your next purchase will start the story.'));
      section.append(empty);
      return section;
    }
    const list = createNode('ul', 'reports-purchase-list');
    for (const expense of result.expenses) {
      const row = createNode('li', 'reports-purchase');
      const [category, color] = categoryInfo(expense.category);
      const mark = createNode('span', 'reports-purchase-mark', category.charAt(0));
      mark.style.setProperty('--report-category-color', color);
      mark.setAttribute('aria-hidden', 'true');
      const detail = createNode('div', 'reports-purchase-detail');
      detail.append(createNode('h3', '', expense.item));
      const meta = createNode('p');
      const time = createNode('time', '', longDate.format(dateValue(expenseDay(expense))));
      time.dateTime = expenseDay(expense);
      meta.append(document.createTextNode(`${category} · `), time, document.createTextNode(` · ${({ cash: 'Cash', credit_card: 'Credit card' })[expense.payment_method] || 'Payment not specified'}`));
      detail.append(meta);
      const amount = createNode('div', 'reports-purchase-value');
      amount.append(createNode('span', '', money(expense.amount)));
      const controls = createNode('div', 'expense-actions reports-purchase-actions');
      for (const [label, callback] of [['Edit', onEdit], ['Delete', onDelete]]) {
        if (typeof callback !== 'function') continue;
        const control = button(`expense-action${label === 'Delete' ? ' expense-action-delete' : ''}`, label, `${label} ${expense.item}, ${money(expense.amount)}, ${longDate.format(dateValue(expenseDay(expense)))}`);
        control.addEventListener('click', () => { if (!loading && !stale) callback(expense); });
        entryButtons.push(control);
        controls.append(control);
      }
      row.append(mark, detail, amount, controls); list.append(row);
    }
    section.append(list);
    return section;
  }

  async function download() {
    if (stale || loading || !data || exporting) return;
    const currentVersion = version;
    const currentExport = ++exportVersion;
    const downloaded = data;
    exporting = true;
    updateControls();
    try {
      let blob;
      if (getDemo()) blob = new Blob([reportCsv(downloaded)], { type: 'text/csv;charset=utf-8' });
      else {
        const controller = new AbortController();
        csvController = controller;
        const timeout = setTimeout(() => controller.abort(), 28000);
        try {
          const response = await fetch(`/api/reports?${new URLSearchParams({ period: downloaded.period, date: downloaded.start_date, payment_method: downloaded.payment_method || 'all', format: 'csv' })}`, { credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'text/csv' } });
          if (!response.ok) {
            let message = 'Your CSV could not be downloaded. Please try again.';
            try { const error = await response.json(); message = error.error?.message || error.message || message; } catch { /* Preserve a readable error for non-JSON failures. */ }
            const error = new Error(message); error.status = response.status; throw error;
          }
          if (!response.headers.get('content-type')?.includes('text/csv')) throw new Error('The server returned an unexpected download. Please try again.');
          blob = await response.blob();
        } finally { clearTimeout(timeout); }
      }
      if (currentVersion !== version) return;
      const url = URL.createObjectURL(blob);
      const link = createNode('a');
      link.href = url;
      link.download = `penny-${downloaded.period}-${downloaded.start_date}-${downloaded.payment_method || 'all'}.csv`;
      root.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.classList.remove('reports-error');
      status.textContent = 'Your CSV is ready. It includes every purchase in this report.';
    } catch (error) {
      if (currentVersion !== version) return;
      if (error.status === 401) { clear(); onUnauthorized?.(); return; }
      status.classList.add('reports-error');
      status.textContent = error.name === 'AbortError' ? 'The download timed out. Please try again.' : error.message || 'Your CSV could not be downloaded. Please try again.';
    } finally {
      if (currentExport === exportVersion) { exporting = false; csvController = null; updateControls(); }
    }
  }

  function clear() {
    version++;
    exportVersion++;
    csvController?.abort();
    csvController = null;
    data = null;
    entryButtons = [];
    loading = false;
    exporting = false;
    stale = true;
    period = 'week';
    paymentMethod = 'all';
    anchor = todayKey();
    followCurrent = true;
    status.textContent = '';
    status.classList.remove('reports-error');
    content.replaceChildren(createNode('div', 'reports-initial', 'Your reports will appear here after you sign in.'));
    updateControls();
  }

  updateControls();
  return { refresh, clear };
}
