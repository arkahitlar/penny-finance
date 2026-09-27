/** Quote each field and neutralize spreadsheet formulas in user/model-provided text. */
export function csvField(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function reportToCsv(report) {
  const rows = [['Expense date (IST)', 'Recorded at (IST)', 'Item', 'Category', 'Payment method', 'Amount (INR)']];
  for (const expense of report.expenses) {
    const local = new Date(Date.parse(expense.created_at) + 19_800_000).toISOString();
    rows.push([
      expense.expense_date ?? local.slice(0, 10), `${local.slice(0, 10)} ${local.slice(11, 19)}`, expense.item, expense.category,
      ({ cash: 'Cash', credit_card: 'Credit card' })[expense.payment_method] ?? 'Not specified',
      Number(expense.amount).toFixed(2),
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}
