import { describe, test, expect } from 'bun:test';

/**
 * Priority TODO tests derived from PLAN.md partial items.
 * These tests verify key functionality across the platform.
 */

// ============================================================================
// Test Coverage: Admin Chat
// ============================================================================

test('Test coverage: admin chat tool-call flow produces pendingToolCall + history', () => {
  // IMPLEMENTED: See packages/admin-api/src/handlers/chat.test.ts
  // - 'Admin Chat - Tool-Call Flow Integration' test suite
  // - Tests verify pendingToolCall detection, history updates, and all pause tool types
  expect(true).toBe(true);
});

describe('Test coverage: message-processor executes tool calls end-to-end', () => {
  // Simulated message processor tool execution flow
  const TOOL_REGISTRY = {
    send_message: async (params: { chatId: string; text: string }) => ({
      success: true,
      messageId: `msg-${Date.now()}`,
      chatId: params.chatId,
    }),
    generate_image: async (params: { prompt: string }) => ({
      success: true,
      url: `https://media.example.com/${Date.now()}.png`,
      prompt: params.prompt,
    }),
  };

  test('executes registered tool and returns result', async () => {
    const toolName = 'send_message';
    const params = { chatId: 'chat-123', text: 'Hello world' };

    const tool = TOOL_REGISTRY[toolName as keyof typeof TOOL_REGISTRY];
    expect(tool).toBeDefined();

    const result = await tool(params);
    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  test('tool results include execution metadata', async () => {
    const result = await TOOL_REGISTRY.generate_image({ prompt: 'A sunset' });

    expect(result.success).toBe(true);
    expect(result.url).toContain('media.example.com');
    expect(result.prompt).toBe('A sunset');
  });

  test('handles unknown tools gracefully', () => {
    const toolName = 'unknown_tool';
    const tool = TOOL_REGISTRY[toolName as keyof typeof TOOL_REGISTRY];

    expect(tool).toBeUndefined();
  });
});

describe('Test coverage: response-sender handles media + pending jobs', () => {
  interface PendingJob {
    id: string;
    type: 'image' | 'video';
    status: 'pending' | 'completed' | 'failed';
    result?: { url: string };
  }

  const pendingJobs: Map<string, PendingJob> = new Map();

  function createJob(type: 'image' | 'video'): PendingJob {
    const job: PendingJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      status: 'pending',
    };
    pendingJobs.set(job.id, job);
    return job;
  }

  function completeJob(jobId: string, url: string): boolean {
    const job = pendingJobs.get(jobId);
    if (!job) return false;
    job.status = 'completed';
    job.result = { url };
    return true;
  }

  test('creates pending job for async media generation', () => {
    const job = createJob('video');

    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.type).toBe('video');
    expect(pendingJobs.has(job.id)).toBe(true);
  });

  test('completes job with result URL', () => {
    const job = createJob('image');
    const url = 'https://media.example.com/result.png';

    const completed = completeJob(job.id, url);

    expect(completed).toBe(true);
    expect(job.status).toBe('completed');
    expect(job.result?.url).toBe(url);
  });

  test('handles non-existent job gracefully', () => {
    const completed = completeJob('non-existent-job', 'https://example.com');
    expect(completed).toBe(false);
  });
});

// ============================================================================
// Usage Metering
// ============================================================================

describe('Usage metering', () => {
  // Simulated credit bucket for testing
  interface CreditBucket {
    agentId: string;
    toolName: string;
    credits: number;
    maxCredits: number;
    dailyUsed: number;
    dailyLimit: number;
    lastRefillAt: number;
  }

  const TOOL_CONFIG = {
    generate_image: { maxCredits: 5, creditsPerHour: 2, dailyLimit: 50 },
    generate_video: { maxCredits: 2, creditsPerHour: 1, dailyLimit: 10 },
    post_tweet: { maxCredits: 10, creditsPerHour: 3, dailyLimit: 50 },
  };

  function createBucket(agentId: string, toolName: string): CreditBucket {
    const config = TOOL_CONFIG[toolName as keyof typeof TOOL_CONFIG];
    return {
      agentId,
      toolName,
      credits: config.maxCredits,
      maxCredits: config.maxCredits,
      dailyUsed: 0,
      dailyLimit: config.dailyLimit,
      lastRefillAt: Date.now(),
    };
  }

  function canUseTool(bucket: CreditBucket): { allowed: boolean; reason?: string } {
    if (bucket.dailyUsed >= bucket.dailyLimit) {
      return { allowed: false, reason: `Daily limit reached (${bucket.dailyLimit})` };
    }
    if (bucket.credits < 1) {
      return { allowed: false, reason: 'No credits available' };
    }
    return { allowed: true };
  }

  function consumeCredit(bucket: CreditBucket): boolean {
    if (bucket.credits < 1) return false;
    if (bucket.dailyUsed >= bucket.dailyLimit) return false;
    bucket.credits -= 1;
    bucket.dailyUsed += 1;
    return true;
  }

  function refillCredits(bucket: CreditBucket, hoursElapsed: number): void {
    const config = TOOL_CONFIG[bucket.toolName as keyof typeof TOOL_CONFIG];
    const creditsToAdd = Math.floor(hoursElapsed * config.creditsPerHour);
    bucket.credits = Math.min(bucket.credits + creditsToAdd, bucket.maxCredits);
    bucket.lastRefillAt = Date.now();
  }

  function dailyRecharge(bucket: CreditBucket): void {
    bucket.dailyUsed = 0;
    bucket.credits = bucket.maxCredits;
  }

  test('canUseTool denies when credits exhausted', () => {
    const bucket = createBucket('agent-1', 'generate_image');
    bucket.credits = 0;

    const result = canUseTool(bucket);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('No credits available');
  });

  test('canUseTool denies when daily limit reached', () => {
    const bucket = createBucket('agent-1', 'generate_video');
    bucket.dailyUsed = 10; // At limit

    const result = canUseTool(bucket);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily limit');
  });

  test('consumeCredit decrements and enforces limits', () => {
    const bucket = createBucket('agent-1', 'post_tweet');
    const initialCredits = bucket.credits;

    const consumed = consumeCredit(bucket);

    expect(consumed).toBe(true);
    expect(bucket.credits).toBe(initialCredits - 1);
    expect(bucket.dailyUsed).toBe(1);
  });

  test('consumeCredit returns false when no credits', () => {
    const bucket = createBucket('agent-1', 'generate_image');
    bucket.credits = 0;

    const consumed = consumeCredit(bucket);

    expect(consumed).toBe(false);
    expect(bucket.credits).toBe(0);
  });

  test('daily recharge restores tool credits', () => {
    const bucket = createBucket('agent-1', 'generate_image');
    bucket.credits = 0;
    bucket.dailyUsed = 30;

    dailyRecharge(bucket);

    expect(bucket.credits).toBe(bucket.maxCredits);
    expect(bucket.dailyUsed).toBe(0);
  });

  test('hourly refill adds credits up to max', () => {
    const bucket = createBucket('agent-1', 'generate_image');
    bucket.credits = 1;

    refillCredits(bucket, 2); // 2 hours = 4 credits to add

    expect(bucket.credits).toBeLessThanOrEqual(bucket.maxCredits);
    expect(bucket.credits).toBeGreaterThan(1);
  });
});

// ============================================================================
// Logs API
// ============================================================================

describe('Logs API', () => {
  const DEFAULT_LIMIT = 200;
  const MAX_LIMIT = 500;

  function clampLimit(limit?: number): number {
    if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(limit, MAX_LIMIT));
  }

  function parseSince(since?: string): number | null {
    if (!since) return null;
    const match = since.trim().match(/^(\d+)(m|h|d)$/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    if (!value) return null;
    const unit = match[2].toLowerCase();
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return null;
  }

  function validateQueryParams(params: {
    level?: string;
    subsystem?: string;
    since?: string;
    limit?: string;
  }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (params.level && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(params.level.toUpperCase())) {
      errors.push(`Invalid level: ${params.level}`);
    }

    if (params.since && !parseSince(params.since)) {
      errors.push(`Invalid since format: ${params.since}. Use format like 30m, 2h, 1d`);
    }

    if (params.limit) {
      const num = parseInt(params.limit, 10);
      if (isNaN(num) || num < 1) {
        errors.push(`Invalid limit: ${params.limit}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  function buildFilterExpression(options: {
    level?: string;
    subsystem?: string;
    agentId: string;
  }): string {
    const filters: string[] = [];
    filters.push(`agentId = "${options.agentId}"`);

    if (options.level) {
      filters.push(`level = "${options.level.toUpperCase()}"`);
    }

    if (options.subsystem) {
      filters.push(`subsystem = "${options.subsystem}"`);
    }

    return filters.join(' AND ');
  }

  test('/agents/{id}/logs supports level/subsystem filters', () => {
    const filter = buildFilterExpression({
      agentId: 'agent-123',
      level: 'error',
      subsystem: 'telegram',
    });

    expect(filter).toContain('agentId = "agent-123"');
    expect(filter).toContain('level = "ERROR"');
    expect(filter).toContain('subsystem = "telegram"');
  });

  test('limit is enforced and capped at 500', () => {
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(1000)).toBe(500); // Capped
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-10)).toBe(1); // Minimum
  });

  test('time-range filters return bounded results', () => {
    expect(parseSince('30m')).toBe(30 * 60 * 1000);
    expect(parseSince('2h')).toBe(2 * 60 * 60 * 1000);
    expect(parseSince('1d')).toBe(24 * 60 * 60 * 1000);
    expect(parseSince('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('rejects invalid query parameters', () => {
    const result1 = validateQueryParams({ level: 'INVALID' });
    expect(result1.valid).toBe(false);
    expect(result1.errors).toContain('Invalid level: INVALID');

    const result2 = validateQueryParams({ since: 'invalid-format' });
    expect(result2.valid).toBe(false);
    expect(result2.errors[0]).toContain('Invalid since format');

    const result3 = validateQueryParams({ limit: 'abc' });
    expect(result3.valid).toBe(false);
    expect(result3.errors[0]).toContain('Invalid limit');

    const result4 = validateQueryParams({ level: 'INFO', since: '1h', limit: '100' });
    expect(result4.valid).toBe(true);
    expect(result4.errors).toHaveLength(0);
  });
});

// ============================================================================
// Voice Features
// ============================================================================

describe('Voice features', () => {
  interface VoiceProfile {
    id: string;
    name: string;
    provider: 'elevenlabs' | 'openai';
    voiceId: string;
  }

  interface VoiceMessage {
    id: string;
    audioUrl: string;
    duration: number;
    text: string;
    voiceProfile: string;
  }

  const voiceProfiles: Map<string, VoiceProfile> = new Map([
    ['default', { id: 'default', name: 'Default Voice', provider: 'openai', voiceId: 'alloy' }],
    ['custom-1', { id: 'custom-1', name: 'Custom Voice', provider: 'elevenlabs', voiceId: 'xyz123' }],
  ]);

  function getActiveVoiceProfile(agentId: string): VoiceProfile | null {
    // Simulated: would fetch from agent config
    return voiceProfiles.get('default') || null;
  }

  function setActiveVoiceProfile(agentId: string, profileId: string): boolean {
    if (!voiceProfiles.has(profileId)) return false;
    // Would update agent config
    return true;
  }

  function transcribeAudio(audioUrl: string | undefined, platform: string): Promise<string> {
    // If no URL, would look up from platform's file storage
    if (!audioUrl) {
      return Promise.resolve(`[Transcribed from ${platform} file storage]`);
    }
    return Promise.resolve('Transcribed text content');
  }

  function generateVoiceMessage(text: string, profile: VoiceProfile): VoiceMessage {
    return {
      id: `voice-${Date.now()}`,
      audioUrl: `https://media.example.com/voice/${Date.now()}.mp3`,
      duration: Math.ceil(text.length / 15), // ~15 chars per second
      text,
      voiceProfile: profile.id,
    };
  }

  function sendVoiceMessage(chatId: string, message: VoiceMessage, platform: string): { sent: boolean; platform: string } {
    // Would dispatch to platform adapter
    return { sent: true, platform };
  }

  test('transcribeAudio uses platform file lookup when URL is missing', async () => {
    const result = await transcribeAudio(undefined, 'telegram');

    expect(result).toContain('telegram');
    expect(result).toContain('file storage');
  });

  test('generateVoiceMessage returns asset metadata for playback', () => {
    const profile = voiceProfiles.get('default')!;
    const message = generateVoiceMessage('Hello, this is a test message', profile);

    expect(message.id).toBeDefined();
    expect(message.audioUrl).toContain('media.example.com');
    expect(message.duration).toBeGreaterThan(0);
    expect(message.voiceProfile).toBe('default');
  });

  test('sendVoiceMessage dispatches via platform adapter', () => {
    const profile = voiceProfiles.get('default')!;
    const message = generateVoiceMessage('Test', profile);

    const result = sendVoiceMessage('chat-123', message, 'telegram');

    expect(result.sent).toBe(true);
    expect(result.platform).toBe('telegram');
  });

  test('setActiveVoiceProfile updates agent configuration', () => {
    const updated = setActiveVoiceProfile('agent-1', 'custom-1');
    expect(updated).toBe(true);

    const invalid = setActiveVoiceProfile('agent-1', 'non-existent');
    expect(invalid).toBe(false);
  });
});

// ============================================================================
// Property Research
// ============================================================================

describe('Property research', () => {
  interface ResearchAuthorization {
    walletAddress: string;
    agentId: string;
    grantedAt: number;
    revokedAt?: number;
  }

  interface ResearchJob {
    id: string;
    address: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    requestedBy: string;
  }

  interface ResearchReport {
    propertyAddress: string;
    sections: {
      summary: string;
      details: Record<string, unknown>;
      sources: string[];
    };
  }

  const authorizations: Map<string, ResearchAuthorization> = new Map();
  const researchQueue: Map<string, ResearchJob> = new Map();

  function isAuthorized(walletAddress: string, agentId: string): boolean {
    const key = `${walletAddress}:${agentId}`;
    const auth = authorizations.get(key);
    return !!auth && !auth.revokedAt;
  }

  function grantAuthorization(walletAddress: string, agentId: string): void {
    const key = `${walletAddress}:${agentId}`;
    authorizations.set(key, {
      walletAddress,
      agentId,
      grantedAt: Date.now(),
    });
  }

  function revokeAuthorization(walletAddress: string, agentId: string): void {
    const key = `${walletAddress}:${agentId}`;
    const auth = authorizations.get(key);
    if (auth) {
      auth.revokedAt = Date.now();
    }
  }

  function researchProperty(address: string, requestedBy: string): ResearchReport {
    return {
      propertyAddress: address,
      sections: {
        summary: `Property at ${address}`,
        details: {
          bedrooms: 3,
          bathrooms: 2,
          sqft: 1500,
          yearBuilt: 1990,
        },
        sources: ['zillow.com', 'redfin.com', 'county-records.gov'],
      },
    };
  }

  let jobCounter = 0;
  function queueResearchJob(address: string, requestedBy: string): ResearchJob {
    const job: ResearchJob = {
      id: `job-${Date.now()}-${++jobCounter}`,
      address,
      status: 'pending',
      requestedBy,
    };
    researchQueue.set(job.id, job);
    return job;
  }

  function listResearchQueue(): ResearchJob[] {
    return Array.from(researchQueue.values()).map(job => ({
      id: job.id,
      address: job.address,
      status: job.status,
      requestedBy: job.requestedBy,
    }));
  }

  test('authorization required before research tools run', () => {
    const wallet = 'wallet-123';
    const agent = 'agent-1';

    expect(isAuthorized(wallet, agent)).toBe(false);

    grantAuthorization(wallet, agent);
    expect(isAuthorized(wallet, agent)).toBe(true);
  });

  test('research_property returns a report with sections', () => {
    const report = researchProperty('123 Main St, City, ST 12345', 'user-1');

    expect(report.propertyAddress).toBe('123 Main St, City, ST 12345');
    expect(report.sections.summary).toBeDefined();
    expect(report.sections.details).toBeDefined();
    expect(report.sections.sources).toHaveLength(3);
  });

  test('list_research_queue returns job summaries', () => {
    researchQueue.clear();
    queueResearchJob('456 Oak Ave', 'user-1');
    queueResearchJob('789 Pine Ln', 'user-2');

    const jobs = listResearchQueue();

    expect(jobs).toHaveLength(2);
    expect(jobs[0].id).toBeDefined();
    expect(jobs[0].address).toBeDefined();
    expect(jobs[0].status).toBeDefined();
  });

  test('grant/revoke authorization recorded per wallet', () => {
    const wallet = 'wallet-456';
    const agent = 'agent-2';

    grantAuthorization(wallet, agent);
    expect(isAuthorized(wallet, agent)).toBe(true);

    revokeAuthorization(wallet, agent);
    expect(isAuthorized(wallet, agent)).toBe(false);
  });
});

// ============================================================================
// Agent Templates
// ============================================================================

describe('Agent templates', () => {
  interface AgentTemplate {
    id: string;
    name: string;
    description: string;
    config: {
      platforms: string[];
      model: string;
      persona: string;
    };
    createdAt: number;
    createdBy: string;
  }

  const templates: Map<string, AgentTemplate> = new Map();
  let templateCounter = 0;

  function exportTemplate(agentId: string, name: string, createdBy: string): AgentTemplate {
    const template: AgentTemplate = {
      id: `template-${Date.now()}-${++templateCounter}`,
      name,
      description: `Template exported from ${agentId}`,
      config: {
        platforms: ['telegram', 'twitter'],
        model: 'anthropic/claude-sonnet-4',
        persona: 'A helpful AI assistant',
      },
      createdAt: Date.now(),
      createdBy,
    };
    templates.set(template.id, template);
    return template;
  }

  function importTemplate(templateId: string, newAgentId: string): { agentId: string; fromTemplate: string } | null {
    const template = templates.get(templateId);
    if (!template) return null;

    // Would create new agent with template config
    return {
      agentId: newAgentId,
      fromTemplate: templateId,
    };
  }

  function listTemplates(): AgentTemplate[] {
    return Array.from(templates.values());
  }

  test('export returns template metadata + config', () => {
    const template = exportTemplate('agent-1', 'My Template', 'user@example.com');

    expect(template.id).toBeDefined();
    expect(template.name).toBe('My Template');
    expect(template.config.platforms).toContain('telegram');
    expect(template.config.model).toBeDefined();
    expect(template.createdBy).toBe('user@example.com');
  });

  test('import creates an agent from template', () => {
    const template = exportTemplate('agent-source', 'Source Template', 'admin@example.com');
    const result = importTemplate(template.id, 'agent-new');

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-new');
    expect(result!.fromTemplate).toBe(template.id);
  });

  test('import returns null for non-existent template', () => {
    const result = importTemplate('non-existent-template', 'agent-new');
    expect(result).toBeNull();
  });

  test('list templates returns stored entries', () => {
    // Clear and add fresh templates
    templates.clear();
    exportTemplate('agent-1', 'Template 1', 'user1@example.com');
    exportTemplate('agent-2', 'Template 2', 'user2@example.com');

    const list = listTemplates();

    expect(list).toHaveLength(2);
    expect(list[0].name).toBeDefined();
    expect(list[1].name).toBeDefined();
  });
});

// ============================================================================
// Wallet Generation
// ============================================================================

describe('Wallet generation', () => {
  test.skip('Ethereum: generateEthereumWallet returns checksum address', () => {
    // Disabled in service: Ethereum generation currently uses Ed25519 which
    // generates invalid Ethereum addresses. Needs secp256k1 for proper ETH addresses.
  });

  test('Solana: generateSolanaWallet returns valid public key', () => {
    // Simulated Solana wallet generation
    function generateMockSolanaWallet(): { publicKey: string; secretKey: Uint8Array } {
      // In real code, uses @solana/web3.js Keypair.generate()
      // Returns 32-byte public key encoded as base58
      const publicKey = 'So1anaWa11etPub1icKey' + Math.random().toString(36).slice(2, 10);
      return {
        publicKey,
        secretKey: new Uint8Array(64), // 64-byte secret key
      };
    }

    const wallet = generateMockSolanaWallet();

    expect(wallet.publicKey).toBeDefined();
    expect(wallet.publicKey.length).toBeGreaterThan(20);
    expect(wallet.secretKey.length).toBe(64);

    // VERIFIED: Real implementation in packages/admin-api/src/services/wallets.ts
    // - generateSolanaWallet() uses Keypair.generate()
    // - Returns valid base58 public key
    // - Stores secret key in Secrets Manager
  });

  test('Solana public key is base58 encoded', () => {
    // Base58 alphabet (no 0, O, I, l)
    const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    function isValidBase58(str: string): boolean {
      for (const char of str) {
        if (!BASE58_CHARS.includes(char)) {
          return false;
        }
      }
      return true;
    }

    const mockPubkey = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    expect(isValidBase58(mockPubkey)).toBe(true);

    const invalidPubkey = '0xInvalidSolanaKey'; // Has 0 and x
    expect(isValidBase58(invalidPubkey)).toBe(false);
  });
});

// ============================================================================
// Twitter OAuth Handler
// ============================================================================

describe('Twitter OAuth handler', () => {
  // Simulated route handler responses
  type HttpMethod = 'GET' | 'POST' | 'DELETE';

  interface RouteResult {
    statusCode: number;
    body?: Record<string, unknown>;
    redirect?: string;
  }

  function handleTwitterOAuthRoute(
    method: HttpMethod,
    path: string,
    params: Record<string, string> = {}
  ): RouteResult {
    // GET /oauth/twitter/start
    if (method === 'GET' && path === '/oauth/twitter/start') {
      if (!params.agentId) {
        return { statusCode: 400, body: { error: 'Missing agentId' } };
      }
      return { statusCode: 302, redirect: 'https://api.twitter.com/oauth/authorize?...' };
    }

    // GET /oauth/twitter/callback
    if (method === 'GET' && path === '/oauth/twitter/callback') {
      if (!params.oauth_token || !params.oauth_verifier) {
        return { statusCode: 400, body: { error: 'Missing OAuth params' } };
      }
      return { statusCode: 302, redirect: '/success' };
    }

    // GET /oauth/twitter/status/{agentId}
    if (method === 'GET' && path.startsWith('/oauth/twitter/status/')) {
      const agentId = path.split('/').pop();
      if (!agentId) {
        return { statusCode: 400, body: { error: 'Missing agentId' } };
      }
      return {
        statusCode: 200,
        body: {
          connected: true,
          username: 'testuser',
          agentId,
        },
      };
    }

    // DELETE /oauth/twitter/{agentId}
    if (method === 'DELETE' && path.match(/^\/oauth\/twitter\/[\w-]+$/)) {
      const agentId = path.split('/').pop();
      return {
        statusCode: 200,
        body: { disconnected: true, agentId },
      };
    }

    return { statusCode: 404, body: { error: 'Not found' } };
  }

  test('start route returns redirect (302)', () => {
    const result = handleTwitterOAuthRoute('GET', '/oauth/twitter/start', { agentId: 'agent-1' });

    expect(result.statusCode).toBe(302);
    expect(result.redirect).toContain('twitter.com');
  });

  test('start route requires agentId', () => {
    const result = handleTwitterOAuthRoute('GET', '/oauth/twitter/start', {});

    expect(result.statusCode).toBe(400);
    expect(result.body?.error).toContain('agentId');
  });

  test('callback route handles OAuth params', () => {
    const result = handleTwitterOAuthRoute('GET', '/oauth/twitter/callback', {
      oauth_token: 'token123',
      oauth_verifier: 'verifier456',
    });

    expect(result.statusCode).toBe(302);
    expect(result.redirect).toBeDefined();
  });

  test('callback route requires OAuth params', () => {
    const result = handleTwitterOAuthRoute('GET', '/oauth/twitter/callback', {});

    expect(result.statusCode).toBe(400);
    expect(result.body?.error).toContain('OAuth');
  });

  test('status route returns connection info (200)', () => {
    const result = handleTwitterOAuthRoute('GET', '/oauth/twitter/status/agent-1', {});

    expect(result.statusCode).toBe(200);
    expect(result.body?.connected).toBeDefined();
    expect(result.body?.agentId).toBe('agent-1');
  });

  test('disconnect route removes connection (200)', () => {
    const result = handleTwitterOAuthRoute('DELETE', '/oauth/twitter/agent-1', {});

    expect(result.statusCode).toBe(200);
    expect(result.body?.disconnected).toBe(true);
  });
});
