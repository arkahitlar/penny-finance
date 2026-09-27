import { todayInIndia, expenseDate, validExpenseDate, dateLabel } from './expenseDates.js';
const categories = { food_drink: 'Food & drink', transport: 'Transport', groceries: 'Groceries', shopping: 'Shopping', entertainment: 'Entertainment', bills: 'Bills & utilities', health: 'Health', other: 'Other' };
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function validateEdit(fields) {
  const item = fields.item.trim();
  if (!item || item.length > 120 || /[\u0000-\u001f\u007f]/.test(item)) throw new Error('Use a description of 1–120 characters.');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(fields.amount)) throw new Error('Use a positive amount with at most two decimal places.');
  const amount = Number(fields.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new Error('Use an amount between ₹0.01 and ₹1,00,00,000.');
  if (!Object.hasOwn(categories, fields.category)) throw new Error('Choose a category.');
  if (!['cash', 'credit_card', 'unspecified'].includes(fields.payment_method)) throw new Error('Choose a payment method.');
  if (!validExpenseDate(fields.expense_date)) throw new Error('Choose a real expense date from 1900 through today.');
  return { item, amount, category: fields.category, payment_method: fields.payment_method, expense_date: fields.expense_date };
}

export function createExpenseManager({ mutate, onChanged, onUnauthorized, onOpenChange }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'expense-dialog manage-dialog';
  dialog.setAttribute('aria-labelledby', 'manager-title');
  dialog.innerHTML = `<form class="manager-form" novalidate>
    <div class="review-top"><span class="eyebrow">YOUR JOURNAL, YOUR CALL</span><button type="button" class="review-close" aria-label="Close expense editor">×</button></div>
    <h2 id="manager-title">Edit expense</h2><p class="review-intro" id="manager-intro"></p>
    <div class="manager-grid">
      <label class="manager-field manager-wide">Description<input name="item" maxlength="120" required autocomplete="off"></label>
      <label class="manager-field">Amount (₹)<input name="amount" type="text" inputmode="decimal" required autocomplete="off"></label>
      <label class="manager-field">Expense date<input name="expense_date" type="date" min="1900-01-01" required></label>
      <label class="manager-field">Category<select name="category" aria-label="Category">${Object.entries(categories).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></label>
      <label class="manager-field">Paid with<select name="payment_method" aria-label="Paid with"><option value="cash">Cash</option><option value="credit_card">Credit card</option><option value="unspecified">Not specified (older entry)</option></select></label>
    </div>
    <p class="manager-status" role="status" aria-live="polite"></p>
    <div class="manager-actions"><button type="button" class="review-cancel">Cancel</button><button type="submit" class="review-save">Save changes</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const grid = dialog.querySelector('.manager-grid');
  const submit = dialog.querySelector('[type="submit"]');
  const cancel = dialog.querySelector('.review-cancel');
  const closeButton = dialog.querySelector('.review-close');
  const status = dialog.querySelector('.manager-status');
  let state = null;
  let busy = false;
  let version = 0;
  let opener = null;
  function update() {
    for (const field of grid.querySelectorAll('input,select')) field.disabled = busy || Boolean(state?.pending) || Boolean(state?.conflict);
    submit.disabled = busy || Boolean(state?.conflict);
    submit.textContent = busy ? 'Saving…' : state?.pending ? 'Retry safely' : state?.kind === 'delete' ? 'Delete expense' : 'Save changes';
    cancel.disabled = closeButton.disabled = busy;
    cancel.textContent = state?.conflict ? 'Refresh entries' : 'Cancel';
    dialog.setAttribute('aria-busy', String(busy));
  }
  async function close() {
    if (busy) return;
    const refresh = Boolean(state?.conflict || state?.pending);
    dialog.close();
    if (refresh) await onChanged({ kind: 'refresh' });
  }
  cancel.addEventListener('click', close);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    version++;
    onOpenChange(false);
    if (opener?.isConnected) opener.focus();
    else document.querySelector('#nav-reports')?.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !state || state.conflict) return;
    let payload;
    try {
      payload = state.pending || { id: state.expense.id, revision: state.expense.revision, ...(state.kind === 'edit' ? validateEdit(Object.fromEntries(new FormData(form))) : {}) };
    } catch (error) { status.textContent = error.message; status.classList.add('error'); return; }
    const current = ++version;
    busy = true;
    status.classList.remove('error');
    status.textContent = state.kind === 'delete' ? 'Deleting this expense…' : 'Saving your corrections…';
    update();
    try {
      await mutate(state.kind === 'delete' ? 'DELETE' : 'PATCH', payload);
      if (current !== version) return;
      const kind = state.kind;
      state = null;
      busy = false;
      dialog.close();
      await onChanged({ kind });
    } catch (error) {
      if (current !== version) return;
      if (error.status === 401) { busy = false; onUnauthorized(); return; }
      if (error.status === 409 || error.status === 404 || error.status === 410) {
        state.conflict = true;
        status.textContent = 'This entry has changed or was deleted. Refresh entries to see the latest version before making another change.';
      } else if (!error.status || error.status >= 500) {
        state.pending = payload;
        status.textContent = 'The connection ended before we could confirm the result. Retry with these same details, or cancel and refresh to check the entry.';
      } else {
        state.pending = null;
        status.textContent = error.message || 'Couldn’t save this change. Please try again.';
      }
      status.classList.add('error');
    } finally { if (current === version) { busy = false; update(); } }
  });
  return {
    open(expense, kind = 'edit') {
      if (dialog.open) return;
      opener = document.activeElement;
      state = { expense: { ...expense }, kind };
      dialog.querySelector('#manager-title').textContent = kind === 'delete' ? 'Delete this expense?' : 'Make it right.';
      dialog.querySelector('#manager-intro').textContent = kind === 'delete'
        ? `${expense.item} · ${money.format(expense.amount)} · ${dateLabel(expenseDate(expense))}. This removes it from your journal and reports. This cannot be undone.`
        : 'Correct the details below. Totals and reports will update with your changes.';
      grid.hidden = kind === 'delete';
      submit.classList.toggle('manager-danger', kind === 'delete');
      form.elements.namedItem('item').value = expense.item;
      form.elements.namedItem('amount').value = expense.amount.toFixed(2);
      form.elements.namedItem('category').value = expense.category;
      form.elements.namedItem('payment_method').value = expense.payment_method || 'unspecified';
      form.elements.namedItem('payment_method').querySelector('[value="unspecified"]').disabled = expense.payment_method !== 'unspecified';
      form.elements.namedItem('expense_date').max = todayInIndia();
      form.elements.namedItem('expense_date').value = expenseDate(expense);
      status.textContent = '';
      status.classList.remove('error');
      update();
      dialog.showModal();
      onOpenChange(true);
      (kind === 'delete' ? cancel : form.elements.namedItem('item')).focus();
    },
    reset() {
      version++;
      busy = false;
      state = null;
      if (dialog.open) dialog.close();
      form.reset();
      status.textContent = '';
    },
  };
}
