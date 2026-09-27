import { todayInIndia, yesterdayInIndia, validExpenseDate } from './expenseDates.js';
const CATEGORY_LABELS = {
  food_drink: 'Food & drink', transport: 'Transport', groceries: 'Groceries',
  shopping: 'Shopping', entertainment: 'Entertainment', bills: 'Bills & utilities',
  health: 'Health', other: 'Other',
};
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** A preview is never a saved expense. Only the confirmation button writes it. */
export function createExpenseComposer({ dialog, preview, save, onSaved, onUnauthorized, onOpenChange, onDismissUncertain }) {
  const find = (selector) => dialog.querySelector(selector);
  const categoryInputs = [...dialog.querySelectorAll('input[name="review-category"]')];
  const paymentInputs = [...dialog.querySelectorAll('input[name="payment-method"]')];
  let entry = null;
  let version = 0;
  let parsing = false;
  let saving = false;

  function status(message, error = false) {
    find('#review-status').textContent = message;
    find('#review-status').classList.toggle('error', error);
  }

  function update() {
    const ready = Boolean(entry?.draft);
    find('#review-details').hidden = !ready;
    find('#review-loading').hidden = !parsing;
    find('#review-categories').disabled = !ready || saving || Boolean(entry?.uncertain);
    find('#review-payment').disabled = !ready || saving || Boolean(entry?.uncertain);
    find('#review-date').disabled = !ready || saving || Boolean(entry?.uncertain);
    find('#review-date').max = todayInIndia();
    find('#review-date').value = entry?.date || todayInIndia();
    for (const id of ['#review-today', '#review-yesterday']) find(id).disabled = !ready || saving || Boolean(entry?.uncertain);
    find('#review-save').disabled = !ready || !entry.payment || !validExpenseDate(entry.date) || saving || parsing;
    find('#review-save').textContent = saving ? 'Saving…' : entry?.uncertain ? 'Retry save' : 'Save expense';
    find('#review-cancel').disabled = saving;
    find('#review-close').disabled = saving;
    find('#review-retry').hidden = parsing || ready;
    dialog.setAttribute('aria-busy', String(parsing || saving));
    for (const input of categoryInputs) input.checked = input.value === entry?.category;
    for (const input of paymentInputs) input.checked = input.value === entry?.payment;
    if (ready) {
      find('#review-item').textContent = entry.draft.item;
      find('#review-amount').textContent = money.format(entry.draft.amount);
      const corrected = entry.category !== entry.draft.category;
      find('#category-detection').textContent = corrected
        ? `Changed to ${CATEGORY_LABELS[entry.category]}`
        : entry.category === 'other' ? 'Not sure? Choose the best fit below.' : 'Detected from your words';
      find('#category-detection').classList.toggle('is-corrected', corrected);
    }
  }

  async function loadPreview() {
    const current = ++version;
    parsing = true;
    entry.draft = null;
    status('');
    update();
    try {
      const draft = await preview(entry.text);
      if (current !== version || !dialog.open) return;
      entry.draft = draft;
      entry.category = draft.category;
      status('Check the category and choose how you paid.');
    } catch (error) {
      if (current !== version || !dialog.open) return;
      if (error.status === 401) { onUnauthorized(); return; }
      status(error.name === 'TimeoutError' ? 'Reading this took too long. Try again, or go back and edit your words.' : error.message || 'Couldn’t read this expense. Go back and try a clearer description.', true);
    } finally {
      if (current === version) { parsing = false; update(); }
    }
  }

  function close() { if (!saving) dialog.close(); }
  find('#review-close').addEventListener('click', close);
  find('#review-cancel').addEventListener('click', close);
  find('#review-retry').addEventListener('click', loadPreview);
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    version++;
    parsing = false;
    onOpenChange(false);
    if (entry?.uncertain) onDismissUncertain?.();
  });

  for (const input of categoryInputs) input.addEventListener('change', () => {
    if (!entry || saving || entry.uncertain) return;
    entry.category = input.value;
    entry.key = crypto.randomUUID();
    update();
  });
  for (const input of paymentInputs) input.addEventListener('change', () => {
    if (!entry || saving || entry.uncertain) return;
    entry.payment = input.value;
    entry.key = crypto.randomUUID();
    status(`${input.value === 'cash' ? 'Cash' : 'Credit card'} selected. Ready when you are.`);
    update();
  });

  function chooseDate(value) {
    if (!entry || saving || entry.uncertain) return;
    entry.date = value;
    entry.key = crypto.randomUUID();
    status(validExpenseDate(value) ? 'This expense will count toward the selected date.' : 'Choose a real date from 1900 through today.', !validExpenseDate(value));
    update();
  }
  find('#review-date').addEventListener('change', event => chooseDate(event.target.value));
  find('#review-today').addEventListener('click', () => chooseDate(todayInIndia()));
  find('#review-yesterday').addEventListener('click', () => chooseDate(yesterdayInIndia()));

  find('#review-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || parsing || !entry?.draft || !entry.payment || !validExpenseDate(entry.date)) return;
    saving = true;
    const current = ++version;
    status('Saving your expense…');
    update();
    try {
      const expense = await save(entry.draft.id, { payment_method: entry.payment, category: entry.category, expense_date: entry.date }, entry.key);
      if (current !== version) return;
      const method = entry.payment;
      saving = false;
      entry = null;
      dialog.close();
      await onSaved(expense, method);
    } catch (error) {
      if (current !== version) return;
      if (error.status === 401) { saving = false; onUnauthorized(); return; }
      // Keep the exact confirmed choices/key after an uncertain network outcome.
      // A retry asks the server for the same draft, so it cannot add a second expense.
      entry.uncertain = !error.status || error.status >= 500;
      if (['DRAFT_EXPIRED', 'EXPENSE_DRAFT_EXPIRED', 'DRAFT_NOT_FOUND', 'EXPENSE_DELETED'].includes(error.code)) {
        entry.draft = null;
        entry.uncertain = false;
        entry.key = crypto.randomUUID();
      }
      status(entry.uncertain
        ? 'We couldn’t confirm the save. Retry safely with the same date, payment, and category.'
        : error.message || 'Couldn’t save this expense. Please try again.', true);
    } finally {
      if (current === version) { saving = false; update(); }
    }
  });

  return {
    open(text) {
      if (dialog.open) return;
      const reusable = entry?.text === text && entry.draft &&
        (entry.uncertain || new Date(entry.draft.expires_at).getTime() > Date.now());
      if (!reusable) entry = { text, draft: null, category: null, payment: null, date: todayInIndia(), key: crypto.randomUUID(), uncertain: false };
      find('#review-original').textContent = text;
      status(entry.uncertain ? 'Retry the previous save with the same choices.' : '');
      dialog.showModal();
      onOpenChange(true);
      update();
      if (!reusable) loadPreview();
    },
    reset() {
      version++;
      entry = null;
      parsing = false;
      saving = false;
      if (dialog.open) dialog.close();
      find('#review-original').textContent = '';
      find('#review-item').textContent = '';
      find('#review-amount').textContent = '';
      status('');
      update();
    },
  };
}
