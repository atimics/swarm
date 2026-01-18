import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UserSession } from '../types.js';

export interface ChatAccessDeps {
  isAdmin: boolean;
  session: UserSession;
  getAvatar: (avatarId: string) => Promise<{ creatorWallet?: string | null; inhabitantWallet?: string | null } | null>;
  corsHeaders: Record<string, string>;
}

export function createAvatarAccessChecker(deps: ChatAccessDeps) {
  const { isAdmin, session, getAvatar, corsHeaders } = deps;

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
    if (!walletAddress || (avatar.creatorWallet !== walletAddress && avatar.inhabitantWallet !== walletAddress)) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      };
    }

    return null;
  };
}
