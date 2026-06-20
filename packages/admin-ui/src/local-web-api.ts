type LocalAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  status: 'shell' | 'configured' | 'active' | 'error' | 'draft' | 'paused';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  slotType?: 'free' | 'orb' | 'nft';
  mediaConfig?: { enabled: boolean; provider?: string };
  voiceConfig?: { enabled: boolean; provider?: string };
  platforms?: {
    telegram?: { enabled: boolean; botUsername?: string };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean; guildId?: string };
  };
  profileImage?: { url: string; updatedAt?: number };
  llmConfig?: Record<string, unknown>;
};

type LocalState = {
  avatars: LocalAvatar[];
  chats: Record<string, Array<{ role: string; content: string; media?: unknown[] }>>;
  secrets: Record<string, string>;
  avatarSecrets: Record<string, Record<string, string>>;
  apiKeys: Record<string, Array<{ keyPrefix: string; name: string; createdAt: number; createdBy: string; enabled: boolean }>>;
  entitlements: Record<string, { plan: 'free' | 'pro' | 'enterprise' | 'team'; limits: Record<string, unknown>; status: string; updatedAt: number }>;
  gallery: Record<string, Array<{ id: string; type: 'image' | 'video' | 'sticker'; url: string; prompt?: string; caption?: string; createdAt: number }>>;
  agentBackends: Record<string, {
    backend: string;
    endpoint?: string;
    apiKey?: string;
    deploymentTarget: 'local' | 'fly';
  }>;
  consentAcceptedAt?: number;
};

const STORAGE_KEY = 'swarm:web-local:v1';

const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

function shouldInstallLocalWebApi(): boolean {
  if (!isBrowser) return false;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  if (env.VITE_WEB_LOCAL === '1' || env.VITE_SWARM_WEB_LOCAL === '1') return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get('local') === '1') return true;
  const host = window.location.hostname.toLowerCase();
  return host === 'rati.chat' || host === 'www.rati.chat' || host === 'swarm.rati.chat';
}

function readState(): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyState(), ...JSON.parse(raw) };
  } catch {
    // Fall through to a fresh local store.
  }
  return emptyState();
}

function emptyState(): LocalState {
  return {
    avatars: [],
    chats: {},
    secrets: {},
    avatarSecrets: {},
    apiKeys: {},
    entitlements: {},
    gallery: {},
    agentBackends: {},
  };
}

function writeState(state: LocalState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function localUser() {
  return {
    authenticated: true,
    user: {
      walletAddress: 'local-web',
      displayName: 'Local Web',
      email: 'local@rati.chat',
    },
    account: {
      accountId: 'local-web',
      role: 'admin',
      identities: [{ type: 'wallet', providerId: 'local-web' }],
    },
    gateStatus: {
      nftsHeld: 1,
      avatarsCreated: 0,
      availableSlots: 999,
      canCreate: true,
      canAbandon: true,
      ownedNFTs: [],
    },
  };
}

function toPublicAvatar(avatar: LocalAvatar): LocalAvatar {
  return {
    ...avatar,
    avatarId: avatar.avatarId,
    status: avatar.status,
  };
}

function defaultAssistantReply(message: string, avatar?: LocalAvatar): string {
  const target = avatar?.name || 'this avatar';
  if (/personality|persona|style|voice/i.test(message)) {
    return `Got it. I saved that direction for ${target}. You can keep refining the personality here, and this web build will keep the state in this browser.`;
  }
  if (/runtime|backend|hermes|cosy|codex|eliza|openclaw/i.test(message)) {
    return `Runtime settings are local to this browser. Pick a runtime in the Agent runtime panel; local endpoints are remembered in localStorage.`;
  }
  if (/download|desktop|native|mac|windows|linux/i.test(message)) {
    return 'Use the Native clients panel to open the latest desktop release for macOS, Windows, or Linux.';
  }
  return `I am running in browser-local mode. I can help configure ${target}, but anything that needs a server, OAuth callback, or background worker should use the native client.`;
}

function defaultLimits(plan: 'free' | 'pro' | 'enterprise' | 'team' = 'free'): Record<string, unknown> {
  const multiplier = plan === 'free' ? 1 : plan === 'pro' ? 5 : 20;
  return {
    messagesPerDay: 100 * multiplier,
    mediaPerDay: 5 * multiplier,
    voiceMinutesPerDay: 10 * multiplier,
    toolCallsPerDay: 50 * multiplier,
  };
}

function entitlementFor(state: LocalState, avatarId: string) {
  const stored = state.entitlements[avatarId];
  if (stored) return stored;
  return { plan: 'free' as const, limits: defaultLimits('free'), status: 'active', updatedAt: Date.now() };
}

function usageFor(state: LocalState, avatarId: string) {
  const entitlement = entitlementFor(state, avatarId);
  return {
    avatarId,
    date: new Date().toISOString().slice(0, 10),
    plan: entitlement.plan,
    source: state.entitlements[avatarId] ? 'entitlement' : 'default',
    meters: {
      messages: { used: 0, limit: Number(entitlement.limits.messagesPerDay ?? 100), label: 'Messages' },
      media: { used: 0, limit: Number(entitlement.limits.mediaPerDay ?? 5), label: 'Media' },
      voice: { used: 0, limit: Number(entitlement.limits.voiceMinutesPerDay ?? 10), label: 'Voice minutes' },
    },
    toolCredits: {},
    energy: { current: 100, max: 100, refillPerHour: 0, bankCredits: 0 },
  };
}

const AGENT_BACKENDS = [
  {
    id: 'swarm-native',
    name: 'Swarm Native',
    description: 'Built-in browser-local Swarm chat and avatar state.',
    authMode: 'none',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: { summary: 'Built in. No install required for the web-local client.', commands: [] },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: false, codeExecution: false, multimodal: false },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'External Hermes-compatible agent runtime reached through a configured HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install Hermes Agent, complete portal setup, then start the local proxy.',
      commands: ['curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh', 'hermes setup --portal'],
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/',
      endpointHint: 'The web client remembers the Hermes endpoint in localStorage.',
    },
    launch: { command: 'hermes proxy start --port 8645', endpoint: 'http://localhost:8645' },
    cloud: { fly: { endpointHint: 'Paste a Fly.io Hermes proxy endpoint.' } },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: true, codeExecution: false, multimodal: false },
  },
  {
    id: 'cosyworld',
    name: 'CosyWorld',
    description: 'Sibling ../cosyworld runtime for world, avatar, Discord, memory, and story systems.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Use the sibling ../cosyworld checkout locally, or paste a hosted endpoint.',
      commands: ['cd ../cosyworld && npm install', 'cd ../cosyworld && WEB_PORT=3101 npm run dev'],
      endpointHint: 'The web client remembers the CosyWorld endpoint in localStorage.',
    },
    launch: { command: 'cd ../cosyworld && WEB_PORT=3101 npm run dev', endpoint: 'http://localhost:3101' },
    cloud: { fly: { command: 'cd ../cosyworld && fly launch --name swarm-cosyworld-runtime', endpointHint: 'Paste a Fly.io CosyWorld endpoint.' } },
    capabilities: { chat: true, tools: true, memory: true, autonomousLoop: true, codeExecution: false, multimodal: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Local Codex CLI runtime for code-aware agent work.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: { summary: 'Install Codex CLI locally and sign in.', commands: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'codex'], docsUrl: 'https://developers.openai.com/codex/cli' },
    capabilities: { chat: true, tools: true, memory: false, autonomousLoop: true, codeExecution: true, multimodal: false },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own agent backend through an HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: { summary: 'Run any custom agent service, then paste its HTTP endpoint.', commands: [], endpointHint: 'Paste the custom agent backend endpoint.' },
    capabilities: { chat: true, tools: true, memory: false, autonomousLoop: false, codeExecution: false, multimodal: false },
  },
];

function backendStatus(state: LocalState, avatarId?: string) {
  const key = avatarId || 'global';
  const stored = state.agentBackends[key] ?? { backend: 'swarm-native', deploymentTarget: 'local' as const };
  const selectedBackend = AGENT_BACKENDS.find((backend) => backend.id === stored.backend) ?? AGENT_BACKENDS[0];
  const endpoint = stored.endpoint || (stored.deploymentTarget === 'local' ? selectedBackend.launch?.endpoint : undefined);
  return {
    selected: selectedBackend.id,
    selectedBackend,
    configured: selectedBackend.id === 'swarm-native' || selectedBackend.authMode === 'local-process' || !selectedBackend.requiresEndpoint || Boolean(endpoint),
    endpoint,
    hasApiKey: Boolean(stored.apiKey),
    deploymentTarget: stored.deploymentTarget,
    scope: avatarId ? { avatarId, label: `Avatar ${avatarId}` } : { label: 'New agents' },
    backends: AGENT_BACKENDS,
  };
}

export function routeLocalApi(request: Request): Response | Promise<Response> | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api')) return null;

  const path = url.pathname.slice('/api'.length) || '/';
  const method = request.method.toUpperCase();
  const state = readState();

  if (path === '/health') return json({ ok: true, mode: 'web-local' });
  if (path === '/auth/me') return json(localUser());
  if (path === '/auth/logout' && method === 'POST') return json({ ok: true });
  if (path.startsWith('/oauth/twitter/status/')) return json({ connected: false });

  if (path.startsWith('/consent')) {
    const policyVersion = url.searchParams.get('policyVersion') || '1.3';
    if (method === 'POST') {
      return readJson(request).then((body) => {
        const acceptedAt = Date.now();
        state.consentAcceptedAt = acceptedAt;
        writeState(state);
        return json({
          consent: {
            policyVersion: String(body.policyVersion || policyVersion),
            acceptedAt,
            status: 'active',
          },
        });
      });
    }
    return json({
      consented: true,
      consent: {
        policyVersion,
        acceptedAt: state.consentAcceptedAt ?? Date.now(),
        status: 'active',
      },
    });
  }

  if (path === '/avatars' && method === 'GET') return json(state.avatars.map(toPublicAvatar));
  if (path === '/avatars' && method === 'POST') {
    return readJson(request).then((body) => {
      const now = Date.now();
      const name = String(body.name || `Avatar ${state.avatars.length + 1}`);
      const avatar: LocalAvatar = {
        avatarId: `avatar-${now.toString(36)}`,
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        createdBy: 'local-web',
        slotType: 'free',
        mediaConfig: { enabled: false },
        voiceConfig: { enabled: false },
        platforms: {},
      };
      state.avatars.unshift(avatar);
      state.chats[avatar.avatarId] = [{
        role: 'assistant',
        content: `Hi! I'm ${name}. Talk to me to configure my integrations.`,
      }];
      writeState(state);
      return json(toPublicAvatar(avatar));
    });
  }
  if (path === '/avatars/health') return json({ avatars: [] });
  if (path === '/avatars/scan-nft' && method === 'POST') {
    return json({ created: [], skippedAlreadyClaimed: 0, available: 0, capped: false });
  }

  const avatarMatch = path.match(/^\/avatars\/([^/]+)(?:\/(.+))?/);
  if (avatarMatch) {
    const avatarId = decodeURIComponent(avatarMatch[1]);
    const actionPath = avatarMatch[2] ?? '';
    const [action, subAction, detailId] = actionPath.split('/').map((part) => decodeURIComponent(part));
    const avatar = state.avatars.find((item) => item.avatarId === avatarId);
    if (!avatar) return json({ error: 'Avatar not found' }, { status: 404 });

    if (!action && method === 'GET') return json(toPublicAvatar(avatar));
    if (!action && method === 'DELETE') {
      state.avatars = state.avatars.filter((item) => item.avatarId !== avatarId);
      delete state.chats[avatarId];
      writeState(state);
      return json({ ok: true });
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      return readJson(request).then((body) => {
        Object.assign(avatar, body, { updatedAt: Date.now(), status: avatar.status === 'draft' ? 'configured' : avatar.status });
        writeState(state);
        return json(toPublicAvatar(avatar));
      });
    }
    if (action === 'activate' && method === 'POST') {
      avatar.status = 'active';
      avatar.updatedAt = Date.now();
      writeState(state);
      return json({ success: true, status: 'active' });
    }
    if (action === 'deactivate' && method === 'POST') {
      avatar.status = 'paused';
      avatar.updatedAt = Date.now();
      writeState(state);
      return json({ success: true, status: 'paused' });
    }
    if (action === 'secrets' && method === 'POST') {
      return readJson(request).then((body) => {
        const key = String(body.key || '');
        if (key) {
          state.avatarSecrets[avatarId] = { ...(state.avatarSecrets[avatarId] ?? {}), [key]: String(body.value ?? '') };
          writeState(state);
        }
        return json({ success: true });
      });
    }
    if (action === 'energy') return json({ avatarId, current: 100, max: 100, nextRefillIn: 0, refillPerHour: 0, baseRefillPerHour: 0, bonusRefillPerHour: 0, ownerTokenBalance: 0 });
    if (action === 'effective-limits' && method === 'GET') {
      const entitlement = entitlementFor(state, avatarId);
      return json({
        avatarId,
        plan: entitlement.plan,
        limits: entitlement.limits,
        source: state.entitlements[avatarId] ? 'entitlement' : 'default',
        entitlementStatus: entitlement.status,
      });
    }
    if (action === 'entitlement') {
      if (method === 'GET') {
        const entitlement = state.entitlements[avatarId];
        return json({
          avatarId,
          entitlement: entitlement
            ? {
              accountId: 'local-web',
              avatarId,
              plan: entitlement.plan,
              limits: entitlement.limits,
              status: entitlement.status,
              updatedAt: entitlement.updatedAt,
              updatedBy: 'local-web',
            }
            : null,
        });
      }
      if (method === 'PUT') {
        return readJson(request).then((body) => {
          const plan = ['free', 'pro', 'enterprise', 'team'].includes(String(body.plan)) ? String(body.plan) as 'free' | 'pro' | 'enterprise' | 'team' : 'free';
          const entitlement = { plan, limits: defaultLimits(plan), status: 'active', updatedAt: Date.now() };
          state.entitlements[avatarId] = entitlement;
          writeState(state);
          return json({
            avatarId,
            entitlement: {
              accountId: 'local-web',
              avatarId,
              plan,
              limits: entitlement.limits,
              status: entitlement.status,
              updatedAt: entitlement.updatedAt,
              updatedBy: 'local-web',
            },
            effective: { plan, limits: entitlement.limits, source: 'entitlement' },
          });
        });
      }
    }
    if (action === 'usage') {
      if (!subAction && method === 'GET') return json(usageFor(state, avatarId));
      if (subAction === 'history' && method === 'GET') {
        const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days') || 7)));
        return json({ avatarId, days, history: [] });
      }
    }
    if (action === 'events') {
      if (subAction === 'counts' && method === 'GET') {
        return json({ avatarId, openIssues: 0, recentFeedback: { positive: 0, negative: 0, neutral: 0 } });
      }
      if (!subAction && method === 'GET') return json({ avatarId, events: [], count: 0 });
      if ((subAction || detailId) && method === 'PATCH') return json({ ok: true });
    }
    if (action === 'gallery') {
      if (subAction === 'upload-url' && method === 'POST') {
        const uploadId = `upload-${Date.now().toString(36)}`;
        return json({
          uploadUrl: `${url.origin}/api/local-upload/${encodeURIComponent(uploadId)}`,
          s3Key: `local/${avatarId}/${uploadId}`,
          publicUrl: `local-gallery://${avatarId}/${uploadId}`,
        });
      }
      if (subAction === 'save' && method === 'POST') {
        return readJson(request).then((body) => {
          const now = Date.now();
          const item = {
            id: `gallery-${now.toString(36)}`,
            type: 'image' as const,
            url: String(body.publicUrl || ''),
            caption: typeof body.caption === 'string' ? body.caption : undefined,
            createdAt: now,
          };
          state.gallery[avatarId] = [item, ...(state.gallery[avatarId] ?? [])];
          writeState(state);
          return json(item);
        });
      }
      return json({ items: state.gallery[avatarId] ?? [] });
    }
    if (action === 'api-keys') {
      if (!subAction && method === 'GET') return json({ keys: state.apiKeys[avatarId] ?? [] });
      if (!subAction && method === 'POST') {
        return readJson(request).then((body) => {
          const now = Date.now();
          const keyPrefix = `sk-local-${now.toString(36)}`;
          const key = {
            keyPrefix,
            name: String(body.name || 'Local web key'),
            createdAt: now,
            createdBy: 'local-web',
            enabled: true,
          };
          state.apiKeys[avatarId] = [key, ...(state.apiKeys[avatarId] ?? [])];
          writeState(state);
          return json({ apiKey: `${keyPrefix}-dev-only`, keyPrefix });
        });
      }
      if (subAction && method === 'DELETE') {
        state.apiKeys[avatarId] = (state.apiKeys[avatarId] ?? []).filter((key) => key.keyPrefix !== subAction);
        writeState(state);
        return json({ ok: true });
      }
    }
    if (action === 'integrations') return json({ integrations: {} });
    if (action === 'discord') return json({ connected: false, mode: 'bot' });
    if (action === 'telegram') return json({ connected: false });
    if (action === 'validate-token' || action === 'validate-ai-key') return json({ valid: true, mode: 'web-local' });
  }

  if (path.startsWith('/local-upload/') && method === 'PUT') return json({ ok: true });

  if (path === '/chat' && method === 'GET') {
    const avatarId = url.searchParams.get('avatarId') || 'global';
    return json({ history: state.chats[avatarId] ?? [] });
  }
  if (path === '/chat' && method === 'DELETE') {
    const avatarId = url.searchParams.get('avatarId') || 'global';
    state.chats[avatarId] = [];
    writeState(state);
    return json({ history: [] });
  }
  if (path === '/chat/message' && method === 'POST') {
    return readJson(request).then((body) => {
      const avatarId = String(body.avatarId || 'global');
      const message = body.message as { role?: string; content?: string } | undefined;
      state.chats[avatarId] = [...(state.chats[avatarId] ?? []), { role: message?.role || 'assistant', content: message?.content || '' }];
      writeState(state);
      return json({ history: state.chats[avatarId] });
    });
  }
  if (path === '/chat' && method === 'POST') {
    return readJson(request).then((body) => {
      const message = String(body.message || '');
      const avatarId = (body.avatar as { id?: string } | undefined)?.id || 'global';
      const avatar = state.avatars.find((item) => item.avatarId === avatarId);
      const history = [...(body.history as Array<{ role: string; content: string }> || [])];
      const reply = defaultAssistantReply(message, avatar);
      const nextHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
      state.chats[avatarId] = nextHistory;
      writeState(state);
      return json({ response: reply, history: nextHistory });
    });
  }

  if (path === '/llm/status') {
    const provider = state.secrets['llm-provider'] as 'openrouter' | 'ollama' | undefined;
    const hasOpenRouter = Boolean(state.secrets['llm-api-key']);
    return json({
      configured: Boolean(provider === 'ollama' || hasOpenRouter),
      provider: provider ?? null,
      selectedProvider: provider ?? null,
      openrouter: { configured: hasOpenRouter },
      ollama: { available: false, endpoint: 'http://localhost:11434/v1' },
    });
  }
  if (path === '/llm/provider' && method === 'POST') {
    return readJson(request).then((body) => {
      state.secrets['llm-provider'] = String(body.provider || '');
      writeState(state);
      return routeLocalApi(new Request(new URL('/api/llm/status', url.origin)))!;
    });
  }
  if (path === '/llm/provider' && method === 'DELETE') {
    delete state.secrets['llm-provider'];
    delete state.secrets['llm-api-key'];
    writeState(state);
    return routeLocalApi(new Request(new URL('/api/llm/status', url.origin)))!;
  }
  if (path === '/secrets/llm-api-key') {
    if (method === 'GET') return json({ exists: Boolean(state.secrets['llm-api-key']) });
    if (method === 'PUT' || method === 'POST') {
      return readJson(request).then((body) => {
        state.secrets['llm-api-key'] = String(body.value || body.apiKey || '');
        state.secrets['llm-provider'] = 'openrouter';
        writeState(state);
        return json({ success: true });
      });
    }
  }

  if (path === '/agent-backends') {
    return json(backendStatus(state, url.searchParams.get('avatarId') || undefined));
  }
  if (path === '/agent-backends/select' && method === 'POST') {
    return readJson(request).then((body) => {
      const avatarId = typeof body.avatarId === 'string' ? body.avatarId : undefined;
      const key = avatarId || 'global';
      state.agentBackends[key] = {
        backend: String(body.backend || 'swarm-native'),
        endpoint: typeof body.endpoint === 'string' ? body.endpoint : undefined,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : state.agentBackends[key]?.apiKey,
        deploymentTarget: body.deploymentTarget === 'fly' ? body.deploymentTarget : 'local',
      };
      writeState(state);
      return json(backendStatus(state, avatarId));
    });
  }
  if (path === '/agent-backends/select' && method === 'DELETE') {
    delete state.agentBackends[url.searchParams.get('avatarId') || 'global'];
    writeState(state);
    return json(backendStatus(state, url.searchParams.get('avatarId') || undefined));
  }

  if (path.startsWith('/runtime/')) {
    const backend = url.searchParams.get('backend') || 'swarm-native';
    const definition = AGENT_BACKENDS.find((item) => item.id === backend);
    if (path.endsWith('/logs')) return json({ logs: ['Browser web client cannot supervise native processes. Use a native client to launch runtimes.'] });
    return json({
      backend,
      running: false,
      pid: null,
      startedAt: null,
      command: definition?.launch?.command ?? '',
      endpoint: definition?.launch?.endpoint ?? '',
      exitCode: null,
      lastError: null,
      supported: false,
    });
  }

  if (path.startsWith('/jobs')) return json(path === '/jobs' ? { count: 0, jobs: [] } : { status: 'completed' });
  if (path.startsWith('/shared-chat')) return json({ messages: [] });
  if (path.startsWith('/prompt-preview')) return json({ systemPrompt: '', tools: [] });
  if (path.startsWith('/issues')) return json({ issues: [] });

  return json({ error: `Web-local route not implemented: ${path}` }, { status: 404 });
}

export function installLocalWebApi(): void {
  if (!shouldInstallLocalWebApi()) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const routed = routeLocalApi(request);
    if (routed) return Promise.resolve(routed);
    return originalFetch(input, init);
  };
  document.documentElement.dataset.swarmWebLocal = 'true';
}
