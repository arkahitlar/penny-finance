export class ApiResponse {
  constructor(statusCode, data = null, message = 'Success', error) {
    this.statusCode = statusCode;
    this.success = statusCode >= 200 && statusCode < 300;
    this.data = data;
    this.message = message;
    if (error) this.error = error;
  }

  toJSON() {
    const body = { success: this.success, data: this.data, message: this.message };
    if (this.error) body.error = this.error;
    return body;
  }

  send(res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(this.statusCode).json(this.toJSON());
  }

  static fromError(error) {
    return new ApiResponse(error.statusCode, null, error.message, {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
}
