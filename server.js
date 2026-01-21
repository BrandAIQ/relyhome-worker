/**
 * RelyHome Puppeteer Automation Worker (FULL FIXED VERSION)
 * - Adds robust login/session handling
 * - Applies cookie cache for BOTH /scrape and /accept
 * - Fixes session-expired heuristic (not overly aggressive)
 * - Handles Node <18 fetch (optional)
 * - Safer navigation/click patterns
 */

const express = require('express');
const puppeteer = require('puppeteer');

// Node 18+ has global fetch.
// If you're on Node < 18, uncomment the next 2 lines:
// const fetch = require('node-fetch');
// global.fetch = fetch;

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.AUTOMATION_WORKER_SECRET;

// Optional: set these in your worker environment for /accept auto re-login
const RELYHOME_USERNAME = process.env.RELYHOME_USERNAME;
const RELYHOME_PASSWORD = process.env.RELYHOME_PASSWORD;

// RelyHome session cookie cache (in-memory; persists within a single worker instance)
let relyhomeCookies = null;
let relyhomeCookiesUpdatedAt = 0;
const RELYHOME_COOKIE_TTL_MS = 1000 * 60 * 60 * 20; // 20 hours

const RELYHOME_SESSION_EXPIRED_PATTERNS = [
  'login',
  'sign in',
  'session expired',
  'please log in',
  'authentication required',
];

function looksLikeRelyhomeSessionExpired(text = '') {
  const t = String(text || '').toLowerCase().trim();

  // If nearly empty, it's suspicious, but not guaranteed.
  if (t.length < 40) return true;

  return RELYHOME_SESSION_EXPIRED_PATTERNS.some((p) => t.includes(p));
}

function hasFreshCookieCache() {
  return (
    Array.isArray(relyhomeCookies) &&
    relyhomeCookies.length > 0 &&
    Date.now() - relyhomeCookiesUpdatedAt < RELYHOME_COOKIE_TTL_MS
  );
}

async function applyRelyhomeCookieCache(page) {
  if (!hasFreshCookieCache()) return;
  try {
    await page.setCookie(...relyhomeCookies);
    console.log(`[Worker] Applied cached RelyHome cookies (${relyhomeCookies.length})`);
  } catch (e) {
    console.log('[Worker] Failed to apply cached cookies; clearing cache');
    relyhomeCookies = null;
    relyhomeCookiesUpdatedAt = 0;
  }
}

async function saveRelyhomeCookieCache(page) {
  try {
    const cookies = await page.cookies();
    if (Array.isArray(cookies) && cookies.length > 0) {
      relyhomeCookies = cookies;
      relyhomeCookiesUpdatedAt = Date.now();
      console.log(`[Worker] Cached RelyHome cookies (${cookies.length})`);
    }
  } catch (e) {
    // non-fatal
  }
}

// FIXED: More lenient login detection (hardened)
async function loginToRelyHome(page, username, password) {
  console.log('[Worker] Logging into RelyHome...');

  await page.goto('https://relyhome.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector(
    'input[name="username"], input[name="email"], input[type="email"], #username, #email',
    { timeout: 15000 }
  );

  const usernameSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    '#username',
    '#email',
  ];
  const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];

  let usernameField = null;
  let passwordField = null;

  for (const selector of usernameSelectors) {
    try {
      usernameField = await page.$(selector);
      if (usernameField) break;
    } catch (_) {}
  }

  for (const selector of passwordSelectors) {
    try {
      passwordField = await page.$(selector);
      if (passwordField) break;
    } catch (_) {}
  }

  if (!usernameField || !passwordField) {
    throw new Error('Could not find login form fields');
  }

  // Clear + type
  await usernameField.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await usernameField.type(username, { delay: 50 });

  await passwordField.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await passwordField.type(password, { delay: 50 });

  const didSubmit = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) {
      btn.click();
      return true;
    }
    const allButtons = [...document.querySelectorAll('button, input[type="submit"]')];
    for (const b of allButtons) {
      const text = (b.value || b.textContent || '').toLowerCase();
      if (text.includes('login') || text.includes('sign in') || text.includes('submit')) {
        b.click();
        return true;
      }
    }
    return false;
  });

  if (!didSubmit) await page.keyboard.press('Enter');

  // Wait for navigation or client-side transition
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
    page.waitForTimeout(12000),
  ]);

  await page.waitForTimeout(1500);

  const finalUrl = page.url();
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const lowerText = pageText.toLowerCase();

  console.log(`[Worker] Post-login URL: ${finalUrl}`);
  console.log(`[Worker] Page text length: ${pageText.length}`);

  // Explicit error messages
  const hasLoginError =
    lowerText.includes('invalid password') ||
    lowerText.includes('invalid credentials') ||
    lowerText.includes('incorrect password') ||
    lowerText.includes('wrong password') ||
    lowerText.includes('login failed') ||
    lowerText.includes('authentication failed') ||
    lowerText.includes('invalid username');

  if (hasLoginError) {
    console.log('[Worker] Login error detected in page text');
    throw new Error('Login failed: Invalid credentials');
  }

  // Best signal: login form still present
  const loginInputsStillPresent = await page.$(
    'input[type="password"], input[name="password"], #password'
  );
  const stillOnLoginUrl = finalUrl.includes('/login');

  if (stillOnLoginUrl && loginInputsStillPresent) {
    console.log('[Worker] Still on login page (password input still present)');
    throw new Error('Login appears to have failed - still on login page');
  }

  console.log('[Worker] Login successful - navigated away from login page');
}

async function ensureRelyhomeSession(page, { username, password, contextLabel }) {
  // Context label is just for logs
  const label = contextLabel ? ` (${contextLabel})` : '';

  // Apply cached cookies first
  await applyRelyhomeCookieCache(page);

  // If the current page already has content, check it.
  // Otherwise caller can do a goto then call ensure again.
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (!looksLikeRelyhomeSessionExpired(text)) return;

    if (!username || !password) {
      throw new Error(
        `Session appears expired${label} but no credentials provided (RELYHOME_USERNAME/RELYHOME_PASSWORD or request creds).`
      );
    }

    console.log(`[Worker] Session appears expired${label}; attempting login...`);
    await loginToRelyHome(page, username, password);
    await saveRelyhomeCookieCache(page);
  } catch (e) {
    // If page isn't ready, ignore and let caller handle after navigation.
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Accept job endpoint
app.post('/accept', async (req, res) => {
  const {
    job_id,
    task_id,
    accept_url,
    preferred_slots,
    preferred_days,
    callback_url,
    secret,
  } = req.body;

  console.log(`[Worker] Received job ${job_id}, task ${task_id}`);
  console.log(`[Worker] Accept URL: ${accept_url}`);
  console.log(`[Worker] Preferred slots: ${(preferred_slots || []).join(', ')}`);
  console.log(`[Worker] Preferred days: ${(preferred_days || []).join(', ')}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    console.error('[Worker] Invalid secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  res.json({ status: 'processing', job_id, task_id });

  processJob({
    job_id,
    task_id,
    accept_url,
    preferred_slots: preferred_slots || [],
    preferred_days: preferred_days || [],
    callback_url,
    secret,
  }).catch((e) => console.error('[Worker] processJob top-level error:', e));
});

async function processJob({
  job_id,
  task_id,
  accept_url,
  preferred_slots,
  preferred_days,
  callback_url,
  secret,
}) {
  let browser = null;
  let screenshotBase64 = null;
  let availableSlots = [];

  try {
    console.log(`[Worker] Starting browser for job ${job_id}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Apply cookies before first navigation
    await applyRelyhomeCookieCache(page);

    console.log(`[Worker] Navigating to ${accept_url}`);
    await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(1500);

    // If this is actually a login/session expired page, re-login and retry
    {
      const firstText = await page.evaluate(() => document.body?.innerText || '');
      if (looksLikeRelyhomeSessionExpired(firstText)) {
        console.log('[Worker] Session looks expired on accept page; logging in and retrying...');

        const u = RELYHOME_USERNAME;
        const p = RELYHOME_PASSWORD;
        if (!u || !p) {
          throw new Error(
            'Session expired on accept page and RELYHOME_USERNAME/RELYHOME_PASSWORD are not set on worker'
          );
        }

        await loginToRelyHome(page, u, p);
        await saveRelyhomeCookieCache(page);

        await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(1500);
      }
    }

    availableSlots = await page.evaluate(() => {
      const slots = [];
      const radioButtons = document.querySelectorAll(
        'input[type="radio"][name="appttime"], ' +
          'input[type="radio"][name="appointment"], ' +
          'input[type="radio"][name="time_slot"]'
      );

      radioButtons.forEach((radio) => {
        let labelText = '';
        if (radio.id) {
          const label = document.querySelector(`label[for="${radio.id}"]`);
          if (label) labelText = label.textContent.trim();
        }
        if (!labelText) {
          const parent = radio.closest('tr, div, li');
          if (parent) labelText = parent.textContent.trim();
        }
        if (!labelText) labelText = radio.value;

        slots.push({
          value: radio.value,
          label: labelText,
          id: radio.id,
          name: radio.name,
        });
      });

      return slots;
    });

    console.log(`[Worker] Found ${availableSlots.length} available slots`);
    availableSlots.forEach((slot, i) =>
      console.log(`  ${i + 1}. ${slot.label} (${slot.value})`)
    );

    if (availableSlots.length === 0) {
      throw new Error('No time slots found on page');
    }

    const bestSlot = findBestSlot(availableSlots, preferred_days, preferred_slots);
    console.log(`[Worker] Selected slot: ${bestSlot.label} (${bestSlot.value})`);

    const radioSelector = bestSlot.id
      ? `#${cssEscape(bestSlot.id)}`
      : `input[type="radio"][name="${cssEscape(bestSlot.name)}"][value="${cssEscape(bestSlot.value)}"]`;

    // Use click with fallback
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, radioSelector);
    await page.waitForTimeout(500);

    const submitClicked = await page.evaluate(() => {
      const submitSelectors = [
        'input[name="accept_button"]',
        'input[type="submit"][value*="Accept"]',
        'button[type="submit"]',
        'input[type="submit"]',
        '.accept-button',
        '#accept-btn',
      ];

      for (const selector of submitSelectors) {
        try {
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            return true;
          }
        } catch (e) {}
      }

      const allButtons = [...document.querySelectorAll('input[type="submit"], button')];
      for (const btn of allButtons) {
        const text = (btn.value || btn.textContent || '').toLowerCase();
        if (text.includes('accept') || text.includes('submit') || text.includes('confirm')) {
          btn.click();
          return true;
        }
      }

      return false;
    });

    if (!submitClicked) {
      throw new Error('Could not find submit button');
    }

    console.log(`[Worker] Submit button clicked, waiting for confirmation...`);

    await Promise.race([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    screenshotBase64 = await page.screenshot({ encoding: 'base64' });

    const pageText = await page.evaluate(() => document.body?.innerText || '');

    const lower = pageText.toLowerCase();
    const isConfirmed =
      lower.includes('confirmed') ||
      lower.includes('accepted') ||
      lower.includes('scheduled') ||
      lower.includes('success') ||
      lower.includes('thank you');

    if (!isConfirmed) {
      console.log(
        `[Worker] Warning: Could not confirm acceptance. Page text preview: ${pageText.slice(
          0,
          200
        )}`
      );
    }

    const { date, day, timeRange } = parseSlotLabel(bestSlot.label);

    console.log(`[Worker] SUCCESS - Job ${job_id} scheduled`);

    await sendCallback(callback_url, {
      job_id,
      task_id,
      success: true,
      selected_slot: timeRange || bestSlot.value,
      selected_date: date,
      selected_day: day,
      confirmation_message: isConfirmed ? 'Job accepted successfully' : 'Submitted but confirmation unclear',
      screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map((s) => s.label),
      error: null,
      secret,
    });
  } catch (error) {
    console.error(`[Worker] Error processing job ${job_id}:`, error.message);

    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          screenshotBase64 = await pages[0].screenshot({ encoding: 'base64' });
        }
      } catch (e) {}
    }

    await sendCallback(callback_url, {
      job_id,
      task_id,
      success: false,
      selected_slot: null,
      selected_date: null,
      selected_day: null,
      confirmation_message: null,
      screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map((s) => s.label),
      error: error.message,
      secret,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function findBestSlot(availableSlots, preferredDays, preferredSlots) {
  const normDays = (preferredDays || []).map((d) => String(d).toLowerCase());
  const normSlots = (preferredSlots || []).map((s) => String(s).toLowerCase());

  const scoredSlots = availableSlots.map((slot) => {
    let score = 0;
    const labelLower = String(slot.label || '').toLowerCase();

    for (const day of normDays) {
      if (labelLower.includes(day) || labelLower.includes(getDayFull(day))) {
        score += 100;
        break;
      }
    }

    for (let i = 0; i < normSlots.length; i++) {
      const prefSlot = normSlots[i];
      if (labelLower.includes(prefSlot) || timeRangeMatches(labelLower, prefSlot)) {
        score += 50 - i * 5;
        break;
      }
    }

    return { ...slot, score };
  });

  scoredSlots.sort((a, b) => b.score - a.score);
  return scoredSlots[0];
}

function getDayFull(abbrev) {
  const days = {
    sun: 'sunday',
    mon: 'monday',
    tue: 'tuesday',
    wed: 'wednesday',
    thu: 'thursday',
    fri: 'friday',
    sat: 'saturday',
  };
  return days[abbrev] || abbrev;
}

function timeRangeMatches(label, prefSlot) {
  const timePattern = /(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;
  const labelTimes = label.match(timePattern) || [];
  const prefTimes = prefSlot.match(timePattern) || [];

  if (labelTimes.length === 0 || prefTimes.length === 0) return false;

  return labelTimes.some((lt) => prefTimes.some((pt) => lt === pt));
}

function parseSlotLabel(label) {
  let date = null;
  let day = null;
  let timeRange = null;

  const dateMatch = label.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) date = dateMatch[1];

  const dayMatch = label.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) day = dayMatch[1];

  const timeMatch = label.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
  );
  if (timeMatch) timeRange = timeMatch[1];

  return { date, day, timeRange };
}

async function sendCallback(callbackUrl, data) {
  try {
    console.log(`[Worker] Sending callback to ${callbackUrl}`);
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    console.log(`[Worker] Callback response: ${response.status}`);
  } catch (error) {
    console.error(`[Worker] Callback error:`, error.message);
  }
}

// Scrape endpoint
app.post('/scrape', async (req, res) => {
  const { url, secret, username, password } = req.body;
  console.log(`[Worker] Scrape request for URL: ${url}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    console.error('[Worker] Invalid secret for scrape');
    return res.status(401).json({ success: false, error: 'Invalid secret' });
  }

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await applyRelyhomeCookieCache(page);

    console.log(`[Worker] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForTimeout(2000);

    let { markdown, jobLinks } = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const links = [];

      const acceptLinks = document.querySelectorAll(
        'a[href*="/jobs/accept/offer.php"], a[href*="offer.php"]'
      );

      acceptLinks.forEach((link, index) => {
        const row = link.closest('tr');
        links.push({
          href: link.href,
          text: link.innerText || link.textContent || '',
          rowText: row ? row.innerText : '',
          index,
        });
      });

      if (links.length === 0) {
        document.querySelectorAll('a').forEach((link, index) => {
          const href = link.href || '';
          const textLower = (link.innerText || '').toLowerCase();
          if (textLower.includes('accept') && href.includes('relyhome')) {
            const row = link.closest('tr');
            links.push({
              href: link.href,
              text: link.innerText || '',
              rowText: row ? row.innerText : '',
              index,
            });
          }
        });
      }

      return { markdown: text, jobLinks: links };
    });

    let html = await page.content();

    if (looksLikeRelyhomeSessionExpired(markdown)) {
      console.log('[Worker] Session appears expired during scrape; attempting login + retry...');

      const u = username || RELYHOME_USERNAME;
      const p = password || RELYHOME_PASSWORD;

      if (!u || !p) {
        throw new Error('Session expired and no credentials provided for scrape');
      }

      await loginToRelyHome(page, u, p);
      await saveRelyhomeCookieCache(page);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await page.waitForTimeout(2000);

      ({ markdown, jobLinks } = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const links = [];
        const acceptLinks = document.querySelectorAll(
          'a[href*="/jobs/accept/offer.php"], a[href*="offer.php"]'
        );
        acceptLinks.forEach((link, index) => {
          const row = link.closest('tr');
          links.push({
            href: link.href,
            text: link.innerText || link.textContent || '',
            rowText: row ? row.innerText : '',
            index,
          });
        });

        if (links.length === 0) {
          document.querySelectorAll('a').forEach((link, index) => {
            const href = link.href || '';
            const textLower = (link.innerText || '').toLowerCase();
            if (textLower.includes('accept') && href.includes('relyhome')) {
              const row = link.closest('tr');
              links.push({
                href: link.href,
                text: link.innerText || '',
                rowText: row ? row.innerText : '',
                index,
              });
            }
          });
        }

        return { markdown: text, jobLinks: links };
      }));

      html = await page.content();
    }

    console.log(`[Worker] Scraped ${markdown.length} chars of text`);
    console.log(`[Worker] Found ${jobLinks.length} accept links`);
    jobLinks.forEach((l, i) => console.log(`  ${i + 1}. ${String(l.href).substring(0, 80)}...`));

    res.json({
      success: true,
      raw_markdown: markdown,
      raw_html: html,
      job_links: jobLinks,
      scraped_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[Worker] Scrape error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// Login endpoint to refresh portal session URL
app.post('/login', async (req, res) => {
  const { username, password, secret } = req.body;
  console.log(`[Worker] Login request for user: ${username}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    console.error('[Worker] Invalid secret for login');
    return res.status(401).json({ success: false, error: 'Invalid secret' });
  }

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[Worker] Logging in to RelyHome...`);
    await loginToRelyHome(page, username, password);
    await saveRelyhomeCookieCache(page);

    await page.waitForTimeout(2000);
    console.log(`[Worker] Post-login URL: ${page.url()}`);

    console.log(`[Worker] Looking for Available Jobs navigation link...`);

    const navResult = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').toLowerCase();

        if (
          (href.includes('available-swo') || href.includes('available') || text.includes('available')) &&
          href.includes('vid=') &&
          href.includes('exp=')
        ) {
          const fullUrl = new URL(href, window.location.origin).href;
          return { found: true, url: fullUrl, method: 'tokenized_link' };
        }
      }

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').toLowerCase();

        if (href.includes('available-swo') || (text.includes('available') && text.includes('job'))) {
          link.click();
          return { found: true, clicked: true, href, method: 'clicked_link' };
        }
      }

      const menuItems = Array.from(document.querySelectorAll('[class*="menu"] a, [class*="nav"] a, .sidebar a'));
      for (const item of menuItems) {
        const text = (item.textContent || '').toLowerCase();
        if (text.includes('available') || text.includes('accept')) {
          item.click();
          return { found: true, clicked: true, text, method: 'menu_click' };
        }
      }

      return { found: false };
    });

    console.log(`[Worker] Nav result:`, JSON.stringify(navResult));

    let portalUrl = null;

    if (navResult.found && navResult.url) {
      portalUrl = navResult.url;
      console.log(`[Worker] Found tokenized URL directly: ${portalUrl}`);
    } else if (navResult.clicked) {
      console.log(`[Worker] Clicked navigation, waiting for page load...`);
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        page.waitForTimeout(6000),
      ]);

      await page.waitForTimeout(1500);
      portalUrl = page.url();
      console.log(`[Worker] URL after navigation: ${portalUrl}`);
    }

    if (!portalUrl || !portalUrl.includes('vid=') || !portalUrl.includes('exp=')) {
      console.log(`[Worker] Trying direct navigation to available-swo.php...`);

      await page.goto('https://relyhome.com/jobs/accept/available-swo.php', {
        waitUntil: 'networkidle2',
        timeout: 20000,
      });

      await page.waitForTimeout(2000);
      portalUrl = page.url();
      console.log(`[Worker] URL after direct navigation: ${portalUrl}`);
    }

    if (!portalUrl.includes('vid=') || !portalUrl.includes('exp=')) {
      console.log(`[Worker] Searching page comprehensively for tokenized URLs...`);

      const tokenizedUrl = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a'));
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          if (href.includes('vid=') && href.includes('exp=')) {
            return { url: new URL(href, window.location.origin).href, source: 'link' };
          }
        }

        const forms = Array.from(document.querySelectorAll('form'));
        for (const form of forms) {
          const action = form.getAttribute('action') || '';
          if (action.includes('vid=') && action.includes('exp=')) {
            return { url: new URL(action, window.location.origin).href, source: 'form' };
          }
        }

        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = iframe.getAttribute('src') || '';
          if (src.includes('vid=') && src.includes('exp=')) {
            return { url: new URL(src, window.location.origin).href, source: 'iframe' };
          }
        }

        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
          const content = metaRefresh.getAttribute('content') || '';
          const urlMatch = content.match(/url=([^;]+)/i);
          if (urlMatch && urlMatch[1].includes('vid=')) {
            return { url: new URL(urlMatch[1], window.location.origin).href, source: 'meta' };
          }
        }

        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        for (const script of scripts) {
          const text = script.textContent || '';
          const urlMatch = text.match(/available-swo\.php\?[^"'\s]+vid=[^"'\s]+exp=[^"'\s]+/);
          if (urlMatch) {
            return { url: new URL(urlMatch[0], window.location.origin).href, source: 'script' };
          }
        }

        return null;
      });

      if (tokenizedUrl) {
        console.log(`[Worker] Found tokenized URL from ${tokenizedUrl.source}: ${tokenizedUrl.url}`);
        portalUrl = tokenizedUrl.url;
      }
    }

    console.log(`[Worker] Final portal URL: ${portalUrl}`);

    if (portalUrl && portalUrl.includes('login')) {
      throw new Error('Login appears to have failed - redirected back to login page');
    }

    if (!portalUrl || (!portalUrl.includes('vid=') && !portalUrl.includes('exp='))) {
      console.log(
        `[Worker] Warning: Could not find session tokens in URL. Session may be cookie-based.`
      );
    }

    res.json({
      success: true,
      portal_url: portalUrl || 'https://relyhome.com/jobs/accept/available-swo.php',
      has_tokens: portalUrl?.includes('vid=') && portalUrl?.includes('exp='),
      refreshed_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[Worker] Login error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`[Worker] Puppeteer automation worker running on port ${PORT}`);
});

// ---------- helpers ----------

function cssEscape(value) {
  // minimal safe escape for IDs/attrs used in querySelector strings
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
