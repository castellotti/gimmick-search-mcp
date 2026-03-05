#!/usr/bin/env node
/**
 * Gimmick Search MCP Server
 *
 * Runs a visible Chromium browser on a virtual display (Xvfb :99), accessible
 * via noVNC at port 6080. A control panel at port 6081 shows the activity log
 * and accepts user interrupt messages.
 *
 * Ports:
 *   6080 — noVNC browser-based VNC viewer
 *   6081 — HTTP control panel (activity log + interrupt input)
 *
 * All browser-interaction tools return a base64 PNG screenshot alongside text,
 * so Claude (multimodal) can read the page without a separate vision call.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let page: Page | null = null;
const userInputQueue: string[] = [];
const activityLog: { ts: string; msg: string }[] = [];
let sessionActive = false;
let paused = false;
let controlSignal: 'pause' | 'resume' | 'stop' | null = null;

// Vision preview state (updated via POST /api/vision)
let visionImage  = '';   // base64 jpeg/png thumbnail
let visionLabel  = '';   // CDN URL or image filename
let visionPrompt = '';   // prompt sent to vision model
let visionResult = '';   // vision model response text

const CHECKPOINT_DIR  = '/checkpoints';
const CHECKPOINT_PATH = '/checkpoints/gimmick-checkpoint.json';

function log(msg: string): void {
  const entry = { ts: new Date().toISOString(), msg };
  activityLog.push(entry);
  if (activityLog.length > 200) activityLog.shift();
  console.error(`[gimmick] ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChromiumPath(): string {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright';
  let dirs: string[];
  try {
    dirs = readdirSync(base).filter(d => d.startsWith('chromium-'));
  } catch {
    throw new Error(`Cannot read ${base}: Playwright browsers not found`);
  }
  if (dirs.length === 0) throw new Error(`No chromium directory found in ${base}`);
  return join(base, dirs[0], 'chrome-linux', 'chrome');
}

async function takeScreenshot(): Promise<string> {
  if (!page) return '';
  try {
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
  } catch {
    return '';
  }
}

function imageContent(base64: string) {
  return { type: 'image' as const, data: base64, mimeType: 'image/png' };
}

function requirePage(): Page {
  if (!page) throw new Error('No browser session open. Call gimmick_open first.');
  return page;
}

async function writeCheckpoint(label: string, notes: string): Promise<void> {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const url     = page?.url() ?? '';
  const title   = page ? await page.title().catch(() => '') : '';
  const cookies = browserContext ? await browserContext.cookies() : [];
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(
    { timestamp: new Date().toISOString(), label, notes, url, title, cookies },
    null, 2
  ));
  log(`Checkpoint saved: "${label}" @ ${url}`);
}

// ---------------------------------------------------------------------------
// Control Panel HTML (self-contained, no external dependencies)
// Uses textContent and DOM methods to avoid any XSS risk in the activity log.
// ---------------------------------------------------------------------------

const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gimmick Search Control Panel</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { display: flex; height: 100vh; background: #1a1a1a; color: #e0e0e0;
         font-family: 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
  #vnc-pane { flex: 0 0 75%; height: 100%; border-right: 2px solid #333; }
  #vnc-pane iframe { width: 100%; height: 100%; border: none; }
  #sidebar { flex: 1; display: flex; flex-direction: column; height: 100%; min-width: 0; }
  #header { padding: 12px 16px; background: #222; border-bottom: 1px solid #333;
            display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  #header h1 { font-size: 14px; font-weight: 600; color: #ccc; }
  #status { font-size: 12px; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
  #status.live   { background: #1a4a1a; color: #4caf50; }
  #status.idle   { background: #333; color: #888; }
  #status.paused { background: #4a3a1a; color: #ff9800; }
  #controls { display: flex; gap: 6px; padding: 8px 10px;
              border-bottom: 1px solid #333; background: #1e1e1e; flex-shrink: 0; }
  .ctrl-btn { flex: 1; padding: 6px 4px; border-radius: 4px; cursor: pointer;
              font-size: 11px; font-weight: 600; border: 1px solid; }
  .ctrl-btn.pause  { background: #3a3a1a; color: #ff9800; border-color: #5a5a2a; }
  .ctrl-btn.resume { background: #1a3a1a; color: #4caf50; border-color: #2a5a2a; }
  .ctrl-btn.stop   { background: #3a1a1a; color: #f44336; border-color: #5a2a2a; }
  #log { flex: 1; overflow-y: auto; padding: 10px;
         font-family: 'Courier New', monospace; font-size: 11px; line-height: 1.6; }
  .log-entry { display: flex; padding: 2px 0; border-bottom: 1px solid #252525;
               gap: 6px; }
  .log-time { color: #555; flex-shrink: 0; }
  .log-msg { color: #aaa; word-break: break-word; min-width: 0; }
  .log-msg.user { color: #4caf50; }
  #input-area { padding: 10px; border-top: 1px solid #333; background: #222; flex-shrink: 0; }
  #input-hint { font-size: 11px; color: #666; margin-bottom: 6px; }
  #user-input { width: 100%; height: 72px; background: #111; border: 1px solid #444;
                color: #e0e0e0; border-radius: 4px; padding: 8px; font-size: 12px;
                resize: none; outline: none; font-family: inherit; }
  #user-input:focus { border-color: #666; }
  #send-btn { margin-top: 6px; width: 100%; padding: 8px; background: #2d5a2d;
              color: #4caf50; border: 1px solid #3a7a3a; border-radius: 4px;
              cursor: pointer; font-size: 12px; font-weight: 600; }
  #send-btn:hover { background: #3a7a3a; }
  #pending { font-size: 11px; color: #888; margin-top: 6px; text-align: center;
             min-height: 16px; }
  #vision-panel { border-top: 1px solid #333; background: #1a1a1a; flex-shrink: 0;
                  overflow: hidden; max-height: 0; transition: max-height 0.3s ease; }
  #vision-panel.vis-visible { max-height: 260px; }
  #vis-header { padding: 5px 10px; font-size: 10px; color: #555; font-weight: 700;
                letter-spacing: 0.05em; border-bottom: 1px solid #252525;
                text-transform: uppercase; }
  #vis-body { display: flex; gap: 8px; padding: 8px 10px; }
  #vis-img-wrap { flex-shrink: 0; width: 72px; height: 72px; background: #111;
                  border: 1px solid #333; border-radius: 3px; overflow: hidden;
                  display: flex; align-items: center; justify-content: center; }
  #vis-img { width: 72px; height: 72px; object-fit: cover; display: none; }
  #vis-info { flex: 1; min-width: 0; font-size: 11px; overflow: hidden; }
  #vis-label { color: #555; font-size: 10px; word-break: break-all; margin-bottom: 3px;
               line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #vis-prompt { color: #666; font-style: italic; margin-bottom: 4px; line-height: 1.4;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #vis-result { color: #8c8; line-height: 1.5; max-height: 130px; overflow-y: auto;
                font-family: 'Courier New', monospace; font-size: 10px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="vnc-pane">
  <iframe src="http://localhost:6080/vnc.html?autoconnect=1&amp;resize=scale"
          allow="fullscreen" title="Live browser view"></iframe>
</div>
<div id="sidebar">
  <div id="header">
    <h1>Gimmick Search</h1>
    <span id="status" class="idle">&#9675; IDLE</span>
  </div>
  <div id="controls">
    <button class="ctrl-btn pause"  id="btn-pause">&#9646;&#9646; Pause</button>
    <button class="ctrl-btn resume" id="btn-resume">&#9654; Resume</button>
    <button class="ctrl-btn stop"   id="btn-stop">&#9632; Stop</button>
  </div>
  <div id="vision-panel">
    <div id="vis-header">Vision Preview</div>
    <div id="vis-body">
      <div id="vis-img-wrap"><img id="vis-img" alt="vision"></div>
      <div id="vis-info">
        <div id="vis-label"></div>
        <div id="vis-prompt"></div>
        <div id="vis-result"></div>
      </div>
    </div>
  </div>
  <div id="log"></div>
  <div id="input-area">
    <p id="input-hint">Send instruction to Claude (Ctrl+Enter / Cmd+Enter):</p>
    <textarea id="user-input"
      placeholder="Type a message to interrupt Claude..."></textarea>
    <button id="send-btn">Send Message</button>
    <p id="pending"></p>
  </div>
</div>
<script>
(function() {
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('status');
  var inputEl = document.getElementById('user-input');
  var sendBtn = document.getElementById('send-btn');
  var pendingEl = document.getElementById('pending');
  var lastLogCount = 0;

  function appendLogEntry(ts, msg, isUser) {
    var div = document.createElement('div');
    div.className = 'log-entry';

    var timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = String(ts).substring(11, 19);

    var msgSpan = document.createElement('span');
    msgSpan.className = isUser ? 'log-msg user' : 'log-msg';
    msgSpan.textContent = String(msg);   // textContent is XSS-safe by design

    div.appendChild(timeSpan);
    div.appendChild(msgSpan);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fetchState() {
    fetch('/api/state')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.paused) {
          statusEl.textContent = '\u23f8 PAUSED';
          statusEl.className = 'paused';
        } else if (data.active) {
          statusEl.textContent = '\u25cf LIVE';
          statusEl.className = 'live';
        } else {
          statusEl.textContent = '\u25cb IDLE';
          statusEl.className = 'idle';
        }

        pendingEl.textContent = data.pendingInput > 0
          ? data.pendingInput + ' message(s) queued'
          : '';

        if (data.log.length > lastLogCount) {
          var newEntries = data.log.slice(lastLogCount);
          for (var i = 0; i < newEntries.length; i++) {
            appendLogEntry(newEntries[i].ts, newEntries[i].msg, false);
          }
          lastLogCount = data.log.length;
        }

        if (data.vision) {
          var vis = data.vision;
          var visPanel  = document.getElementById('vision-panel');
          var visImg    = document.getElementById('vis-img');
          var visLabel  = document.getElementById('vis-label');
          var visPrompt = document.getElementById('vis-prompt');
          var visResult = document.getElementById('vis-result');
          if (vis.label || vis.result) {
            visPanel.className = 'vis-visible';
            if (vis.image) {
              var src = vis.image.startsWith('http') ? vis.image
                        : 'data:image/jpeg;base64,' + vis.image;
              visImg.src = src;
              visImg.style.display = 'block';
            }
            visLabel.textContent  = vis.label  || '';
            visPrompt.textContent = vis.prompt ? 'Q: ' + vis.prompt.substring(0, 120) : '';
            if (vis.result !== visResult.textContent) {
              visResult.textContent = vis.result || '';
            }
          }
        }
      })
      .catch(function() { /* server not ready yet */ });
  }

  function sendMessage() {
    var msg = inputEl.value.trim();
    if (!msg) return;
    fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    })
      .then(function() {
        appendLogEntry(new Date().toISOString(), '[you] ' + msg, true);
        inputEl.value = '';
      })
      .catch(function(e) { console.error('Send failed:', e); });
  }

  function sendControl(action) {
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action }),
    }).then(function() {
      appendLogEntry(new Date().toISOString(), '[panel] ' + action + ' signal sent', true);
    }).catch(function(e) { console.error('Control failed:', e); });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMessage();
  });

  document.getElementById('btn-pause').addEventListener('click',  function() { sendControl('pause');  });
  document.getElementById('btn-resume').addEventListener('click', function() { sendControl('resume'); });
  document.getElementById('btn-stop').addEventListener('click',   function() { sendControl('stop');   });

  fetchState();
  setInterval(fetchState, 2000);
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP Control Panel Server (port 6081)
// ---------------------------------------------------------------------------

function startHttpServer(): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PANEL_HTML);
      return;
    }

    if (req.method === 'GET' && url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active: sessionActive,
        paused,
        log: activityLog.slice(-50),
        pendingInput: userInputQueue.length,
        vision: { image: visionImage, label: visionLabel, prompt: visionPrompt, result: visionResult },
      }));
      return;
    }

    if (req.method === 'POST' && url === '/api/input') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { message?: unknown };
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            const msg = parsed.message.trim();
            userInputQueue.push(msg);
            log(`[panel] User queued: ${msg}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/control') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { action?: unknown };
          const action = parsed.action;
          if (action === 'pause' || action === 'resume' || action === 'stop') {
            controlSignal = action;
            if (action === 'pause') {
              paused = true;
            } else if (action === 'resume') {
              paused = false;
            } else if (action === 'stop') {
              paused = false;
            }
            log(`[panel] Control signal: ${action}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/vision') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            image?: unknown; label?: unknown; prompt?: unknown; result?: unknown;
          };
          if (typeof parsed.image  === 'string') visionImage  = parsed.image;
          if (typeof parsed.label  === 'string') visionLabel  = parsed.label;
          if (typeof parsed.prompt === 'string') visionPrompt = parsed.prompt;
          if (typeof parsed.result === 'string') visionResult = parsed.result;
          if (visionLabel) log(`[vision] ${visionLabel.substring(0, 80)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(6081, '0.0.0.0', () => {
    log('Control panel listening on http://0.0.0.0:6081');
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcpServer = new McpServer({ name: 'gimmick-search-mcp', version: '1.0.0' });

// --- gimmick_open -----------------------------------------------------------

mcpServer.tool(
  'gimmick_open',
  'Launch a visible Chromium browser on the virtual display, accessible via noVNC. Returns the viewer URL, control panel URL, and an initial screenshot. Call this before any other gimmick_* tools.',
  {
    start_url: z.string().url().optional()
      .describe('Initial URL to navigate to (default: about:blank)'),
  },
  async ({ start_url }) => {
    try {
      paused = false;
      controlSignal = null;

      if (!browser) {
        log('Launching Chromium...');
        const executablePath = findChromiumPath();
        log(`Chromium executable: ${executablePath}`);

        browser = await chromium.launch({
          headless: false,
          executablePath,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1280,900',
            '--window-position=0,0',
            '--disable-blink-features=AutomationControlled',
          ],
        });

        browserContext = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        page = await browserContext.newPage();
        log('Browser launched');
      } else {
        log('Reusing existing browser session');
      }

      sessionActive = true;
      const url = start_url ?? 'about:blank';
      if (url !== 'about:blank') {
        await page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        log(`Navigated to ${url}`);
      }

      const shot = await takeScreenshot();

      const lines = [
        'Browser launched successfully.',
        'VNC viewer:     http://localhost:6080/vnc.html',
        'Control panel:  http://localhost:6081',
        `Current URL:    ${url}`,
        '',
        'Open the VNC viewer to watch navigation in real time.',
        'Use gimmick_check_user_input() periodically to receive interrupt messages.',
      ];

      // Report any existing checkpoint
      if (existsSync(CHECKPOINT_PATH)) {
        try {
          const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8')) as {
            timestamp: string; label: string; notes: string; url: string; title: string;
          };
          lines.push(
            '',
            '--- Existing checkpoint found ---',
            `  Saved:  ${cp.timestamp}`,
            `  Label:  ${cp.label}`,
            `  URL:    ${cp.url}`,
            `  Title:  ${cp.title}`,
            `  Notes:  ${cp.notes}`,
            '',
            'Call gimmick_load_checkpoint({ navigate: true }) to restore session state.',
          );
        } catch {
          lines.push('', 'Note: A checkpoint file exists but could not be parsed.');
        }
      }

      const content: McpContent[] = [{ type: 'text' as const, text: lines.join('\n') }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_navigate -------------------------------------------------------

mcpServer.tool(
  'gimmick_navigate',
  'Navigate the browser to a URL. Returns the page title and a screenshot.',
  {
    url: z.string().describe('URL to navigate to'),
    wait_for: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('When to consider navigation done (default: domcontentloaded)'),
  },
  async ({ url, wait_for }) => {
    try {
      const p = requirePage();
      log(`Navigating to ${url}`);
      await p.goto(url, { waitUntil: wait_for ?? 'domcontentloaded', timeout: 30000 });
      const title = await p.title();
      log(`Loaded: ${title}`);
      const shot = await takeScreenshot();
      const content: McpContent[] = [
        { type: 'text' as const, text: `Title: ${title}\nURL: ${p.url()}` },
      ];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_search ---------------------------------------------------------

const SEARCH_ENGINES: Record<string, (q: string) => string> = {
  google:          q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing:            q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo:      q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  alibaba:         q => `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(q)}`,
  'made-in-china': q => `https://www.made-in-china.com/multi-search/${encodeURIComponent(q)}/F0/`,
};

mcpServer.tool(
  'gimmick_search',
  'Navigate to a search engine and extract results. Supports google, bing, duckduckgo, alibaba, and made-in-china. Returns page text, links, and a screenshot.',
  {
    query: z.string().describe('Search query'),
    engine: z.enum(['google', 'bing', 'duckduckgo', 'alibaba', 'made-in-china'])
      .default('google')
      .describe('Search engine to use'),
  },
  async ({ query, engine }) => {
    try {
      const p = requirePage();
      const searchUrl = SEARCH_ENGINES[engine](query);
      log(`Searching "${query}" on ${engine}`);
      await p.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(1500); // allow dynamic content to settle

      const extracted = await p.evaluate((maxLen: number) => {
        const links: { text: string; href: string }[] = [];
        document.querySelectorAll('a[href]').forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          const text = (a.textContent ?? '').trim();
          if (text && href && !href.startsWith('javascript:') && text.length > 2) {
            links.push({ text: text.substring(0, 200), href });
          }
        });
        return {
          text: (document.body.innerText ?? '').substring(0, maxLen),
          links: links.slice(0, 40),
        };
      }, 3000);

      log(`Search complete: ${extracted.links.length} links extracted`);
      const shot = await takeScreenshot();
      const textOut = [
        `Search: "${query}" on ${engine}`,
        `URL: ${p.url()}`,
        '',
        '--- Page Text (first 3000 chars) ---',
        extracted.text,
        '',
        '--- Links ---',
        extracted.links.map(l => `${l.text}\n  ${l.href}`).join('\n'),
      ].join('\n');

      const content: McpContent[] = [{ type: 'text' as const, text: textOut }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_click ----------------------------------------------------------

mcpServer.tool(
  'gimmick_click',
  'Click an element on the page identified by its visible text or accessible name. Returns a screenshot after clicking.',
  {
    description: z.string().describe('Visible text or accessible name of the element to click'),
    exact: z.boolean().default(false)
      .describe('Require exact text match (default: false for partial match)'),
  },
  async ({ description, exact }) => {
    try {
      const p = requirePage();
      log(`Clicking: "${description}"`);

      let clicked = false;
      const strategies: Array<() => Promise<void>> = [
        () => p.getByText(description, { exact }).first().click({ timeout: 5000 }),
        () => p.getByRole('link', { name: description, exact }).first().click({ timeout: 5000 }),
        () => p.getByRole('button', { name: description, exact }).first().click({ timeout: 5000 }),
        () => p.locator(`[aria-label="${description}"]`).first().click({ timeout: 5000 }),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          clicked = true;
          break;
        } catch { /* try next strategy */ }
      }

      if (!clicked) {
        return {
          content: [{ type: 'text' as const, text: `Could not find clickable element matching "${description}"` }],
          isError: true,
        };
      }

      await p.waitForTimeout(1000);
      log(`Clicked "${description}", URL now: ${p.url()}`);
      const shot = await takeScreenshot();
      const content: McpContent[] = [
        { type: 'text' as const, text: `Clicked "${description}"\nURL: ${p.url()}` },
      ];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_type -----------------------------------------------------------

mcpServer.tool(
  'gimmick_type',
  'Type text into an input field. Optionally specify the field by its label or placeholder. Returns a screenshot.',
  {
    text: z.string().describe('Text to type'),
    field_label: z.string().optional()
      .describe('Label, placeholder, or aria-label of the target input (uses first visible input if omitted)'),
    submit: z.boolean().default(false)
      .describe('Press Enter after typing to submit the form'),
    clear_first: z.boolean().default(true)
      .describe('Clear the field before typing'),
  },
  async ({ text, field_label, submit, clear_first }) => {
    try {
      const p = requirePage();
      const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
      log(`Typing "${preview}"${field_label ? ` into "${field_label}"` : ''}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let locator: any;

      if (field_label) {
        const strategies = [
          () => p.getByLabel(field_label, { exact: false }).first(),
          () => p.getByPlaceholder(field_label, { exact: false }).first(),
          () => p.locator(`[aria-label="${field_label}"]`).first(),
          () => p.locator(`input[name="${field_label}"]`).first(),
        ];

        for (const s of strategies) {
          try {
            const loc = s();
            if (await loc.isVisible({ timeout: 2000 })) {
              locator = loc;
              break;
            }
          } catch { /* try next */ }
        }

        if (!locator) {
          return {
            content: [{ type: 'text' as const, text: `Could not find input field "${field_label}"` }],
            isError: true,
          };
        }
      } else {
        locator = p.locator('input:visible, textarea:visible').first();
      }

      if (clear_first) await locator.clear();
      await locator.fill(text);
      if (submit) await locator.press('Enter');
      await p.waitForTimeout(500);

      log('Typed successfully');
      const shot = await takeScreenshot();
      const content: McpContent[] = [
        { type: 'text' as const, text: `Typed text${submit ? ' and submitted' : ''}` },
      ];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_extract --------------------------------------------------------

mcpServer.tool(
  'gimmick_extract',
  'Extract visible text and links from the current page or a CSS selector scope.',
  {
    focus: z.string().optional()
      .describe('CSS selector to scope extraction to (default: entire body)'),
    include_links: z.boolean().default(true)
      .describe('Include hyperlinks in output'),
    max_length: z.number().min(500).max(50000).default(10000)
      .describe('Maximum characters of text to return'),
  },
  async ({ focus, include_links, max_length }) => {
    try {
      const p = requirePage();
      log(`Extracting content${focus ? ` from "${focus}"` : ''}`);

      const extracted = await p.evaluate(
        (args: { sel: string | undefined; incLinks: boolean; maxLen: number }) => {
          const root: Element | null = args.sel
            ? document.querySelector(args.sel)
            : document.body;
          if (!root) return { text: '', links: [] as { text: string; href: string }[] };

          const text = ((root as HTMLElement).innerText ?? '').substring(0, args.maxLen);
          const links: { text: string; href: string }[] = [];

          if (args.incLinks) {
            root.querySelectorAll('a[href]').forEach(a => {
              const href = (a as HTMLAnchorElement).href;
              const t = (a.textContent ?? '').trim();
              if (t && href && !href.startsWith('javascript:') && t.length > 1) {
                links.push({ text: t.substring(0, 200), href });
              }
            });
          }

          return { text, links: links.slice(0, 50) };
        },
        { sel: focus, incLinks: include_links, maxLen: max_length }
      );

      log(`Extracted ${extracted.text.length} chars, ${extracted.links.length} links`);
      const shot = await takeScreenshot();

      const parts = [
        `URL: ${p.url()}`,
        '',
        '--- Text ---',
        extracted.text,
      ];
      if (include_links && extracted.links.length > 0) {
        parts.push('', '--- Links ---');
        parts.push(extracted.links.map(l => `${l.text}\n  ${l.href}`).join('\n'));
      }

      const content: McpContent[] = [{ type: 'text' as const, text: parts.join('\n') }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_screenshot -----------------------------------------------------

mcpServer.tool(
  'gimmick_screenshot',
  'Take a screenshot of the current browser page and return it as an image. Optionally save it to a file on the mounted output volume (e.g. /output/images/supplier_name_01.png → appears at ./drone-research/images/ on the host).',
  {
    full_page: z.boolean().default(false)
      .describe('Capture the full scrollable page instead of just the viewport'),
    save_path: z.string().optional()
      .describe('Absolute path inside the container to save the PNG (e.g. /output/images/page_001.png). Parent directory is created automatically.'),
  },
  async ({ full_page, save_path }) => {
    try {
      const p = requirePage();
      const buf = await p.screenshot({ type: 'png', fullPage: full_page });
      const base64 = buf.toString('base64');
      log(`Screenshot taken (${full_page ? 'full page' : 'viewport'})`);

      const content: McpContent[] = [imageContent(base64)];

      if (save_path) {
        mkdirSync(dirname(save_path), { recursive: true });
        writeFileSync(save_path, buf);
        log(`Screenshot saved to ${save_path}`);
        content.unshift({ type: 'text' as const, text: `Saved to ${save_path}` });
      }

      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_scroll ---------------------------------------------------------

mcpServer.tool(
  'gimmick_scroll',
  'Scroll the page up, down, or jump to the top or bottom. Returns a screenshot.',
  {
    direction: z.enum(['up', 'down', 'top', 'bottom'])
      .describe('Scroll direction'),
    amount: z.number().default(500)
      .describe('Pixels to scroll for up/down (default: 500)'),
  },
  async ({ direction, amount }) => {
    try {
      const p = requirePage();
      log(`Scrolling ${direction}`);

      await p.evaluate(
        (args: { dir: string; px: number }) => {
          if (args.dir === 'top') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } else if (args.dir === 'bottom') {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          } else if (args.dir === 'down') {
            window.scrollBy({ top: args.px, behavior: 'smooth' });
          } else {
            window.scrollBy({ top: -args.px, behavior: 'smooth' });
          }
        },
        { dir: direction, px: amount }
      );

      await p.waitForTimeout(600);
      const shot = await takeScreenshot();
      const content: McpContent[] = [{ type: 'text' as const, text: `Scrolled ${direction}` }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_wait -----------------------------------------------------------

mcpServer.tool(
  'gimmick_wait',
  'Wait for a number of seconds or until specific text appears on the page. Returns a screenshot.',
  {
    seconds: z.number().min(0.1).max(30).optional()
      .describe('Seconds to wait'),
    wait_for_text: z.string().optional()
      .describe('Wait until this text appears anywhere on the page (up to 30s)'),
  },
  async ({ seconds, wait_for_text }) => {
    try {
      const p = requirePage();

      if (wait_for_text) {
        log(`Waiting for text: "${wait_for_text}"`);
        const escaped = JSON.stringify(wait_for_text);
        await p.waitForFunction(
          `document.body.innerText.includes(${escaped})`,
          undefined,
          { timeout: 30000 }
        );
        log(`Text appeared: "${wait_for_text}"`);
      } else if (seconds) {
        log(`Waiting ${seconds}s`);
        await p.waitForTimeout(seconds * 1000);
      }

      const shot = await takeScreenshot();
      const content: McpContent[] = [{ type: 'text' as const, text: 'Wait complete' }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_check_user_input -----------------------------------------------

mcpServer.tool(
  'gimmick_check_user_input',
  'Check for control signals (pause/resume/stop) or interrupt messages from the user via the control panel at http://localhost:6081. Returns the next signal or queued message, or "No pending input". Call this periodically during long research sessions.',
  {},
  async () => {
    // Control signals take priority over text messages
    if (controlSignal) {
      const sig = controlSignal;
      controlSignal = null;
      const msgs: Record<string, string> = {
        pause:  '[PAUSE] User paused the session. Call gimmick_pause() to save state, then stop calling browser tools until gimmick_resume() is called.',
        resume: '[RESUME] User resumed the session. Continue where you left off.',
        stop:   '[STOP] User stopped the session. Call gimmick_close() to clean up.',
      };
      return { content: [{ type: 'text' as const, text: msgs[sig] ?? `[${sig.toUpperCase()}]` }] };
    }

    const msg = userInputQueue.shift();
    if (msg) {
      log(`Delivering user interrupt to Claude: "${msg}"`);
      return { content: [{ type: 'text' as const, text: `User says: ${msg}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'No pending input' }] };
  }
);

// --- gimmick_pause ----------------------------------------------------------

mcpServer.tool(
  'gimmick_pause',
  'Pause the current research session and save a checkpoint. Call this when gimmick_check_user_input returns a PAUSE signal. Saves current URL, page title, and cookies to /checkpoints/gimmick-checkpoint.json. Returns a checkpoint summary and screenshot.',
  {
    notes: z.string().optional()
      .describe('Optional notes describing where you are in the research (saved to checkpoint)'),
  },
  async ({ notes }) => {
    try {
      paused = true;
      await writeCheckpoint('paused', notes ?? '');

      const url   = page?.url() ?? '(no browser)';
      const title = page ? await page.title().catch(() => '') : '';
      const shot  = await takeScreenshot();

      const lines = [
        'Session paused. Checkpoint saved.',
        `URL:   ${url}`,
        `Title: ${title}`,
        `Notes: ${notes ?? '(none)'}`,
        '',
        'Stop calling browser tools. Poll gimmick_check_user_input() periodically.',
        'When resumed, call gimmick_resume() to get current context.',
      ];

      const content: McpContent[] = [{ type: 'text' as const, text: lines.join('\n') }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_resume ---------------------------------------------------------

mcpServer.tool(
  'gimmick_resume',
  'Resume a paused session. Clears the paused state and returns the current page URL, title, and a screenshot so Claude knows its context. If no browser is open, returns a status message.',
  {},
  async () => {
    try {
      paused = false;
      controlSignal = null;
      log('Session resumed');

      if (!page) {
        return {
          content: [{ type: 'text' as const, text: 'Resumed. No browser session is currently open. Call gimmick_open() to start one.' }],
        };
      }

      const url   = page.url();
      const title = await page.title().catch(() => '');
      const shot  = await takeScreenshot();

      const lines = [
        'Session resumed.',
        `URL:   ${url}`,
        `Title: ${title}`,
        '',
        'Continue where you left off.',
      ];

      const content: McpContent[] = [{ type: 'text' as const, text: lines.join('\n') }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_save_checkpoint ------------------------------------------------

mcpServer.tool(
  'gimmick_save_checkpoint',
  'Save a checkpoint of the current session state to /checkpoints/gimmick-checkpoint.json. Captures current URL, page title, cookies, and optional notes. Call this after each significant step to enable recovery from crashes.',
  {
    label: z.string().optional()
      .describe('Short label for this checkpoint (default: "manual")'),
    notes: z.string().optional()
      .describe('Notes describing current progress and next steps'),
  },
  async ({ label, notes }) => {
    try {
      const cpLabel = label ?? 'manual';
      await writeCheckpoint(cpLabel, notes ?? '');

      const url   = page?.url() ?? '';
      const title = page ? await page.title().catch(() => '') : '';

      const lines = [
        'Checkpoint saved.',
        `Path:      ${CHECKPOINT_PATH}`,
        `Timestamp: ${new Date().toISOString()}`,
        `Label:     ${cpLabel}`,
        `URL:       ${url}`,
        `Title:     ${title}`,
        `Notes:     ${notes ?? '(none)'}`,
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_load_checkpoint ------------------------------------------------

mcpServer.tool(
  'gimmick_load_checkpoint',
  'Load a saved checkpoint from /checkpoints/gimmick-checkpoint.json. Optionally navigates the browser to the checkpointed URL and restores cookies. Use this after gimmick_open() reports an existing checkpoint.',
  {
    navigate: z.boolean().default(false)
      .describe('If true and a browser session is open: restore cookies and navigate to the checkpointed URL'),
  },
  async ({ navigate }) => {
    try {
      if (!existsSync(CHECKPOINT_PATH)) {
        return {
          content: [{ type: 'text' as const, text: `No checkpoint found at ${CHECKPOINT_PATH}.` }],
        };
      }

      const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8')) as {
        timestamp: string; label: string; notes: string;
        url: string; title: string; cookies: Parameters<BrowserContext['addCookies']>[0];
      };

      paused = false;
      controlSignal = null;

      const lines = [
        'Checkpoint loaded.',
        `Saved:  ${cp.timestamp}`,
        `Label:  ${cp.label}`,
        `URL:    ${cp.url}`,
        `Title:  ${cp.title}`,
        `Notes:  ${cp.notes}`,
        `Cookies: ${cp.cookies.length} restored`,
      ];

      let shot = '';
      if (navigate && browserContext && page) {
        await browserContext.addCookies(cp.cookies);
        await page.goto(cp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const currentTitle = await page.title().catch(() => '');
        log(`Checkpoint navigated to: ${cp.url}`);
        lines.push('', `Navigated to: ${cp.url}`, `Current title: ${currentTitle}`);
        shot = await takeScreenshot();
      } else if (navigate && !page) {
        lines.push('', 'Note: navigate=true requested but no browser session is open. Call gimmick_open() first.');
      }

      const content: McpContent[] = [{ type: 'text' as const, text: lines.join('\n') }];
      if (shot) content.push(imageContent(shot));
      return { content };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// --- gimmick_close ----------------------------------------------------------

mcpServer.tool(
  'gimmick_close',
  'Close the browser and end the session. The virtual display and VNC server remain running.',
  {},
  async () => {
    try {
      if (browser) {
        await browser.close();
        browser = null;
        browserContext = null;
        page = null;
        sessionActive = false;
        paused = false;
        log('Browser closed');
      }
      return { content: [{ type: 'text' as const, text: 'Browser closed.' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Gimmick Search MCP starting...');
  startHttpServer();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log('MCP server connected on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
