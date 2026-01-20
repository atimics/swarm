import { API_BASE } from './apiBase';

interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface MediaItem {
  type: 'image' | 'video' | 'sticker' | 'audio';
  url: string;
  prompt?: string;
  id?: string;
}

interface PendingJob {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  prompt?: string;
  purpose?: string;
}

interface ChatResponse {
  response: string;
  history: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
    media?: MediaItem[];
  }>;
  media?: MediaItem[];
  pendingJobs?: PendingJob[];
  avatarUpdates?: {
    profileImageUrl?: string;
    name?: string;
  };
  pendingToolCall?: PendingToolCall;
  error?: string;
}

interface AvatarContext {
  id: string;
  name: string;
  description?: string;
  persona?: string;
}

interface SenderContext {
  walletAddress?: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
}

/**
 * Send a chat message to the admin API
 */
export async function sendChatMessage(
  message: string,
  history: Array<{ role: string; content: string }>,
  avatar?: AvatarContext,
  sender?: SenderContext
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ask the API to return immediately with a jobId (avoids Lambda/API Gateway timeouts)
      'Prefer': 'respond-async',
      // CF Access token is automatically included via cookie/header by Cloudflare
    },
    credentials: 'include',
    body: JSON.stringify({
      message,
      history: history.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      // Pass avatar context so the LLM knows which avatar it IS
      avatar: avatar ? {
        id: avatar.id,
        name: avatar.name,
        description: avatar.description,
        persona: avatar.persona,
      } : undefined,
      // Pass sender context for message attribution
      sender: sender ? {
        walletAddress: sender.walletAddress,
        displayName: sender.displayName,
        avatarUrl: sender.avatarUrl,
        inhabitedAvatarId: sender.inhabitedAvatarId,
      } : undefined,
    }),
  });

  // Async path: API returns a jobId, UI polls /jobs until completion
  if (response.status === 202) {
    const data = await response.json().catch(() => null) as { jobId?: string } | null;
    const jobId = data?.jobId;
    if (!jobId) {
      throw new Error('Async chat requested but no jobId returned');
    }

    const job = await pollJobCompletion(jobId);
    if (job.type !== 'chat') {
      throw new Error(`Unexpected job type for chat: ${job.type}`);
    }
    if (job.status !== 'completed') {
      throw new Error(job.error || `Chat job ${job.status}`);
    }

    return {
      response: job.response || '',
      history: job.history || [],
      media: job.media,
      pendingJobs: job.pendingJobs,
      pendingToolCall: job.pendingToolCall,
      avatarUpdates: job.avatarUpdates,
    };
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Submit a tool call result (e.g., secret input)
 */
export async function submitToolResult(
  avatarId: string,
  toolCallId: string,
  result: unknown
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/tools/${toolCallId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ result }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Save a secret for an avatar
 */
export async function saveAvatarSecret(
  avatarId: string,
  secretKey: string,
  secretValue: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/avatars/${avatarId}/secrets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ key: secretKey, value: secretValue }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Check if user is authenticated
 */
export async function checkAuth(): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const response = await fetch(`${API_BASE}/health`, {
      credentials: 'include',
    });
    
    if (response.ok) {
      return { authenticated: true };
    }
    
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Fetch chat history from backend (for cross-device sync)
 */
export async function fetchChatHistory(
  avatarId?: string
): Promise<Array<{ role: string; content: string; media?: MediaItem[] }>> {
  const params = avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : '';
  const response = await fetch(`${API_BASE}/chat${params}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.history || [];
}

/**
 * Clear chat history on the backend
 */
export async function clearChatHistory(avatarId?: string): Promise<void> {
  const params = avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : '';
  const response = await fetch(`${API_BASE}/chat${params}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

// ============================================================================
// Job Status Polling (for async image/video generation)
// ============================================================================

export interface JobStatus {
  jobId: string;
  type: 'image' | 'video' | 'sticker' | 'chat';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resultUrl?: string;
  url?: string; // Alias for resultUrl for compatibility
  error?: string;

  // Chat job result fields (present when type === 'chat')
  response?: string;
  history?: ChatResponse['history'];
  media?: MediaItem[];
  pendingJobs?: PendingJob[];
  pendingToolCall?: PendingToolCall;
  avatarUpdates?: ChatResponse['avatarUpdates'];
}

/**
 * Get the status of a specific job
 */
export async function getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.message || error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get all pending jobs for an avatar
 */
export async function getPendingJobs(avatarId: string): Promise<{ count: number; jobs: JobStatus[] }> {
  const response = await fetch(`${API_BASE}/jobs?avatarId=${encodeURIComponent(avatarId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.message || error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Poll for job completion
 * Returns the completed job status or throws if the job fails
 */
export async function pollJobCompletion(
  jobId: string,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
    maxIntervalMs?: number;
    backoffFactor?: number;
    onProgress?: (status: JobStatus) => void;
    signal?: AbortSignal;
  } = {}
): Promise<JobStatus> {
  const {
    maxAttempts = 120,
    intervalMs = 2000,
    maxIntervalMs = 12000,
    backoffFactor = 1.5,
    onProgress,
    signal,
  } = options;
  let currentInterval = intervalMs;

  const createAbortError = () => {
    const err = new Error('Polling cancelled');
    (err as Error & { name: string }).name = 'AbortError';
    return err;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const status = await getJobStatus(jobId, signal);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'completed') {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(status.error || 'Job failed');
    }

    // Wait before next poll
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(resolve, currentInterval);
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    currentInterval = Math.min(Math.floor(currentInterval * backoffFactor), maxIntervalMs);
  }

  throw new Error('Job timed out');
}

/**
 * Transcribe audio using the backend API
 * Uploads audio blob and returns transcribed text
 */
export async function transcribeAudio(
  audioBlob: Blob,
  avatarId?: string
): Promise<{ text: string; language?: string }> {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  if (avatarId) {
    formData.append('avatarId', avatarId);
  }

  const response = await fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Transcription failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// =============================================================================
// LEGACY API - Deprecated aliases for backwards compatibility
// =============================================================================

/** @deprecated Use saveAvatarSecret instead */
export const saveAgentSecret = saveAvatarSecret;
