const { request, modelPath, submission, confirmPaid, paidField } = require('../lib/api');
const { getModel, modelFields, collectInputs, isGenerationModel } = require('../lib/model-inputs');

module.exports = {
  key: 'generate_image_video', noun: 'Generation Request',
  display: {
    label: 'Generate Image or Video',
    description: 'Submits a paid AI image or video generation request and returns its request ID immediately.',
  },
  operation: {
    inputFields: [
      { key: 'model_search', label: 'Model Search', type: 'string', required: false, helpText: 'Optional keyword to narrow the model list, such as FLUX, Seedream, Wan, Seedance, or LTX. Refresh the Model dropdown after changing this value.' },
      { key: 'model_id', label: 'Model', type: 'string', required: true, dynamic: 'model_choices.id.name', altersDynamicFields: true, helpText: 'Choose an AI image model or AI video model. Current models and pricing: [RunComfy Models](https://www.runcomfy.com/models). You can also enter its model ID as a custom value.' },
      modelFields,
      { key: 'additional_inputs', label: 'Additional Inputs', type: 'text', required: false, helpText: 'Optional JSON object for inputs not filled above, including LoRA configuration supported by the chosen model. Do not duplicate a named field. File inputs must be public HTTPS URLs.' },
      paidField,
    ],
    perform: async (z, bundle) => {
      confirmPaid(z, bundle.inputData.accept_charges);
      const model = await getModel(z, bundle);
      if (!isGenerationModel(model)) {
        throw new Error('Choose a model that generates images or videos. No paid request was submitted.');
      }
      const inputs = collectInputs(model, bundle.inputData);
      const response = await request(z, bundle, 'model', `/v1/models/${modelPath(bundle.inputData.model_id)}`, { method: 'POST', body: inputs });
      return submission(z, response, { service: 'model', model_id: bundle.inputData.model_id.trim() });
    },
    sample: { id: 'request-example', request_id: 'request-example', service: 'model', model_id: 'blackforestlabs/flux-1-kontext/pro/edit', status: 'in_queue' },
    outputFields: [
      { key: 'request_id', label: 'Request ID' }, { key: 'service', label: 'Request Type' },
      { key: 'model_id', label: 'Model ID' }, { key: 'status', label: 'Status' },
    ],
  },
};
