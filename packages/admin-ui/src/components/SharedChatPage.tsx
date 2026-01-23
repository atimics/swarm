import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../store/auth';
import { WalletLogin } from './WalletLogin';
import { getSharedChatMessages, sendSharedChatMessage, type SharedChatMessage } from '../api/sharedChat';

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
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const channelId = useMemo(() => botId, [botId]);

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

  useEffect(() => {
    if (!isAuthenticated) return;
    void loadMessages();
    const interval = window.setInterval(() => {
      void loadMessages();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [isAuthenticated, loadMessages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    try {
      const message = await sendSharedChatMessage(channelId, input.trim());
      setMessages((prev) => [...prev, message]);
      setInput('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    }
  }, [channelId, input]);

  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    void handleSend();
  }, [handleSend]);

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700" />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">Group chat</p>
            <h1 className="truncate text-lg font-semibold">{botId}</h1>
          </div>
          <div className="ml-auto">
            <WalletLogin />
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
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="fixed bottom-0 left-0 right-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/90 backdrop-blur">
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
          <input
            className="flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm outline-none focus:border-brand-500"
            placeholder={isAuthenticated ? 'Say something…' : 'Sign in to chat'}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={!isAuthenticated}
          />
          <button
            type="submit"
            className="rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!isAuthenticated || input.trim().length === 0}
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
