const { request, pathId, objectResponse } = require('../lib/api');

const outputUrls = (value) => {
  const found = new Set();
  const walk = (item) => {
    if (typeof item === 'string' && /^https:\/\//u.test(item)) found.add(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value);
  return [...found];
};

const makeRead = (kind) => ({
  key: `get_request_${kind}`, noun: kind === 'status' ? 'Request Status' : 'Request Result',
  display: {
    label: kind === 'status' ? 'Get Request Status' : 'Get Request Result',
    description: kind === 'status' ? 'Checks an existing image, video, or ComfyUI request once without creating a paid job.' : 'Retrieves an existing image, video, or ComfyUI request result and output URLs without creating a paid job.',
  },
  operation: {
    inputFields: [
      { key: 'service', label: 'Request Type', type: 'string', required: true, choices: { model: 'Image or Video Generation', serverless: 'ComfyUI Workflow' }, altersDynamicFields: true, helpText: 'Map Request Type from the submit action, or select the API used to create this request.' },
      { key: 'request_id', label: 'Request ID', type: 'string', required: true, helpText: 'Map Request ID from the submit action. Checking status or results never submits a new job.' },
      async (z, bundle) => bundle.inputData.service === 'serverless' ? [{ key: 'deployment_id', label: 'Deployment ID', type: 'string', required: true, helpText: 'Map Deployment ID from Run ComfyUI Workflow.' }] : [],
    ],
    perform: async (z, bundle) => {
      const { service, request_id, deployment_id } = bundle.inputData;
      if (!['model', 'serverless'].includes(service)) throw new Error('Choose the request type.');
      const id = pathId(request_id);
      const path = service === 'model' ? `/v1/requests/${id}/${kind}` : `/prod/v2/deployments/${pathId(deployment_id, 'Deployment ID')}/requests/${id}/${kind}`;
      const response = objectResponse(await request(z, bundle, service, path));
      return {
        ...response, id: request_id.trim(), request_id: request_id.trim(), service,
        ...(service === 'serverless' ? { deployment_id: deployment_id.trim() } : {}),
        ...(kind === 'result' ? { output_urls: outputUrls(service === 'model' ? response.output : response.outputs) } : {}),
      };
    },
    sample: {
      id: 'request-example', request_id: 'request-example', service: 'model', status: 'completed',
      ...(kind === 'result' ? { output_urls: ['https://example.com/generated-image.png'], output: { images: ['https://example.com/generated-image.png'] } } : {}),
    },
    outputFields: [
      { key: 'request_id', label: 'Request ID' }, { key: 'service', label: 'Request Type' },
      { key: 'deployment_id', label: 'Deployment ID' }, { key: 'status', label: 'Status' },
      ...(kind === 'result' ? [{ key: 'output_urls', label: 'Output URLs', type: 'string', list: true }] : []),
    ],
  },
});
module.exports = { makeRead, outputUrls };
