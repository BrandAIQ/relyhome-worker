const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const CALLBACK_URL = process.env.CALLBACK_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/automate-accept', async (req, res) => {
  const { task_id, job_id, accept_url, preferred_slots, preferred_days } = req.body;
  console.log(`[Worker] Starting automation for task ${task_id}`);
  res.json({ success: true, message: 'Automation started', task_id });
  runAutomation(task_id, job_id, accept_url, preferred_slots || [], preferred_days || []);
});

async function runAutomation(task_id, job_id, accept_url, preferred_slots, preferred_days) {
  let browser = null;
  let screenshot = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(accept_url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
    
    const slots = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('button, [class*="slot"], [class*="time"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.match(/\d{1,2}:\d{2}/)) results.push({ text, selector: el.className });
      });
      return results;
    });
    
    if (slots.length > 0) {
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"], [class*="accept"], [class*="confirm"]');
        if (btn) btn.click();
      });
    }
    
    await sendCallback({ task_id, job_id, success: true, status: 'COMPLETED', screenshot_base64: screenshot });
  } catch (error) {
    await sendCallback({ task_id, job_id, success: false, status: 'FAILED', error_message: error.message, screenshot_base64: screenshot });
  } finally {
    if (browser) await browser.close();
  }
}

async function sendCallback(result) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET || '' },
      body: JSON.stringify(result)
    });
  } catch (e) { console.error('Callback error:', e); }
}

app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));