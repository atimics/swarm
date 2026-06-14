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
  agentBackends: Record<string, {
    backend: string;
    endpoint?: string;
    apiKey?: string;
    deploymentTarget: 'local' | 'fly' | 'ecs';
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
    cloud: { fly: { endpointHint: 'Paste a Fly.io Hermes proxy endpoint.' }, ecs: { supported: false, endpointHint: 'ECS support is planned.' } },
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
    cloud: { fly: { command: 'cd ../cosyworld && fly launch --name swarm-cosyworld-runtime', endpointHint: 'Paste a Fly.io CosyWorld endpoint.' }, ecs: { supported: false, endpointHint: 'ECS support is planned.' } },
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

function routeLocalApi(request: Request): Response | Promise<Response> | null {
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

  const avatarMatch = path.match(/^\/avatars\/([^/]+)(?:\/([^/]+))?/);
  if (avatarMatch) {
    const avatarId = decodeURIComponent(avatarMatch[1]);
    const action = avatarMatch[2];
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
    if (action === 'gallery') return json({ items: [] });
    if (action === 'integrations') return json({ integrations: {} });
    if (action === 'discord') return json({ connected: false, mode: 'bot' });
    if (action === 'telegram') return json({ connected: false });
  }

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
        deploymentTarget: body.deploymentTarget === 'fly' || body.deploymentTarget === 'ecs' ? body.deploymentTarget : 'local',
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
