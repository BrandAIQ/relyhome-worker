const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const CALLBACK_URL = process.env.CALLBACK_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const MAX_TIMEOUT = 60000;

// Store active browser sessions
const sessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes idle timeout

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    activeSessions: sessions.size
  });
});

// Cleanup stale sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`[Worker] Cleaning up stale session ${id}`);
      session.browser?.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60000);

// ============ INTERACTIVE BROWSER SESSION ============

app.post('/browser-session', async (req, res) => {
  const secret = req.headers['x-worker-secret'];
  if (WORKER_SECRET && secret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, sessionId, ...params } = req.body;
  console.log(`[Worker] Browser session action: ${action}, sessionId: ${sessionId || 'new'}`);

  try {
    switch (action) {
      case 'start':
        return await handleStart(res, params);
      case 'screenshot':
        return await handleScreenshot(res, sessionId);
      case 'click':
        return await handleClick(res, sessionId, params);
      case 'type':
        return await handleType(res, sessionId, params);
      case 'keypress':
        return await handleKeypress(res, sessionId, params);
      case 'navigate':
        return await handleNavigate(res, sessionId, params);
      case 'stop':
        return await handleStop(res, sessionId);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error(`[Worker] Session error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
});

async function handleStart(res, params) {
  const { url, credentials } = params;
  const sessionId = crypto.randomUUID();
  
  console.log(`[Worker] Starting new session ${sessionId} for URL: ${url}`);
  
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions'
  ],
});

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Navigate to URL
  await page.goto(url || 'https://relyhome.com/jobs/available/', { 
    waitUntil: 'networkidle2',
    timeout: MAX_TIMEOUT 
  });
  await page.waitForTimeout(1500);

  // If credentials provided, try to auto-login
  if (credentials?.username && credentials?.password) {
    await attemptAutoLogin(page, credentials);
  }

  const screenshot = await page.screenshot({ encoding: 'base64' });
  
  sessions.set(sessionId, {
    browser,
    page,
    lastActivity: Date.now(),
    url: page.url()
  });

  console.log(`[Worker] Session ${sessionId} started, active sessions: ${sessions.size}`);
  
  res.json({ 
    sessionId, 
    screenshot,
    url: page.url()
  });
}

async function attemptAutoLogin(page, credentials) {
  console.log(`[Worker] Attempting auto-login...`);
  
  try {
    // Look for common login form selectors
    const usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[id*="user"]',
      'input[id*="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
    ];
    
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[id*="pass"]',
    ];

    let usernameField = null;
    let passwordField = null;

    for (const sel of usernameSelectors) {
      usernameField = await page.$(sel);
      if (usernameField) break;
    }

    for (const sel of passwordSelectors) {
      passwordField = await page.$(sel);
      if (passwordField) break;
    }

    if (usernameField && passwordField) {
      await usernameField.click();
      await usernameField.type(credentials.username, { delay: 50 });
      await passwordField.click();
      await passwordField.type(credentials.password, { delay: 50 });
      
      // Look for submit button
      const submitButton = await page.$('button[type="submit"]') || 
                           await page.$('input[type="submit"]') ||
                           await page.$('button:has-text("Login")') ||
                           await page.$('button:has-text("Sign in")');
      
      if (submitButton) {
        await submitButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        console.log(`[Worker] Auto-login submitted`);
      }
    } else {
      console.log(`[Worker] Login form not found, skipping auto-login`);
    }
  } catch (error) {
    console.log(`[Worker] Auto-login failed: ${error.message}`);
  }
}

async function handleScreenshot(res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  session.lastActivity = Date.now();
  const screenshot = await session.page.screenshot({ encoding: 'base64' });
  
  res.json({ screenshot, url: session.page.url() });
}

async function handleClick(res, sessionId, params) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { x, y } = params;
  session.lastActivity = Date.now();
  
  console.log(`[Worker] Clicking at (${x}, ${y})`);
  await session.page.mouse.click(x, y);
  await session.page.waitForTimeout(500);
  
  const screenshot = await session.page.screenshot({ encoding: 'base64' });
  res.json({ screenshot, url: session.page.url() });
}

async function handleType(res, sessionId, params) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { text } = params;
  session.lastActivity = Date.now();
  
  console.log(`[Worker] Typing: "${text}"`);
  await session.page.keyboard.type(text, { delay: 30 });
  await session.page.waitForTimeout(300);
  
  const screenshot = await session.page.screenshot({ encoding: 'base64' });
  res.json({ screenshot, url: session.page.url() });
}

async function handleKeypress(res, sessionId, params) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { key } = params;
  session.lastActivity = Date.now();
  
  console.log(`[Worker] Pressing key: ${key}`);
  await session.page.keyboard.press(key);
  await session.page.waitForTimeout(500);
  
  const screenshot = await session.page.screenshot({ encoding: 'base64' });
  res.json({ screenshot, url: session.page.url() });
}

async function handleNavigate(res, sessionId, params) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { url } = params;
  session.lastActivity = Date.now();
  
  console.log(`[Worker] Navigating to: ${url}`);
  await session.page.goto(url, { waitUntil: 'networkidle2', timeout: MAX_TIMEOUT });
  await session.page.waitForTimeout(1000);
  
  const screenshot = await session.page.screenshot({ encoding: 'base64' });
  res.json({ screenshot, url: session.page.url() });
}

async function handleStop(res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ success: true, message: 'Session already stopped' });
  }
  
  console.log(`[Worker] Stopping session ${sessionId}`);
  await session.browser.close();
  sessions.delete(sessionId);
  
  res.json({ success: true, message: 'Session stopped' });
}

// ============ AUTOMATION ENDPOINT (existing) ============

app.post('/automate-accept', async (req, res) => {
  const { task_id, job_id, accept_url, preferred_slots, preferred_days } = req.body;

  console.log(`[Worker] Starting automation for task ${task_id}, job ${job_id}`);
  console.log(`[Worker] Accept URL: ${accept_url}`);
  console.log(`[Worker] Preferred slots: ${preferred_slots?.join(', ')}`);
  console.log(`[Worker] Preferred days: ${preferred_days?.join(', ')}`);

  res.json({ 
    success: true, 
    message: 'Automation started',
    task_id 
  });

  runAutomation(task_id, job_id, accept_url, preferred_slots || [], preferred_days || []);
});

async function runAutomation(task_id, job_id, accept_url, preferred_slots, preferred_days) {
  let browser = null;
  let screenshot = null;

  try {
    console.log(`[Worker] Launching browser for task ${task_id}`);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions'
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`[Worker] Navigating to ${accept_url}`);
    
    await page.goto(accept_url, { 
      waitUntil: 'networkidle2',
      timeout: MAX_TIMEOUT 
    });

    await page.waitForTimeout(2000);
    screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log(`[Worker] Initial screenshot taken`);

    const availableSlots = await findAvailableSlots(page);
    console.log(`[Worker] Found ${availableSlots.length} available slots:`, availableSlots);

    if (availableSlots.length === 0) {
      throw new Error('No available time slots found on the page');
    }

    const selectedSlot = selectBestSlot(availableSlots, preferred_slots, preferred_days);
    
    if (!selectedSlot) {
      throw new Error('No matching time slot found for preferences');
    }

    console.log(`[Worker] Selected slot:`, selectedSlot);
    await clickSlot(page, selectedSlot);
    await page.waitForTimeout(1000);
    await clickAcceptButton(page);
    await page.waitForTimeout(2000);

    screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    console.log(`[Worker] Final screenshot taken after acceptance`);

    const isConfirmed = await checkConfirmation(page);
    
    if (!isConfirmed) {
      throw new Error('Acceptance confirmation not detected');
    }

    console.log(`[Worker] Job accepted successfully!`);

    await sendCallback({
      task_id,
      job_id,
      success: true,
      status: 'COMPLETED',
      selected_slot: selectedSlot.time,
      selected_day: selectedSlot.day,
      appointment_time: `${selectedSlot.day} ${selectedSlot.time}`,
      screenshot_base64: screenshot,
      available_slots: availableSlots.map(s => `${s.day} ${s.time}`),
    });

  } catch (error) {
    console.error(`[Worker] Automation error for task ${task_id}:`, error.message);

    await sendCallback({
      task_id,
      job_id,
      success: false,
      status: 'FAILED',
      error_message: error.message,
      screenshot_base64: screenshot,
    });

  } finally {
    if (browser) {
      await browser.close();
      console.log(`[Worker] Browser closed for task ${task_id}`);
    }
  }
}

async function findAvailableSlots(page) {
  const slots = await page.evaluate(() => {
    const results = [];
    
    const slotSelectors = [
      '[data-slot]',
      '.time-slot',
      '.appointment-slot',
      '.schedule-slot',
      'button[class*="slot"]',
      'div[class*="time"]',
      '.available-time',
      '[class*="appointment"]',
    ];

    for (const selector of slotSelectors) {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent?.trim() || '';
        if (text && !el.classList.contains('disabled') && !el.hasAttribute('disabled')) {
          const dayMatch = text.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
          const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(AM|PM)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(AM|PM)?)/i) ||
                           text.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          
          if (dayMatch || timeMatch) {
            results.push({
              text,
              day: dayMatch ? dayMatch[0] : null,
              time: timeMatch ? timeMatch[0] : text,
              selector: selector,
              elementIndex: Array.from(document.querySelectorAll(selector)).indexOf(el),
            });
          }
        }
      });
    }

    const tableRows = document.querySelectorAll('table tr');
    tableRows.forEach((row, rowIndex) => {
      const cells = row.querySelectorAll('td, th');
      cells.forEach((cell, cellIndex) => {
        const text = cell.textContent?.trim() || '';
        if (text && text.match(/\d{1,2}:\d{2}/)) {
          results.push({
            text,
            day: null,
            time: text,
            selector: 'table',
            rowIndex,
            cellIndex,
          });
        }
      });
    });

    return results;
  });

  return slots;
}

function selectBestSlot(availableSlots, preferredSlots, preferredDays) {
  let bestSlot = null;
  let bestScore = -1;

  for (const slot of availableSlots) {
    let score = 0;

    if (slot.day && preferredDays.length > 0) {
      const dayIndex = preferredDays.findIndex(d => 
        slot.day.toLowerCase().includes(d.toLowerCase())
      );
      if (dayIndex >= 0) {
        score += (preferredDays.length - dayIndex) * 10;
      }
    }

    if (slot.time && preferredSlots.length > 0) {
      const slotIndex = preferredSlots.findIndex(s => 
        slot.time.includes(s) || s.includes(slot.time.split('-')[0]?.trim())
      );
      if (slotIndex >= 0) {
        score += (preferredSlots.length - slotIndex) * 5;
      }
    }

    if (score === 0 && availableSlots.length > 0) {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSlot = slot;
    }
  }

  return bestSlot;
}

async function clickSlot(page, slot) {
  console.log(`[Worker] Clicking slot: ${slot.text}`);
  
  if (slot.selector === 'table') {
    const rows = await page.$$('table tr');
    if (rows[slot.rowIndex]) {
      const cells = await rows[slot.rowIndex].$$('td, th');
      if (cells[slot.cellIndex]) {
        await cells[slot.cellIndex].click();
        return;
      }
    }
  } else {
    const elements = await page.$$(slot.selector);
    if (elements[slot.elementIndex]) {
      await elements[slot.elementIndex].click();
      return;
    }
  }

  await page.evaluate((text) => {
    const elements = document.querySelectorAll('button, div[class*="slot"], a');
    for (const el of elements) {
      if (el.textContent?.includes(text)) {
        el.click();
        return true;
      }
    }
    return false;
  }, slot.text);
}

async function clickAcceptButton(page) {
  console.log(`[Worker] Looking for accept/confirm button`);
  
  const acceptSelectors = [
    'button[type="submit"]',
    'button:contains("Accept")',
    'button:contains("Confirm")',
    'button:contains("Submit")',
    'button:contains("Book")',
    'button:contains("Schedule")',
    '[class*="accept"]',
    '[class*="confirm"]',
    '[class*="submit"]',
    'input[type="submit"]',
  ];

  for (const selector of acceptSelectors) {
    try {
      const button = await page.$(selector);
      if (button) {
        await button.click();
        console.log(`[Worker] Clicked accept button with selector: ${selector}`);
        return;
      }
    } catch (e) {
      // continue
    }
  }

  const clicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"], a[class*="btn"]');
    const acceptTexts = ['accept', 'confirm', 'submit', 'book', 'schedule', 'ok', 'yes'];
    
    for (const button of buttons) {
      const text = button.textContent?.toLowerCase() || '';
      if (acceptTexts.some(t => text.includes(t))) {
        button.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    throw new Error('Accept/Confirm button not found');
  }
}

async function checkConfirmation(page) {
  await page.waitForTimeout(1500);

  const confirmation = await page.evaluate(() => {
    const pageText = document.body.textContent?.toLowerCase() || '';
    const confirmIndicators = [
      'confirmed',
      'accepted',
      'scheduled',
      'booked',
      'success',
      'thank you',
      'appointment has been',
    ];
    
    return confirmIndicators.some(indicator => pageText.includes(indicator));
  });

  return confirmation;
}

async function sendCallback(result) {
  if (!CALLBACK_URL) {
    console.error('[Worker] CALLBACK_URL not configured');
    return;
  }

  try {
    const response = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET || '',
      },
      body: JSON.stringify(result),
    });

    if (!response.ok) {
      console.error(`[Worker] Callback failed: ${response.status}`);
    } else {
      console.log(`[Worker] Callback sent successfully for task ${result.task_id}`);
    }
  } catch (error) {
    console.error(`[Worker] Callback error:`, error);
  }
}

app.listen(PORT, () => {
  console.log(`[Worker] Puppeteer automation worker listening on port ${PORT}`);
  console.log(`[Worker] Callback URL: ${CALLBACK_URL}`);
});

