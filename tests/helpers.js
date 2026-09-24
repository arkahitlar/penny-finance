import { Readable } from 'node:stream';

export function mockRequest({ method = 'POST', body, headers = {}, url = '/' } = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.body = body;
  request.headers = headers;
  request.url = url;
  return request;
}

export function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    end(value) {
      if (value !== undefined) {
        try {
          this.body = JSON.parse(value);
        } catch {
          this.body = value;
        }
      }
      this.ended = true;
      return this;
    },
  };
}

export function jsonCompletion(content, options = {}) {
  const { status = 200, refusal = null, finishReason = 'stop' } = options;
  return new Response(JSON.stringify({
    choices: [{
      message: { content: typeof content === 'string' ? content : JSON.stringify(content), refusal },
      finish_reason: finishReason,
    }],
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const VALID_EXPENSE = Object.freeze({
  item: 'Dosa and coffee',
  amount: 235,
  category: 'food_drink',
  is_potential_leak: true,
});
