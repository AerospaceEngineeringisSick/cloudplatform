/**
 * Drives the real dashboard in a browser: first-run setup, TOTP enrolment,
 * sign-out, two-factor sign-in, then a pass over every page.
 *
 * Run via scripts/smoke-test.sh, which supplies API_BASE and a clean database.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { generateCode, stepFor } from '../apps/api/dist/auth/totp.js';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8791';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/ui-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : '*** FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** Wait until the TOTP step advances, so a fresh code is never a replay. */
async function waitForFreshStep() {
  const start = stepFor();
  const waitMs = (start + 1) * 30000 - Date.now() + 400;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

// The sandbox ships a pinned Chromium build; use it rather than downloading.
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1512, height: 950 } });
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
// Track which requests actually failed, so expected 401s during the
// unauthenticated probe and the deliberate wrong-credential tests can be told
// apart from genuine errors.
page.on('response', (res) => {
  if (res.status() >= 400) failedRequests.push(`${res.status()} ${new URL(res.url()).pathname}`);
});

try {
  // ---------------------------------------------------------------- setup
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('setup screen appears on a fresh install',
    await page.getByText('Create the owner account').isVisible());
  await page.screenshot({ path: `${SHOTS}/01-setup.png` });

  await page.fill('#s-username', 'luke');
  await page.fill('#s-display', 'Luke');
  await page.fill('#s-password', 'a-long-enough-passphrase');
  await page.fill('#s-confirm', 'a-long-enough-passphrase');
  await page.click('button:has-text("Create account")');

  // ------------------------------------------------------------ enrolment
  await page.waitForSelector('#enroll-code', { timeout: 15000 });
  check('two-factor enrolment is forced immediately',
    await page.getByText('Set up two-factor authentication').isVisible());
  const qrVisible = await page.locator('img[alt*="QR"]').isVisible();
  check('a scannable QR code is rendered', qrVisible);
  await page.screenshot({ path: `${SHOTS}/02-enroll.png` });

  // Read the secret the page shows, so the code is generated the same way a
  // real authenticator app would.
  const secret = (await page.locator('.mono').first().innerText()).trim();
  check('the manual-entry secret is shown', /^[A-Z2-7]{32}$/.test(secret), secret.slice(0, 12) + '…');

  await page.fill('#enroll-code', generateCode(secret));
  await page.click('button:has-text("Verify and finish")');

  await page.waitForSelector('.recovery-grid', { timeout: 15000 });
  const codeCount = await page.locator('.recovery-grid span').count();
  check('ten recovery codes are shown once', codeCount === 10, `${codeCount} codes`);
  await page.screenshot({ path: `${SHOTS}/03-recovery.png` });
  await page.click('button:has-text("I have saved them")');

  // ------------------------------------------------------------- overview
  await page.waitForSelector('.app-shell', { timeout: 15000 });
  check('the dashboard loads after enrolment', await page.locator('.page-title').isVisible());
  await page.waitForTimeout(2500); // let one telemetry sample arrive
  const liveBadge = await page.getByText('Live', { exact: true }).isVisible().catch(() => false);
  check('the live WebSocket connects', liveBadge);
  await page.screenshot({ path: `${SHOTS}/04-overview.png`, fullPage: true });

  // Confirm real numbers rendered, not placeholders.
  const cpuText = await page.locator('figure').first().innerText();
  check('gauges render real readings', /\d/.test(cpuText), cpuText.replace(/\n/g, ' ').slice(0, 40));

  // ---------------------------------------------------------- every page
  const pages = [
    ['Compute', 'compute'], ['Containers', 'containers'], ['Minecraft', 'minecraft'],
    ['Media', 'media'], ['Cloud', 'cloud'], ['Storage', 'storage'],
    ['Desktops', 'desktops'], ['Network', 'network'], ['Monitoring', 'monitoring'],
    ['Jobs', 'jobs'], ['Logs', 'logs'], ['Security', 'security'], ['Settings', 'settings'],
  ];

  for (const [label, slug] of pages) {
    await page.click(`.nav-item:has-text("${label}")`);
    await page.waitForTimeout(700);
    const heading = await page.locator('.page-title').first().innerText().catch(() => '');
    const ok = heading.trim() === label;
    check(`${label} page renders`, ok, ok ? '' : `heading was "${heading}"`);
    await page.screenshot({ path: `${SHOTS}/page-${slug}.png`, fullPage: true });
  }

  // ------------------------------------------------------- theme + modes
  await page.click('.nav-item:has-text("Overview")');
  await page.waitForTimeout(500);
  await page.click('button[aria-label*="light theme"]');
  await page.waitForTimeout(600);
  const themeAttr = await page.getAttribute('html', 'data-theme');
  check('light theme applies', themeAttr === 'light', `data-theme=${themeAttr}`);
  await page.screenshot({ path: `${SHOTS}/05-light.png`, fullPage: true });
  await page.click('button[aria-label*="dark theme"]');
  await page.waitForTimeout(500);

  // Switching profile must re-tint the interface accent.
  const accentBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  await page.click('button[aria-haspopup="menu"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/06-profiles.png` });
  await page.click('[role="menuitem"]:has-text("Gaming")');
  await page.waitForTimeout(1800);
  const accentAfter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('switching profile re-tints the interface', accentBefore !== accentAfter,
    `${accentBefore} -> ${accentAfter}`);
  await page.screenshot({ path: `${SHOTS}/07-gaming.png`, fullPage: true });

  // --------------------------------------------------------- sign in again
  await page.click('button:has-text("Sign out")');
  await page.waitForSelector('#username', { timeout: 15000 });
  check('signing out returns to the login screen', await page.locator('#password').isVisible());
  await page.screenshot({ path: `${SHOTS}/08-login.png` });

  await page.fill('#username', 'luke');
  await page.fill('#password', 'a-long-enough-passphrase');
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#code', { timeout: 15000 });
  check('password alone only reaches the second factor',
    await page.getByText('Two-factor authentication').isVisible());
  await page.screenshot({ path: `${SHOTS}/09-2fa.png` });

  // A wrong code must be refused.
  await page.fill('#code', '000000');
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(1200);
  check('a wrong code is refused', await page.locator('#code').isVisible());

  await waitForFreshStep();
  await page.fill('#code', generateCode(secret));
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('.app-shell', { timeout: 20000 });
  check('the correct code signs back in', await page.locator('.page-title').isVisible());

  // ------------------------------------------------------------- mobile
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(BASE, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(1500);
  const noHorizontalScroll = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  check('mobile layout does not scroll horizontally', noHorizontalScroll);
  await mobile.screenshot({ path: `${SHOTS}/10-mobile.png`, fullPage: true });
  await mobile.close();

  // Uncaught exceptions are never acceptable.
  const pageErrors = consoleErrors.filter((e) => e.startsWith('pageerror:'));
  check('no uncaught JavaScript errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  // Failed requests are only acceptable on the auth endpoints, where a 401 is
  // how the app discovers it is signed out and how a wrong code is refused.
  const EXPECTED = /^(401|429) \/api\/auth\/(me|login|login\/verify)$/;
  const unexpected = failedRequests.filter((r) => !EXPECTED.test(r));
  check('no unexpected failed requests', unexpected.length === 0,
    unexpected.length ? unexpected.slice(0, 3).join(' | ') : `${failedRequests.length} expected auth 401s`);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
console.log(`screenshots in ${SHOTS}`);
if (failed.length > 0) process.exit(1);
