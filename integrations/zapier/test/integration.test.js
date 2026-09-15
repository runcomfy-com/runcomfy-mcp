const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');
const App = require('../index');
const { inputKey, modelFields } = require('../lib/model-inputs');
const { pathId, modelPath } = require('../lib/api');
const appTester = zapier.createAppTester(App);
const token = 'test-only-runcomfy-token';
const bundle = (inputData = {}, meta = {}) => ({ authData: { api_token: token }, inputData, meta });
const modelId = 'blackforestlabs/flux-1-kontext/pro/edit';
const model = {
  model_id: modelId, categories: ['image-to-image'], base_price_usd: 0.04, price_unit: 'image',
  input_schema: {
    type: 'object', required: ['prompt', 'image_url'], additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1 }, image_url: { type: 'string' },
      seed: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' },
      aspect_ratio: { type: 'string', enum: ['1:1', '16:9'] }, lora: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
};
const mock = (service = 'model') => nock(service === 'model' ? 'https://model-api.runcomfy.net' : 'https://api.runcomfy.net', { reqheaders: { authorization: `Bearer ${token}` } });
const modelInputs = (extra = {}) => ({ model_id: modelId, accept_charges: true, [inputKey('prompt')]: 'A red shoe', [inputKey('image_url')]: 'https://example.com/input.png', ...extra });
const run = (key, data) => appTester(App.creates[key].operation.perform, bundle(data));

beforeEach(() => { nock.disableNetConnect(); });
afterEach(() => { assert.equal(nock.isDone(), true, `Unconsumed requests: ${nock.pendingMocks().join(', ')}`); nock.cleanAll(); nock.enableNetConnect(); });

test('authentication checks balance without any paid requests', async () => {
  mock('serverless').get('/prod/v2/balance').reply(200, { balance_usd: 5, balance_microdollars: 5000000, currency: 'USD' });
  assert.equal((await appTester(App.authentication.test, bundle())).balance_usd, 5);
});

test('authentication rejects HTTP-200 API errors and never echoes returned secrets', async () => {
  mock('serverless').get('/prod/v2/balance').reply(200, { error_code: 403003, error_message: token });
  await assert.rejects(appTester(App.authentication.test, bundle()), (error) => error.message.includes('403003') && !error.message.includes(token));
});

test('authentication handles invalid tokens safely', async () => {
  mock('serverless').get('/prod/v2/balance').reply(401, { error_message: token });
  await assert.rejects(appTester(App.authentication.test, bundle()), /rejected this connection/);
});

test('paid action requires explicit consent before schema GET or submit', async () => {
  for (const value of [false, 'false', undefined, 1, 'yes']) {
    await assert.rejects(run('generate_image_video', modelInputs({ accept_charges: value })), /Confirm Paid Request/);
    await assert.rejects(run('run_comfyui_workflow', { deployment_id: 'd1', accept_charges: value }), /Confirm Paid Request/);
  }
});

test('selected model exposes real fields, enum choices, and structured JSON help', async () => {
  mock().get(`/v1/models/${modelId}`).reply(200, model);
  const fields = await appTester(modelFields, bundle({ model_id: modelId }));
  assert.equal(fields.find((field) => field.key === inputKey('prompt')).required, true);
  assert.deepEqual(fields.find((field) => field.key === inputKey('aspect_ratio')).choices, ['1:1', '16:9']);
  assert.match(fields.find((field) => field.key === inputKey('lora')).helpText, /JSON/);
});

test('model submit preserves slashes, numeric zero, false, and nested inputs then returns immediately', async () => {
  mock().get(`/v1/models/${modelId}`).reply(200, model);
  mock().post(`/v1/models/${modelId}`, { prompt: 'A red shoe', image_url: 'https://example.com/input.png', seed: 0, enabled: false, lora: { path: 'my-lora.safetensors' } }).reply(202, { request_id: 'r1', status: 'in_queue' });
  const output = await run('generate_image_video', modelInputs({ [inputKey('seed')]: 0, [inputKey('enabled')]: false, [inputKey('lora')]: '{"path":"my-lora.safetensors"}' }));
  assert.deepEqual(output, { request_id: 'r1', status: 'in_queue', id: 'r1', model_id: modelId, service: 'model' });
});

test('video model submits with its own schema', async () => {
  const id = 'example/video';
  mock().get(`/v1/models/${id}`).reply(200, { ...model, model_id: id, categories: ['text-to-video'], input_schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, duration: { type: 'integer', enum: [5, 10] } } } });
  mock().post(`/v1/models/${id}`, { prompt: 'A red shoe', duration: 5 }).reply(200, { request_id: 'v1' });
  assert.equal((await run('generate_image_video', { model_id: id, accept_charges: true, [inputKey('prompt')]: 'A red shoe', [inputKey('duration')]: 5 })).request_id, 'v1');
});

test('invalid required input, type, range and enum prevent paid submission', async () => {
  for (const change of [{ [inputKey('prompt')]: '' }, { [inputKey('seed')]: -1 }, { [inputKey('seed')]: 'not a number' }, { [inputKey('aspect_ratio')]: '4:3' }]) {
    mock().get(`/v1/models/${modelId}`).reply(200, model);
    await assert.rejects(run('generate_image_video', modelInputs(change)), /Model input validation failed/);
  }
});

test('duplicate JSON/field input is rejected rather than silently overwritten', async () => {
  mock().get(`/v1/models/${modelId}`).reply(200, model);
  await assert.rejects(run('generate_image_video', modelInputs({ additional_inputs: '{"prompt":"Conflicting"}' })), /not both/);
});

test('missing request ID and ambiguous submission failure never auto-resubmit', async () => {
  mock('serverless').post('/prod/v2/deployments/d1/inference', {}).reply(200, { status: 'queued' });
  await assert.rejects(run('run_comfyui_workflow', { deployment_id: 'd1', accept_charges: true }), /did not return a request ID.*Another execution/);
  mock('serverless').post('/prod/v2/deployments/d1/inference', {}).replyWithError('Connection reset');
  await assert.rejects(run('run_comfyui_workflow', { deployment_id: 'd1', accept_charges: true }), /Another execution may create another paid request/);
});

test('workflow submits structured overrides without a hidden wait loop', async () => {
  const overrides = { 6: { inputs: { text: 'A sneaker' } } };
  mock('serverless').post('/prod/v2/deployments/d1/inference', { overrides }).reply(200, { request_id: 'w1' });
  assert.equal((await run('run_comfyui_workflow', { deployment_id: 'd1', overrides: JSON.stringify(overrides), accept_charges: true })).deployment_id, 'd1');
});

test('status chooses the correct API family and keeps terminal failure visible', async () => {
  mock().get('/v1/requests/r1/status').reply(200, { status: 'failed', error: 'Model run failed' });
  assert.equal((await run('get_request_status', { service: 'model', request_id: 'r1' })).status, 'failed');
  mock('serverless').get('/prod/v2/deployments/d1/requests/r1/status').reply(200, { status: 'in_progress' });
  assert.equal((await run('get_request_status', { service: 'serverless', request_id: 'r1', deployment_id: 'd1' })).status, 'in_progress');
});

test('result keeps original output and exposes deduplicated hosted URLs', async () => {
  mock().get('/v1/requests/r1/result').reply(200, { status: 'completed', output: { images: ['https://example.com/a.png'], preview: { url: 'https://example.com/a.png' } } });
  const output = await run('get_request_result', { service: 'model', request_id: 'r1' });
  assert.deepEqual(output.output_urls, ['https://example.com/a.png']);
  assert.deepEqual(output.output.images, ['https://example.com/a.png']);
  mock('serverless').get('/prod/v2/deployments/d1/requests/r1/result').reply(200, { status: 'completed', outputs: { 8: { images: [{ url: 'https://example.com/workflow.png' }] } } });
  assert.deepEqual((await run('get_request_result', { service: 'serverless', request_id: 'r1', deployment_id: 'd1' })).output_urls, ['https://example.com/workflow.png']);
});

test('read result never fabricates completion on not-ready errors', async () => {
  mock().get('/v1/requests/r1/result').reply(400, { error_code: 400005 });
  await assert.rejects(run('get_request_result', { service: 'model', request_id: 'r1' }), /400005/);
});

test('API redirects cannot forward the account token elsewhere', async () => {
  mock('serverless').get('/prod/v2/balance').reply(302, '', { Location: 'https://untrusted.example/steal' });
  await assert.rejects(appTester(App.authentication.test, bundle()), /could not be reached/);
});

test('path validation blocks cross-resource paths and URL input', () => {
  for (const value of ['', '.', '..', '../balance', 'https://example.com', 'a?x=y']) assert.throws(() => pathId(value));
  assert.equal(modelPath(modelId), modelId);
  for (const value of ['../v1', 'https://example.com', '/abc', 'abc/']) assert.throws(() => modelPath(value));
});

test('model dropdown paginates and searches live availability', async () => {
  mock().get('/v1/models').query({ limit: 100, offset: 100, search: 'FLUX' }).reply(200, { models: [{ ...model, display_name: 'FLUX Kontext' }] });
  const result = await appTester(App.triggers.model_choices.operation.perform, bundle({ model_search: 'FLUX' }, { page: 1 }));
  assert.equal(result[0].id, modelId);
  assert.match(result[0].name, /\$0.04\/image/);
});

test('workflow rejects incompatible full-workflow and override modes before submitting', async () => {
  await assert.rejects(run('run_comfyui_workflow', { deployment_id: 'd1', accept_charges: true, overrides: '{"6":{"inputs":{}}}', workflow_api_json: '{"6":{"inputs":{}}}' }), /not both/);
});

test('deployment dropdown reads connected-account choices', async () => {
  mock('serverless').get('/prod/v2/deployments').reply(200, [{ id: 'd1', name: 'Product Images' }]);
  assert.deepEqual(await appTester(App.triggers.deployment_choices.operation.perform, bundle()), [{ id: 'd1', name: 'Product Images' }]);
});

test('authentication rejects unrelated objects but accepts zero and negative balance', async () => {
  mock('serverless').get('/prod/v2/balance').reply(200, {});
  await assert.rejects(appTester(App.authentication.test, bundle()), /valid balance response/);
  for (const amount of [0, -1]) {
    mock('serverless').get('/prod/v2/balance').reply(200, { balance_usd: amount, balance_microdollars: amount * 1000000, currency: 'USD' });
    assert.equal((await appTester(App.authentication.test, bundle())).balance_usd, amount);
  }
});

const { HaltedError } = zapier.errors;
const postFailureCases = [
  ['connection loss', (interceptor) => interceptor.replyWithError('Connection reset')],
  ['timeout', (interceptor) => interceptor.replyWithError(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }))],
  ...[400, 401, 403, 429, 500, 503].map((status) => [`HTTP ${status}`, (interceptor) => interceptor.reply(status, { error_message: token })]),
  ['invalid JSON', (interceptor) => interceptor.reply(200, '{invalid', { 'Content-Type': 'application/json' })],
  ['null JSON', (interceptor) => interceptor.reply(200, 'null', { 'Content-Type': 'application/json' })],
  ['array acknowledgement', (interceptor) => interceptor.reply(200, [{ request_id: 'r1' }])],
  ['empty acknowledgement', (interceptor) => interceptor.reply(200, {})],
  ['missing ID', (interceptor) => interceptor.reply(200, { status: 'queued' })],
  ['blank ID', (interceptor) => interceptor.reply(200, { request_id: '  ' })],
  ['non-string ID', (interceptor) => interceptor.reply(200, { request_id: 123 })],
  ['invalid ID path', (interceptor) => interceptor.reply(200, { request_id: '../other' })],
  ['body-level API error', (interceptor) => interceptor.reply(200, { error_code: 500001, error_message: token })],
  ['reflected error code', (interceptor) => interceptor.reply(200, { error_code: token })],
];

for (const action of ['generate_image_video', 'run_comfyui_workflow']) {
  for (const [scenario, reply] of postFailureCases) {
    test(`${action}: ${scenario} halts rather than becoming eligible for AutoReplay`, async () => {
      if (action === 'generate_image_video') mock().get(`/v1/models/${modelId}`).reply(200, model);
      const interceptor = action === 'generate_image_video'
        ? mock().post(`/v1/models/${modelId}`)
        : mock('serverless').post('/prod/v2/deployments/d1/inference');
      reply(interceptor);
      const input = action === 'generate_image_video' ? modelInputs() : { deployment_id: 'd1', accept_charges: true };
      await assert.rejects(run(action, input), (error) => {
        assert.ok(error instanceof HaltedError, `Expected SDK HaltedError, got ${error.name}`);
        assert.equal(error.name, 'HaltedError');
        assert.match(error.message, /Check your existing RunComfy requests before retrying/);
        assert.equal(error.message.includes(token), false);
        return true;
      });
    });
  }
}

test('safe reads and pre-submit schema failures retain ordinary error handling', async () => {
  mock().get('/v1/requests/r1/status').reply(503, {});
  await assert.rejects(run('get_request_status', { service: 'model', request_id: 'r1' }), (error) => error.name === 'AppError');
  mock().get(`/v1/models/${modelId}`).reply(503, {});
  await assert.rejects(run('generate_image_video', modelInputs()), (error) => error.name === 'AppError');
  await assert.rejects(run('run_comfyui_workflow', { deployment_id: 'd1', accept_charges: false }), (error) => error.name === 'AppError');
});

test('generation choices exclude audio and use the same eligibility rule as submission', async () => {
  const audio = { ...model, model_id: 'acestep/text-to-audio', categories: ['text-to-audio'] };
  const video = { ...model, model_id: 'example/video', categories: ['image-to-video'] };
  mock().get('/v1/models').query({ limit: 100, offset: 0 }).reply(200, { models: [audio, model, video] });
  const choices = await appTester(App.triggers.model_choices.operation.perform, bundle());
  assert.deepEqual(choices.map((choice) => choice.id), [modelId, 'example/video']);
  mock().get('/v1/models/acestep/text-to-audio').reply(200, audio);
  await assert.rejects(run('generate_image_video', modelInputs({ model_id: audio.model_id })), /Choose a model that generates images or videos/);
});

test('real FLUX 2 Flash float metadata produces numeric fields and valid submissions', async () => {
  const flux = require('./fixtures/flux-2-flash.json');
  const { collectInputs } = require('../lib/model-inputs');
  mock().get(`/v1/models/${flux.model_id}`).reply(200, flux);
  const fields = await appTester(modelFields, bundle({ model_id: flux.model_id }));
  const guidance = fields.find((field) => field.key === inputKey('guidance_scale'));
  assert.equal(guidance.type, 'number');
  assert.equal(guidance.default, '2.5');
  assert.deepEqual(collectInputs(flux, { [inputKey('prompt')]: 'A red shoe' }), { prompt: 'A red shoe' });
  assert.throws(() => collectInputs(flux, { [inputKey('prompt')]: 'A red shoe', [inputKey('guidance_scale')]: 21 }), /must be <= 20/);
  mock().get(`/v1/models/${flux.model_id}`).reply(200, flux);
  mock().post(`/v1/models/${flux.model_id}`, { prompt: 'A red shoe', guidance_scale: 2.5 }).reply(200, { request_id: 'flux-request' });
  const result = await run('generate_image_video', { model_id: flux.model_id, accept_charges: true, [inputKey('prompt')]: 'A red shoe', [inputKey('guidance_scale')]: 2.5 });
  assert.equal(result.request_id, 'flux-request');
  assert.equal(flux.input_schema.properties.guidance_scale.type, 'float');
});

test('float normalization handles nested schema branches without changing literal data', () => {
  const { normalizeSchema, collectInputs } = require('../lib/model-inputs');
  const schema = { type: 'object', properties: {
    weights: { type: 'array', items: { type: 'float' } },
    settings: { type: 'object', properties: { value: { type: ['float', 'null'] } } },
    mixed: { anyOf: [{ type: 'float' }, { type: 'string' }] },
    literal: { const: { type: 'float' }, default: { type: 'float' } },
  } };
  const normalized = normalizeSchema(schema);
  assert.equal(normalized.properties.weights.items.type, 'number');
  assert.deepEqual(normalized.properties.settings.properties.value.type, ['number', 'null']);
  assert.equal(normalized.properties.mixed.anyOf[0].type, 'number');
  assert.deepEqual(normalized.properties.literal, schema.properties.literal);
  const nestedModel = { input_schema: schema };
  assert.deepEqual(collectInputs(nestedModel, { additional_inputs: '{"weights":[0.5],"settings":{"value":1.5},"mixed":2.5,"literal":{"type":"float"}}' }), { weights: [0.5], settings: { value: 1.5 }, mixed: 2.5, literal: { type: 'float' } });
});
