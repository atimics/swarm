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
 * - Cloudflare Access: Uses service token headers (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET)
 * - Wallet Auth: Uses a test wallet keypair to sign challenges programmatically
 * 
 * Usage: node scripts/test-browser.mjs [env]
 * 
 * Environment Variables:
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token client ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token client secret
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
        ...getCloudflareAccessHeaders(),
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
// Cloudflare Access Authentication
// ============================================================================

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

function getCloudflareAccessHeaders() {
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
    return {};
  }
  return {
    'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
  };
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
      ...getCloudflareAccessHeaders(),
    },
    body: JSON.stringify({ walletAddress: wallet.publicKey }),
  });
  
  const challengeText = await challengeResponse.text();
  
  // Check for HTML (CF Access login page)
  if (challengeText.startsWith('<!DOCTYPE') || challengeText.startsWith('<html')) {
    throw new Error(`CF Access blocked auth request - got login page. Status: ${challengeResponse.status}`);
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
      ...getCloudflareAccessHeaders(),
    },
    body: JSON.stringify({
      signature,
      publicKey: wallet.publicKey,
      nonce,
    }),
  });
  
  const verifyText = await verifyResponse.text();
  
  // Check for HTML
  if (verifyText.startsWith('<!DOCTYPE') || verifyText.startsWith('<html')) {
    throw new Error(`CF Access blocked verify request - got login page. Status: ${verifyResponse.status}`);
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
  try {
    // Extract button info, preferring aria-label over text content to avoid badge text pollution
    const buttonElements = await page.locator('button:visible').evaluateAll(els =>
      els.map(e => {
        // Prefer aria-label for accessibility and cleaner text
        const ariaLabel = e.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        
        // Get text of direct children only, excluding nested badges/spans with slot counts
        const directText = Array.from(e.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE || 
                       (n.nodeType === Node.ELEMENT_NODE && 
                        n.classList && 
                        (n.classList.contains('font-medium') || n.tagName === 'SPAN' && !n.classList.contains('ml-auto'))))
          .map(n => n.textContent?.trim())
          .filter(t => t && t.length > 0 && !t.includes('slot') && !t.match(/^\d+/))
          .join(' ')
          .trim();
        
        if (directText) return directText;
        
        // Fallback to full text content but clean up common badge patterns
        const fullText = (e.textContent || '').trim();
        return fullText
          .replace(/\d+\s*(free\s*)?slot(s)?/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
      }).filter(Boolean)
    );
    
    const links = await page.locator('a:visible').allTextContents();
    
    // Extract input field info including aria-label, placeholder, name, and id
    const inputs = await page.locator('input:visible, textarea:visible').evaluateAll(els => 
      els.map(e => {
        const ariaLabel = e.getAttribute('aria-label');
        const placeholder = e.getAttribute('placeholder');
        const name = e.getAttribute('name');
        const id = e.id;
        const dataTestId = e.getAttribute('data-testid');
        
        // Prefer aria-label, then placeholder, then name, then id, then data-testid
        return ariaLabel || placeholder || name || id || dataTestId || e.type || '[unnamed]';
      }).filter(Boolean)
    );
    
    // Clean up - remove empty strings and duplicates
    const cleanButtons = [...new Set(buttonElements.map(b => b.trim()).filter(b => b && b.length < 50 && b.length > 0))];
    const cleanLinks = [...new Set(links.map(l => l.trim()).filter(l => l && l.length < 50))];
    const cleanInputs = [...new Set(inputs.filter(i => i && i.length < 50))];
    
    return { buttons: cleanButtons, links: cleanLinks, inputs: cleanInputs };
  } catch {
    return { buttons: [], links: [], inputs: [] };
  }
}

async function getNextAction(apiUrl, testKey, screenshotPath, history, goal, pageElements) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  
  // Format available elements for the prompt
  const elementsSection = `
AVAILABLE CLICKABLE ELEMENTS ON THIS PAGE:
Buttons: ${pageElements.buttons.length > 0 ? pageElements.buttons.map(b => `"${b}"`).join(', ') : '(none visible)'}
Links: ${pageElements.links.length > 0 ? pageElements.links.map(l => `"${l}"`).join(', ') : '(none visible)'}
Input fields: ${pageElements.inputs.length > 0 ? pageElements.inputs.map(i => `"${i}"`).join(', ') : '(none visible)'}
`;

  const systemPrompt = `You are an autonomous browser avatar exploring a web application.

YOUR GOAL: ${goal}

You can see a screenshot of the current page state. Based on what you observe, decide on ONE action to take.
${elementsSection}
AVAILABLE ACTIONS:
- CLICK: text - Click a button/link using EXACT text from the lists above
- TYPE: text - Type text into the currently focused input field  
- FILL: placeholder | text - Fill an input field (e.g., "Enter avatar name | MyAgent")
- PRESS: key - Press a keyboard key (Enter, Tab, Escape)
- SCROLL: down/up - Scroll the page
- NAVIGATE: /path - Navigate to a URL path (e.g., "/avatars/new")
- DONE: summary - Task complete, provide summary
- ABORT: reason - End test early due to blocking issue (auth wall, crash, wrong app, etc.)

WHEN TO USE ABORT:
- You see a login/authentication page that blocks access (e.g., Cloudflare Access, SSO login)
- The application shows an error page or has crashed
- The page is clearly not the expected admin UI application
- You're stuck in an unrecoverable state after multiple failed attempts

CRITICAL RULES:
1. For CLICK: Copy the EXACT text from the "Buttons" or "Links" list above
2. For FILL: Use a value from the "Input fields" list as the first part
3. If no suitable button exists, try NAVIGATE to /avatars/new or /avatars
4. Don't invent button names - use only what's in the lists above

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
      ...getCloudflareAccessHeaders(),
    },
    body: JSON.stringify(payload)
  });
  
  const text = await response.text();
  
  // Check if we got HTML (CF Access login page) instead of JSON
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error(`CF Access blocked request - got login page instead of API response. Status: ${response.status}`);
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
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('OBSERVATION:')) {
      observation = trimmed.replace('OBSERVATION:', '').trim();
    } else if (trimmed.startsWith('REASONING:')) {
      reasoning = trimmed.replace('REASONING:', '').trim();
    } else if (trimmed.startsWith('ACTION:')) {
      action = trimmed.replace('ACTION:', '').trim();
    }
  }
  
  if (action) {
    const match = action.match(/^(\w+):\s*(.*)$/);
    if (match) {
      return {
        observation,
        reasoning,
        type: match[1].toUpperCase(),
        params: match[2].trim(),
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

async function executeAction(page, action) {
  const { type, params } = action;
  
  try {
    switch (type) {
      case 'CLICK': {
        const strategies = [
          // Exact text match
          () => page.click(`text="${params}"`, { timeout: 2000 }),
          // Partial/fuzzy text match  
          () => page.click(`text=${params}`, { timeout: 2000 }),
          // Button with text
          () => page.click(`button:has-text("${params}")`, { timeout: 2000 }),
          // Link with text
          () => page.click(`a:has-text("${params}")`, { timeout: 2000 }),
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
      ...getCloudflareAccessHeaders()
    },
    body: JSON.stringify(payload)
  });
  
  const text = await response.text();
  
  // Check if we got HTML instead of JSON
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    console.log('   ⚠️  Report generation blocked by CF Access');
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
  const apiUrl = getStackOutput('admin-api-url');
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
  
  // Check for Cloudflare Access credentials
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
    console.warn('⚠️  No Cloudflare Access credentials found');
    console.warn('   Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET env vars');
    console.warn('   Create a service token at: Cloudflare Zero Trust > Access > Service Auth');
  } else {
    console.log('🔒 Cloudflare Access: Service token configured');
  }
  
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
    extraHTTPHeaders: getCloudflareAccessHeaders(),
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
  
  // Set Cloudflare Access headers for all page requests
  const cfHeaders = getCloudflareAccessHeaders();
  if (Object.keys(cfHeaders).length > 0) {
    await page.setExtraHTTPHeaders(cfHeaders);
    console.log('🔐 Cloudflare Access headers set for browser requests');
    console.log(`   Client ID: ${CF_ACCESS_CLIENT_ID?.slice(0, 8)}...${CF_ACCESS_CLIENT_ID?.slice(-4)}`);
  } else {
    console.warn('⚠️  No Cloudflare Access credentials - browser may hit auth wall');
    console.warn('   Ensure CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are set');
  }
  
  // Intercept API requests to add internal test key header
  // This allows the browser to make authenticated API calls even without CF Access JWT
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
  const goal = `Create a new AI avatar by clicking the create/add button (usually a + icon or "Create" button).
After the avatar is created, send it a test message like "Hello" to verify it responds.
The avatar name "${avatarName}" may be auto-generated - you don't need to fill in forms manually.
Focus on: 1) Find and click the create button, 2) Verify the avatar appears, 3) Send a message.`;

  console.log(`🎯 Goal: Create avatar "${avatarName}" and test conversation`);
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
    
    // Debug: First make a fetch request to see what Cloudflare returns
    if (Object.keys(cfHeaders).length > 0) {
      console.log('🔍 Testing Cloudflare Access with service token...');
      try {
        const testResponse = await fetch(adminUrl, {
          headers: cfHeaders,
          redirect: 'manual', // Don't follow redirects
        });
        console.log(`   Response status: ${testResponse.status}`);
        console.log(`   Location: ${testResponse.headers.get('location') || '(none)'}`);
        const cfCookie = testResponse.headers.get('set-cookie');
        if (cfCookie && cfCookie.includes('CF_Authorization')) {
          console.log('   ✅ CF_Authorization cookie received');
          // Extract and add the cookie to the browser context
          const cfAuthMatch = cfCookie.match(/CF_Authorization=([^;]+)/);
          if (cfAuthMatch) {
            // Add cookie for admin UI domain
            await context.addCookies([{
              name: 'CF_Authorization',
              value: cfAuthMatch[1],
              domain: adminUrlParsed.hostname,
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'None',
            }]);
            console.log('   🍪 CF_Authorization cookie added for admin UI');
            
            // Also add cookie for API domain (different subdomain)
            const apiUrlParsed = new URL(apiUrl);
            await context.addCookies([{
              name: 'CF_Authorization',
              value: cfAuthMatch[1],
              domain: apiUrlParsed.hostname,
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'None',
            }]);
            console.log('   🍪 CF_Authorization cookie added for API');
          }
        } else {
          console.log(`   ⚠️  No CF_Authorization cookie - service token may not be valid for this app`);
          console.log(`   Cookies received: ${cfCookie || '(none)'}`);
        }
      } catch (fetchErr) {
        console.log(`   Fetch test failed: ${fetchErr.message}`);
      }
    }
    
    // Use 'domcontentloaded' instead of 'networkidle' - the latter can timeout
    // if there are persistent connections (websockets, SSE) or slow resources
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give the app time to hydrate and render
    await page.waitForTimeout(3000);
    
    // Take initial screenshot for comparison
    let previousScreenshot = await takeScreenshotBase64(page);
    
    while (step < MAX_STEPS && !success) {
      step++;
      console.log(`\n--- Step ${step}/${MAX_STEPS} ---`);
      
      // Save screenshot to file for debugging
      const screenshotPath = path.join(screenshotsDir, `step-${step.toString().padStart(2, '0')}.jpg`);
      await fsPromises.writeFile(screenshotPath, Buffer.from(previousScreenshot, 'base64'));
      
      // Extract available elements from the page
      const pageElements = await getPageElements(page);
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
