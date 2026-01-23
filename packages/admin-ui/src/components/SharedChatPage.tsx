import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../store/auth';
import { PrivyLoginButton } from './PrivyLoginButton';
import {
  getSharedChatMessages,
  sendSharedChatMessage,
  getChannelAvatar,
  getTypingStatus,
  RateLimitError,
  type SharedChatMessage,
  type ChannelAvatarInfo,
} from '../api/sharedChat';

interface SharedChatPageProps {
  botId: string;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SharedChatPage({ botId }: SharedChatPageProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const [messages, setMessages] = useState<SharedChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [avatarInfo, setAvatarInfo] = useState<ChannelAvatarInfo | null>(null);
  const [loadingAvatar, setLoadingAvatar] = useState(true);
  const [typingIndicator, setTypingIndicator] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const channelId = useMemo(() => botId, [botId]);

  // Fetch avatar info on mount (public endpoint, no auth required)
  useEffect(() => {
    async function fetchAvatar() {
      try {
        const result = await getChannelAvatar(channelId);
        setAvatarInfo(result.avatar);
      } catch (err) {
        console.error('Failed to load avatar info:', err);
      } finally {
        setLoadingAvatar(false);
      }
    }
    void fetchAvatar();
  }, [channelId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const loadMessages = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoadingMessages(true);
    try {
      const result = await getSharedChatMessages(channelId);
      setMessages(result.messages || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoadingMessages(false);
    }
  }, [channelId, isAuthenticated]);

  // Poll for messages and typing status
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadMessages();

    const messageInterval = window.setInterval(() => {
      void loadMessages();
    }, 5000);

    // Poll typing status more frequently when not sending
    const typingInterval = window.setInterval(async () => {
      if (!sending) {
        try {
          const status = await getTypingStatus(channelId);
          setTypingIndicator(status.typing ? status.avatarName || null : null);
        } catch {
          // Ignore typing status errors
        }
      }
    }, 2000);

    return () => {
      window.clearInterval(messageInterval);
      window.clearInterval(typingInterval);
    };
  }, [isAuthenticated, loadMessages, channelId, sending]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, typingIndicator, scrollToBottom]);

  // Rate limit countdown timer
  useEffect(() => {
    if (!rateLimitedUntil) return;

    const interval = window.setInterval(() => {
      const remaining = rateLimitedUntil - Date.now();
      if (remaining <= 0) {
        setRateLimitedUntil(null);
        setError(null);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [rateLimitedUntil]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || sending || rateLimitedUntil) return;

    setSending(true);
    setTypingIndicator(avatarInfo?.name || null); // Optimistic typing indicator

    try {
      const result = await sendSharedChatMessage(channelId, input.trim());
      // Add user message first
      setMessages((prev) => [...prev, result.message]);
      // Add avatar response if present
      if (result.avatarResponse) {
        setMessages((prev) => [...prev, result.avatarResponse!]);
      }
      setInput('');
      setError(null);
      setTypingIndicator(null);
    } catch (err) {
      if (err instanceof RateLimitError) {
        const unlockTime = Date.now() + err.retryAfter * 1000;
        setRateLimitedUntil(unlockTime);
        setError(`Too many messages. Please wait ${err.retryAfter} seconds.`);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to send message');
      }
      setTypingIndicator(null);
    } finally {
      setSending(false);
    }
  }, [channelId, input, sending, rateLimitedUntil, avatarInfo?.name]);

  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    void handleSend();
  }, [handleSend]);

  // Get display name for header
  const displayName = loadingAvatar ? 'Loading...' : (avatarInfo?.name || botId);

  // Calculate remaining rate limit time
  const rateLimitRemaining = rateLimitedUntil
    ? Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000))
    : 0;

  // Determine if input should be disabled
  const inputDisabled = !isAuthenticated || sending || rateLimitRemaining > 0;

  // Determine placeholder text
  let placeholder = 'Say something…';
  if (!isAuthenticated) placeholder = 'Sign in to chat';
  else if (rateLimitRemaining > 0) placeholder = `Wait ${rateLimitRemaining}s...`;
  else if (sending) placeholder = 'Sending...';

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
          <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
            {loadingAvatar ? (
              <div className="h-full w-full animate-pulse bg-[var(--color-bg-tertiary)]" />
            ) : avatarInfo?.profileImageUrl ? (
              <img
                src={avatarInfo.profileImageUrl}
                alt={avatarInfo.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-white text-lg font-bold">
                {avatarInfo?.name?.[0]?.toUpperCase() || '?'}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">Chat with</p>
            <h1 className="truncate text-lg font-semibold">{displayName}</h1>
            {avatarInfo?.description && (
              <p className="truncate text-xs text-[var(--color-text-muted)]">
                {avatarInfo.description}
              </p>
            )}
          </div>
          <div className="ml-auto">
            <PrivyLoginButton />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-28 pt-6">
        {!isAuthenticated && !isLoading && (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 text-center">
            <h2 className="text-lg font-semibold">Sign in to join the chat</h2>
            <p className="mt-2 text-sm text-[var(--color-text-tertiary)]">
              Log in with Privy to send messages in this group chat.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-1 flex-col gap-4">
          {loadingMessages && messages.length === 0 ? (
            <div className="text-sm text-[var(--color-text-tertiary)]">Loading messages...</div>
          ) : messages.length === 0 ? (
            <div className="text-sm text-[var(--color-text-tertiary)]">No messages yet.</div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                  {message.sender.avatarUrl ? (
                    <img src={message.sender.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-sm">{message.sender.isGhost ? '👻' : '🙂'}</div>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
                    <span className="font-medium text-[var(--color-text-secondary)]">
                      {message.sender.displayName || message.sender.walletAddress}
                    </span>
                    <span>{formatTimestamp(message.timestamp)}</span>
                  </div>
                  <div className="mt-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm leading-relaxed">
                    {message.content}
                  </div>
                </div>
              </div>
            ))
          )}

          {typingIndicator && (
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                {avatarInfo?.profileImageUrl ? (
                  <img src={avatarInfo.profileImageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm">🤖</div>
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
                  <span className="font-medium text-[var(--color-text-secondary)]">
                    {typingIndicator}
                  </span>
                </div>
                <div className="mt-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm leading-relaxed">
                  <span className="text-[var(--color-text-muted)]">typing...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="fixed bottom-0 left-0 right-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/90 backdrop-blur">
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
          <input
            className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm outline-none focus:border-brand-500 disabled:opacity-50"
            placeholder={placeholder}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={inputDisabled}
          />
          <button
            type="submit"
            className="rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={inputDisabled || input.trim().length === 0}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </form>
      </footer>
    </div>
  );
}
