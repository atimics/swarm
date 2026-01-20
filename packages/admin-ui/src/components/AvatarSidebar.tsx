/**
 * Avatar Sidebar - Discord-like avatar list with tiered access
 *
 * Access Tiers:
 * - No wallet: Browse profiles only (read-only)
 * - Authenticated, no Orb: Browse, chat as ghost, no inhabit/create
 * - Authenticated + Orb, not inhabiting: Can browse, chat, inhabit unclaimed
 * - Inhabiting, has Orbs: Full admin on inhabited, chat on others, can create
 * - Inhabiting, no Orbs: Full admin on inhabited only, chat on others, no create
 */
import { useAvatarStore } from '../store/avatars';
import { useAuth } from '../store/auth';
import { ThemeToggle } from './ThemeToggle';
import { WalletLogin } from './WalletLogin';
import type { Avatar } from '../types';

interface AvatarDisplayProps {
  avatar: Avatar;
  size?: 'sm' | 'md' | 'lg';
  showStatus?: boolean;
}

function AvatarDisplay({ avatar, size = 'md', showStatus = true }: AvatarDisplayProps) {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  const statusColors = {
    shell: 'bg-gray-500',
    configured: 'bg-yellow-500',
    active: 'bg-green-500',
    error: 'bg-red-500',
  };

  return (
    <div className="relative">
      <div
        className={`${sizeClasses[size]} rounded-full overflow-hidden ring-2 ring-brand-600`}
        style={{ backgroundColor: avatar.color }}
      >
        {avatar.avatar ? (
          <img
            src={avatar.avatar}
            alt={avatar.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white font-bold">
            {avatar.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      {showStatus && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--color-bg-secondary)] ${statusColors[avatar.status]}`}
          title={avatar.status}
        />
      )}
    </div>
  );
}

interface AvatarListItemProps {
  avatar: Avatar;
  isActive: boolean;
  onClick: () => void;
}

function AvatarListItem({ avatar, isActive, onClick }: AvatarListItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left ${
        isActive
          ? 'bg-brand-600/20 text-[var(--color-text)] ring-1 ring-brand-600/50'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]'
      }`}
    >
      <AvatarDisplay avatar={avatar} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{avatar.name}</div>
        <div className="text-xs text-[var(--color-text-muted)] truncate">
          {avatar.status === 'shell' && 'Unconfigured'}
          {avatar.status === 'configured' && `${avatar.secrets.filter(s => s.isSet).length} secrets`}
          {avatar.status === 'active' && 'Active'}
          {avatar.status === 'error' && 'Error'}
        </div>
      </div>
    </button>
  );
}

interface AvatarSidebarProps {
  className?: string;
  onClose?: () => void;
  onSelectAvatar?: (avatarId: string) => void;
}

export function AvatarSidebar({ className, onClose, onSelectAvatar }: AvatarSidebarProps) {
  const { avatars, activeAvatarId, createAvatar, setActiveAvatar, isLoading, error } = useAvatarStore();
  const { isAuthenticated, user, gateStatus, account } = useAuth();

  const isAdmin = account?.role === 'admin';

  // Determine access level
  const walletAddress = user?.walletAddress;
  const inhabitedAvatarId = user?.inhabitedAvatarId; // Still uses avatarId from backend
  const hasOrbs = (gateStatus?.nftsHeld || 0) > 0;
  const canCreate = gateStatus?.canCreate || false;

  const bypassRestrictions = isAdmin;

  // Filter avatars based on access level:
  // - If inhabiting with no orbs: only show inhabited avatar
  // - Otherwise: show all avatars
  const filteredAvatars = !bypassRestrictions && inhabitedAvatarId && !hasOrbs
    ? avatars.filter(a => a.id === inhabitedAvatarId)
    : avatars;

  // Sort avatars: inhabited first, then created by user, then others
  const sortedAvatars = [...filteredAvatars].sort((a, b) => {
    // Inhabited avatar always first
    if (a.id === inhabitedAvatarId) return -1;
    if (b.id === inhabitedAvatarId) return 1;
    // Created by user second
    const aCreatedByMe = a.creatorWallet === walletAddress;
    const bCreatedByMe = b.creatorWallet === walletAddress;
    if (aCreatedByMe && !bCreatedByMe) return -1;
    if (bCreatedByMe && !aCreatedByMe) return 1;
    // Then by name
    return a.name.localeCompare(b.name);
  });

  const handleCreateAvatar = async () => {
    try {
      await createAvatar();
    } catch (e) {
      // Error is already set in store
      console.error('Failed to create avatar:', e);
    }
  };

  const handleSelectAvatar = (avatarId: string) => {
    if (onSelectAvatar) {
      // Use callback from parent to handle URL state sync
      onSelectAvatar(avatarId);
    } else {
      setActiveAvatar(avatarId);
    }
    onClose?.();
  };

  // Determine if create button should be shown (visible when authenticated, but may be disabled)
  const showCreateButton = isAuthenticated;
  const canCreateAvatar = canCreate;

  const gateNftsHeld = gateStatus?.nftsHeld ?? 0;
  const gateAvatarsCreated = gateStatus?.avatarsCreated ?? 0;
  const totalSlotsRaw = 1 + gateNftsHeld;
  const totalSlots = Number.isFinite(totalSlotsRaw) ? totalSlotsRaw : 1;
  const usedSlots = Math.max(0, Math.min(totalSlots, totalSlots - (gateStatus?.availableSlots ?? 0)));
  const maxSlotOrbs = 10;
  const displaySlots = Math.min(totalSlots, maxSlotOrbs);
  const hiddenSlots = Math.max(0, totalSlots - displaySlots);

  // Get reason why creation is disabled (for tooltip)
  const getCreateDisabledReason = (): string | null => {
    if (!isAuthenticated) return 'Sign in to create avatars';
    if (canCreate) return null;
    if ((gateStatus?.availableSlots ?? 0) <= 0) {
      return gateStatus?.nftsHeld === 0
        ? 'You need an Orb NFT to create more avatars'
        : 'No available slots - all your Orbs are bound to avatars';
    }
    return 'Cannot create avatar at this time';
  };
  const createDisabledReason = getCreateDisabledReason();

  return (
    <div className={`w-72 lg:w-64 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col h-full ${className || ''}`}>
      {/* Header */}
      <div className="p-4 border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/swarm.svg" alt="Swarm" className="w-7 h-7" />
            <h2 className="font-semibold text-[var(--color-text)]">Avatars</h2>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {showCreateButton && (
              <button
                onClick={handleCreateAvatar}
                disabled={isLoading || !canCreateAvatar}
                className={`w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors ${
                  isLoading || !canCreateAvatar ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                title={createDisabledReason || `Create new avatar (${gateStatus?.availableSlots || 0} slots available)`}
                data-testid="create-avatar-button"
                aria-label="Create new avatar"
              >
                {isLoading ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-5 h-5"
                  >
                    <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                  </svg>
                )}
              </button>
            )}
            {/* Close button - only on mobile */}
            {onClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {error && (
          <div className="mt-2 text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {error}
          </div>
        )}
      </div>

      {/* Avatar List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* Slot Orbs (wallet gating) */}
        {isAuthenticated && gateStatus && !bypassRestrictions && (
          <div className="px-2 py-2 mb-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                Slots
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {gateStatus.availableSlots} available • {gateAvatarsCreated} used
              </div>
            </div>

            <div className="flex items-center gap-2">
              {Array.from({ length: displaySlots }).map((_, idx) => {
                const slotIndex = idx + 1;
                const isFree = slotIndex === 1;
                const isUsed = idx < usedSlots;
                const isAvailable = !isUsed;
                const clickable = isAvailable && canCreateAvatar && !isLoading;

                const baseClass =
                  'w-7 h-7 rounded-full flex items-center justify-center border transition-colors';
                const className = isUsed
                  ? `${baseClass} bg-brand-600/70 border-brand-500/70`
                  : `${baseClass} bg-[var(--color-bg-secondary)] border-[var(--color-border)] hover:border-brand-500/60`;

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={clickable ? handleCreateAvatar : undefined}
                    disabled={!clickable}
                    className={`${className} ${clickable ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
                    title={
                      isFree
                        ? isUsed
                          ? 'Free slot (used)'
                          : clickable
                          ? 'Free slot (click to create)'
                          : 'Free slot'
                        : isUsed
                        ? 'Orb slot (used)'
                        : clickable
                        ? 'Orb slot (click to create)'
                        : 'Orb slot'
                    }
                    aria-label={isFree ? 'Free slot' : 'Orb slot'}
                  >
                    <div
                      className={
                        isFree
                          ? 'w-3 h-3 rounded-full bg-yellow-300/90'
                          : 'w-3 h-3 rounded-full bg-white/90'
                      }
                    />
                  </button>
                );
              })}

              {hiddenSlots > 0 && (
                <div className="text-xs text-[var(--color-text-muted)] px-1">
                  +{hiddenSlots}
                </div>
              )}
            </div>

            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              1 free slot • +1 per Orb NFT
            </div>
          </div>
        )}

        {/* Prominent New Avatar Button */}
        {showCreateButton && (
          <button
            onClick={handleCreateAvatar}
            disabled={isLoading || !canCreateAvatar}
            className={`w-full flex items-center gap-3 px-3 py-3 mb-2 rounded-lg border-2 border-dashed transition-all ${
              isLoading || !canCreateAvatar
                ? 'opacity-50 cursor-not-allowed border-gray-500/30 text-gray-500'
                : 'border-brand-500/50 hover:border-brand-500 hover:bg-brand-500/10 text-brand-400 hover:text-brand-300'
            }`}
            data-testid="create-avatar-button"
            aria-label={createDisabledReason || 'Create new avatar'}
            title={createDisabledReason || undefined}
          >
            {isLoading ? (
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : !canCreateAvatar ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
              >
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
              >
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
            )}
            <span className="font-medium">
              {!canCreateAvatar ? 'Get an Orb to Create' : 'Create Avatar'}
            </span>
            {canCreateAvatar && gateStatus?.availableSlots !== undefined && (
              <span className="ml-auto text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] px-2 py-0.5 rounded-full" aria-hidden="true">
                {gateStatus.availableSlots === 1 && gateStatus.nftsHeld === 0
                  ? '1 free slot'
                  : `${gateStatus.availableSlots} slot${gateStatus.availableSlots !== 1 ? 's' : ''}`}
              </span>
            )}
          </button>
        )}

        {isLoading && avatars.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)]">
            <svg className="w-6 h-6 animate-spin mx-auto mb-2" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-sm">Loading avatars...</p>
          </div>
        ) : sortedAvatars.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)]">
            <p className="text-sm">
              {inhabitedAvatarId && !hasOrbs
                ? 'You need an Orb to view other avatars'
                : 'No avatars yet'}
            </p>
          </div>
        ) : (
          <>
            {/* Section: Your Avatar (if inhabiting) */}
            {inhabitedAvatarId && sortedAvatars.some(a => a.id === inhabitedAvatarId) && (
              <div className="mb-2">
                <div className="px-2 py-1 text-xs font-medium text-brand-400 uppercase tracking-wider">
                  Your Avatar
                </div>
                {sortedAvatars.filter(a => a.id === inhabitedAvatarId).map((avatar) => (
                  <AvatarListItem
                    key={avatar.id}
                    avatar={avatar}
                    isActive={avatar.id === activeAvatarId}
                    onClick={() => handleSelectAvatar(avatar.id)}
                  />
                ))}
              </div>
            )}

            {/* Section: Other Avatars (if has orbs or not inhabiting yet) */}
            {(hasOrbs || !inhabitedAvatarId) && sortedAvatars.filter(a => a.id !== inhabitedAvatarId).length > 0 && (
              <div>
                {inhabitedAvatarId && (
                  <div className="px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                    Other Avatars
                  </div>
                )}
                {sortedAvatars.filter(a => a.id !== inhabitedAvatarId).map((avatar) => (
                  <AvatarListItem
                    key={avatar.id}
                    avatar={avatar}
                    isActive={avatar.id === activeAvatarId}
                    onClick={() => handleSelectAvatar(avatar.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Wallet Login Footer */}
      <div className="p-3 border-t border-[var(--color-border)]">
        <WalletLogin />
      </div>
    </div>
  );
}

export { AvatarDisplay };

