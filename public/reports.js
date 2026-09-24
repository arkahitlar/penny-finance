const INDIA_OFFSET = 330 * 60 * 1000;
const DAY = 86400000;
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthDate = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const expenseDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
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

// The preview uses only its actual in-memory expenses, including an empty past.
export function buildDemoReport(allExpenses, period = 'week', anchor = todayKey(), now = new Date()) {
  const today = todayKey(now);
  const { start, end } = periodBounds(period, anchor);
  const elapsedEnd = end < today ? end : today;
  const daysElapsed = dateCount(start, elapsedEnd);
  const within = (expenses, from, through) => expenses.filter((expense) => {
    const key = todayKey(expense.created_at);
    return key >= from && key <= through;
  });
  const expenses = within(allExpenses, start, elapsedEnd).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const series = Array.from({ length: daysElapsed }, (_, index) => ({ date: shiftDay(start, index), total: 0, leak_total: 0 }));
  const seriesByDay = new Map(series.map((entry) => [entry.date, entry]));
  const groups = new Map();
  const warnings = new Map();
  let totalPaise = 0;
  let leakPaise = 0;
  let leakCount = 0;
  for (const expense of expenses) {
    const amountPaise = Math.round(expense.amount * 100);
    const isLeak = expense.is_potential_leak && amountPaise < 50000;
    const key = `${expense.category}:${Boolean(expense.is_potential_leak)}`;
    const group = groups.get(key) || { category: expense.category, is_potential_leak: Boolean(expense.is_potential_leak), count: 0, total: 0 };
    group.count++;
    group.total = rounded(group.total + expense.amount);
    groups.set(key, group);
    totalPaise += amountPaise;
    const daily = seriesByDay.get(todayKey(expense.created_at));
    daily.total = rounded(daily.total + expense.amount);
    if (isLeak) {
      leakCount++;
      leakPaise += amountPaise;
      daily.leak_total = rounded(daily.leak_total + expense.amount);
      const warning = warnings.get(expense.category) || { category: expense.category, count: 0, total: 0 };
      warning.count++;
      warning.total = rounded(warning.total + expense.amount);
      warnings.set(expense.category, warning);
    }
  }
  const prior = periodBounds(period, movePeriod(period, anchor, -1));
  const matchedDays = Math.min(daysElapsed, dateCount(prior.start, prior.end));
  const previousEnd = shiftDay(prior.start, matchedDays - 1);
  const previousPaise = within(allExpenses, prior.start, previousEnd).reduce((sum, expense) => sum + Math.round(expense.amount * 100), 0);
  const matchedCurrentPaise = within(expenses, start, shiftDay(start, matchedDays - 1)).reduce((sum, expense) => sum + Math.round(expense.amount * 100), 0);
  return {
    period, start_date: start, end_date: end, timezone: 'Asia/Kolkata', currency: 'INR',
    total_spent: totalPaise / 100, expense_count: expenses.length, leak_total: leakPaise / 100, leak_count: leakCount,
    daily_leak_velocity: daysElapsed ? rounded(leakPaise / 100 / daysElapsed) : 0,
    leak_share_percent: totalPaise ? rounded(leakPaise / totalPaise * 100) : 0,
    average_daily_spend: daysElapsed ? rounded(totalPaise / 100 / daysElapsed) : 0, days_elapsed: daysElapsed,
    groups: [...groups.values()], warnings: [...warnings.values()].filter((entry) => entry.count >= 3).sort((a, b) => b.total - a.total),
    series, expenses,
    comparison: { start_date: prior.start, end_date: previousEnd, days_elapsed: matchedDays, total_spent: previousPaise / 100,
      current_total_spent: matchedCurrentPaise / 100,
      change_percent: previousPaise ? rounded((matchedCurrentPaise - previousPaise) / previousPaise * 100) : null },
  };
}

export function reportCsv(data) {
  const escape = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [['Date (IST)', 'Item', 'Category', 'Payment method', 'Amount (INR)', 'Small discretionary purchase']];
  for (const expense of data.expenses) {
    rows.push([new Date(new Date(expense.created_at).valueOf() + INDIA_OFFSET).toISOString().replace('T', ' ').slice(0, 19), expense.item,
      categoryInfo(expense.category)[0], ({ cash: 'Cash', credit_card: 'Credit card' })[expense.payment_method] || 'Not specified', expense.amount.toFixed(2), expense.is_potential_leak && expense.amount < 500 ? 'Yes' : 'No']);
  }
  return '\uFEFF' + rows.map((row) => row.map(escape).join(',')).join('\r\n');
}

export function createReportsView({ root, request, getDemo, onUnauthorized }) {
  let period = 'week';
  let anchor = todayKey();
  let followCurrent = true;
  let version = 0;
  let data = null;
  let loading = false;
  let stale = true;
  let exporting = false;
  let exportVersion = 0;
  let csvController = null;

  const heading = createNode('div', 'reports-heading');
  const headingCopy = createNode('div');
  headingCopy.append(createNode('p', 'eyebrow', 'YOUR MONEY, IN PERSPECTIVE'), createNode('h1', '', 'Notice your patterns.'));
  const headingNote = createNode('p', 'reports-heading-note', 'A few small habits. A much clearer picture.');
  heading.append(headingCopy, headingNote);

  const toolbar = createNode('div', 'reports-toolbar');
  const segments = createNode('div', 'reports-segments');
  segments.setAttribute('role', 'group');
  segments.setAttribute('aria-label', 'Report period');
  const segmentButtons = new Map();
  for (const [key, label] of [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]) {
    const control = button('reports-segment', label);
    control.addEventListener('click', () => { period = key; anchor = todayKey(); followCurrent = true; refresh(); });
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
    if (candidate > todayKey()) return;
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

  const status = createNode('p', 'reports-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = createNode('div', 'reports-content');
  content.append(createNode('div', 'reports-initial', 'Choose a period to see where your money went.'));
  root.replaceChildren(heading, toolbar, status, content);

  function updateControls() {
    for (const [key, control] of segmentButtons) control.setAttribute('aria-pressed', String(key === period));
    const { start, end } = periodBounds(period, anchor);
    periodText.textContent = periodLabel(period, start, end);
    previous.setAttribute('aria-label', `Previous ${period}`);
    next.setAttribute('aria-label', `Next ${period}`);
    next.disabled = movePeriod(period, anchor, 1) > todayKey();
    refreshButton.disabled = loading;
    refreshButton.textContent = loading ? 'Refreshing…' : '↻ Refresh';
    downloadButton.disabled = loading || stale || !data || exporting;
    downloadButton.textContent = exporting ? 'Downloading…' : '↓ Download CSV';
    content.setAttribute('aria-busy', String(loading));
    content.classList.toggle('reports-stale', stale && Boolean(data));
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
      const result = demo ? buildDemoReport(demo.getExpenses().expenses, period, anchor)
        : await request(`/api/reports?${new URLSearchParams({ period, date: anchor })}`);
      if (currentVersion !== version) return false;
      data = result;
      stale = false;
      render(result);
      status.textContent = demo ? 'Sample report · Only today has sample expenses. Your data is kept in memory.' : `Updated just now · India Standard Time · ${result.end_date >= todayKey() ? 'Current period includes today so far.' : 'Completed period.'}`;
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
    const fragment = document.createDocumentFragment();
    const rangeNote = createNode('p', 'reports-range-note', `${periodLabel(result.period, result.start_date, result.end_date)} · ${result.days_elapsed} ${result.days_elapsed === 1 ? 'day' : 'days'} included`);
    fragment.append(rangeNote);
    const metrics = createNode('div', 'reports-metrics');
    const comparison = result.comparison;
    const change = comparison?.change_percent;
    let changeText = 'No spending recorded in the previous period.';
    if (typeof change === 'number') {
      changeText = change === 0 ? 'Unchanged from the previous period' : `${change < 0 ? '↓' : '↑'} ${Math.abs(change).toLocaleString('en-IN', { maximumFractionDigits: 1 })}% ${change < 0 ? 'less' : 'more'} than the previous period`;
    }
    const totalCard = metric('Total spent', money(result.total_spent), `${result.expense_count} ${result.expense_count === 1 ? 'purchase' : 'purchases'} logged`);
    const comparisonNote = createNode('p', `reports-comparison ${typeof change === 'number' && change < 0 ? 'reports-down' : ''}`, changeText);
    totalCard.append(comparisonNote);
    if (comparison) {
      const previousLabel = comparison.days_elapsed === 1 ? 'same 1 day' : `same ${comparison.days_elapsed} days`;
      totalCard.append(createNode('p', 'reports-metric-detail', `${money(comparison.total_spent)} previously · ${previousLabel}`));
      if (comparison.days_elapsed < result.days_elapsed) totalCard.append(createNode('p', 'reports-metric-detail', `Compared with the first ${comparison.days_elapsed} days of this period (${money(comparison.current_total_spent)}).`));
    }
    const averageCard = metric('Daily average', money(result.average_daily_spend), `Across ${result.days_elapsed} ${result.days_elapsed === 1 ? 'calendar day' : 'calendar days'}`);
    averageCard.append(createNode('p', 'reports-metric-detail reports-average-note', 'Quiet days count, too. Averages include days with no recorded spending.'));
    const leakCard = metric('Small discretionary spends', money(result.leak_total), `${result.leak_count} ${result.leak_count === 1 ? 'purchase' : 'purchases'} under ₹500`);
    leakCard.classList.add('reports-leak-metric');
    const leakFoot = createNode('p', 'reports-leak-foot');
    leakFoot.append(createNode('strong', '', `${money(result.daily_leak_velocity)} / day`), createNode('span', '', `${Math.round(result.leak_share_percent)}% of spending`));
    leakCard.append(leakFoot);
    metrics.append(totalCard, averageCard, leakCard);
    fragment.append(metrics);

    const grid = createNode('div', 'reports-chart-grid');
    grid.append(renderChart(result), renderCategories(result));
    fragment.append(grid);
    if (result.warnings?.length) {
      const warning = result.warnings[0];
      const insight = createNode('aside', 'reports-insight');
      insight.append(createNode('span', 'reports-insight-symbol', '↗'));
      const copy = createNode('div');
      copy.append(createNode('h2', '', 'A pattern worth noticing'), createNode('p', '', `${warning.count} small ${categoryInfo(warning.category)[0].toLowerCase()} purchases added up to ${money(warning.total)} this ${result.period}. A little awareness goes a long way.`));
      insight.append(copy);
      fragment.append(insight);
    }
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
    const legend = createNode('div', 'reports-chart-legend');
    legend.append(createNode('span', 'reports-total-key', 'Total'), createNode('span', 'reports-leak-key', 'Small discretionary'));
    head.append(legend);
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
      column.title = `${shortDate.format(dateValue(entry.date))}: ${money(entry.total)} spent; ${money(entry.leak_total)} small discretionary`;
      const track = createNode('div', 'reports-chart-track');
      const bar = createNode('div', 'reports-chart-bar');
      bar.style.height = `${entry.total / maximum * 100}%`;
      if (entry.total) bar.classList.add('has-spending');
      const leak = createNode('div', 'reports-chart-leak');
      leak.style.height = `${entry.total ? entry.leak_total / entry.total * 100 : 0}%`;
      bar.append(leak);
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
    const caption = createNode('caption', 'sr-only', 'Daily spending and small discretionary purchases in Indian rupees');
    const headRow = createNode('tr');
    for (const text of ['Day', 'Total', 'Small discretionary']) { const cell = createNode('th', '', text); cell.scope = 'col'; headRow.append(cell); }
    const tableHead = createNode('thead'); tableHead.append(headRow);
    const tableBody = createNode('tbody');
    for (const entry of result.series) {
      const row = createNode('tr');
      row.append(createNode('td', '', shortDate.format(dateValue(entry.date))), createNode('td', '', money(entry.total)), createNode('td', '', money(entry.leak_total)));
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
    head.append(createNode('h2', '', 'The little details'), createNode('span', 'reports-heading-unit', `${result.expense_count} ${result.expense_count === 1 ? 'purchase' : 'purchases'} · IST`));
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
      const time = createNode('time', '', expenseDate.format(new Date(expense.created_at)));
      time.dateTime = expense.created_at;
      meta.append(document.createTextNode(`${category} · `), time, document.createTextNode(` · ${({ cash: 'Cash', credit_card: 'Credit card' })[expense.payment_method] || 'Payment not specified'}`));
      detail.append(meta);
      const amount = createNode('div', 'reports-purchase-value');
      amount.append(createNode('span', '', money(expense.amount)));
      if (expense.is_potential_leak && expense.amount < 500) amount.append(createNode('small', '', 'Small discretionary'));
      row.append(mark, detail, amount); list.append(row);
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
          const response = await fetch(`/api/reports?${new URLSearchParams({ period: downloaded.period, date: downloaded.start_date, format: 'csv' })}`, { credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'text/csv' } });
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
      link.download = `penny-${downloaded.period}-${downloaded.start_date}.csv`;
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
    loading = false;
    exporting = false;
    stale = true;
    period = 'week';
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
