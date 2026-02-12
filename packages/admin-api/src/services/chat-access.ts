import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UserSession } from '../types.js';

export interface ChatAccessDeps {
  isAdmin: boolean;
  session: UserSession;
  getAvatar: (avatarId: string) => Promise<{ creatorWallet?: string | null; inhabitantWallet?: string | null } | null>;
  corsHeaders: Record<string, string>;
  /**
   * Avatar ID resolved from a trusted public subdomain host.
   * When present, any authenticated user may access that specific avatar.
   */
  publicAvatarId?: string | null;
}

export type AccessMode = 'admin' | 'owner' | 'public' | 'denied';

export interface AccessCheckResult {
  error: APIGatewayProxyResultV2 | null;
  mode: AccessMode;
}

export function createAvatarAccessChecker(deps: ChatAccessDeps) {
  const { isAdmin, session, getAvatar, corsHeaders, publicAvatarId } = deps;

  return async (avatarId: string | undefined | null): Promise<APIGatewayProxyResultV2 | null> => {
    if (isAdmin) return null;

    if (!avatarId) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'avatarId is required' }),
      };
    }

    const avatar = await getAvatar(avatarId);
    if (!avatar) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      };
    }

    const walletAddress = session.userId;
    const isOwner = walletAddress && (avatar.creatorWallet === walletAddress || avatar.inhabitantWallet === walletAddress);

    // Allow access if user owns/inhabits the avatar
    if (isOwner) {
      return null;
    }

    // Allow public access only for the avatar resolved from the trusted host context.
    if (publicAvatarId && walletAddress && avatarId === publicAvatarId) {
      return null;
    }

    // Otherwise deny access
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Avatar not found' }),
    };
  };
}

/**
 * Extended access checker that returns both error and access mode
 */
export function createAvatarAccessCheckerWithMode(deps: ChatAccessDeps) {
  const { isAdmin, session, getAvatar, corsHeaders, publicAvatarId } = deps;

  return async (avatarId: string | undefined | null): Promise<AccessCheckResult> => {
    if (isAdmin) {
      return { error: null, mode: 'admin' };
    }

    if (!avatarId) {
      return {
        error: {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId is required' }),
        },
        mode: 'denied',
      };
    }

    const avatar = await getAvatar(avatarId);
    if (!avatar) {
      return {
        error: {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        },
        mode: 'denied',
      };
    }

    const walletAddress = session.userId;
    const isOwner = walletAddress && (avatar.creatorWallet === walletAddress || avatar.inhabitantWallet === walletAddress);

    // Owner/inhabitor gets owner mode
    if (isOwner) {
      return { error: null, mode: 'owner' };
    }

    // Public access only for the avatar resolved from the trusted host context.
    if (publicAvatarId && walletAddress && avatarId === publicAvatarId) {
      return { error: null, mode: 'public' };
    }

    // Deny access
    return {
      error: {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      },
      mode: 'denied',
    };
  };
}
