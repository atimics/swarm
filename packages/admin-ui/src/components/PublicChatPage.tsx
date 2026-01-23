/**
 * Public Chat Page - Wrapper for subdomain chat access
 *
 * This component:
 * 1. Fetches avatar info publicly (no ownership required)
 * 2. Sets up the avatar in the store for ChatPanel
 * 3. Renders ChatPanel with public access mode
 */
import { useEffect, useState, useMemo } from 'react';
import { useAvatarStore } from '../store';
import { useAuth } from '../store/auth';
import { PrivyLoginButton } from './PrivyLoginButton';
import { ChatPanel } from './ChatPanel';
import { getChannelAvatar, type ChannelAvatarInfo } from '../api/sharedChat';

interface PublicChatPageProps {
  botId: string;
}

export function PublicChatPage({ botId }: PublicChatPageProps) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { avatars, setActiveAvatar, fetchAvatars } = useAvatarStore();

  const [avatarInfo, setAvatarInfo] = useState<ChannelAvatarInfo | null>(null);
  const [loadingAvatar, setLoadingAvatar] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // When authenticated and avatar info is loaded, ensure avatar is in store
  useEffect(() => {
    if (!isAuthenticated || !avatarInfo) return;

    // Check if avatar is already in store
    const existingAvatar = avatars.find(a => a.id === botId);
    if (existingAvatar) {
      // Avatar already in store, just set it as active
      setActiveAvatar(botId);
      return;
    }

    // Avatar not in store - fetch avatars (which should include public avatars)
    // Then set the target avatar as active
    void fetchAvatars().then(() => {
      // After fetch, try to set active again
      const store = useAvatarStore.getState();
      const avatarInStore = store.avatars.find(a => a.id === botId);
      if (avatarInStore) {
        setActiveAvatar(botId);
      } else {
        // Avatar still not in store - add it manually as a "public" avatar
        // This allows ChatPanel to display it even if user doesn't own it
        const now = Date.now();
        const publicAvatar = {
          id: botId,
          name: avatarInfo.name,
          description: avatarInfo.description || '',
          avatar: avatarInfo.profileImageUrl || '',
          persona: avatarInfo.persona || '',
          color: '#6366f1', // Default color
          secrets: [],
          status: 'active' as const,
          createdAt: now,
          updatedAt: now,
          // Note: no creatorWallet means this is a public avatar
        };

        // Add to store using setState and set active
        useAvatarStore.setState((state) => ({
          avatars: [...state.avatars, publicAvatar],
        }));
        setActiveAvatar(botId);
      }
    }).catch(console.error);
  }, [isAuthenticated, avatarInfo, avatars, botId, setActiveAvatar, fetchAvatars]);

  // Display name for header
  const displayName = useMemo(() => {
    if (loadingAvatar) return 'Loading...';
    return avatarInfo?.name || botId;
  }, [loadingAvatar, avatarInfo, botId]);

  // Loading state
  if (loadingAvatar || authLoading) {
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

  // Authenticated - render ChatPanel with the public avatar
  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)]">
      {/* Custom header for public chat */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
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
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-[var(--color-text)] truncate">
                {displayName}
              </h1>
              {avatarInfo?.description && (
                <p className="text-xs text-[var(--color-text-muted)] truncate">
                  {avatarInfo.description}
                </p>
              )}
            </div>
          </div>
          <PrivyLoginButton />
        </div>
      </header>

      {/* ChatPanel in full height */}
      <div className="flex-1 min-h-0">
        <ChatPanel />
      </div>
    </div>
  );
}
