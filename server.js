const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.AUTOMATION_WORKER_SECRET;

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
  const { url, secret } = req.body;

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

    console.log(`[Worker] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait for dynamic content to load
    await page.waitForTimeout(2000);

    // Extract page content AND job links
    const { markdown, jobLinks } = await page.evaluate(() => {
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

    const html = await page.content();

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

app.listen(PORT, () => {
  console.log(`[Worker] Puppeteer automation worker running on port ${PORT}`);
});
