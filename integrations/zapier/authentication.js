const { request, objectResponse } = require('./lib/api');

module.exports = {
  type: 'custom',
  fields: [{
    key: 'api_token', label: 'API Token', type: 'password', required: true,
    helpText: 'Create or copy your API token in your [RunComfy Profile](https://www.runcomfy.com/profile). Enter only the token, without Bearer. Connecting checks your balance and does not create a paid request.',
  }],
  test: async (z, bundle) => {
    const balance = objectResponse(await request(z, bundle, 'serverless', '/prod/v2/balance'));
    if (!Number.isFinite(balance.balance_usd) || !Number.isFinite(balance.balance_microdollars) || typeof balance.currency !== 'string') {
      throw new z.errors.Error('RunComfy did not return a valid balance response. Check the connection and try again.', 'InvalidBalanceResponse');
    }
    return balance;
  },
};
