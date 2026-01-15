import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentStore } from './store';
import { useWalletAuth } from './store/walletAuth';
import { AgentSidebar, AgentLogsPanel, ChatPanel, LandingPage } from './components';

function getLogsAgentId(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/([^/]+)\/logs\/?$/);
  return match?.[1] || null;
}

function getInhabitAgentId(pathname: string): string | null {
  const match = pathname.match(/^\/inhabit\/([^/]+)\/?$/);
  return match?.[1] || null;
}

function App() {
  const { agents, fetchAgents, activeAgentId, syncChatHistory, setActiveAgent, addMessage } = useAgentStore();
  const { isAuthenticated, checkAuth } = useWalletAuth();
  const [initialized, setInitialized] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logsAgentId, setLogsAgentId] = useState<string | null>(
    () => getLogsAgentId(window.location.pathname)
  );
  const [inhabitAgentId, setInhabitAgentId] = useState<string | null>(
    () => getInhabitAgentId(window.location.pathname)
  );
  const [pendingInhabitPrompt, setPendingInhabitPrompt] = useState(Boolean(inhabitAgentId));

  const isLogsRoute = useMemo(() => Boolean(logsAgentId), [logsAgentId]);

  // Check auth status on mount with timeout protection
  useEffect(() => {
    if (!authChecked) {
      const timeoutId = setTimeout(() => {
        // If auth check takes too long, assume not authenticated and continue
        console.warn('[App] Auth check timeout - continuing without auth');
        setAuthChecked(true);
      }, 10000); // 10 second timeout
      
      checkAuth()
        .finally(() => {
          clearTimeout(timeoutId);
          setAuthChecked(true);
        });
      
      return () => clearTimeout(timeoutId);
    }
  }, [authChecked, checkAuth]);

  // Fetch agents from backend once authenticated
  useEffect(() => {
    if (!initialized && authChecked && isAuthenticated) {
      fetchAgents()
        .catch(console.error)
        .finally(() => setInitialized(true));
    }
  }, [initialized, authChecked, isAuthenticated, fetchAgents]);

  // Sync chat history from backend when agent is selected
  // ALWAYS sync on agent change to ensure cross-device consistency
  useEffect(() => {
    if (activeAgentId && initialized && !isLogsRoute) {
      const sync = async () => {
        // Always sync from backend - it's the source of truth for cross-device
        await syncChatHistory(activeAgentId).catch(console.error);

        if (pendingInhabitPrompt && inhabitAgentId === activeAgentId) {
          addMessage(activeAgentId, {
            role: 'assistant',
            content: JSON.stringify({
              action: 'inhabit_agent',
              agentId: activeAgentId,
              label: 'Inhabit this agent',
              message: 'Tap to inhabit this agent with your wallet.',
            }),
          });
          setPendingInhabitPrompt(false);
          setInhabitAgentId(null);
        }
      };

      sync();
    }
  }, [
    activeAgentId,
    initialized,
    isLogsRoute,
    syncChatHistory,
    pendingInhabitPrompt,
    inhabitAgentId,
    addMessage,
  ]);

  // Close sidebar when agent is selected on mobile
  useEffect(() => {
    if (activeAgentId) {
      setSidebarOpen(false);
    }
  }, [activeAgentId]);

  useEffect(() => {
    const handlePopState = () => {
      setLogsAgentId(getLogsAgentId(window.location.pathname));
      const nextInhabitAgentId = getInhabitAgentId(window.location.pathname);
      setInhabitAgentId(nextInhabitAgentId);
      setPendingInhabitPrompt(Boolean(nextInhabitAgentId));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!initialized || !inhabitAgentId) return;
    const hasAgent = agents.some((agent) => agent.id === inhabitAgentId);
    if (hasAgent && activeAgentId !== inhabitAgentId) {
      setActiveAgent(inhabitAgentId);
    }
  }, [agents, activeAgentId, inhabitAgentId, initialized, setActiveAgent]);

  const openLogs = useCallback((agentId: string) => {
    const nextPath = `/agents/${agentId}/logs`;
    window.history.pushState({}, '', nextPath);
    setLogsAgentId(agentId);
  }, []);

  const openChat = useCallback(() => {
    window.history.pushState({}, '', '/');
    setLogsAgentId(null);
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
          <AgentSidebar onClose={() => setSidebarOpen(false)} />
        </div>

        {/* Main Chat Area */}
        {isLogsRoute && logsAgentId ? (
          <AgentLogsPanel
            agentId={logsAgentId}
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
