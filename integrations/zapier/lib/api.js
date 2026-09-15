const BASES = Object.freeze({ model: 'https://model-api.runcomfy.net', serverless: 'https://api.runcomfy.net' });
const UNCERTAIN = 'Check your existing RunComfy requests before retrying. Another execution may create another paid request.';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const pathId = (value, label = 'Request ID') => {
  if (typeof value !== 'string' || !value.trim() || /[\\/?#]/u.test(value) || ['.', '..'].includes(value.trim())) {
    throw new Error(`${label} must be one ID, not a URL or path.`);
  }
  return encodeURIComponent(value.trim());
};

const modelPath = (value) => {
  if (typeof value !== 'string') throw new Error('Choose a model.');
  return value.trim().split('/').map((part) => pathId(part, 'Model ID segment')).join('/');
};

const parseObject = (value, label) => {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON.`); }
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
};

const request = async (z, bundle, service, path, { method = 'GET', body, params } = {}) => {
  if (!BASES[service] || !path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid RunComfy API endpoint.');
  const token = typeof bundle.authData.api_token === 'string' ? bundle.authData.api_token.trim() : '';
  if (!token || /^Bearer\s/i.test(token)) throw new z.errors.Error('Enter your RunComfy API token without the Bearer prefix.', 'InvalidToken', 401);
  let response;
  try {
    response = await z.request({
      url: `${BASES[service]}${path}`, method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body }), ...(params ? { params } : {}),
      timeout: 10000, redirect: 'error', skipThrowForStatus: true, throwForThrottlingEarly: false,
    });
  } catch {
    throw new z.errors.Error(`RunComfy could not be reached. ${method === 'POST' ? UNCERTAIN : 'Try again shortly.'}`, 'RunComfyConnectionError');
  }
  const data = response.data;
  const applicationError = isObject(data) && data.error_code !== undefined && data.error_code !== null;
  if (response.status < 200 || response.status >= 300 || applicationError) {
    const code = applicationError ? `, code ${data.error_code}` : '';
    // Never copy API response text into Zap errors; it may contain request inputs or credentials.
    const message = [401, 403].includes(response.status)
      ? 'RunComfy rejected this connection. Check your API token and access to the selected resource.'
      : `RunComfy could not complete the request (HTTP ${response.status}${code}). ${method === 'POST' ? UNCERTAIN : 'Check the request ID and account access.'}`;
    throw new z.errors.Error(message, 'RunComfyAPIError', response.status);
  }
  if (!isObject(data) && !Array.isArray(data)) throw new z.errors.Error('RunComfy returned an unexpected response.', 'InvalidResponse');
  return data;
};

const objectResponse = (data) => {
  if (!isObject(data)) throw new Error('RunComfy returned an unexpected response; a JSON object is required.');
  return data;
};

const submission = (data, extra) => {
  objectResponse(data);
  if (typeof data.request_id !== 'string' || !data.request_id.trim()) throw new Error(`RunComfy did not return a request ID. ${UNCERTAIN}`);
  return { ...data, ...extra, id: data.request_id };
};

const confirmPaid = (z, value) => {
  if (value !== true && value !== 'true') throw new z.errors.Error('Enable Confirm Paid Request to submit this job. Each execution, including a Zap editor test, can charge your RunComfy balance.', 'PaidRequestNotConfirmed');
};

const paidField = {
  key: 'accept_charges', label: 'Confirm Paid Request', type: 'boolean', required: true, default: 'false',
  helpText: 'Set to Yes to allow a paid RunComfy job on every execution, including Test. Check the model or deployment price first. Replaying this action can create another paid job.',
};

module.exports = { request, pathId, modelPath, parseObject, objectResponse, submission, confirmPaid, paidField, isObject };
