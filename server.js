const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.AUTOMATION_WORKER_SECRET;

// RelyHome session cookie cache (in-memory; persists within a single worker instance)
// This avoids needing tokenized URLs and prevents logging in on every scrape.
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
  const t = String(text || '').toLowerCase();
  if (t.length < 100) return true;
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

async function loginToRelyHome(page, username, password) {
  console.log('[Worker] Logging into RelyHome (for cookie refresh)...');

  await page.goto('https://relyhome.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input[name="username"], input[name="email"], input[type="email"]', { timeout: 10000 });

  const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', '#username', '#email'];
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

  // Click submit (robust fallback)
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

  if (!didSubmit) {
    // final fallback
    await page.keyboard.press('Enter');
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.waitForTimeout(8000),
  ]);

  // Detect obvious failures
  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    const hasError = await page.evaluate(() => {
      const errorSelectors = ['.error', '.alert-danger', '.login-error', '[class*="error"]'];
      for (const selector of errorSelectors) {
        const el = document.querySelector(selector);
        if (el && (el.innerText || '').toLowerCase().includes('invalid')) {
          return el.innerText;
        }
      }
      return null;
    });

    throw new Error(hasError ? `Login failed: ${hasError}` : 'Login appears to have failed');
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
    secret
  } = req.body;

  console.log(`[Worker] Received job ${job_id}, task ${task_id}`);
  console.log(`[Worker] Accept URL: ${accept_url}`);
  console.log(`[Worker] Preferred slots: ${preferred_slots?.join(', ')}`);
  console.log(`[Worker] Preferred days: ${preferred_days?.join(', ')}`);

  // Validate secret
  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    console.error('[Worker] Invalid secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  // Respond immediately, process async
  res.json({ status: 'processing', job_id, task_id });

  // Process in background
  processJob({
    job_id,
    task_id,
    accept_url,
    preferred_slots: preferred_slots || [],
    preferred_days: preferred_days || [],
    callback_url,
    secret
  });
});

async function processJob({
  job_id,
  task_id,
  accept_url,
  preferred_slots,
  preferred_days,
  callback_url,
  secret
}) {
  let browser = null;
  let screenshotBase64 = null;
  let availableSlots = [];

  try {
    console.log(`[Worker] Starting browser for job ${job_id}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to accept URL
    console.log(`[Worker] Navigating to ${accept_url}`);
    await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Parse available slots from the page
    // RelyHome format: radio buttons with name="appttime" or "appointment"
    availableSlots = await page.evaluate(() => {
      const slots = [];
      
      // Try different selectors for time slot radio buttons
      const radioButtons = document.querySelectorAll(
        'input[type="radio"][name="appttime"], ' +
        'input[type="radio"][name="appointment"], ' +
        'input[type="radio"][name="time_slot"]'
      );

      radioButtons.forEach(radio => {
        // Get the label text
        let labelText = '';
        
        // Check for associated label
        if (radio.id) {
          const label = document.querySelector(`label[for="${radio.id}"]`);
          if (label) labelText = label.textContent.trim();
        }
        
        // Check parent elements for text
        if (!labelText) {
          const parent = radio.closest('tr, div, li');
          if (parent) labelText = parent.textContent.trim();
        }
        
        // Use value as fallback
        if (!labelText) labelText = radio.value;

        slots.push({
          value: radio.value,
          label: labelText,
          id: radio.id,
          name: radio.name
        });
      });

      return slots;
    });

    console.log(`[Worker] Found ${availableSlots.length} available slots`);
    availableSlots.forEach((slot, i) => console.log(`  ${i + 1}. ${slot.label} (${slot.value})`));

    if (availableSlots.length === 0) {
      throw new Error('No time slots found on page');
    }

    // Find the best matching slot
    const bestSlot = findBestSlot(availableSlots, preferred_days, preferred_slots);
    console.log(`[Worker] Selected slot: ${bestSlot.label} (${bestSlot.value})`);

    // Click the radio button
    const radioSelector = bestSlot.id 
      ? `#${bestSlot.id}`
      : `input[type="radio"][name="${bestSlot.name}"][value="${bestSlot.value}"]`;
    
    await page.click(radioSelector);
    await page.waitForTimeout(500);

    // Find and click the submit button
    const submitClicked = await page.evaluate(() => {
      // Try various submit button selectors
      const submitSelectors = [
        'input[name="accept_button"]',
        'input[type="submit"][value*="Accept"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:contains("Accept")',
        '.accept-button',
        '#accept-btn'
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

      // Fallback: find any button/input with "accept" text
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

    // Wait for navigation or confirmation
    await Promise.race([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.waitForTimeout(5000)
    ]);

    // Take screenshot
    screenshotBase64 = await page.screenshot({ encoding: 'base64' });

    // Check for confirmation
    const pageContent = await page.content();
    const pageText = await page.evaluate(() => document.body.innerText);
    
    const isConfirmed = 
      pageText.toLowerCase().includes('confirmed') ||
      pageText.toLowerCase().includes('accepted') ||
      pageText.toLowerCase().includes('scheduled') ||
      pageText.toLowerCase().includes('success') ||
      pageText.toLowerCase().includes('thank you');

    if (!isConfirmed) {
      console.log(`[Worker] Warning: Could not confirm acceptance. Page text: ${pageText.slice(0, 200)}`);
    }

    // Extract date and day from slot label
    const { date, day, timeRange } = parseSlotLabel(bestSlot.label);

    console.log(`[Worker] SUCCESS - Job ${job_id} scheduled`);

    // Send callback
    await sendCallback(callback_url, {
      job_id,
      task_id,
      success: true,
      selected_slot: timeRange || bestSlot.value,
      selected_date: date,
      selected_day: day,
      confirmation_message: isConfirmed ? 'Job accepted successfully' : 'Submitted but confirmation unclear',
      screenshot_base64: screenshotBase64,
      available_slots: availableSlots.map(s => s.label),
      error: null,
      secret
    });

  } catch (error) {
    console.error(`[Worker] Error processing job ${job_id}:`, error.message);

    // Take error screenshot if possible
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
      available_slots: availableSlots.map(s => s.label),
      error: error.message,
      secret
    });

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function findBestSlot(availableSlots, preferredDays, preferredSlots) {
  // Normalize preferred values
  const normDays = (preferredDays || []).map(d => d.toLowerCase());
  const normSlots = (preferredSlots || []).map(s => s.toLowerCase());

  // Score each slot
  const scoredSlots = availableSlots.map(slot => {
    let score = 0;
    const labelLower = slot.label.toLowerCase();

    // Check day match
    for (const day of normDays) {
      if (labelLower.includes(day) || labelLower.includes(getDayFull(day))) {
        score += 100;
        break;
      }
    }

    // Check time slot match
    for (let i = 0; i < normSlots.length; i++) {
      const prefSlot = normSlots[i];
      if (labelLower.includes(prefSlot) || timeRangeMatches(labelLower, prefSlot)) {
        score += 50 - i * 5; // Earlier preferences get higher score
        break;
      }
    }

    return { ...slot, score };
  });

  // Sort by score (highest first)
  scoredSlots.sort((a, b) => b.score - a.score);

  // Return best match, or first available if no preferences matched
  return scoredSlots[0];
}

function getDayFull(abbrev) {
  const days = {
    'sun': 'sunday', 'mon': 'monday', 'tue': 'tuesday', 'wed': 'wednesday',
    'thu': 'thursday', 'fri': 'friday', 'sat': 'saturday'
  };
  return days[abbrev] || abbrev;
}

function timeRangeMatches(label, prefSlot) {
  // Extract times and compare
  const timePattern = /(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;
  const labelTimes = label.match(timePattern) || [];
  const prefTimes = prefSlot.match(timePattern) || [];
  
  if (labelTimes.length === 0 || prefTimes.length === 0) return false;
  
  // Simple overlap check
  return labelTimes.some(lt => prefTimes.some(pt => lt === pt));
}

function parseSlotLabel(label) {
  let date = null;
  let day = null;
  let timeRange = null;

  // Try to extract date (MM/DD/YYYY or YYYY-MM-DD)
  const dateMatch = label.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
  if (dateMatch) date = dateMatch[1];

  // Try to extract day name
  const dayMatch = label.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) day = dayMatch[1];

  // Try to extract time range
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
      body: JSON.stringify(data)
    });
    console.log(`[Worker] Callback response: ${response.status}`);
  } catch (error) {
    console.error(`[Worker] Callback error:`, error.message);
  }
}

// Scrape endpoint for quick polling (no form submission)
app.post('/scrape', async (req, res) => {
  const { url, secret, username, password } = req.body;

  console.log(`[Worker] Scrape request for URL: ${url}`);

  // Validate secret
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Apply cached cookies (if any) before navigating
    await applyRelyhomeCookieCache(page);

    console.log(`[Worker] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for dynamic content to load
    await page.waitForTimeout(2000);

    // Extract page content AND job links
    let { markdown, jobLinks } = await page.evaluate(() => {
      const text = document.body.innerText;
      const links = [];
      
      // Find all Accept links in the table
      // RelyHome uses links like: /jobs/accept/offer.php?sid=...&cid=...&vid=...
      const acceptLinks = document.querySelectorAll('a[href*="/jobs/accept/offer.php"], a[href*="offer.php"]');
      
      acceptLinks.forEach((link, index) => {
        // Get the row data (parent tr or closest row)
        const row = link.closest('tr');
        let rowText = '';
        if (row) {
          rowText = row.innerText;
        }
        
        links.push({
          href: link.href,
          text: link.innerText || link.textContent,
          rowText: rowText,
          index: index
        });
      });
      
      // Also try to find links in DataTables format
      if (links.length === 0) {
        // Try finding any links that look like accept buttons
        document.querySelectorAll('a').forEach((link, index) => {
          const href = link.href || '';
          const text = (link.innerText || '').toLowerCase();
          if (text.includes('accept') && href.includes('relyhome')) {
            const row = link.closest('tr');
            links.push({
              href: link.href,
              text: link.innerText,
              rowText: row ? row.innerText : '',
              index: index
            });
          }
        });
      }
      
      return { markdown: text, jobLinks: links };
    });

    let html = await page.content();

    // If we look logged out/expired, try a login in the SAME browser session (when creds are provided)
    if (looksLikeRelyhomeSessionExpired(markdown) && username && password) {
      console.log('[Worker] Session appears expired during scrape; attempting login + retry...');
      await loginToRelyHome(page, username, password);
      await saveRelyhomeCookieCache(page);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await page.waitForTimeout(2000);

      ({ markdown, jobLinks } = await page.evaluate(() => {
        const text = document.body.innerText;
        const links = [];

        const acceptLinks = document.querySelectorAll('a[href*="/jobs/accept/offer.php"], a[href*="offer.php"]');
        acceptLinks.forEach((link, index) => {
          const row = link.closest('tr');
          let rowText = '';
          if (row) rowText = row.innerText;
          links.push({
            href: link.href,
            text: link.innerText || link.textContent,
            rowText,
            index,
          });
        });

        if (links.length === 0) {
          document.querySelectorAll('a').forEach((link, index) => {
            const href = link.href || '';
            const text = (link.innerText || '').toLowerCase();
            if (text.includes('accept') && href.includes('relyhome')) {
              const row = link.closest('tr');
              links.push({
                href: link.href,
                text: link.innerText,
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
    jobLinks.forEach((l, i) => console.log(`  ${i + 1}. ${l.href.substring(0, 80)}...`));

    res.json({
      success: true,
      raw_markdown: markdown,
      raw_html: html,
      job_links: jobLinks,
      scraped_at: new Date().toISOString()
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

  // Validate secret
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to RelyHome login page
    console.log(`[Worker] Navigating to RelyHome login page...`);
    await page.goto('https://relyhome.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for login form
    await page.waitForSelector('input[name="username"], input[name="email"], input[type="email"]', { timeout: 10000 });

    // Fill in credentials - try different field names
    const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', '#username', '#email'];
    const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];

    let usernameField = null;
    let passwordField = null;

    for (const selector of usernameSelectors) {
      try {
        usernameField = await page.$(selector);
        if (usernameField) break;
      } catch (e) {}
    }

    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.$(selector);
        if (passwordField) break;
      } catch (e) {}
    }

    if (!usernameField || !passwordField) {
      throw new Error('Could not find login form fields');
    }

    console.log(`[Worker] Entering credentials...`);
    await usernameField.type(username, { delay: 50 });
    await passwordField.type(password, { delay: 50 });

    // Click login button
    const loginClicked = await page.evaluate(() => {
      const selectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:contains("Login")',
        'button:contains("Sign In")',
        '.login-button',
        '#login-btn'
      ];

      for (const selector of selectors) {
        try {
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            return true;
          }
        } catch (e) {}
      }

      // Fallback: find any button with login-related text
      const allButtons = [...document.querySelectorAll('button, input[type="submit"]')];
      for (const btn of allButtons) {
        const text = (btn.value || btn.textContent || '').toLowerCase();
        if (text.includes('login') || text.includes('sign in') || text.includes('submit')) {
          btn.click();
          return true;
        }
      }

      return false;
    });

    if (!loginClicked) {
      throw new Error('Could not find login button');
    }

    console.log(`[Worker] Login submitted, waiting for redirect...`);

    // Wait for navigation after login
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      page.waitForTimeout(8000)
    ]);

    // Check if login was successful by looking for dashboard/jobs elements
    const currentUrl = page.url();
    console.log(`[Worker] Current URL after login: ${currentUrl}`);

    // Check for login error messages
    const hasError = await page.evaluate(() => {
      const errorSelectors = ['.error', '.alert-danger', '.login-error', '[class*="error"]'];
      for (const selector of errorSelectors) {
        const el = document.querySelector(selector);
        if (el && el.innerText.toLowerCase().includes('invalid')) {
          return el.innerText;
        }
      }
      return null;
    });

    if (hasError) {
      throw new Error(`Login failed: ${hasError}`);
    }

    // Navigate to the available jobs page
    console.log(`[Worker] Navigating to available jobs page...`);
    
    // Try direct navigation to available SWO page
    await page.goto('https://relyhome.com/jobs/accept/available-swo.php', { 
      waitUntil: 'networkidle2', 
      timeout: 20000 
    });

    // Wait for page to fully load
    await page.waitForTimeout(2000);

    // Get the final URL with fresh tokens
    let portalUrl = page.url();
    console.log(`[Worker] Page URL after navigation: ${portalUrl}`);

    // If URL doesn't have tokens, try to find them in links on the page
    if (!portalUrl.includes('vid=') || !portalUrl.includes('exp=')) {
      console.log(`[Worker] URL missing session tokens, searching for tokenized links...`);
      
      // Look for links that contain session tokens
      const tokenizedUrl = await page.evaluate(() => {
        // Look for any links to available-swo.php that have tokens
        const links = Array.from(document.querySelectorAll('a[href*="available-swo.php"]'));
        for (const link of links) {
          const href = link.getAttribute('href');
          if (href && href.includes('vid=') && href.includes('exp=')) {
            // Convert relative URL to absolute
            const url = new URL(href, window.location.origin);
            return url.href;
          }
        }
        
        // Also check the current URL in case it was updated
        if (window.location.href.includes('vid=') && window.location.href.includes('exp=')) {
          return window.location.href;
        }
        
        // Look in menu/navigation links
        const allLinks = Array.from(document.querySelectorAll('a'));
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          if (href.includes('available-swo') && href.includes('vid=')) {
            const url = new URL(href, window.location.origin);
            return url.href;
          }
        }
        
        return null;
      });
      
      if (tokenizedUrl) {
        console.log(`[Worker] Found tokenized URL: ${tokenizedUrl}`);
        portalUrl = tokenizedUrl;
      } else {
        console.log(`[Worker] Warning: Could not find tokenized URL, using current page URL`);
        // The session might be cookie-based, still return the URL
      }
    }
    
    console.log(`[Worker] Fresh portal URL: ${portalUrl}`);

    // Verify we're on the right page (not redirected to login)
    if (portalUrl.includes('login') || portalUrl.includes('signin')) {
      throw new Error('Login appears to have failed - redirected back to login page');
    }

    res.json({
      success: true,
      portal_url: portalUrl,
      refreshed_at: new Date().toISOString()
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
