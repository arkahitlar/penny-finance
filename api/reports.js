import { ApiError } from '../lib/http/ApiError.js';
import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { requireMethod } from '../lib/http/request.js';
import { getExpenseService } from '../lib/services/container.js';
import { requireUser } from '../lib/auth/index.js';
import { reportToCsv } from '../lib/domain/reportCsv.js';

export function createReportsHandler({ service, authenticate = requireUser } = {}) {
  return asyncHandler(async (req, res) => {
    requireMethod(req, res, 'GET');
    const user = await authenticate(req);
    const query = new URL(req.url, 'http://localhost').searchParams;
    for (const key of ['period', 'date', 'format']) {
      if (query.getAll(key).length > 1) throw new ApiError(400, 'Use each report filter only once.', 'INVALID_REPORT_QUERY');
    }
    const format = query.get('format') ?? 'json';
    if (!['json', 'csv'].includes(format)) throw new ApiError(400, 'Choose JSON or CSV for your report.', 'INVALID_REPORT_FORMAT');
    const report = await (service ?? getExpenseService()).report(user.id, {
      period: query.get('period') ?? 'day', date: query.get('date') ?? undefined,
    });
    if (format === 'csv') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="penny-${report.period}-${report.start_date}.csv"`);
      return res.status(200).end(reportToCsv(report));
    }
    return new ApiResponse(200, report, 'Your spending report.').send(res);
  });
}

export default createReportsHandler();
