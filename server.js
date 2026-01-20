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

    console.log(`[Worker] Navigating to ${accept_url}`);
    await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(2000);

    availableSlots = await page.evaluate(() => {
      const slots = [];
      const radioButtons = document.querySelectorAll(
        'input[type="radio"][name="appttime"], ' +
        'input[type="radio"][name="appointment"], ' +
        'input[type="radio"][name="time_slot"]'
      );

      radioButtons.forEach(radio => {
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

    const bestSlot = findBestSlot(availableSlots, preferred_days, preferred_slots);
    console.log(`[Worker] Selected slot: ${bestSlot.label} (${bestSlot.value})`);

    const radioSelector = bestSlot.id 
      ? `#${bestSlot.id}`
      : `input[type="radio"][name="${bestSlot.name}"][value="${bestSlot.value}"]`;
    
    await page.click(radioSelector);
    await page.waitForTimeout(500);

    const submitClicked = await page.evaluate(() => {
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
      page.waitForTimeout(5000)
    ]);

    screenshotBase64 = await page.screenshot({ encoding: 'base64' });

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
      available_slots: availableSlots.map(s => s.label),
      error: null,
      secret
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
  const normDays = (preferredDays || []).map(d => d.toLowerCase());
  const normSlots = (preferredSlots || []).map(s => s.toLowerCase());

  const scoredSlots = availableSlots.map(slot => {
    let score = 0;
    const labelLower = slot.label.toLowerCase();

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
    'sun': 'sunday', 'mon': 'monday', 'tue': 'tuesday', 'wed': 'wednesday',
    'thu': 'thursday', 'fri': 'friday', 'sat': 'saturday'
  };
  return days[abbrev] || abbrev;
}

function timeRangeMatches(label, prefSlot) {
  const timePattern = /(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;
  const labelTimes = label.match(timePattern) || [];
  const prefTimes = prefSlot.match(timePattern) || [];
  
  if (labelTimes.length === 0 || prefTimes.length === 0) return false;
  return labelTimes.some(lt => prefTimes.some(pt => lt === pt));
}

function parseSlotLabel(label) {
  let date = null;
  let day = null;
  let timeRange = null;

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
      body: JSON.stringify(data)
    });
    console.log(`[Worker] Callback response: ${response.status}`);
  } catch (error) {
    console.error(`[Worker] Callback error:`, error.message);
  }
}

// NEW: Scrape endpoint for quick polling (no form submission)
app.post('/scrape', async (req, res) => {
  const { url, secret } = req.body;

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
    await page.waitForTimeout(2000);

    const markdown = await page.evaluate(() => document.body.innerText);
    const html = await page.content();

    console.log(`[Worker] Scraped ${markdown.length} chars of text`);

    res.json({
      success: true,
      raw_markdown: markdown,
      raw_html: html,
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
