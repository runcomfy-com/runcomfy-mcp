const { request, isObject } = require('../lib/api');
const { isGenerationModel } = require('../lib/model-inputs');

const models = {
  key: 'model_choices', noun: 'Model',
  display: { label: 'List Models', description: 'Lists available RunComfy image and video models for selection.', hidden: true },
  operation: {
    canPaginate: true,
    perform: async (z, bundle) => {
      const data = await request(z, bundle, 'model', '/v1/models', { params: {
        limit: 100, offset: (bundle.meta.page || 0) * 100,
        ...(bundle.inputData.model_search ? { search: bundle.inputData.model_search } : {}),
      } });
      if (!Array.isArray(data.models)) throw new Error('RunComfy returned an unexpected model list.');
      return data.models.filter((model) => isObject(model) && typeof model.model_id === 'string' && isGenerationModel(model)).map((model) => ({
        ...model, id: model.model_id,
        name: `${model.display_name || model.model_id}${model.base_price_usd != null ? ` — $${model.base_price_usd}/${model.price_unit || 'request'}` : ''}`,
      }));
    },
    sample: { id: 'blackforestlabs/flux-1-kontext/pro/edit', model_id: 'blackforestlabs/flux-1-kontext/pro/edit', name: 'FLUX.1 Kontext Pro Edit' },
    outputFields: [{ key: 'id', label: 'Model ID' }, { key: 'name', label: 'Model Name' }],
  },
};

const deployments = {
  key: 'deployment_choices', noun: 'Deployment',
  display: { label: 'List Deployments', description: 'Lists ComfyUI deployments available in the connected account.', hidden: true },
  operation: {
    perform: async (z, bundle) => {
      const data = await request(z, bundle, 'serverless', '/prod/v2/deployments');
      if (!Array.isArray(data)) throw new Error('RunComfy returned an unexpected deployment list.');
      return data;
    },
    sample: { id: 'deployment-example', name: 'Product Image Workflow' },
    outputFields: [{ key: 'id', label: 'Deployment ID' }, { key: 'name', label: 'Deployment Name' }],
  },
};
module.exports = { models, deployments };
