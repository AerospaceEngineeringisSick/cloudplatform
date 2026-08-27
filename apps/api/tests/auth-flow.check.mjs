const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8791';
const { generateCode } = await import('/home/user/cloudplatform/apps/api/dist/auth/totp.js');

let cookie = '';
async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('cloud_session=')) cookie = pair;
  }
  let data;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 120); }
  return { status: res.status, data };
}

const check = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : '*** FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

// 1. Fresh install reports it needs setup.
let r = await call('GET', '/api/auth/setup-state');
check('reports needsSetup on a fresh database', r.data.needsSetup === true);

// 2. Protected routes reject anonymous callers.
r = await call('GET', '/api/host');
check('rejects anonymous access to /api/host', r.status === 401, `got ${r.status}`);

// 3. Weak passwords are refused.
r = await call('POST', '/api/auth/setup', { username: 'luke', displayName: 'Luke', password: 'short' });
check('rejects a short password', r.status === 400, r.data.message);
r = await call('POST', '/api/auth/setup', { username: 'luke', displayName: 'Luke', password: 'password123' });
check('rejects a common password', r.status === 400, r.data.message);

// 4. Create the owner.
r = await call('POST', '/api/auth/setup', {
  username: 'luke', displayName: 'Luke', password: 'a-long-enough-passphrase',
});
check('creates the first owner', r.status === 200 && r.data.user.role === 'owner', JSON.stringify(r.data.user ?? r.data));
check('flags that TOTP enrolment is required', r.data.mustEnrollTotp === true);

// 5. Setup is closed once an account exists.
const saved = cookie; cookie = '';
r = await call('POST', '/api/auth/setup', { username: 'evil', displayName: 'E', password: 'another-long-passphrase' });
check('refuses a second setup call', r.status === 403, `got ${r.status}`);
cookie = saved;

// 6. Enrol TOTP.
r = await call('POST', '/api/auth/totp/begin');
const secret = r.data.secret;
check('issues a TOTP secret and QR', typeof secret === 'string' && r.data.qr.startsWith('data:image/png'));

r = await call('POST', '/api/auth/totp/confirm', { code: '000000' });
check('rejects a wrong enrolment code', r.status === 400);

r = await call('POST', '/api/auth/totp/confirm', { code: generateCode(secret) });
check('accepts the correct enrolment code', r.status === 200);
const recovery = r.data.recoveryCodes ?? [];
check('issues 10 recovery codes', recovery.length === 10, recovery[0]);

// 7. Authenticated access now works.
r = await call('GET', '/api/host');
check('serves host metrics once signed in', r.status === 200 && typeof r.data.cpu.usage === 'number',
  `cpu=${(r.data?.cpu?.usage ?? 0).toFixed(3)} mem=${((r.data?.memory?.usedBytes ?? 0)/2**30).toFixed(1)}GiB`);

// 8. Log out, then log back in through the two-legged flow.
await call('POST', '/api/auth/logout');
r = await call('GET', '/api/auth/me');
check('session is dead after logout', r.status === 401);

r = await call('POST', '/api/auth/login', { username: 'luke', password: 'wrong-password-here' });
check('rejects a wrong password', r.status === 401);

r = await call('POST', '/api/auth/login', { username: 'luke', password: 'a-long-enough-passphrase' });
check('password leg returns a TOTP challenge, not a session', r.data.stage === 'totp' && !!r.data.challengeId);
const challengeId = r.data.challengeId;

r = await call('GET', '/api/host');
check('challenge alone grants no access', r.status === 401);

r = await call('POST', '/api/auth/login/verify', { challengeId, code: '111111' });
check('rejects a wrong TOTP code', r.status === 401);

// Enrolment consumed the current 30s step, so a genuinely fresh code needs the
// next one. Waiting proves both halves: the old step stays refused, the new
// step is accepted.
const { stepFor } = await import('/home/user/cloudplatform/apps/api/dist/auth/totp.js');
const startStep = stepFor();
const waitMs = (startStep + 1) * 30000 - Date.now() + 500;
await new Promise((r2) => setTimeout(r2, Math.max(0, waitMs)));
check('TOTP step advanced', stepFor() > startStep, `step ${startStep} -> ${stepFor()}`);

const code = generateCode(secret);
r = await call('POST', '/api/auth/login/verify', { challengeId, code });
check('accepts the correct TOTP code', r.status === 200 && r.data.user.username === 'luke');

// 9. Replay: the same code must not work again on a new challenge.
const before = cookie;
cookie = '';
r = await call('POST', '/api/auth/login', { username: 'luke', password: 'a-long-enough-passphrase' });
const replayChallenge = r.data.challengeId;
r = await call('POST', '/api/auth/login/verify', { challengeId: replayChallenge, code });
check('refuses to replay an already-used TOTP code', r.status === 401, r.data.message);
cookie = before;

// 10. A used challenge id cannot be reused.
r = await call('POST', '/api/auth/login/verify', { challengeId, code: generateCode(secret) });
check('refuses a spent challenge id', r.status === 401);

// 11. CSRF: a cross-origin POST is refused.
r = await call('POST', '/api/auth/logout', undefined, { origin: 'https://evil.example' });
check('refuses a cross-origin state change', r.status === 403, r.data.message);

// 12. Recovery code works, and only once.
cookie = '';
r = await call('POST', '/api/auth/login', { username: 'luke', password: 'a-long-enough-passphrase' });
const rc = r.data.challengeId;
r = await call('POST', '/api/auth/login/verify', { challengeId: rc, recoveryCode: recovery[0] });
check('accepts a recovery code', r.status === 200);

cookie = '';
r = await call('POST', '/api/auth/login', { username: 'luke', password: 'a-long-enough-passphrase' });
r = await call('POST', '/api/auth/login/verify', { challengeId: r.data.challengeId, recoveryCode: recovery[0] });
check('refuses to reuse a spent recovery code', r.status === 401);
