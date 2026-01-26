/**
 * Public Chat Page - Wrapper for subdomain chat access
 *
 * This component:
 * 1. Fetches avatar info publicly (no ownership required)
 * 2. Sets up the avatar in the store for ChatPanel
 * 3. Renders ChatPanel with public access mode
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../store/auth';
import { bootstrapAuthFromBackendSession } from '../auth/bootstrap';
import { PrivyLoginButton } from './PrivyLoginButton';
import { SharedChatPanel } from './SharedChatPanel';
import { TwitterFeedPanel } from './TwitterFeedPanel';
import { getChannelAvatar, type ChannelAvatarInfo } from '../api/sharedChat';

interface PublicChatPageProps {
  botId: string;
}

export function PublicChatPage({ botId }: PublicChatPageProps) {
  const { isAuthenticated, isLoading: authLoading, gateStatus } = useAuth();

  // Debug: trace PublicChatPage render
  console.log('[PublicChatPage] Rendering with botId:', botId, 'isAuthenticated:', isAuthenticated, 'authLoading:', authLoading);

  const [authChecked, setAuthChecked] = useState(false);

  const [avatarInfo, setAvatarInfo] = useState<ChannelAvatarInfo | null>(null);
  const [loadingAvatar, setLoadingAvatar] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const getViewFromPath = useCallback((): 'chat' | 'twitter' => {
    const path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/twitter' || path === '/twitter/feed' || path.startsWith('/twitter/')) return 'twitter';
    return 'chat';
  }, []);

  const [view, setView] = useState<'chat' | 'twitter'>(() => getViewFromPath());

  // Bootstrap auth from backend cookie/session on public subdomains.
  // Without this, Privy sessions can exist (cookie) while the UI still thinks
  // it's unauthenticated because provider localStorage is origin-scoped.
  useEffect(() => {
    if (authChecked) return;

    let mounted = true;

    const doAuthCheck = async () => {
      await bootstrapAuthFromBackendSession();
      if (mounted) setAuthChecked(true);
    };

    const timeoutId = setTimeout(() => {
      if (mounted) {
        console.warn('[PublicChatPage] Auth check timeout');
        setAuthChecked(true);
      }
    }, 10000);

    void doAuthCheck();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [authChecked]);

  // Keep view in sync with browser navigation.
  useEffect(() => {
    const onPopState = () => setView(getViewFromPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [getViewFromPath]);

  // Fetch avatar info on mount (public endpoint, no auth required)
  useEffect(() => {
    async function fetchAvatar() {
      try {
        const result = await getChannelAvatar(botId);
        if (result.avatar) {
          setAvatarInfo(result.avatar);
        } else {
          setError('Avatar not found');
        }
      } catch (err) {
        console.error('Failed to load avatar info:', err);
        setError(err instanceof Error ? err.message : 'Failed to load avatar');
      } finally {
        setLoadingAvatar(false);
      }
    }
    void fetchAvatar();
  }, [botId]);

  // If auth status changes, default back to chat
  useEffect(() => {
    if (!isAuthenticated) setView('chat');
  }, [isAuthenticated]);

  // Display name for header
  const displayName = useMemo(() => {
    if (loadingAvatar) return 'Loading...';
    return avatarInfo?.name || botId;
  }, [loadingAvatar, avatarInfo, botId]);

  const description = avatarInfo?.description || '';

  // Loading state
  if (!authChecked || loadingAvatar || authLoading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
            <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
              <div className="h-full w-full animate-pulse bg-[var(--color-bg-tertiary)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">Chat with</p>
              <h1 className="truncate text-lg font-semibold">Loading...</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
            <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <span className="text-white text-lg font-bold">?</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">Chat with</p>
              <h1 className="truncate text-lg font-semibold">{botId}</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-4 text-center">
            <p className="text-red-200">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Not authenticated - show login prompt with avatar info
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
            <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
              {avatarInfo?.profileImageUrl ? (
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
              {description ? (
                description.length > 60 ? (
                  <div className="mt-0.5 min-w-0">
                    <span
                      className="text-xs text-[var(--color-text-muted)] marquee"
                      aria-label={description}
                      style={{
                        ['--marquee-duration' as never]: `${Math.min(140, Math.max(36, Math.round(description.length * 0.45)))}s`,
                      }}
                    >
                      <span className="marquee__inner">{description}</span>
                    </span>
                  </div>
                ) : (
                  <p className="truncate text-xs text-[var(--color-text-muted)]">{description}</p>
                )
              ) : null}
            </div>
            <div className="ml-auto">
              <PrivyLoginButton />
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 text-center max-w-md">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
              {avatarInfo?.profileImageUrl ? (
                <img
                  src={avatarInfo.profileImageUrl}
                  alt={avatarInfo.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-white text-2xl font-bold">
                  {avatarInfo?.name?.[0]?.toUpperCase() || '?'}
                </div>
              )}
            </div>
            <h2 className="text-lg font-semibold">{displayName}</h2>
            {avatarInfo?.description && (
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                {avatarInfo.description}
              </p>
            )}
            <div className="mt-6">
              <PrivyLoginButton />
            </div>
            <p className="mt-4 text-xs text-[var(--color-text-tertiary)]">
              Sign in to start chatting
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Determine if user is an Orb holder (affects message limits)
  const isOrbHolder = (gateStatus?.nftsHeld ?? 0) > 0;
  const dailyLimit = isOrbHolder ? 100 : 10;

  const effectiveAvatarId = avatarInfo?.avatarId || botId;

  // Debug: trace authenticated render
  console.log('[PublicChatPage] Rendering authenticated view for botId:', botId, 'view:', view, 'isOrbHolder:', isOrbHolder);

  // Authenticated - render SharedChatPanel with the public avatar
  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)]">
      {/* Custom header for public chat */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
              {avatarInfo?.profileImageUrl ? (
                <img
                  src={avatarInfo.profileImageUrl}
                  alt={avatarInfo.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-white font-bold">
                  {avatarInfo?.name?.[0]?.toUpperCase() || '?'}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-[var(--color-text)] truncate">
                  {displayName}
                </h1>
                {/* Limited Mode indicator */}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    isOrbHolder
                      ? 'bg-brand-500/20 text-brand-400'
                      : 'bg-yellow-500/20 text-yellow-400'
                  }`}
                  title={isOrbHolder ? `Orb holder: ${dailyLimit}/day` : `Limited: ${dailyLimit}/day. Hold an Orb for 100/day.`}
                >
                  {isOrbHolder ? 'Orb' : 'Limited'}
                </span>
              </div>
              {description ? (
                description.length > 60 ? (
                  <div className="mt-0.5 min-w-0">
                    <span
                      className="text-xs text-[var(--color-text-muted)] marquee"
                      aria-label={description}
                      style={{
                        ['--marquee-duration' as never]: `${Math.min(140, Math.max(36, Math.round(description.length * 0.45)))}s`,
                      }}
                    >
                      <span className="marquee__inner">{description}</span>
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-text-muted)] truncate">{description}</p>
                )
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                const nextView = view === 'chat' ? 'twitter' : 'chat';
                setView(nextView);
                try {
                  window.history.pushState({}, '', nextView === 'twitter' ? '/twitter' : '/');
                } catch {
                  // ignore
                }
              }}
              className="px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] text-xs font-medium transition-colors"
            >
              {view === 'chat' ? 'Twitter' : 'Back to chat'}
            </button>
            <PrivyLoginButton />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {view === 'chat' ? (
          <SharedChatPanel channelId={botId} />
        ) : (
          <TwitterFeedPanel
            avatarId={effectiveAvatarId}
            readOnly
            hideHeader
            onBack={() => setView('chat')}
          />
        )}
      </div>
    </div>
  );
}
