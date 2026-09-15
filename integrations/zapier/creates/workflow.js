const { request, pathId, parseObject, submission, confirmPaid, paidField } = require('../lib/api');

module.exports = {
  key: 'run_comfyui_workflow', noun: 'Workflow Request',
  display: { label: 'Run ComfyUI Workflow', description: 'Submits a paid ComfyUI workflow request to an existing deployment and returns its request ID immediately.' },
  operation: {
    inputFields: [
      { key: 'deployment_id', label: 'Deployment', type: 'string', required: true, dynamic: 'deployment_choices.id.name', helpText: 'Choose an existing RunComfy serverless ComfyUI deployment. Deployment creation and GPU settings are managed in RunComfy.' },
      { key: 'overrides', label: 'Workflow Input Overrides', type: 'text', required: false, helpText: 'Optional JSON object keyed by ComfyUI node ID. Example: {"6":{"inputs":{"text":"A red sneaker on a white background"}}}. Use the deployment API page for node IDs and input names. Leave empty to use its saved workflow inputs.' },
      { key: 'workflow_api_json', label: 'Complete Workflow JSON', type: 'text', required: false, helpText: 'Optional complete ComfyUI API-format workflow JSON. Most Zaps only need Workflow Input Overrides.' },
      paidField,
    ],
    perform: async (z, bundle) => {
      confirmPaid(z, bundle.inputData.accept_charges);
      const deployment = pathId(bundle.inputData.deployment_id, 'Deployment ID');
      const body = {};
      if (bundle.inputData.overrides) body.overrides = parseObject(bundle.inputData.overrides, 'Workflow Input Overrides');
      if (bundle.inputData.workflow_api_json) body.workflow_api_json = parseObject(bundle.inputData.workflow_api_json, 'Complete Workflow JSON');
      if (body.workflow_api_json && body.overrides && Object.keys(body.overrides).length) throw new Error('Use Workflow Input Overrides or Complete Workflow JSON, not both.');
      return submission(await request(z, bundle, 'serverless', `/prod/v2/deployments/${deployment}/inference`, { method: 'POST', body }), {
        service: 'serverless', deployment_id: bundle.inputData.deployment_id.trim(),
      });
    },
    sample: { id: 'request-example', request_id: 'request-example', service: 'serverless', deployment_id: 'deployment-example', status: 'in_queue' },
    outputFields: [
      { key: 'request_id', label: 'Request ID' }, { key: 'service', label: 'Request Type' },
      { key: 'deployment_id', label: 'Deployment ID' }, { key: 'status', label: 'Status' },
    ],
  },
};
