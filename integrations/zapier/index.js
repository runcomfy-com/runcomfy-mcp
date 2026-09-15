const { version: platformVersion } = require('zapier-platform-core');
const { models, deployments } = require('./triggers/choices');
const generate = require('./creates/generate');
const workflow = require('./creates/workflow');
const { makeRead } = require('./creates/read-request');
const status = makeRead('status');
const result = makeRead('result');

module.exports = {
  version: require('./package.json').version,
  platformVersion,
  flags: { cleanInputData: false },
  authentication: require('./authentication'),
  triggers: { [models.key]: models, [deployments.key]: deployments },
  creates: { [generate.key]: generate, [workflow.key]: workflow, [status.key]: status, [result.key]: result },
  searches: {},
};
