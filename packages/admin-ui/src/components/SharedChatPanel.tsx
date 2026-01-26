import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatInput } from './ChatInput';
import { getSharedChatMessages, getTypingStatus, sendSharedChatMessage, type SharedChatMessage } from '../api/sharedChat';
import { useAuth } from '../store/auth';

interface SharedChatPanelProps {
  channelId: string;
  disabled?: boolean;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function displayNameForSender(sender: SharedChatMessage['sender']): string {
  if (sender.inhabitedAvatarName) return sender.inhabitedAvatarName;
  if (sender.displayName) return sender.displayName;
  return sender.walletAddress ? `${sender.walletAddress.slice(0, 6)}…${sender.walletAddress.slice(-4)}` : 'Unknown';
}

export function SharedChatPanel({ channelId, disabled }: SharedChatPanelProps) {
  const { user, isAuthenticated } = useAuth();

  // Debug: trace SharedChatPanel render
  console.log('[SharedChatPanel] Rendering for channelId:', channelId, 'isAuthenticated:', isAuthenticated, 'disabled:', disabled);

  const [messages, setMessages] = useState<SharedChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [typingName, setTypingName] = useState<string | undefined>(undefined);

  const scrollRef = useRef<HTMLDivElement>(null);

  const currentWalletAddress = user?.walletAddress;

  const load = useCallback(async () => {
    if (!channelId) return;
    setError(null);

    try {
      const data = await getSharedChatMessages(channelId);
      setMessages(data.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  const pollTyping = useCallback(async () => {
    if (!channelId) return;
    try {
      const status = await getTypingStatus(channelId);
      setIsTyping(Boolean(status.typing));
      setTypingName(status.avatarName);
    } catch {
      // ignore
    }
  }, [channelId]);

  useEffect(() => {
    void load();

    const interval = setInterval(() => {
      void load();
    }, 2500);

    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => {
      void pollTyping();
    }, 1200);

    return () => clearInterval(interval);
  }, [pollTyping]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isTyping]);

  const canSend = useMemo(() => {
    if (disabled) return false;
    if (!isAuthenticated) return false;
    return true;
  }, [disabled, isAuthenticated]);

  const handleSend = useCallback(async (content: string) => {
    if (!canSend) return;
    if (!channelId) return;

    setIsSending(true);
    setError(null);

    const optimisticMessage: SharedChatMessage = {
      id: `local-${Date.now()}`,
      channelId,
      content,
      sender: {
        walletAddress: currentWalletAddress || 'unknown',
        displayName: user?.displayName,
        avatarUrl: user?.avatarUrl,
        inhabitedAvatarId: user?.inhabitedAvatarId,
      },
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const result = await sendSharedChatMessage(channelId, content);

      // Replace optimistic message with server message and append avatar response if present
      setMessages((prev) => {
        const withoutOptimistic = prev.filter((m) => m.id !== optimisticMessage.id);
        const next = [...withoutOptimistic, result.message];
        if (result.avatarResponse) next.push(result.avatarResponse);
        return next;
      });
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [canSend, channelId, currentWalletAddress, user?.avatarUrl, user?.displayName, user?.inhabitedAvatarId]);

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-[var(--color-bg)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {messages.map((m) => {
          const isSelf = Boolean(currentWalletAddress && m.sender.walletAddress === currentWalletAddress);
          return (
            <div key={m.id} className={`flex ${isSelf ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 border ${isSelf ? 'bg-brand-600/20 border-brand-500/30' : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)]'}`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-[var(--color-text)] truncate">
                    {displayNameForSender(m.sender)}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    {formatTimestamp(m.timestamp)}
                  </span>
                </div>
                <div className="mt-1 text-sm text-[var(--color-text)] whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}

        {isTyping ? (
          <div className="text-xs text-[var(--color-text-tertiary)] px-2">
            {typingName ? `${typingName} is typing…` : 'Typing…'}
          </div>
        ) : null}
      </div>

      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
        <ChatInput
          onSend={handleSend}
          disabled={!canSend || isSending}
          voiceEnabled={false}
          placeholder={isAuthenticated ? 'Type a message…' : 'Sign in to chat…'}
        />
      </div>
    </div>
  );
}
