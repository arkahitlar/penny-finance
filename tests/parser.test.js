import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIParser } from '../lib/ai/OpenAIParser.js';
import { ApiError } from '../lib/http/ApiError.js';
import { jsonCompletion, VALID_EXPENSE } from './helpers.js';

test('Groq uses its own endpoint and retains strict expense validation', async () => {
  let request;
  const parser = new OpenAIParser({ provider: 'groq', apiKey: 'fake-groq-key', fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return jsonCompletion(VALID_EXPENSE);
  } });
  assert.equal((await parser.parse('coffee 235')).amount_paise, 23500);
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer fake-groq-key');
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.include_reasoning, false);
  assert.throws(() => new OpenAIParser({ provider: 'unknown' }), ApiError);
});

test('requests strict structured output and validates a successful completion', async () => {
  let request;
  const parser = new OpenAIParser({
    apiKey: 'test-key-never-sent',
    fetchImpl: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return jsonCompletion(VALID_EXPENSE);
    },
  });
  const parsed = await parser.parse('had a dosa and coffee for 235');
  assert.equal(parsed.amount_paise, 23500);
  assert.equal(parsed.item, VALID_EXPENSE.item);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.deepEqual(new Set(request.body.response_format.json_schema.schema.required), new Set(Object.keys(VALID_EXPENSE)));
  assert.equal(request.body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(request.body.messages.at(-1).role, 'user');
  assert.equal(request.body.messages.at(-1).content, 'had a dosa and coffee for 235');
  assert.ok(request.signal instanceof AbortSignal);
});

test('rejects provider refusals and incomplete outputs', async () => {
  for (const completion of [
    jsonCompletion(null, { refusal: 'I cannot parse this request' }),
    jsonCompletion(VALID_EXPENSE, { finishReason: 'length' }),
    jsonCompletion(VALID_EXPENSE, { finishReason: 'content_filter' }),
  ]) {
    const parser = new OpenAIParser({ apiKey: 'test-key', fetchImpl: async () => completion });
    await assert.rejects(parser.parse('coffee 235'), ApiError);
  }
});

test('recovers explicit categories from misspelled descriptions when the model says other', async () => {
  for (const [text, category, leak] of [
    ['cofee 235', 'food_drink', true],
    ['grocries 235', 'groceries', false],
    ['petorl 235', 'transport', false],
    ['medicine 235', 'health', false],
  ]) {
    const parser = new OpenAIParser({ apiKey: 'test-key', fetchImpl: async () => jsonCompletion({ ...VALID_EXPENSE, category: 'other', is_potential_leak: false }) });
    const parsed = await parser.parse(text);
    assert.equal(parsed.category, category);
    assert.equal(parsed.is_potential_leak, leak);
  }
});

test('preserves semantic AI decisions and keeps unsupported category guesses as other', async () => {
  for (const [text, output, expected] of [
    ['coffee beans 235', { category: 'food_drink', is_potential_leak: false }, 'food_drink'],
    ['paid Ravi 235', { category: 'other', is_potential_leak: false }, 'other'],
    ['steam cleaner 235', { category: 'other', is_potential_leak: false }, 'other'],
    ['coffee and medicine 235', { category: 'other', is_potential_leak: false }, 'other'],
  ]) {
    const parser = new OpenAIParser({ apiKey: 'test-key', fetchImpl: async () => jsonCompletion({ ...VALID_EXPENSE, ...output }) });
    const parsed = await parser.parse(text);
    assert.equal(parsed.category, expected);
    assert.equal(parsed.is_potential_leak, false);
  }
});

test('rejects malformed JSON and invalid model fields instead of coercing them', async () => {
  for (const output of [
    '```json\n{"amount":235}\n```',
    '{ invalid JSON',
    { ...VALID_EXPENSE, amount: '235' },
    { ...VALID_EXPENSE, amount: 0 },
    { ...VALID_EXPENSE, amount: 12.345 },
    { ...VALID_EXPENSE, is_potential_leak: 'true' },
    { ...VALID_EXPENSE, injected_field: 'unexpected' },
  ]) {
    const parser = new OpenAIParser({ apiKey: 'test-key', fetchImpl: async () => jsonCompletion(output) });
    await assert.rejects(parser.parse('coffee 235'), ApiError);
  }
});

test('handles upstream errors without exposing provider response bodies', async () => {
  for (const status of [401, 429, 500]) {
    const parser = new OpenAIParser({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('secret-provider-diagnostic', { status }),
    });
    await assert.rejects(parser.parse('coffee 235'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message.includes('secret-provider-diagnostic'), false);
      assert.equal(error.message.includes('test-key'), false);
      return true;
    });
  }
});

test('aborts a stalled HTTP request within the configured timeout', async () => {
  let receivedSignal;
  const parser = new OpenAIParser({
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('timeout was never applied')), 1000);
        const onAbort = () => {
          clearTimeout(keepAlive);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
  await assert.rejects(parser.parse('coffee 235'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
});

 test('preprocessing preserves text and provides conservative numeric hints', async () => {
 const { prepareExpense } = await import('../lib/ai/prepareExpense.js');
 assert.equal(prepareExpense('coffee 235').numeric_amount_hint,235);
 assert.equal(prepareExpense('2 dosas for 235').numeric_amount_hint,null);
 assert.equal(prepareExpense('coffee $5').numeric_amount_hint,null);
 assert.equal(prepareExpense('shoes 1,200').numeric_amount_hint,1200);
 assert.equal(prepareExpense('coffee -80').numeric_amount_hint,null);
 });
 test('rejects AI amount changes when the input has one clear numeric amount',async()=>{
 const parser=new OpenAIParser({apiKey:'fake',fetchImpl:async()=>jsonCompletion({...VALID_EXPENSE,amount:99})});
 await assert.rejects(parser.parse('coffee 235'),e=>e.code==='AMOUNT_MISMATCH');
 });

test('Cloudflare translates its response envelope and validates output', async () => {
  const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  try {
    let request;
    const parser = new OpenAIParser({provider:'cloudflare',apiKey:'fake-key',fetchImpl:async(url,options)=>{
      request={url,body:JSON.parse(options.body)};
      return Response.json({success:true,result:{response:JSON.stringify(VALID_EXPENSE)}});
    }});
    assert.equal((await parser.parse('coffee 235')).amount,235);
    assert.ok(request.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
    assert.equal(request.body.response_format.type,'json_object');
    assert.equal(request.body.max_tokens,300);
  } finally {
    if(previous===undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID=previous;
  }
});
