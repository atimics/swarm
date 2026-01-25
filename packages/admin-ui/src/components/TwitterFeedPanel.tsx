/**
 * Twitter Feed Panel
 *
 * Shows the avatar's Twitter feed including:
 * - Pending posts awaiting review
 * - Posted tweets (from content store)
 * - Simulated feed (for simulation mode avatars)
 *
 * Access modes:
 * - admin: Can approve/reject/cancel posts
 * - readonly: Just viewing (for public webchat)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchTwitterFeed,
  approvePost,
  rejectPost,
  cancelPost,
  setModerationMode,
  type ContentStorePost,
  type ModerationStats,
  type TwitterFeedResponse,
} from '../api/twitter-feed';
import { useActiveAvatar, useAvatarStore } from '../store/avatars';
import { useWalletAuth } from '../store/walletAuth';
import { AvatarDisplay } from './AvatarSidebar';

interface TwitterFeedPanelProps {
  avatarId: string;
  onMenuClick?: () => void;
  onBack?: () => void;
  readOnly?: boolean;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Status badge component
 */
function StatusBadge({ status }: { status: ContentStorePost['status'] }) {
  const colors: Record<ContentStorePost['status'], string> = {
    pending_review: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
    approved: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
    rejected: 'bg-red-500/20 text-red-400 border-red-500/40',
    queued: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
    posted: 'bg-green-500/20 text-green-400 border-green-500/40',
    failed: 'bg-red-500/20 text-red-400 border-red-500/40',
  };

  const labels: Record<ContentStorePost['status'], string> = {
    pending_review: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    queued: 'Queued',
    posted: 'Posted',
    failed: 'Failed',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${colors[status]}`}>
      {labels[status]}
    </span>
  );
}

/**
 * Source badge component
 */
function SourceBadge({ source }: { source: ContentStorePost['source'] }) {
  const colors: Record<ContentStorePost['source'], string> = {
    ingested: 'bg-gray-500/20 text-gray-400',
    generated: 'bg-brand-500/20 text-brand-400',
    simulation: 'bg-cyan-500/20 text-cyan-400',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded ${colors[source]}`}>
      {source}
    </span>
  );
}

/**
 * Post card component
 */
function PostCard({
  post,
  isAdmin,
  onApprove,
  onReject,
  onCancel,
}: {
  post: ContentStorePost;
  isAdmin: boolean;
  onApprove?: (postId: string) => void;
  onReject?: (postId: string, reason: string) => void;
  onCancel?: (postId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const canManage = isAdmin && (post.status === 'pending_review' || post.status === 'approved' || post.status === 'queued');

  const handleReject = () => {
    if (rejectReason.trim() && onReject) {
      onReject(post.postId, rejectReason.trim());
      setShowRejectForm(false);
      setRejectReason('');
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-secondary)]/70 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[var(--color-border)]">
        <StatusBadge status={post.status} />
        <SourceBadge source={post.source} />
        {post.communityName && (
          <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
            {post.communityName}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-xs text-[var(--color-text-muted)]">{formatTime(post.createdAt)}</span>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1 hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
        >
          <svg
            className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="px-3 py-3">
        <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap break-words">
          {post.text}
        </p>

        {/* Media preview */}
        {post.media && post.media.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {post.media.map((m, i) => (
              <div key={i} className="relative w-20 h-20 rounded overflow-hidden bg-[var(--color-bg-tertiary)]">
                <img
                  src={m.url}
                  alt={`Media ${i + 1}`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg)]/50 space-y-2">
          <div className="flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
            <span>ID: {post.postId.slice(0, 8)}...</span>
            <span>Quality: {post.qualityScore}/100</span>
            {post.twitterId && (
              <a
                href={`https://twitter.com/i/status/${post.twitterId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-400 hover:underline"
              >
                View on Twitter
              </a>
            )}
          </div>
          {post.lastError && (
            <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
              Error: {post.lastError}
            </div>
          )}
          {post.reviewReason && (
            <div className="text-xs text-[var(--color-text-secondary)]">
              Rejection reason: {post.reviewReason}
            </div>
          )}
        </div>
      )}

      {/* Action buttons (admin only) */}
      {canManage && (
        <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg)]/30">
          {showRejectForm ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection..."
                className="flex-1 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text)]"
                onKeyDown={(e) => e.key === 'Enter' && handleReject()}
                autoFocus
              />
              <button
                onClick={handleReject}
                disabled={!rejectReason.trim()}
                className="px-3 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 transition-colors"
              >
                Reject
              </button>
              <button
                onClick={() => setShowRejectForm(false)}
                className="px-3 py-1 text-xs rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              {post.status === 'pending_review' && onApprove && (
                <button
                  onClick={() => onApprove(post.postId)}
                  className="px-3 py-1 text-xs rounded bg-green-600 hover:bg-green-500 text-white transition-colors"
                >
                  Approve
                </button>
              )}
              {post.status === 'pending_review' && onReject && (
                <button
                  onClick={() => setShowRejectForm(true)}
                  className="px-3 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                >
                  Reject
                </button>
              )}
              {onCancel && (
                <button
                  onClick={() => onCancel(post.postId)}
                  className="px-3 py-1 text-xs rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Moderation settings card
 */
function ModerationSettings({
  stats,
  onModeChange,
  disabled,
}: {
  stats: ModerationStats;
  onModeChange: (mode: 'pre' | 'post' | 'none') => void;
  disabled?: boolean;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-secondary)]/70 p-4">
      <h3 className="text-sm font-medium text-[var(--color-text)] mb-3">Moderation Settings</h3>

      <div className="grid grid-cols-3 gap-3 mb-4 text-center">
        <div className="p-2 rounded bg-[var(--color-bg-tertiary)]">
          <div className="text-lg font-semibold text-yellow-400">{stats.pendingCount}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Pending</div>
        </div>
        <div className="p-2 rounded bg-[var(--color-bg-tertiary)]">
          <div className="text-lg font-semibold text-green-400">{stats.approvedCount}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Approved</div>
        </div>
        <div className="p-2 rounded bg-[var(--color-bg-tertiary)]">
          <div className="text-lg font-semibold text-red-400">{stats.rejectedCount}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Rejected</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--color-text-secondary)]">Moderation Mode</span>
          <select
            value={stats.moderationMode}
            onChange={(e) => onModeChange(e.target.value as 'pre' | 'post' | 'none')}
            disabled={disabled}
            className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs text-[var(--color-text)] disabled:opacity-50"
          >
            <option value="pre">Pre-moderation (review before posting)</option>
            <option value="post">Post-moderation (review after posting)</option>
            <option value="none">No moderation</option>
          </select>
        </div>

        <div className="text-xs text-[var(--color-text-muted)]">
          {stats.hasGraduated ? (
            <span className="text-green-400">Graduated from mandatory pre-moderation</span>
          ) : (
            <span>Progress: {stats.approvedPostCount}/{stats.autoGraduateAfter} approved posts to graduate</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TwitterFeedPanel({ avatarId, onMenuClick, onBack, readOnly = false }: TwitterFeedPanelProps) {
  const activeAvatar = useActiveAvatar();
  const { setActiveAvatar } = useAvatarStore();
  const { user, isAuthenticated } = useWalletAuth();

  const [feed, setFeed] = useState<TwitterFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'pending' | 'posted' | 'simulated'>('pending');

  // Determine if user has admin access
  const isAdmin = useMemo(() => {
    if (readOnly) return false;
    if (!isAuthenticated || !user) return false;
    const isInhabited = user.inhabitedAvatarId === activeAvatar?.id;
    const isCreator = activeAvatar?.creatorWallet === user.walletAddress;
    return isInhabited || isCreator;
  }, [readOnly, isAuthenticated, user, activeAvatar]);

  // Set active avatar
  useEffect(() => {
    if (avatarId) {
      setActiveAvatar(avatarId);
    }
  }, [avatarId, setActiveAvatar]);

  // Load feed
  const loadFeed = useCallback(async () => {
    if (!avatarId) return;
    setLoading(true);
    setError(null);

    try {
      const data = await fetchTwitterFeed(avatarId);
      setFeed(data);

      // Auto-select tab based on content
      if (data.pendingPosts.length > 0) {
        setActiveTab('pending');
      } else if (data.isSimulationMode && data.simulatedFeed.length > 0) {
        setActiveTab('simulated');
      } else {
        setActiveTab('posted');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  // Action handlers
  const handleApprove = useCallback(async (postId: string) => {
    try {
      await approvePost(avatarId, postId);
      loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve post');
    }
  }, [avatarId, loadFeed]);

  const handleReject = useCallback(async (postId: string, reason: string) => {
    try {
      await rejectPost(avatarId, postId, reason);
      loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject post');
    }
  }, [avatarId, loadFeed]);

  const handleCancel = useCallback(async (postId: string) => {
    if (!confirm('Cancel this post? This cannot be undone.')) return;
    try {
      await cancelPost(avatarId, postId);
      loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel post');
    }
  }, [avatarId, loadFeed]);

  const handleModeChange = useCallback(async (mode: 'pre' | 'post' | 'none') => {
    try {
      await setModerationMode(avatarId, mode);
      loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update moderation mode');
    }
  }, [avatarId, loadFeed]);

  // Get posts for current tab
  const currentPosts = useMemo(() => {
    if (!feed) return [];
    switch (activeTab) {
      case 'pending':
        return feed.pendingPosts;
      case 'posted':
        return feed.recentPosts;
      case 'simulated':
        return feed.simulatedFeed;
      default:
        return [];
    }
  }, [feed, activeTab]);

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
      {/* Header */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
              aria-label="Open menu"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            {activeAvatar && <AvatarDisplay avatar={activeAvatar} size="md" />}
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate flex items-center gap-2">
                <span>{activeAvatar?.name || avatarId}</span>
                <span className="text-[var(--color-text-tertiary)]">Twitter</span>
              </h1>
              <p className="text-xs text-[var(--color-text-tertiary)] truncate">
                {feed?.isSimulationMode && <span className="text-cyan-400">Simulation mode</span>}
                {feed?.isConnected && !feed?.isSimulationMode && <span className="text-green-400">Connected to Twitter</span>}
                {!feed?.isConnected && !feed?.isSimulationMode && <span className="text-[var(--color-text-muted)]">Not connected</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] text-xs font-medium transition-colors"
              >
                Back to chat
              </button>
            )}
            <button
              onClick={loadFeed}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Tab navigation */}
      <div className="border-b border-[var(--color-border)] px-4 lg:px-6 bg-[var(--color-bg-secondary)]">
        <div className="flex gap-4">
          <button
            onClick={() => setActiveTab('pending')}
            className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'pending'
                ? 'border-yellow-500 text-yellow-400'
                : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            Pending
            {feed?.pendingPosts && feed.pendingPosts.length > 0 && (
              <span className="px-1.5 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">
                {feed.pendingPosts.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('posted')}
            className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'posted'
                ? 'border-green-500 text-green-400'
                : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            Posted
          </button>
          {feed?.isSimulationMode && (
            <button
              onClick={() => setActiveTab('simulated')}
              className={`py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'simulated'
                  ? 'border-cyan-500 text-cyan-400'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              Simulated Feed
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 lg:px-6 py-4">
        {loading && (
          <div className="text-center py-8 text-[var(--color-text-tertiary)]">
            Loading feed...
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-4">
            {/* Moderation settings (admin only, pending tab) */}
            {isAdmin && activeTab === 'pending' && feed?.moderationStats && (
              <ModerationSettings
                stats={feed.moderationStats}
                onModeChange={handleModeChange}
                disabled={!isAdmin}
              />
            )}

            {/* Posts list */}
            {currentPosts.length === 0 ? (
              <div className="text-center py-8 text-[var(--color-text-tertiary)]">
                {activeTab === 'pending' && 'No posts pending review.'}
                {activeTab === 'posted' && 'No posts yet.'}
                {activeTab === 'simulated' && 'No simulated posts yet.'}
              </div>
            ) : (
              <div className="space-y-3">
                {currentPosts.map((post) => (
                  <PostCard
                    key={post.postId}
                    post={post}
                    isAdmin={isAdmin}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Read-only notice */}
      {readOnly && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 px-4 py-3 text-center">
          <p className="text-xs text-[var(--color-text-muted)]">
            View only - connect as admin to manage posts
          </p>
        </div>
      )}
    </div>
  );
}
