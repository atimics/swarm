import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAvatarStore } from './store';
import { useWalletAuth } from './store/walletAuth';
import { useAuth } from './store/auth';
import { AvatarSidebar, AvatarLogsPanel, ChatPanel, LandingPage } from './components';

function getLogsAvatarId(pathname: string): string | null {
  const match = pathname.match(/^\/avatars\/([^/]+)\/logs\/?$/);
  return match?.[1] || null;
}

function getInhabitAvatarId(pathname: string): string | null {
  const match = pathname.match(/^\/inhabit\/([^/]+)\/?$/);
  return match?.[1] || null;
}

function App() {
  const { avatars, fetchAvatars, activeAvatarId, syncChatHistory, setActiveAvatar, addMessage } = useAvatarStore();
  const { checkAuth } = useWalletAuth();
  // Use unified auth to check both wallet and Crossmint authentication
  const { isAuthenticated } = useAuth();
  const [initialized, setInitialized] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logsAvatarId, setLogsAvatarId] = useState<string | null>(
    () => getLogsAvatarId(window.location.pathname)
  );
  const [inhabitAvatarId, setInhabitAvatarId] = useState<string | null>(
    () => getInhabitAvatarId(window.location.pathname)
  );
  const [pendingInhabitPrompt, setPendingInhabitPrompt] = useState(Boolean(inhabitAvatarId));

  const isLogsRoute = useMemo(() => Boolean(logsAvatarId), [logsAvatarId]);

  // Check auth status on mount (run once)
  useEffect(() => {
    if (authChecked) return; // Already checked
    
    let mounted = true;
    
    const doAuthCheck = async () => {
      try {
        await checkAuth();
      } catch (e) {
        console.error('[App] Auth check failed:', e);
      }
      if (mounted) {
        setAuthChecked(true);
      }
    };
    
    // Use a timeout as a fallback
    const timeoutId = setTimeout(() => {
      if (mounted) {
        console.warn('[App] Auth check timeout');
        setAuthChecked(true);
      }
    }, 10000);
    
    doAuthCheck();
    
    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [checkAuth, authChecked]);

  // Fetch avatars from backend once authenticated (run once when conditions are met)
  useEffect(() => {
    if (initialized || !authChecked || !isAuthenticated) return;
    
    let mounted = true;
    
    fetchAvatars()
      .catch(console.error)
      .finally(() => {
        if (mounted) setInitialized(true);
      });
    
    return () => { mounted = false; };
  }, [authChecked, isAuthenticated, fetchAvatars, initialized]);

  // Sync chat history from backend when avatar is selected
  // ALWAYS sync on avatar change to ensure cross-device consistency
  useEffect(() => {
    if (activeAvatarId && initialized && !isLogsRoute) {
      const sync = async () => {
        // Always sync from backend - it's the source of truth for cross-device
        await syncChatHistory(activeAvatarId).catch(console.error);

        if (pendingInhabitPrompt && inhabitAvatarId === activeAvatarId) {
          addMessage(activeAvatarId, {
            role: 'assistant',
            content: JSON.stringify({
              action: 'inhabit_avatar',
              avatarId: activeAvatarId,
              label: 'Inhabit this avatar',
              message: 'Tap to inhabit this avatar with your wallet.',
            }),
          });
          setPendingInhabitPrompt(false);
          setInhabitAvatarId(null);
        }
      };

      sync();
    }
  }, [
    activeAvatarId,
    initialized,
    isLogsRoute,
    syncChatHistory,
    pendingInhabitPrompt,
    inhabitAvatarId,
    addMessage,
  ]);

  // Close sidebar when avatar is selected on mobile
  useEffect(() => {
    if (activeAvatarId) {
      setSidebarOpen(false);
    }
  }, [activeAvatarId]);

  useEffect(() => {
    const handlePopState = () => {
      setLogsAvatarId(getLogsAvatarId(window.location.pathname));
      const nextInhabitAvatarId = getInhabitAvatarId(window.location.pathname);
      setInhabitAvatarId(nextInhabitAvatarId);
      setPendingInhabitPrompt(Boolean(nextInhabitAvatarId));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!initialized || !inhabitAvatarId) return;
    const hasAvatar = avatars.some((avatar) => avatar.id === inhabitAvatarId);
    if (hasAvatar && activeAvatarId !== inhabitAvatarId) {
      setActiveAvatar(inhabitAvatarId);
    }
  }, [avatars, activeAvatarId, inhabitAvatarId, initialized, setActiveAvatar]);

  const openLogs = useCallback((avatarId: string) => {
    const nextPath = `/avatars/${avatarId}/logs`;
    window.history.pushState({}, '', nextPath);
    setLogsAvatarId(avatarId);
  }, []);

  const openChat = useCallback(() => {
    window.history.pushState({}, '', '/');
    setLogsAvatarId(null);
  }, []);

  // Show loading state while checking auth (only use local authChecked state)
  if (!authChecked) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-[var(--color-bg)]">
        <div className="flex flex-col items-center gap-4">
          <img src="/swarm.svg" alt="Swarm" className="w-12 h-12 animate-pulse" />
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Show landing page for unauthenticated users
  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)] relative">
      {/* Safe area spacer for iOS status bar */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg-secondary)]" 
        style={{ height: 'env(safe-area-inset-top, 0px)' }} 
      />
      
      {/* Main content area */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/50 z-20 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile unless toggled */}
        <div className={`
          fixed lg:relative inset-y-0 left-0 z-30 
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
          style={{ top: 'env(safe-area-inset-top, 0px)' }}
        >
          <AvatarSidebar onClose={() => setSidebarOpen(false)} />
        </div>

        {/* Main Chat Area */}
        {isLogsRoute && logsAvatarId ? (
          <AvatarLogsPanel
            avatarId={logsAvatarId}
            onMenuClick={() => setSidebarOpen(true)}
            onBack={openChat}
          />
        ) : (
          <ChatPanel
            onMenuClick={() => setSidebarOpen(true)}
            onOpenLogs={openLogs}
          />
        )}
      </div>
      
      {/* Safe area spacer for iOS home indicator */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg)]" 
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }} 
      />
    </div>
  );
}

export default App;
