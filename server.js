/**
 * RelyHome Puppeteer Automation Worker (FULLY FIXED - Enhanced Token Discovery)
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Accept job endpoint
app.post('/accept', async (req, res) => {
  const { job_id, task_id, accept_url, preferred_slots, preferred_days, callback_url, secret } = req.body;

  console.log(`[Worker] Received job ${job_id}, task ${task_id}`);
  console.log(`[Worker] Accept URL: ${accept_url}`);

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
      job_id, task_id, success: true,
      selected_slot: timeRange || bestSlot.value,
      selected_date: date, selected_day: day,
      confirmation_message: isConfirmed ? 'Job accepted' : 'Submitted',
      screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map((s) => s.label),
      error: null, secret,
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
      job_id, task_id, success: false,
      selected_slot: null, selected_date: null, selected_day: null,
      confirmation_message: null, screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map((s) => s.label),
      error: error.message, secret,
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

// Scrape endpoint
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
      links.push({ href: link.href, text: link.innerText || '', rowText: row ? row.innerText : '', index });
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

// ENHANCED Login endpoint with better token discovery
app.post('/login', async (req, res) => {
  const { username, password, secret } = req.body;
  console.log(`[Worker] Login request for: ${username}`);

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

    await loginToRelyHome(page, username, password);
    await saveRelyhomeCookieCache(page);

    // Wait for dashboard to fully load
    await delay(3000);
    
    let currentUrl = page.url();
    console.log(`[Worker] Post-login URL: ${currentUrl}`);
    
    // Log the full HTML to help debug
    const postLoginHtml = await page.content();
    console.log(`[Worker] Post-login HTML length: ${postLoginHtml.length}`);
    console.log(`[Worker] HTML contains vid=: ${postLoginHtml.includes('vid=')}`);
    console.log(`[Worker] HTML contains exp=: ${postLoginHtml.includes('exp=')}`);

    let portalUrl = null;

    // Strategy 1: Look for tokenized link in current page
    console.log('[Worker] Strategy 1: Looking for tokenized links in page...');
    const tokenizedFromPage = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.includes('vid=') && href.includes('exp=')) {
          return { url: new URL(href, window.location.origin).href, source: 'link', text: link.textContent };
        }
      }
      return null;
    });

    if (tokenizedFromPage) {
      console.log(`[Worker] Found tokenized URL from link: ${tokenizedFromPage.url}`);
      portalUrl = tokenizedFromPage.url;
    }

    // Strategy 2: Click on "Available" or similar navigation link
    if (!portalUrl || !portalUrl.includes('vid=')) {
      console.log('[Worker] Strategy 2: Clicking navigation to Available Jobs...');
      
      const clickResult = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a'));
        for (const link of allLinks) {
          const text = (link.textContent || '').toLowerCase();
          const href = link.getAttribute('href') || '';
          // Look for "Available" link that's NOT the current page
          if ((text.includes('available') || href.includes('available')) && 
              !href.includes('vid=') && 
              href.length > 0) {
            console.log('Clicking:', text, href);
            link.click();
            return { clicked: true, text: link.textContent, href };
          }
        }
        return { clicked: false };
      });

      console.log(`[Worker] Click result:`, JSON.stringify(clickResult));

      if (clickResult.clicked) {
        // Wait for navigation
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
          delay(8000),
        ]);
        await delay(2000);
        
        currentUrl = page.url();
        console.log(`[Worker] URL after clicking nav: ${currentUrl}`);
        
        if (currentUrl.includes('vid=') && currentUrl.includes('exp=')) {
          portalUrl = currentUrl;
          console.log(`[Worker] Got tokenized URL from navigation: ${portalUrl}`);
        }
      }
    }

    // Strategy 3: Direct navigation to available-swo.php
    if (!portalUrl || !portalUrl.includes('vid=')) {
      console.log('[Worker] Strategy 3: Direct navigation to available-swo.php...');
      
      await page.goto('https://relyhome.com/jobs/accept/available-swo.php', {
        waitUntil: 'networkidle2',
        timeout: 20000,
      });
      await delay(3000);
      
      currentUrl = page.url();
      console.log(`[Worker] URL after direct navigation: ${currentUrl}`);
      
      if (currentUrl.includes('vid=') && currentUrl.includes('exp=')) {
        portalUrl = currentUrl;
      }
    }

    // Strategy 4: Search current page HTML for tokenized URLs
    if (!portalUrl || !portalUrl.includes('vid=')) {
      console.log('[Worker] Strategy 4: Searching HTML source for tokens...');
      
      const htmlContent = await page.content();
      
      // Look for full URLs with tokens
      const urlPatterns = [
        /https?:\/\/[^\s"'<>]*available-swo\.php\?[^\s"'<>]*vid=[^\s"'<>]*/gi,
        /available-swo\.php\?[^\s"'<>]*vid=[^\s"'<>]*/gi,
        /href="([^"]*vid=[^"]*exp=[^"]*)"/gi,
        /href='([^']*vid=[^']*exp=[^']*)'/gi,
      ];

      for (const pattern of urlPatterns) {
        const matches = htmlContent.match(pattern);
        if (matches && matches.length > 0) {
          let match = matches[0];
          // Clean up the match
          match = match.replace(/^href=["']/, '').replace(/["']$/, '');
          if (!match.startsWith('http')) {
            match = new URL(match, 'https://relyhome.com').href;
          }
          console.log(`[Worker] Found token URL in HTML: ${match}`);
          portalUrl = match;
          break;
        }
      }
    }

    // Strategy 5: Look in iframes, forms, meta tags, scripts
    if (!portalUrl || !portalUrl.includes('vid=')) {
      console.log('[Worker] Strategy 5: Deep search in page elements...');
      
      const deepSearch = await page.evaluate(() => {
        // Check iframes
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = iframe.getAttribute('src') || '';
          if (src.includes('vid=') && src.includes('exp=')) {
            return { url: src, source: 'iframe' };
          }
        }

        // Check forms
        const forms = Array.from(document.querySelectorAll('form'));
        for (const form of forms) {
          const action = form.getAttribute('action') || '';
          if (action.includes('vid=') && action.includes('exp=')) {
            return { url: action, source: 'form' };
          }
        }

        // Check meta refresh
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
          const content = metaRefresh.getAttribute('content') || '';
          const urlMatch = content.match(/url=([^;]+)/i);
          if (urlMatch && urlMatch[1].includes('vid=')) {
            return { url: urlMatch[1], source: 'meta' };
          }
        }

        // Check inline scripts
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        for (const script of scripts) {
          const text = script.textContent || '';
          const urlMatch = text.match(/available-swo\.php\?[^"'\s]+vid=[^"'\s]+/);
          if (urlMatch) {
            return { url: urlMatch[0], source: 'script' };
          }
        }

        // Check window.location assignments in scripts
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('vid=') && text.includes('exp=')) {
            const matches = text.match(/['"]([^'"]*vid=[^'"]*exp=[^'"]*)['"]/) ||
                           text.match(/['"]([^'"]*\?[^'"]*vid=[^'"]*)['"]/) ||
                           text.match(/location\s*=\s*['"]([^'"]+)['"]/);
            if (matches && matches[1]) {
              return { url: matches[1], source: 'script-location' };
            }
          }
        }

        return null;
      });

      if (deepSearch) {
        let url = deepSearch.url;
        if (!url.startsWith('http')) {
          url = new URL(url, 'https://relyhome.com').href;
        }
        console.log(`[Worker] Found token URL from ${deepSearch.source}: ${url}`);
        portalUrl = url;
      }
    }

    // Final URL check
    console.log(`[Worker] Final portal URL: ${portalUrl}`);

    if (portalUrl && portalUrl.includes('login')) {
      throw new Error('Redirected back to login page');
    }

    const hasTokens = portalUrl && portalUrl.includes('vid=') && portalUrl.includes('exp=');
    
    if (!hasTokens) {
      console.log('[Worker] WARNING: Could not find session tokens. Using base URL.');
      // Still return the base URL - the session might be cookie-based
    }

    res.json({
      success: true,
      portal_url: portalUrl || 'https://relyhome.com/jobs/accept/available-swo.php',
      has_tokens: hasTokens,
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
