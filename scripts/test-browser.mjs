#!/usr/bin/env node
/**
 * Autonomous Browser Avatar E2E Test
 * 
 * An LLM avatar that explores the admin UI with minimal context,
 * discovers how to create an avatar, and has a conversation.
 * 
 * The avatar receives only:
 * - A screenshot of the current page state
 * - A high-level goal ("explore this app and create a new AI avatar")
 * - Its own history of observations and actions
 * 
 * Authentication:
 * - Wallet Auth: Uses a test wallet keypair to sign challenges programmatically
 * 
 * Usage: node scripts/test-browser.mjs [env]
 * 
 * Environment Variables:
 *   TEST_WALLET_PRIVATE_KEY - Base58 encoded private key for test wallet (optional)
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ============================================================================
// Issue Reporting (via internal API)
// ============================================================================

/**
 * Report an error/warning to the internal auto-issues system
 * Uses fingerprinting for deduplication
 */
async function reportIssue(apiUrl, testKey, params) {
  const { error, stack, subsystem, category, context } = params;

  try {
    const response = await fetch(`${apiUrl}/issues`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-test-key': testKey,
      },
      body: JSON.stringify({
        error,
        stack,
        subsystem,
        category,
        context,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`   ⚠️ Failed to report issue: ${response.status} ${text}`);
      return null;
    }

    const result = await response.json();
    console.log(`   📋 Issue ${result.isNew ? 'created' : 'updated'}: ${result.issueId} (${result.occurrenceCount} occurrences)`);
    return result;
  } catch (err) {
    console.warn(`   ⚠️ Failed to report issue: ${err.message}`);
    return null;
  }
}

async function reportError(apiUrl, testKey, params) {
  return reportIssue(apiUrl, testKey, { ...params, category: 'error' });
}

async function reportWarning(apiUrl, testKey, params) {
  return reportIssue(apiUrl, testKey, { ...params, category: 'warning' });
}

const ENV = process.argv[2] || 'staging';
const MAX_STEPS = 25;
const INITIAL_WAIT = 500;      // Initial wait after action
const MAX_WAIT = 8000;         // Max wait for page change (exponential backoff cap)
const BACKOFF_MULTIPLIER = 1.5; // Exponential backoff multiplier

// Early failure detection thresholds
const MAX_EMPTY_PAGE_STEPS = 3;  // Abort after 3 consecutive steps with no elements
const MAX_WAIT_ACTIONS = 4;      // Abort after 4 consecutive WAIT actions (unparseable responses)
const MAX_CONSECUTIVE_FAILURES = 3;  // Abort after 3 consecutive failed actions
const MAX_REPEATED_ACTIONS = 3;  // Abort after 3 repetitions of the same action

function getStackOutput(exportNameSuffix) {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  const exportName = `swarm-${exportNameSuffix}-${ENV === 'production' ? 'prod' : ENV}`;
  try {
    // Use ExportName which is stable (not OutputKey which has CDK hash suffix)
    const result = execSync(
      `aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs[?ExportName=='${exportName}'].OutputValue | [0]" --output text`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result && result !== 'None' ? result : null;
  } catch {
    return null;
  }
}

function getInternalTestKey() {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  try {
    const resources = JSON.parse(execSync(
      `aws cloudformation describe-stack-resources --stack-name ${stack} --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(PhysicalResourceId, 'ChatHandler')]" --output json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ));
    if (!resources.length) return null;
    
    const functionName = resources[0].PhysicalResourceId;
    const config = JSON.parse(execSync(
      `aws lambda get-function-configuration --function-name "${functionName}" --output json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ));
    return config.Environment?.Variables?.INTERNAL_TEST_KEY || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Screenshot Comparison & Page Stability
// ============================================================================

/**
 * Take a screenshot and return it as a base64 string
 * Uses JPEG compression to reduce token usage (PNG is huge)
 */
async function takeScreenshotBase64(page) {
  const buffer = await page.screenshot({ 
    fullPage: false,
    type: 'jpeg',
    quality: 60, // Good balance of quality vs size
  });
  return buffer.toString('base64');
}

/**
 * Compare two base64 screenshots - returns true if they are different
 * Uses a simple byte comparison - any difference counts as a change
 */
function screenshotsAreDifferent(screenshot1, screenshot2) {
  if (!screenshot1 || !screenshot2) return true;
  return screenshot1 !== screenshot2;
}

/**
 * Wait for the page to change with exponential backoff
 * Returns the new screenshot when page has changed, or after max timeout
 */
async function waitForPageChange(page, previousScreenshot, actionType) {
  let currentWait = INITIAL_WAIT;
  let totalWaited = 0;
  let attempts = 0;
  
  // Some actions don't cause visual changes - use shorter timeout
  const quickActions = ['SCROLL', 'WAIT', 'KEY'];
  const maxWaitForAction = quickActions.includes(actionType) ? MAX_WAIT / 2 : MAX_WAIT;
  
  while (totalWaited < maxWaitForAction) {
    await page.waitForTimeout(currentWait);
    totalWaited += currentWait;
    attempts++;
    
    const newScreenshot = await takeScreenshotBase64(page);
    
    if (screenshotsAreDifferent(previousScreenshot, newScreenshot)) {
      if (attempts > 1) {
        console.log(`   📸 Page changed after ${totalWaited}ms (${attempts} checks)`);
      }
      return { screenshot: newScreenshot, changed: true, waitTime: totalWaited };
    }
    
    // Exponential backoff
    currentWait = Math.min(currentWait * BACKOFF_MULTIPLIER, MAX_WAIT - totalWaited);
  }
  
  // Max timeout reached - return current screenshot anyway
  const finalScreenshot = await takeScreenshotBase64(page);
  console.log(`   ⏱️  Max wait reached (${totalWaited}ms) - page may not have changed`);
  return { screenshot: finalScreenshot, changed: false, waitTime: totalWaited };
}

// ============================================================================
// Test Wallet for Programmatic Signing
// ============================================================================

/**
 * Generate or load a test wallet keypair
 * If TEST_WALLET_PRIVATE_KEY is set, use it; otherwise generate a new one
 */
function getTestWallet() {
  const privateKeyBase58 = process.env.TEST_WALLET_PRIVATE_KEY;
  
  if (privateKeyBase58) {
    // Load existing wallet from private key
    const secretKey = bs58.decode(privateKeyBase58);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    const publicKey = bs58.encode(keypair.publicKey);
    console.log(`📛 Using test wallet: ${publicKey.slice(0, 8)}...`);
    return { keypair, publicKey };
  }
  
  // Generate ephemeral test wallet
  const keypair = nacl.sign.keyPair();
  const publicKey = bs58.encode(keypair.publicKey);
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  console.log(`🔑 Generated ephemeral test wallet: ${publicKey.slice(0, 8)}...`);
  console.log(`   (Set TEST_WALLET_PRIVATE_KEY=${secretKeyBase58} to reuse)`);
  return { keypair, publicKey };
}

/**
 * Sign a message with the test wallet
 */
function signMessage(message, keypair) {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(signature);
}

/**
 * Authenticate with the API using wallet signature
 * Returns the session cookie to use in subsequent requests
 */
async function authenticateWithWallet(apiUrl, testKey) {
  const wallet = getTestWallet();
  
  console.log('🔐 Authenticating with wallet...');
  
  // Step 1: Request challenge
  const challengeResponse = await fetch(`${apiUrl}/auth/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
    },
    body: JSON.stringify({ walletAddress: wallet.publicKey }),
  });
  
  const challengeText = await challengeResponse.text();
  
  // Check for HTML (auth wall / proxy page)
  if (challengeText.startsWith('<!DOCTYPE') || challengeText.startsWith('<html')) {
    throw new Error(`Auth request blocked (HTML response). Status: ${challengeResponse.status}`);
  }
  
  if (!challengeResponse.ok) {
    throw new Error(`Challenge request failed: ${challengeResponse.status} ${challengeText}`);
  }
  
  let challengeData;
  try {
    challengeData = JSON.parse(challengeText);
  } catch (e) {
    throw new Error(`Invalid JSON in challenge response: ${challengeText.substring(0, 200)}`);
  }
  
  const { nonce, message } = challengeData;
  console.log(`   Challenge received (nonce: ${nonce.slice(0, 16)}...)`);
  
  // Step 2: Sign the challenge
  const signature = signMessage(message, wallet.keypair);
  console.log(`   Message signed`);
  
  // Step 3: Verify and get session
  const verifyResponse = await fetch(`${apiUrl}/auth/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
    },
    body: JSON.stringify({
      signature,
      publicKey: wallet.publicKey,
      nonce,
    }),
  });
  
  const verifyText = await verifyResponse.text();
  
  // Check for HTML (auth wall / proxy page)
  if (verifyText.startsWith('<!DOCTYPE') || verifyText.startsWith('<html')) {
    throw new Error(`Verify request blocked (HTML response). Status: ${verifyResponse.status}`);
  }
  
  if (!verifyResponse.ok) {
    throw new Error(`Verify request failed: ${verifyResponse.status} ${verifyText}`);
  }
  
  let result;
  try {
    result = JSON.parse(verifyText);
  } catch (e) {
    throw new Error(`Invalid JSON in verify response: ${verifyText.substring(0, 200)}`);
  }
  
  // Extract session cookie from response
  const setCookie = verifyResponse.headers.get('set-cookie');
  
  console.log(`   ✅ Authenticated as ${wallet.publicKey.slice(0, 8)}...`);
  
  return {
    sessionCookie: setCookie,
    walletAddress: wallet.publicKey,
    user: result.user,
  };
}

async function getPageElements(page) {
  return annotatePageForVision(page);
}

async function clearVisionOverlay(page) {
  try {
    await page.evaluate(() => {
      const OVERLAY_ID = '__agent_overlay__';
      const ATTR = 'data-agent-id';
      document.getElementById(OVERLAY_ID)?.remove();
      document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
    });
  } catch {
    // ignore
  }
}

async function annotatePageForVision(page) {
  try {
    const result = await page.evaluate(() => {
      const OVERLAY_ID = '__agent_overlay__';
      const ATTR = 'data-agent-id';
      const MAX_LABEL_LEN = 80;
      const MAX_ELEMENTS = 70;

      const existing = document.getElementById(OVERLAY_ID);
      if (existing) existing.remove();
      document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const opacity = parseFloat(style.opacity || '1');
        if (!Number.isNaN(opacity) && opacity <= 0.01) return false;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
      };

      const candidates = new Set();
      const addAll = (selector) => document.querySelectorAll(selector).forEach((el) => candidates.add(el));
      addAll('button');
      addAll('a[href]');
      addAll('[role="button"]');
      addAll('[role="link"]');
      addAll('input');
      addAll('textarea');
      addAll('select');
      addAll('[contenteditable="true"]');

      const items = [];
      for (const node of candidates) {
        if (items.length >= MAX_ELEMENTS) break;
        const el = node;
        if (!isVisible(el)) continue;

        const tag = (el.tagName || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
        const kind = role === 'link' || tag === 'a' ? 'link' : isInput ? 'input' : 'button';

        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const name = (el.getAttribute('name') || '').trim();
        const testId = (el.getAttribute('data-testid') || '').trim();
        const idAttr = (el.id || '').trim();

        let label = '';
        if (kind === 'input') {
          label = ariaLabel || placeholder || name || idAttr || testId || (tag === 'input' ? (el.getAttribute('type') || 'input') : 'input');
        } else {
          if (ariaLabel && ariaLabel.length <= MAX_LABEL_LEN) {
            label = ariaLabel;
          } else {
            label = (el.innerText || el.textContent || '').trim();
          }
          if (!label) label = title || testId || ariaLabel || '';
        }
        label = label.replace(/\s+/g, ' ').trim();
        if (label.length > MAX_LABEL_LEN) label = label.slice(0, MAX_LABEL_LEN - 1) + '…';

        const id = items.length + 1;
        el.setAttribute(ATTR, String(id));
        const rect = el.getBoundingClientRect();
        items.push({ id, kind, label, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.zIndex = '2147483647';
      overlay.style.pointerEvents = 'none';

      for (const item of items) {
        const color = item.kind === 'button' ? '#22c55e' : item.kind === 'link' ? '#60a5fa' : '#f59e0b';

        const box = document.createElement('div');
        box.style.position = 'absolute';
        box.style.left = `${Math.max(0, item.rect.x)}px`;
        box.style.top = `${Math.max(0, item.rect.y)}px`;
        box.style.width = `${Math.max(0, item.rect.width)}px`;
        box.style.height = `${Math.max(0, item.rect.height)}px`;
        box.style.border = `2px solid ${color}`;
        box.style.borderRadius = '6px';
        box.style.boxSizing = 'border-box';
        box.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.15)';

        const badge = document.createElement('div');
        badge.textContent = String(item.id);
        badge.style.position = 'absolute';
        badge.style.left = '-2px';
        badge.style.top = '-18px';
        badge.style.background = color;
        badge.style.color = '#0b0b0b';
        badge.style.font = '12px/14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        badge.style.padding = '2px 6px';
        badge.style.borderRadius = '6px';
        badge.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
        box.appendChild(badge);

        overlay.appendChild(box);
      }

      document.documentElement.appendChild(overlay);

      const uniq = (arr) => [...new Set(arr.filter(Boolean))];
      const buttons = uniq(items.filter((i) => i.kind === 'button').map((i) => i.label));
      const links = uniq(items.filter((i) => i.kind === 'link').map((i) => i.label));
      const inputs = uniq(items.filter((i) => i.kind === 'input').map((i) => i.label));

      return {
        buttons,
        links,
        inputs,
        interactables: items.map(({ id, kind, label }) => ({ id, kind, label })),
      };
    });

    return result;
  } catch {
    return { buttons: [], links: [], inputs: [], interactables: [] };
  }
}

async function getNextAction(apiUrl, testKey, screenshotPath, history, goal, pageElements) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  
  // Format available elements for the prompt (IDs are drawn on the screenshot)
  const interactableList = (pageElements.interactables || [])
    .slice(0, 30)
    .map((i) => `${i.id}. [${i.kind}] ${i.label || '(no label)'}`)
    .join('\n');

  const elementsSection = `
INTERACTIVE ELEMENTS (numbered on the screenshot):
${interactableList || '(none detected)'}

(If the list is incomplete, rely on the screenshot overlay numbers.)
`;

  const systemPrompt = `You are an autonomous browser avatar exploring a web application.

YOUR GOAL: ${goal}

You can see a screenshot of the current page state. Based on what you observe, decide on ONE action to take.
${elementsSection}
AVAILABLE ACTIONS:
- CLICK_ID: number - Click the element with that number on the screenshot overlay
- TYPE_ID: number | text - Focus that element (usually an input) and type text
- FILL_ID: number | text - Fill that element (clears existing text, for inputs)
- CLICK: text - Fallback: click by text if needed
- TYPE: text - Type text into the currently focused input field  
- FILL: placeholder | text - Fill an input field (e.g., "Enter avatar name | MyAgent")
- PRESS: key - Press a keyboard key (Enter, Tab, Escape)
- SCROLL: down/up - Scroll the page
- NAVIGATE: /path - Navigate to a URL path (prefer "/"; avoid guessing deep routes)
- DONE: summary - Task complete, provide summary
- ABORT: reason - End test early due to blocking issue (auth wall, crash, wrong app, etc.)

WHEN TO USE ABORT:
- You see a login/authentication page that blocks access (SSO login, auth wall)
- The application shows an error page or has crashed
- The page is clearly not the expected admin UI application
- You're stuck in an unrecoverable state after multiple failed attempts

CRITICAL RULES:
1. Prefer CLICK_ID/TYPE_ID/FILL_ID using the numbered screenshot overlay
2. If you must use CLICK by text, copy the EXACT text from the element list above
3. NEVER CLICK an input. Use FILL_ID/FILL/TYPE_ID/TYPE instead.
4. If you need to send a chat message, prefer: FILL_ID on the message box, then PRESS: Enter.
5. Prefer creation via existing UI controls (e.g., "Create new avatar" / "Create Avatar"). If stuck, NAVIGATE: / and retry.
6. Avoid guessing routes like /avatars/new (it may not exist).
7. Don't invent button names.

ANTI-STUCK RULES:
- Do NOT click "Preview" or "System Prompt" unless the goal explicitly asks to inspect prompts.
- Do NOT open "Account" unless you need wallet/account actions.
- If you accidentally open a modal/panel you don't need, use PRESS: Escape to close it.
- If the last action caused no visible change, choose a different action next.

OUTPUT REQUIREMENTS:
- Output MUST be exactly 3 lines.
- Each line MUST start with one of: OBSERVATION:, REASONING:, ACTION:
- Do NOT use markdown, bullets, code blocks, or extra lines.

RESPONSE FORMAT (use exactly this format on separate lines):
OBSERVATION: [What you see on screen]
REASONING: [Why you're taking this action]
ACTION: [Exactly one action, e.g., CLICK: Create New Avatar]

HISTORY OF YOUR ACTIONS:
${history.length > 0 ? history.map((h, i) => `Step ${i + 1}: ${h}`).join('\n') : '(Starting fresh - explore the interface!)'}
`;

  // Use Haiku 4.5 for faster, cheaper browser testing
  const BROWSER_TEST_MODEL = 'anthropic/claude-haiku-4.5';

  const payload = {
    message: 'Analyze the screenshot and decide your next action.',
    history: [],
    systemPrompt,
    model: BROWSER_TEST_MODEL,
    attachments: [{
      type: 'image',
      data: `data:image/jpeg;base64,${base64Image}`,
      name: path.basename(screenshotPath).replace('.png', '.jpg')
    }]
  };
  
  const response = await fetch(apiUrl + '/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
    },
    body: JSON.stringify(payload)
  });
  
  const text = await response.text();
  
  // Check if we got HTML (auth wall / proxy page) instead of JSON
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error(`Request blocked (HTML response) - got a non-JSON page. Status: ${response.status}`);
  }
  
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${text}`);
  }
  
  let result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON response from API: ${text.substring(0, 200)}`);
  }
  
  // The chat API returns { response: "...", history: [...] }
  return result.response || result.message || result.content || '';
}

function parseAction(response) {
  const lines = response.split('\n');
  let observation = '';
  let reasoning = '';
  let action = null;
  
  const actionTypeMatch = (text) => text.match(/^(CLICK_ID|TYPE_ID|FILL_ID|CLICK|TYPE|FILL|PRESS|SCROLL|NAVIGATE|DONE|ABORT)\s*:\s*(.*)$/i);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Tolerate minor format drift (case, markdown bold, leading bullets)
    const obsMatch = trimmed.match(/^(?:[-*]\s*)?(?:\*\*)?\s*OBSERVATION\s*(?:\*\*)?\s*:\s*(.*)$/i);
    if (obsMatch) {
      observation = obsMatch[1].trim();
      continue;
    }

    const reasonMatch = trimmed.match(/^(?:[-*]\s*)?(?:\*\*)?\s*REASONING\s*(?:\*\*)?\s*:\s*(.*)$/i);
    if (reasonMatch) {
      reasoning = reasonMatch[1].trim();
      continue;
    }

    const actionMatch = trimmed.match(/^(?:[-*]\s*)?(?:\*\*)?\s*ACTION\s*(?:\*\*)?\s*:\s*(.*)$/i);
    if (actionMatch) {
      action = actionMatch[1].trim();
      continue;
    }
  }

  // Fallback: sometimes the model outputs a bare action line without ACTION:
  if (!action) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = actionTypeMatch(trimmed);
      if (m) {
        action = `${m[1]}: ${m[2]}`;
        break;
      }
    }
  }
  
  if (action) {
    const match = action.match(/^(\w+)\s*:\s*(.*)$/);
    if (match) {
      // Normalize numeric clicks to CLICK_ID for robustness
      const rawType = match[1].toUpperCase();
      const rawParams = match[2].trim();
      if (rawType === 'CLICK' && /^#?\d+$/.test(rawParams)) {
        return {
          observation,
          reasoning,
          type: 'CLICK_ID',
          params: rawParams.replace(/^#/, ''),
          raw: action
        };
      }
      return {
        observation,
        reasoning,
        type: rawType,
        params: rawParams,
        raw: action
      };
    }

    // Last-chance fallback: allow "CLICK <text>" style (no colon)
    const parts = action.trim().split(/\s+/);
    const maybeType = (parts[0] || '').toUpperCase();
    const allowed = new Set(['CLICK', 'TYPE', 'FILL', 'PRESS', 'SCROLL', 'NAVIGATE', 'DONE', 'ABORT']);
    if (allowed.has(maybeType)) {
      return {
        observation,
        reasoning,
        type: maybeType,
        params: action.trim().slice(parts[0].length).trim(),
        raw: action
      };
    }
  }
  
  const actionMatch = response.match(/ACTION:\s*(\w+):\s*(.*?)(\n|$)/i);
  if (actionMatch) {
    return {
      observation,
      reasoning,
      type: actionMatch[1].toUpperCase(),
      params: actionMatch[2].trim(),
      raw: actionMatch[0]
    };
  }
  
  return { observation, reasoning, type: 'WAIT', params: 'Could not parse action', raw: response };
}

/**
 * Convert text to kebab-case for data-testid matching
 */
function toTestId(text) {
  return text.toLowerCase().replace(/\s+/g, '-');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLooseTextRegex(text) {
  // Match words with flexible whitespace/newlines in between.
  // Example: "Create new avatar" -> /Create\s+new\s+avatar/i
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegex);
  const pattern = tokens.join('\\s+');
  return new RegExp(pattern || escapeRegex(text), 'i');
}

function parseIdAndText(params) {
  const raw = String(params || '').trim();
  const sep = raw.indexOf('|');
  if (sep === -1) {
    return { id: raw.replace(/^#/, '').trim(), text: '' };
  }
  const id = raw.slice(0, sep).replace(/^#/, '').trim();
  const text = raw.slice(sep + 1).trim();
  return { id, text };
}

async function executeAction(page, action) {
  const { type, params } = action;
  
  try {
    switch (type) {
      case 'CLICK_ID': {
        const id = String(params || '').replace(/^#/, '').trim();
        if (!id) return { success: false, error: 'Missing element id' };
        await page.locator(`[data-agent-id="${id}"]`).first().click({ timeout: 2000 });
        return { success: true };
      }

      case 'TYPE_ID': {
        const { id, text } = parseIdAndText(params);
        if (!id) return { success: false, error: 'Missing element id' };
        await page.locator(`[data-agent-id="${id}"]`).first().click({ timeout: 2000 });
        if (text) {
          await page.keyboard.type(text, { delay: 50 });
        }
        return { success: true };
      }

      case 'FILL_ID': {
        const { id, text } = parseIdAndText(params);
        if (!id) return { success: false, error: 'Missing element id' };
        const target = page.locator(`[data-agent-id="${id}"]`).first();
        await target.click({ timeout: 2000 });

        // Prefer element.fill when supported (input/textarea), fallback to select-all + type.
        try {
          await target.fill(text, { timeout: 2000 });
        } catch {
          try {
            await page.keyboard.press('Control+A');
          } catch {
            // ignore
          }
          try {
            await page.keyboard.press('Meta+A');
          } catch {
            // ignore
          }
          await page.keyboard.type(text, { delay: 50 });
        }
        return { success: true };
      }

      case 'CLICK': {
        const loose = buildLooseTextRegex(params);
        const strategies = [
          // Exact text match
          () => page.click(`text="${params}"`, { timeout: 2000 }),
          // Partial/fuzzy text match  
          () => page.click(`text=${params}`, { timeout: 2000 }),
          // Robust text match (tolerates newlines / multiple spaces)
          () => page.getByText(loose).first().click({ timeout: 2000 }),
          // Button with text
          () => page.click(`button:has-text("${params}")`, { timeout: 2000 }),
          () => page.getByRole('button', { name: loose }).first().click({ timeout: 2000 }),
          // Link with text
          () => page.click(`a:has-text("${params}")`, { timeout: 2000 }),
          () => page.getByRole('link', { name: loose }).first().click({ timeout: 2000 }),
          // Any element with text (div, span, etc)
          () => page.click(`*:has-text("${params}"):visible`, { timeout: 2000 }),
          // Role-based selectors
          () => page.click(`role=button[name="${params}"]`, { timeout: 2000 }),
          () => page.click(`role=link[name="${params}"]`, { timeout: 2000 }),
          // Aria label
          () => page.click(`[aria-label*="${params}" i]`, { timeout: 2000 }),
          // Title attribute
          () => page.click(`[title*="${params}" i]`, { timeout: 2000 }),
          // Data-testid (common in React apps)
          () => page.click(`[data-testid*="${toTestId(params)}"]`, { timeout: 2000 }),
          // Try as raw CSS selector
          () => page.click(params, { timeout: 2000 }),
          // Get first visible button with matching text using locator
          () => page.locator(`button`, { hasText: params }).first().click({ timeout: 2000 }),
        ];
        
        for (const strategy of strategies) {
          try {
            await strategy();
            return { success: true };
          } catch { /* try next */ }
        }
        
        // Debug aid: print a small sample of visible button labels to help diagnose mismatches.
        try {
          const sample = await page.$$eval('button:visible', (buttons) =>
            buttons
              .slice(0, 12)
              .map((b) => {
                const text = (b.innerText || b.textContent || '').trim();
                const aria = b.getAttribute('aria-label') || '';
                const title = b.getAttribute('title') || '';
                const testId = b.getAttribute('data-testid') || '';
                const label = text || aria || title || testId;
                return label.replace(/\s+/g, ' ').trim();
              })
              .filter(Boolean)
          );
          if (sample.length) {
            console.log(`   🔎 Visible button sample: ${sample.join(' | ')}`);
          }
        } catch {
          // ignore
        }

        return { success: false, error: `Could not find clickable element: ${params}` };
      }
      
      case 'TYPE': {
        // First try to find and focus a text input if nothing is focused
        const focused = await page.$(':focus');
        if (!focused || !(await focused.evaluate(el => ['INPUT', 'TEXTAREA'].includes(el.tagName)))) {
          // Try to focus the chat input or first visible textarea/input
          const focusStrategies = [
            () => page.click('textarea:visible', { timeout: 1000 }),
            () => page.click('input[type="text"]:visible', { timeout: 1000 }),
            () => page.click('[placeholder*="message" i]:visible', { timeout: 1000 }),
            () => page.click('[placeholder*="hello" i]:visible', { timeout: 1000 }),
            () => page.click('[placeholder*="type" i]:visible', { timeout: 1000 }),
          ];
          for (const strategy of focusStrategies) {
            try {
              await strategy();
              break;
            } catch { /* try next */ }
          }
        }
        await page.keyboard.type(params, { delay: 50 }); // Add small delay between keystrokes
        return { success: true };
      }
      
      case 'FILL': {
        const separatorIndex = params.indexOf('|');
        if (separatorIndex === -1) {
          const focused = await page.$(':focus');
          if (focused) {
            await focused.fill(params);
            return { success: true };
          }
          return { success: false, error: 'No separator and no focused element' };
        }
        
        const selector = params.substring(0, separatorIndex).trim();
        const text = params.substring(separatorIndex + 1).trim();
        
        const fillStrategies = [
          // By aria-label (most specific for accessibility)
          () => page.fill(`input[aria-label*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[aria-label*="${selector}" i]`, text, { timeout: 2000 }),
          // By placeholder text
          () => page.fill(`[placeholder*="${selector}" i]`, text, { timeout: 2000 }),
          // By input name
          () => page.fill(`input[name*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[name*="${selector}" i]`, text, { timeout: 2000 }),
          // By data-testid
          () => page.fill(`input[data-testid*="${toTestId(selector)}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[data-testid*="${toTestId(selector)}" i]`, text, { timeout: 2000 }),
          // By associated label
          () => page.fill(`label:has-text("${selector}") + input`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") ~ input`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") ~ textarea`, text, { timeout: 2000 }),
          // By id containing text
          () => page.fill(`input[id*="${selector.toLowerCase().replace(/\s+/g, '')}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[id*="${selector.toLowerCase().replace(/\s+/g, '')}" i]`, text, { timeout: 2000 }),
          // Role-based
          () => page.locator(`role=textbox[name="${selector}"]`).fill(text, { timeout: 2000 }),
          // Using getByLabel (Playwright testing library style)
          () => page.getByLabel(selector).fill(text, { timeout: 2000 }),
          // Using getByPlaceholder
          () => page.getByPlaceholder(selector).fill(text, { timeout: 2000 }),
          // Raw selector as fallback
          () => page.fill(selector, text, { timeout: 2000 }),
        ];
        
        for (const strategy of fillStrategies) {
          try {
            await strategy();
            return { success: true };
          } catch { /* try next */ }
        }
        return { success: false, error: `Could not fill field: ${selector}` };
      }
      
      case 'PRESS': {
        // Map common key names to Playwright key names
        const keyMap = {
          'enter': 'Enter',
          'tab': 'Tab',
          'escape': 'Escape',
          'esc': 'Escape',
          'backspace': 'Backspace',
          'delete': 'Delete',
          'arrowup': 'ArrowUp',
          'arrowdown': 'ArrowDown',
          'arrowleft': 'ArrowLeft',
          'arrowright': 'ArrowRight',
          'up': 'ArrowUp',
          'down': 'ArrowDown',
          'left': 'ArrowLeft',
          'right': 'ArrowRight',
          'space': 'Space',
          'home': 'Home',
          'end': 'End',
          'pageup': 'PageUp',
          'pagedown': 'PageDown',
        };
        const key = keyMap[params.toLowerCase()] || params;
        await page.keyboard.press(key);
        return { success: true };
      }
      
      case 'SCROLL': {
        const direction = params.toLowerCase();
        if (direction.includes('down')) {
          await page.evaluate(() => window.scrollBy(0, 400));
        } else {
          await page.evaluate(() => window.scrollBy(0, -400));
        }
        return { success: true };
      }
      
      case 'WAIT': {
        await page.waitForTimeout(2000);
        return { success: true };
      }
      
      case 'NAVIGATE': {
        const currentUrl = new URL(page.url());
        const newPath = params.startsWith('/') ? params : `/${params}`;
        await page.goto(`${currentUrl.origin}${newPath}`, { waitUntil: 'networkidle', timeout: 15000 });
        return { success: true };
      }
      
      case 'DONE': {
        return { success: true, done: true, summary: params };
      }
      
      case 'ABORT': {
        return { success: true, aborted: true, reason: params };
      }
      
      default:
        return { success: false, error: `Unknown action: ${type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function generateAgentName() {
  const adjectives = ['Curious', 'Clever', 'Swift', 'Bright', 'Bold', 'Wise', 'Keen', 'Quick'];
  const nouns = ['Explorer', 'Pioneer', 'Tester', 'Scout', 'Pathfinder', 'Seeker', 'Wanderer'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Date.now().toString(36).slice(-4);
  return `${adj}${noun}-${id}`;
}

/**
 * Generate a test report analyzing the browser avatar's session
 */
async function generateTestReport(apiUrl, testKey, screenshotsDir, history, goal, success, avatarName, walletAddress) {
  // Get final screenshot for context
  const finalScreenshotPath = path.join(screenshotsDir, 'final.jpg');
  let imageData = null;
  try {
    imageData = fs.readFileSync(finalScreenshotPath).toString('base64');
  } catch { /* no final screenshot */ }
  
  const systemPrompt = `You are a QA engineer analyzing the results of an automated browser test.

The test goal was: ${goal}

The avatar took ${history.length} steps. ${success ? 'It completed successfully.' : 'It did NOT complete the task.'}

Based on the action history and final screenshot, write a concise test report covering:

## Summary
A 2-3 sentence overview of what happened.

## Bugs Found
List any bugs, broken UI elements, or unexpected behaviors discovered. If none, say "None detected."

## UX Issues
Note any confusing UI patterns, unclear labels, or poor user experience elements.

## What Worked Well
Highlight positive aspects of the application.

## Recommendations
Specific suggestions to improve the application or fix issues found.

Be specific and actionable. Reference actual UI elements and behaviors observed.`;

  const historyText = history.map((h, i) => `${i + 1}. ${h}`).join('\n');
  
  const payload = {
    message: `Here's the action history from the test session:\n\n${historyText}\n\nPlease analyze and generate the test report.`,
    history: [],
    systemPrompt,
    ...(imageData ? {
      attachments: [{
        type: 'image',
        data: `data:image/jpeg;base64,${imageData}`,
        name: 'final-screenshot.jpg'
      }]
    } : {})
  };
  
  const response = await fetch(apiUrl + '/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
    },
    body: JSON.stringify(payload)
  });
  
  const text = await response.text();
  
  // Check if we got HTML instead of JSON (auth wall / proxy page)
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    console.log('   ⚠️  Report generation blocked (HTML response)');
    return null;
  }
  
  if (!response.ok) {
    return null;
  }
  
  let result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    console.log('   ⚠️  Invalid JSON in report response');
    return null;
  }
  
  return result.response || result.message || null;
}

async function runAutonomousBrowserTest() {
  console.log('🤖 Autonomous Browser Avatar E2E Test');
  console.log('='.repeat(50));
  console.log(`Environment: ${ENV}`);
  console.log();
  
  const adminUrl = getStackOutput('admin-ui-url');
  const rawApiUrl = getStackOutput('admin-api-url');
  const apiUrl = (() => {
    if (!rawApiUrl) return null;
    // If API URL points at the admin UI domain without /api, use /api path.
    if (adminUrl && rawApiUrl === adminUrl) {
      return `${adminUrl}/api`;
    }
    if (adminUrl && rawApiUrl.startsWith(adminUrl) && !rawApiUrl.includes('/api')) {
      return `${adminUrl}/api`;
    }
    return rawApiUrl;
  })();
  const testKey = getInternalTestKey();
  
  if (!adminUrl) {
    console.error('❌ Could not get Admin UI URL from stack outputs');
    process.exit(1);
  }
  
  if (!apiUrl || !testKey) {
    console.error('❌ Could not get API credentials for LLM avatar');
    console.error('   This test requires the chat API to reason about screenshots');
    process.exit(1);
  }
  
  console.log(`📍 Admin UI: ${adminUrl}`);
  console.log(`📍 API: ${apiUrl}`);
  console.log(`📍 Max Steps: ${MAX_STEPS}`);
  console.log();
  
  const runId = Date.now().toString(36);
  const screenshotsDir = path.join(process.cwd(), 'test-screenshots', `run-${runId}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  
  // Get wallet info (even before auth attempt)
  const wallet = getTestWallet();
  const walletAddress = wallet.publicKey;
  
  // Display wallet prominently for CI logs
  console.log('='.repeat(50));
  console.log('🔑 TEST SIGNING WALLET');
  console.log(`   ${walletAddress}`);
  console.log('='.repeat(50));
  console.log();
  
  // Authenticate with wallet before launching browser
  let authSession = null;
  try {
    authSession = await authenticateWithWallet(apiUrl, testKey);
  } catch (err) {
    console.error(`⚠️  Wallet authentication failed: ${err.message}`);
    console.error('   Continuing without authentication (may hit login wall)');
  }
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  // Parse the admin URL to get the domain for cookies
  const adminUrlParsed = new URL(adminUrl);
  
  // Create browser context with auth headers and cookies
  // Use desktop viewport so sidebar is always visible (no hamburger menu needed)
  const contextOptions = {
    viewport: { width: 1280, height: 800 }, // Desktop size - sidebar visible at lg breakpoint
    deviceScaleFactor: 1, // No retina scaling needed for LLM
    isMobile: false,
    hasTouch: false,
  };
  
  const context = await browser.newContext(contextOptions);
  
  // Inject session cookie if we have one
  if (authSession?.sessionCookie) {
    // Parse the Set-Cookie header to extract cookie details
    const cookieMatch = authSession.sessionCookie.match(/^([^=]+)=([^;]*)/);
    if (cookieMatch) {
      const [, name, value] = cookieMatch;
      
      // Extract parent domain for cookie sharing between admin and api subdomains
      // e.g., 'admin-staging.rati.chat' -> '.rati.chat'
      const hostParts = adminUrlParsed.hostname.split('.');
      const parentDomain = hostParts.length >= 2 
        ? '.' + hostParts.slice(-2).join('.') 
        : adminUrlParsed.hostname;
      
      // Add cookie for parent domain (covers both admin and api subdomains)
      await context.addCookies([{
        name,
        value,
        domain: parentDomain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax', // Match server-side cookie settings
      }]);
      console.log(`🍪 Session cookie injected for ${parentDomain} (covers all subdomains)`);
    }
  }
  
  const page = await context.newPage();
  
  // Intercept API requests to add internal test key header
  // This allows the browser to make authenticated API calls without relying on UI auth flows.
  const apiUrlParsed = new URL(apiUrl);
  await page.route(`${apiUrl}/**`, async (route, request) => {
    const headers = {
      ...request.headers(),
      'x-internal-test-key': testKey,
    };
    await route.continue({ headers });
  });
  console.log(`🔑 Request interceptor added for API calls to ${apiUrlParsed.hostname}`);
  
  const avatarName = generateAgentName();
  const goal = `Create a new AI avatar and fully configure it.
After creating the avatar, explore its capabilities - try giving it a name, personality, or profile picture.
Verify the avatar responds to messages and any configuration changes are reflected in the UI.`;

  console.log(`🎯 Goal: Create and configure avatar "${avatarName}"`);
  console.log();
  
  const history = [];
  let step = 0;
  let success = false;
  let finalSummary = '';
  
  // Early failure detection counters
  let consecutiveEmptyPageSteps = 0;
  let consecutiveWaitActions = 0;
  let consecutiveFailedActions = 0;
  let lastAction = null;
  let sameActionCount = 0;
  
  try {
    console.log('📸 Loading application...');
    
    // Use 'domcontentloaded' instead of 'networkidle' - the latter can timeout
    // if there are persistent connections (websockets, SSE) or slow resources
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give the app time to hydrate and render
    await page.waitForTimeout(3000);
    
    // Take initial raw screenshot for change detection
    await clearVisionOverlay(page);
    let previousScreenshot = await takeScreenshotBase64(page);
    
    while (step < MAX_STEPS && !success) {
      step++;
      console.log(`\n--- Step ${step}/${MAX_STEPS} ---`);

      // Add numbered overlay and extract available elements
      const pageElements = await getPageElements(page);
      const annotatedScreenshot = await takeScreenshotBase64(page);

      // Save annotated screenshot to file for debugging and for the LLM
      const screenshotPath = path.join(screenshotsDir, `step-${step.toString().padStart(2, '0')}.jpg`);
      await fsPromises.writeFile(screenshotPath, Buffer.from(annotatedScreenshot, 'base64'));

      const totalElements = pageElements.buttons.length + pageElements.links.length + pageElements.inputs.length;
      console.log(`📋 Found: ${pageElements.buttons.length} buttons, ${pageElements.links.length} links, ${pageElements.inputs.length} inputs`);
      
      // Early failure: detect empty page state
      if (totalElements === 0) {
        consecutiveEmptyPageSteps++;
        console.log(`   ⚠️  Empty page detected (${consecutiveEmptyPageSteps}/${MAX_EMPTY_PAGE_STEPS} consecutive)`);
        
        if (consecutiveEmptyPageSteps >= MAX_EMPTY_PAGE_STEPS) {
          const abortReason = `Page appears blank or not loaded after ${consecutiveEmptyPageSteps} consecutive steps with no interactive elements. This may indicate: authentication blocking the page, a JavaScript error preventing rendering, or the app failing to load.`;
          console.log(`\n🛑 Early abort: ${abortReason}`);
          history.push(`[AUTO-ABORT: ${abortReason}]`);
          finalSummary = `ABORTED: ${abortReason}`;
          
          // Report to auto-issues
          await reportError(apiUrl, testKey, {
            error: `Browser test auto-aborted: empty page`,
            subsystem: 'browser-test',
            context: {
              environment: ENV,
              step,
              adminUrl,
              consecutiveEmptyPageSteps,
              history: history.slice(-5),
            },
          }).catch(err => console.warn(`   ⚠️ Failed to report: ${err.message}`));
          
          break;
        }
      } else {
        consecutiveEmptyPageSteps = 0; // Reset counter when we find elements
      }
      
      console.log('🧠 Avatar reasoning...');
      const response = await getNextAction(apiUrl, testKey, screenshotPath, history, goal, pageElements);
      const action = parseAction(response);
      
      console.log(`📝 Observation: ${(action.observation || '').substring(0, 120)}...`);
      console.log(`💭 Reasoning: ${(action.reasoning || '').substring(0, 120)}...`);
      console.log(`⚡ Action: ${action.type}: ${action.params}`);
      
      // Early failure: detect repeated actions (avatar stuck in loop)
      const actionKey = `${action.type}:${action.params}`;
      if (lastAction === actionKey) {
        sameActionCount++;
        console.log(`   ⚠️  Same action repeated (${sameActionCount}/${MAX_REPEATED_ACTIONS})`);
        
        if (sameActionCount >= MAX_REPEATED_ACTIONS) {
          const abortReason = `Avatar stuck: repeated "${action.type}: ${action.params}" ${sameActionCount} times. The action may not be working or the page is unresponsive.`;
          console.log(`\n🛑 Early abort: ${abortReason}`);
          history.push(`[AUTO-ABORT: ${abortReason}]`);
          finalSummary = `ABORTED: ${abortReason}`;
          
          await reportError(apiUrl, testKey, {
            error: `Browser test auto-aborted: avatar stuck in loop`,
            subsystem: 'browser-test',
            context: {
              environment: ENV,
              step,
              adminUrl,
              repeatedAction: actionKey,
              sameActionCount,
              history: history.slice(-5),
            },
          }).catch(err => console.warn(`   ⚠️ Failed to report: ${err.message}`));
          
          break;
        }
      } else {
        sameActionCount = 1;
        lastAction = actionKey;
      }
      
      // Early failure: detect consecutive unparseable/WAIT actions
      if (action.type === 'WAIT' && action.params === 'Could not parse action') {
        consecutiveWaitActions++;
        console.log(`   ⚠️  Unparseable response (${consecutiveWaitActions}/${MAX_WAIT_ACTIONS} consecutive)`);
        
        if (consecutiveWaitActions >= MAX_WAIT_ACTIONS) {
          const abortReason = `LLM returned ${consecutiveWaitActions} consecutive unparseable responses. The page may be stuck, blank, or the LLM cannot determine a valid action.`;
          console.log(`\n🛑 Early abort: ${abortReason}`);
          history.push(`[AUTO-ABORT: ${abortReason}]`);
          finalSummary = `ABORTED: ${abortReason}`;
          
          await reportError(apiUrl, testKey, {
            error: `Browser test auto-aborted: consecutive unparseable LLM responses`,
            subsystem: 'browser-test',
            context: {
              environment: ENV,
              step,
              adminUrl,
              consecutiveWaitActions,
              history: history.slice(-5),
            },
          }).catch(err => console.warn(`   ⚠️ Failed to report: ${err.message}`));
          
          break;
        }
      } else {
        consecutiveWaitActions = 0; // Reset counter on valid action
      }
      
      const result = await executeAction(page, action);
      
      if (result.error) {
        console.log(`⚠️  Action failed: ${result.error}`);
        history.push(`${action.type}: ${action.params} -> FAILED: ${result.error}`);
        
        // Track consecutive failures
        consecutiveFailedActions++;
        console.log(`   ⚠️  Consecutive failures: ${consecutiveFailedActions}/${MAX_CONSECUTIVE_FAILURES}`);
        
        if (consecutiveFailedActions >= MAX_CONSECUTIVE_FAILURES) {
          const abortReason = `${consecutiveFailedActions} consecutive action failures. The UI may have changed or elements are not clickable.`;
          console.log(`\n🛑 Early abort: ${abortReason}`);
          history.push(`[AUTO-ABORT: ${abortReason}]`);
          finalSummary = `ABORTED: ${abortReason}`;
          
          await reportError(apiUrl, testKey, {
            error: `Browser test auto-aborted: consecutive action failures`,
            subsystem: 'browser-test',
            context: {
              environment: ENV,
              step,
              adminUrl,
              consecutiveFailedActions,
              history: history.slice(-5),
            },
          }).catch(err => console.warn(`   ⚠️ Failed to report: ${err.message}`));
          
          break;
        }
      } else if (result.aborted) {
        console.log(`🛑 Avatar aborted test: ${result.reason}`);
        history.push(`ABORT: ${result.reason}`);
        finalSummary = `ABORTED: ${result.reason}`;

        // Report abort to auto-issues system
        await reportError(apiUrl, testKey, {
          error: `Browser test aborted: ${result.reason}`,
          subsystem: 'browser-test',
          context: {
            environment: ENV,
            step,
            adminUrl,
            goal,
            history: history.slice(-5), // Last 5 actions for context
          },
        }).catch(err => console.warn(`   ⚠️ Failed to report issue: ${err.message}`));

        break; // Exit the while loop
      } else if (result.done) {
        console.log(`✅ Avatar completed: ${result.summary}`);
        success = true;
        finalSummary = result.summary;
        history.push(`DONE: ${result.summary}`);
        break; // Exit early on completion
      } else {
        console.log('✅ Action executed');
        history.push(`${action.type}: ${action.params} -> OK`);
        consecutiveFailedActions = 0; // Reset on success
      }
      
      // Wait for page to change with exponential backoff before next LLM call
      await clearVisionOverlay(page);
      const { screenshot: newScreenshot, changed } = await waitForPageChange(
        page, 
        previousScreenshot,
        action.type
      );
      
      if (!changed && step < MAX_STEPS) {
        // Page didn't change - add context for the LLM
        history.push(`[Note: Page did not visually change after action]`);
      }
      
      previousScreenshot = newScreenshot;
    }
    
    const finalScreenshotPath = path.join(screenshotsDir, 'final.jpg');
    await page.screenshot({ path: finalScreenshotPath, fullPage: true, type: 'jpeg', quality: 60 });
    console.log(`\n📸 Final screenshot: ${finalScreenshotPath}`);
    
  } catch (err) {
    console.error(`\n❌ Test error: ${err.message}`);
    const errorScreenshot = path.join(screenshotsDir, 'error.jpg');
    await page.screenshot({ path: errorScreenshot, fullPage: true, type: 'jpeg', quality: 60 }).catch(() => {});

    // Report test error to auto-issues system
    await reportError(apiUrl, testKey, {
      error: `Browser test error: ${err.message}`,
      stack: err.stack,
      subsystem: 'browser-test',
      context: {
        environment: ENV,
        step,
        adminUrl,
        goal,
        history: history.slice(-5),
      },
    }).catch(reportErr => console.warn(`   ⚠️ Failed to report issue: ${reportErr.message}`));
  } finally {
    await browser.close();
  }
  
  // Determine test result status
  const wasAborted = finalSummary.startsWith('ABORTED:');
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Summary:');
  console.log(`   Steps taken: ${step}`);
  console.log(`   Screenshots: ${screenshotsDir}`);
  
  if (success) {
    console.log(`   Result: ✅ SUCCESS`);
    console.log(`   Summary: ${finalSummary}`);
  } else if (wasAborted) {
    console.log(`   Result: 🛑 ABORTED`);
    console.log(`   Reason: ${finalSummary.replace('ABORTED: ', '')}`);
  } else if (step >= MAX_STEPS) {
    console.log(`   Result: ⚠️  MAX STEPS REACHED`);
    console.log('   The avatar did not complete the task within the step limit.');

    // Report max steps as a warning (might indicate UX issues)
    await reportWarning(apiUrl, testKey, {
      error: `Browser test reached max steps: Test did not complete goal within ${MAX_STEPS} steps. This may indicate UX issues or unclear navigation.`,
      subsystem: 'browser-test',
      context: {
        environment: ENV,
        maxSteps: MAX_STEPS,
        goal,
        history: history.slice(-10), // Last 10 actions
      },
    }).catch(err => console.warn(`   ⚠️ Failed to report issue: ${err.message}`));
  } else {
    console.log(`   Result: ❌ FAILED`);
  }
  
  // Generate AI-powered test report
  console.log('\n📝 Generating test report...');
  const report = await generateTestReport(apiUrl, testKey, screenshotsDir, history, goal, success, avatarName, walletAddress);
  
  // Determine result string for report
  const resultString = success ? 'SUCCESS' : wasAborted ? 'ABORTED' : step >= MAX_STEPS ? 'MAX STEPS' : 'FAILED';
  
  if (report) {
    console.log('\n' + '='.repeat(50));
    console.log('📋 TEST REPORT');
    console.log('='.repeat(50));
    console.log(report);
    console.log('='.repeat(50));
    
    // Save report to file
    const reportFile = path.join(screenshotsDir, 'report.md');
    fs.writeFileSync(reportFile, `# Browser Test Report\n\n**Date:** ${new Date().toISOString()}\n**Signing Wallet:** \`${walletAddress}\`\n**Goal:** ${goal}\n**Avatar Name:** ${avatarName}\n**Steps:** ${step}\n**Result:** ${resultString}\n\n---\n\n${report}`);
    console.log(`\n📄 Report saved to: ${reportFile}`);
  } else {
    console.log('⚠️  Could not generate report');
    
    // Fallback: print action history
    console.log('\n📜 Action History:');
    history.forEach((h, i) => console.log(`   ${i + 1}. ${h}`));
  }
  
  const historyFile = path.join(screenshotsDir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify({
    walletAddress,
    goal,
    avatarName,
    steps: step,
    success,
    aborted: wasAborted,
    summary: finalSummary,
    history
  }, null, 2));
  
  // Exit codes:
  // - 0: Success or max steps reached (explored the app)
  // - 1: Failed, aborted (blocked by auth/crash), or error
  if (!success) {
    process.exit(1);
  }
}

runAutonomousBrowserTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
