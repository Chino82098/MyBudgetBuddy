'use strict';
// Minimal Plaid API client (JSON over HTTPS, client_id + secret in the body).
// Docs: https://plaid.com/docs/api/
const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

class PlaidError extends Error {
  constructor(message, status, code, type) {
    super(message);
    this.status = status;
    this.code = code; // e.g. "ITEM_LOGIN_REQUIRED"
    this.type = type; // e.g. "ITEM_ERROR"
  }
}

// Errors that mean the bank login needs to be redone through Link (update mode).
const RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'ACCESS_NOT_GRANTED',
  'INVALID_CREDENTIALS',
  'INVALID_MFA',
  'ITEM_LOCKED',
  'USER_SETUP_REQUIRED',
  'NO_ACCOUNTS',
]);

function createClient(config, fetchImpl = globalThis.fetch) {
  if (!config.plaidClientId || !config.plaidSecret) {
    throw new PlaidError('Add your Plaid client ID and secret in Settings first.', 400, 'config.missing_keys');
  }
  const base = HOSTS[config.plaidEnvironment] || HOSTS.sandbox;

  async function call(endpoint, body = {}) {
    let res;
    try {
      res = await fetchImpl(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' },
        body: JSON.stringify({ client_id: config.plaidClientId, secret: config.plaidSecret, ...body }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new PlaidError(e.name === 'TimeoutError' ? 'Plaid request timed out' : e.message, 0, 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    throw new PlaidError(
      data.display_message || data.error_message || `Plaid returned HTTP ${res.status}`,
      res.status,
      data.error_code,
      data.error_type
    );
  }

  return {
    // New connection, or "update mode" (re-login) when accessToken is given.
    createLinkToken: (accessToken) =>
      call('/link/token/create', {
        client_name: 'Budget Buddy',
        user: { client_user_id: 'budget-buddy-local-user' },
        language: 'en',
        country_codes: ['US', 'CA'],
        ...(accessToken
          ? { access_token: accessToken }
          : { products: ['transactions'], transactions: { days_requested: 730 } }),
      }),
    exchangePublicToken: (publicToken) => call('/item/public_token/exchange', { public_token: publicToken }),
    getAccounts: (accessToken) => call('/accounts/get', { access_token: accessToken }),
    // Real-time balances. Capital One requires min_last_updated_datetime for credit cards (it has no
    // real-time card balance); every other bank and account type ignores it.
    getBalances: (accessToken, maxAgeDays = 30) =>
      call('/accounts/balance/get', {
        access_token: accessToken,
        options: { min_last_updated_datetime: new Date(Date.now() - maxAgeDays * 86400000).toISOString() },
      }),
    transactionsSync: (accessToken, cursor) =>
      call('/transactions/sync', { access_token: accessToken, count: 500, ...(cursor ? { cursor } : {}) }),
    removeItem: (accessToken) => call('/item/remove', { access_token: accessToken }),
  };
}

module.exports = { createClient, PlaidError, RECONNECT_CODES };
