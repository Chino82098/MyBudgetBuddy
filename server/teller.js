'use strict';
// Minimal Teller API client: mTLS client certificate + HTTP Basic auth (token as username).
// Docs: https://teller.io/docs/api
const https = require('node:https');
const fs = require('node:fs');

const BASE_HOST = 'api.teller.io';
const API_VERSION = '2020-10-12';

class TellerError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code; // e.g. "enrollment.disconnected"
  }
}

function createClient(config) {
  let cert;
  let key;
  if (config.tellerCertPath && config.tellerKeyPath) {
    cert = fs.readFileSync(config.tellerCertPath);
    key = fs.readFileSync(config.tellerKeyPath);
  } else if (config.tellerEnvironment !== 'sandbox') {
    throw new TellerError(
      'A Teller certificate and private key are required for development/production. Add their paths in Settings.',
      0,
      'config.missing_certificate'
    );
  }
  const agent = new https.Agent({ cert, key, keepAlive: true });

  function request(accessToken, pathname, query = {}) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    ).toString();
    const auth = Buffer.from(`${accessToken}:`).toString('base64');
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: BASE_HOST,
          path: pathname + (qs ? `?${qs}` : ''),
          method: 'GET',
          agent,
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Teller-Version': API_VERSION },
          timeout: 30000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            let data;
            try {
              data = body ? JSON.parse(body) : null;
            } catch {
              data = body;
            }
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
            const err = data && data.error ? data.error : {};
            reject(new TellerError(err.message || `Teller returned HTTP ${res.statusCode}`, res.statusCode, err.code));
          });
        }
      );
      req.on('timeout', () => req.destroy(new TellerError('Teller request timed out', 0, 'timeout')));
      req.on('error', (e) => reject(e instanceof TellerError ? e : new TellerError(e.message, 0, 'network')));
      req.end();
    });
  }

  return {
    listAccounts: (token) => request(token, '/accounts'),
    getBalances: (token, accountId) => request(token, `/accounts/${encodeURIComponent(accountId)}/balances`),
    listTransactions: (token, accountId, query) =>
      request(token, `/accounts/${encodeURIComponent(accountId)}/transactions`, query),
  };
}

module.exports = { createClient, TellerError };
