// Microsoft 365 (Entra ID) sign-in — OpenID Connect authorization-code flow with PKCE.
// Env: M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, PUBLIC_URL (e.g. https://grid.idealinsurance.in)
//      optional M365_ALLOWED_DOMAINS (e.g. idealinsurance.in) ; M365_AUTHORITY / M365_ISSUER only for tests
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function m365Config(env = process.env) {
  const { M365_TENANT_ID: tenant, M365_CLIENT_ID: clientId, M365_CLIENT_SECRET: secret, PUBLIC_URL: url } = env;
  if (!tenant || !clientId || !secret || !url) return null;
  const base = (env.M365_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/$/, '') + '/' + tenant;
  return {
    tenant, clientId, secret,
    redirect: url.replace(/\/$/, '') + '/api/auth/m365/callback',
    authorize: base + '/oauth2/v2.0/authorize',
    token: base + '/oauth2/v2.0/token',
    jwks: createRemoteJWKSet(new URL(base + '/discovery/v2.0/keys')),
    issuer: env.M365_ISSUER || `https://login.microsoftonline.com/${tenant}/v2.0`,
    domains: (env.M365_ALLOWED_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  };
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Step 1: where to send the browser + what to remember in a short-lived cookie */
export function startLogin(cfg) {
  const state = b64url(crypto.randomBytes(24)), nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirect, response_mode: 'query',
    scope: 'openid profile email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: cfg.authorize + '?' + q.toString(), memo: { state, nonce, verifier } };
}

/** Step 2: exchange the code, verify Microsoft's signed ID token, return the person */
export async function finishLogin(cfg, { code, state }, memo) {
  if (!memo || !state || state !== memo.state) throw new Error('Sign-in expired, please try again');
  const body = new URLSearchParams({
    client_id: cfg.clientId, client_secret: cfg.secret, grant_type: 'authorization_code', code,
    redirect_uri: cfg.redirect, code_verifier: memo.verifier, scope: 'openid profile email',
  });
  const r = await fetch(cfg.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) throw new Error('Microsoft sign-in failed' + (t.error_description ? ': ' + String(t.error_description).split('\n')[0] : ''));
  const { payload } = await jwtVerify(t.id_token, cfg.jwks, { issuer: cfg.issuer, audience: cfg.clientId });
  if (payload.nonce !== memo.nonce) throw new Error('Sign-in check failed (nonce)');
  if (payload.tid && payload.tid !== cfg.tenant) throw new Error('This Microsoft account is not from Ideal Insurance');
  const email = String(payload.email || payload.preferred_username || payload.upn || '').toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Your Microsoft account has no email address');
  if (cfg.domains.length && !cfg.domains.includes(email.split('@')[1])) throw new Error('Please use your office email (' + cfg.domains.join(', ') + ')');
  return { email, name: payload.name || email, oid: payload.oid || payload.sub };
}
