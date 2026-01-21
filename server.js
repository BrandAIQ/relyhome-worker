/**
 * RelyHome Puppeteer Automation Worker (COMPLETE FIXED VERSION)
 * Enhanced token discovery and cookie-based session fallback
 */

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.AUTOMATION_WORKER_SECRET;
const RELYHOME_USERNAME = process.env.RELYHOME_USERNAME;
const RELYHOME_PASSWORD = process.env.RELYHOME_PASSWORD;

let relyhomeCookies = null;
let relyhomeCookiesUpdatedAt = 0;
const RELYHOME_COOKIE_TTL_MS = 1000 * 60 * 60 * 20;

const RELYHOME_SESSION_EXPIRED_PATTERNS = [
  'login',
  'sign in',
  'session expired',
  'please log in',
  'authentication required',
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function looksLikeRelyhomeSessionExpired(text = '') {
  const t = String(text || '').toLowerCase().trim();
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
    console.log(`[Worker] Applied cached cookies (${relyhomeCookies.length})`);
  } catch (e) {
    console.log('[Worker] Failed to apply cookies; clearing cache');
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
      console.log(`[Worker] Cached cookies (${cookies.length})`);
    }
  } catch (e) {}
}

async function loginToRelyHome(page, username, password) {
  console.log('[Worker] Logging into RelyHome...');
  
  await page.goto('https://relyhome.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  await page.waitForSelector(
    'input[name="username"], input[name="email"], input[type="email"], input[type="text"], #username, #email',
    { timeout: 15000 }
  );

  const usernameSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[type="text"]:not([type="password"])',
    '#username',
    '#email',
  ];
  const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];

  let usernameField = null;
  let passwordField = null;

  for (const selector of usernameSelectors) {
    try {
      usernameField = await page.$(selector);
      if (usernameField) {
        console.log(`[Worker] Found username field: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  for (const selector of passwordSelectors) {
    try {
      passwordField = await page.$(selector);
      if (passwordField) {
        console.log(`[Worker] Found password field: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  if (!usernameField || !passwordField) {
    throw new Error('Could not find login form fields');
  }

  await usernameField.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await usernameField.type(username, { delay: 30 });
  
  await passwordField.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press('Backspace');
  await passwordField.type(password, { delay: 30 });

  await delay(500);

  const didSubmit = await page.evaluate(() => {
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.login-btn',
      'button.btn-login',
      '#login-button',
      '#loginBtn',
    ];
    
    for (const selector of submitSelectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        btn.click();
        return { clicked: true, selector };
      }
    }

    const allButtons = [...document.querySelectorAll('button, input[type="submit"]')];
    for (const btn of allButtons) {
      const text = (btn.value || btn.textContent || btn.innerText || '').toLowerCase();
      if (text.includes('login') || text.includes('sign in') || text.includes('submit') || text.includes('log in')) {
        btn.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  console.log(`[Worker] Submit result:`, JSON.stringify(didSubmit));

  if (!didSubmit.clicked) {
    console.log('[Worker] No button found, pressing Enter');
    await page.keyboard.press('Enter');
  }

  console.log('[Worker] Waiting for post-login navigation...');
  
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
    delay(15000),
  ]);

  await delay(3000);

  const finalUrl = page.url();
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const lowerText = pageText.toLowerCase();

  console.log(`[Worker] Post-login URL: ${finalUrl}`);
  console.log(`[Worker] Page text length: ${pageText.length}`);

  const errorMessages = [
    'invalid password',
    'invalid credentials',
    'incorrect password',
    'wrong password',
    'login failed',
    'authentication failed',
    'invalid username',
    'invalid email',
    'user not found',
    'account not found',
    'bad credentials',
  ];

  const hasLoginError = errorMessages.some(msg => lowerText.includes(msg));

  if (hasLoginError) {
    console.log('[Worker] Explicit login error detected');
    throw new Error('Login failed: Invalid credentials');
  }

  const successIndicators = [
    !finalUrl.includes('/login'),
    finalUrl.includes('dashboard'),
    finalUrl.includes('available'),
    finalUrl.includes('jobs'),
    finalUrl.includes('home'),
    finalUrl.includes('portal'),
    lowerText.includes('welcome'),
    lowerText.includes('dashboard'),
    lowerText.includes('available jobs'),
    lowerText.includes('logout'),
    lowerText.includes('sign out'),
    lowerText.includes('my account'),
    pageText.length > 500 && !lowerText.includes('password'),
  ];

  const hasSuccessIndicator = successIndicators.some(Boolean);

  if (hasSuccessIndicator) {
    console.log('[Worker] Login successful - found success indicators');
    return;
  }

  const passwordStillVisible = await page.$('input[type="password"]');
  const stillOnLoginUrl = finalUrl.includes('/login');

  if (stillOnLoginUrl && passwordStillVisible) {
    console.log('[Worker] Still on login page with password field visible');
    throw new Error('Login appears to have failed - still on login page');
  }

  console.log('[Worker] Login appears successful');
}

async function ensureRelyhomeSession(page, { username, password, contextLabel }) {
  const label = contextLabel ? ` (${contextLabel})` : '';
  await applyRelyhomeCookieCache(page);

  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (!looksLikeRelyhomeSessionExpired(text)) return;

    if (!username || !password) {
      throw new Error(`Session appears expired${label} but no credentials provided.`);
    }

    console.log(`[Worker] Session expired${label}; logging in...`);
    await loginToRelyHome(page, username, password);
    await saveRelyhomeCookieCache(page);
  } catch (e) {}
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/accept', async (req, res) => {
  const { job_id, task_id, accept_url, preferred_slots, preferred_days, callback_url, secret } = req.body;

  console.log(`[Worker] Received job ${job_id}, task ${task_id}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
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
  }).catch((e) => console.error('[Worker] processJob error:', e));
});

async function processJob({ job_id, task_id, accept_url, preferred_slots, preferred_days, callback_url, secret }) {
  let browser = null;
  let screenshotBase64 = null;
  let availableSlots = [];

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await applyRelyhomeCookieCache(page);

    await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1500);

    const firstText = await page.evaluate(() => document.body?.innerText || '');
    if (looksLikeRelyhomeSessionExpired(firstText)) {
      console.log('[Worker] Session expired on accept page; logging in...');
      if (!RELYHOME_USERNAME || !RELYHOME_PASSWORD) {
        throw new Error('Session expired and no credentials configured');
      }
      await loginToRelyHome(page, RELYHOME_USERNAME, RELYHOME_PASSWORD);
      await saveRelyhomeCookieCache(page);
      await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(1500);
    }

    availableSlots = await page.evaluate(() => {
      const slots = [];
      const radioButtons = document.querySelectorAll(
        'input[type="radio"][name="appttime"], input[type="radio"][name="appointment"], input[type="radio"][name="time_slot"]'
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
        slots.push({ value: radio.value, label: labelText, id: radio.id, name: radio.name });
      });
      return slots;
    });

    console.log(`[Worker] Found ${availableSlots.length} slots`);

    if (availableSlots.length === 0) {
      throw new Error('No time slots found on page');
    }

    const bestSlot = findBestSlot(availableSlots, preferred_days, preferred_slots);
    console.log(`[Worker] Selected: ${bestSlot.label}`);

    const radioSelector = bestSlot.id
      ? `#${cssEscape(bestSlot.id)}`
      : `input[type="radio"][name="${cssEscape(bestSlot.name)}"][value="${cssEscape(bestSlot.value)}"]`;

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, radioSelector);

    await delay(500);

    const submitClicked = await page.evaluate(() => {
      const selectors = [
        'input[name="accept_button"]',
        'input[type="submit"][value*="Accept"]',
        'button[type="submit"]',
        'input[type="submit"]',
      ];
      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn) { btn.click(); return true; }
      }
      const allButtons = [...document.querySelectorAll('input[type="submit"], button')];
      for (const btn of allButtons) {
        const text = (btn.value || btn.textContent || '').toLowerCase();
        if (text.includes('accept') || text.includes('submit')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!submitClicked) throw new Error('Could not find submit button');

    await Promise.race([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      delay(5000),
    ]);

    screenshotBase64 = await page.screenshot({ encoding: 'base64' });

    const pageText = await page.evaluate(() => document.body?.innerText || '');
    const lower = pageText.toLowerCase();
    const isConfirmed = ['confirmed', 'accepted', 'scheduled', 'success', 'thank you'].some(w => lower.includes(w));

    const { date, day, timeRange } = parseSlotLabel(bestSlot.label);

    await sendCallback(callback_url, {
      job_id,
      task_id,
      success: true,
      selected_slot: timeRange || bestSlot.value,
      selected_date: date,
      selected_day: day,
      confirmation_message: isConfirmed ? 'Job accepted' : 'Submitted',
      screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map((s) => s.label),
      error: null,
      secret,
    });

  } catch (error) {
    console.error(`[Worker] Error:`, error.message);
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) screenshotBase64 = await pages[0].screenshot({ encoding: 'base64' });
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
    if (browser) await browser.close();
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
  const days = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
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
  let date = null, day = null, timeRange = null;
  const dateMatch = label.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) date = dateMatch[1];
  const dayMatch = label.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) day = dayMatch[1];
  const timeMatch = label.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
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

app.post('/scrape', async (req, res) => {
  const { url, secret, username, password } = req.body;
  console.log(`[Worker] Scrape request: ${url}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    return res.status(401).json({ success: false, error: 'Invalid secret' });
  }

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL required' });
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

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);

    let { markdown, jobLinks } = await extractJobData(page);
    let html = await page.content();

    if (looksLikeRelyhomeSessionExpired(markdown)) {
      console.log('[Worker] Session expired during scrape; logging in...');
      const u = username || RELYHOME_USERNAME;
      const p = password || RELYHOME_PASSWORD;
      if (!u || !p) throw new Error('Session expired and no credentials');

      await loginToRelyHome(page, u, p);
      await saveRelyhomeCookieCache(page);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(2000);

      ({ markdown, jobLinks } = await extractJobData(page));
      html = await page.content();
    }

    console.log(`[Worker] Scraped ${markdown.length} chars, ${jobLinks.length} links`);

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
    if (browser) await browser.close();
  }
});

async function extractJobData(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText || '';
    const links = [];

    const acceptLinks = document.querySelectorAll('a[href*="/jobs/accept/offer.php"], a[href*="offer.php"]');
    acceptLinks.forEach((link, index) => {
      const row = link.closest('tr');
      links.push({
        href: link.href,
        text: link.innerText || '',
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
          links.push({ href: link.href, text: link.innerText || '', rowText: row ? row.innerText : '', index });
        }
      });
    }

    return { markdown: text, jobLinks: links };
  });
}

// ENHANCED LOGIN ENDPOINT WITH MULTI-STRATEGY TOKEN DISCOVERY
app.post('/login', async (req, res) => {
  const { username, password, secret } = req.body;
  console.log(`[Worker] ========== LOGIN REQUEST ==========`);
  console.log(`[Worker] Username: ${username}`);

  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    return res.status(401).json({ success: false, error: 'Invalid secret' });
  }

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Step 1: Login
    await loginToRelyHome(page, username, password);
    await saveRelyhomeCookieCache(page);

    console.log(`[Worker] Login successful, current URL: ${page.url()}`);
    await delay(2000);

    // Step 2: Log all relevant links for debugging
    const allLinksInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        text: (a.textContent || '').trim().substring(0, 50),
        href: a.href || ''
      })).filter(l => 
        l.href.includes('available') || 
        l.href.includes('swo') || 
        l.href.includes('vid') ||
        l.href.includes('exp') ||
        l.text.toLowerCase().includes('available') ||
        l.text.toLowerCase().includes('job')
      );
    });
    console.log('[Worker] Relevant links found after login:');
    allLinksInfo.slice(0, 15).forEach((l, i) => {
      console.log(`  ${i + 1}. "${l.text}" -> ${l.href}`);
    });

    let portalUrl = null;

    // Step 3: Check if any link already has tokens
    const tokenizedLink = allLinksInfo.find(l => l.href.includes('vid=') && l.href.includes('exp='));
    if (tokenizedLink) {
      console.log(`[Worker] Found tokenized link directly: ${tokenizedLink.href}`);
      portalUrl = tokenizedLink.href;
    }

    // Step 4: If no tokenized link, click on "Available" navigation
    if (!portalUrl) {
      console.log('[Worker] No tokenized link found, clicking navigation...');
      
      const clickResult = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a'));
        for (const link of allLinks) {
          const text = (link.textContent || '').toLowerCase();
          const href = link.href || '';
          if (text.includes('available') || href.includes('available-swo') || text.includes('accept job')) {
            console.log('Clicking:', link.href);
            link.click();
            return { clicked: true, text: link.textContent, href: link.href };
          }
        }
        return { clicked: false };
      });

      console.log(`[Worker] Click result:`, JSON.stringify(clickResult));

      if (clickResult.clicked) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
          delay(8000),
        ]);
        await delay(3000);
        
        portalUrl = page.url();
        console.log(`[Worker] URL after clicking nav: ${portalUrl}`);
      }
    }

    // Step 5: Force navigation to available-swo.php
    if (!portalUrl || (!portalUrl.includes('vid=') && !portalUrl.includes('exp='))) {
      console.log('[Worker] Force navigating to available-swo.php...');
      
      await page.goto('https://relyhome.com/jobs/accept/available-swo.php', {
        waitUntil: 'networkidle2',
        timeout: 20000
      });
      
      await delay(4000);
      
      portalUrl = page.url();
      console.log(`[Worker] URL after force navigation: ${portalUrl}`);
    }

    // Step 6: Search page HTML for tokenized URLs
    if (!portalUrl.includes('vid=') || !portalUrl.includes('exp=')) {
      console.log('[Worker] Searching page HTML for tokenized URLs...');
      
      const htmlContent = await page.content();
      console.log(`[Worker] HTML content length: ${htmlContent.length}`);
      console.log(`[Worker] HTML contains vid=: ${htmlContent.includes('vid=')}`);
      console.log(`[Worker] HTML contains exp=: ${htmlContent.includes('exp=')}`);
      
      // Search for tokenized URLs in HTML
      const foundUrl = await page.evaluate(() => {
        // Method 1: Search all links
        for (const a of document.querySelectorAll('a')) {
          const href = a.href || a.getAttribute('href') || '';
          if (href.includes('vid=') && href.includes('exp=')) {
            return { url: href, source: 'link_href' };
          }
        }
        
        // Method 2: Search HTML source with regex
        const html = document.documentElement.outerHTML;
        
        // Pattern 1: Full URL
        const fullUrlMatch = html.match(/https?:\/\/[^\s"'<>]*available-swo\.php\?[^\s"'<>]*vid=[^\s"'<>]*exp=[^\s"'<>]*/i);
        if (fullUrlMatch) {
          return { url: fullUrlMatch[0], source: 'html_full_url' };
        }
        
        // Pattern 2: Relative URL in href
        const hrefMatch = html.match(/href=["']([^"']*available-swo\.php\?[^"']*vid=[^"']*exp=[^"']*)["']/i);
        if (hrefMatch) {
          return { url: hrefMatch[1], source: 'html_href' };
        }
        
        // Pattern 3: Any URL with vid and exp
        const anyMatch = html.match(/available-swo\.php\?[^\s"'<>]*vid=[^\s"'<>]*exp=[^\s"'<>]*/i);
        if (anyMatch) {
          return { url: 'https://relyhome.com/jobs/accept/' + anyMatch[0], source: 'html_partial' };
        }
        
        // Method 3: Check iframes
        for (const iframe of document.querySelectorAll('iframe')) {
          const src = iframe.src || iframe.getAttribute('src') || '';
          if (src.includes('vid=') && src.includes('exp=')) {
            return { url: src, source: 'iframe' };
          }
        }
        
        // Method 4: Check form actions
        for (const form of document.querySelectorAll('form')) {
          const action = form.action || form.getAttribute('action') || '';
          if (action.includes('vid=') && action.includes('exp=')) {
            return { url: action, source: 'form_action' };
          }
        }
        
        return null;
      });

      if (foundUrl) {
        console.log(`[Worker] Found tokenized URL via ${foundUrl.source}: ${foundUrl.url}`);
        portalUrl = foundUrl.url;
        
        // Normalize URL
        if (portalUrl && !portalUrl.startsWith('http')) {
          portalUrl = 'https://relyhome.com' + (portalUrl.startsWith('/') ? '' : '/') + portalUrl;
        }
      }
    }

    // Step 7: Final validation
    if (portalUrl && portalUrl.includes('/login')) {
      throw new Error('Session failed - redirected back to login');
    }

    const hasTokens = portalUrl && portalUrl.includes('vid=') && portalUrl.includes('exp=');
    const sessionType = hasTokens ? 'TOKEN' : 'COOKIE';

    console.log(`[Worker] ========== LOGIN RESULT ==========`);
    console.log(`[Worker] Final portal URL: ${portalUrl}`);
    console.log(`[Worker] Has tokens: ${hasTokens}`);
    console.log(`[Worker] Session type: ${sessionType}`);

    res.json({
      success: true,
      portal_url: portalUrl || 'https://relyhome.com/jobs/accept/available-swo.php',
      has_tokens: hasTokens,
      session_type: sessionType,
      refreshed_at: new Date().toISOString(),
    });

  } catch (error) {
    console.error(`[Worker] Login error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`[Worker] Running on port ${PORT}`);
});

function cssEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
