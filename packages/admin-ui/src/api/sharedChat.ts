import { API_BASE } from './apiBase';

export interface SharedChatMessage {
  id: string;
  channelId: string;
  content: string;
  sender: {
    walletAddress: string;
    displayName?: string;
    avatarUrl?: string;
    inhabitedAvatarId?: string;
    inhabitedAvatarName?: string;
    isGhost?: boolean;
  };
  timestamp: number;
  replyToId?: string;
}

export async function getSharedChatMessages(channelId: string): Promise<{ messages: SharedChatMessage[]; sender?: SharedChatMessage['sender'] }> {
  const response = await fetch(`${API_BASE}/shared-chat/messages?channelId=${encodeURIComponent(channelId)}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to load messages');
  }

  return response.json() as Promise<{ messages: SharedChatMessage[]; sender?: SharedChatMessage['sender'] }>;
}

export async function sendSharedChatMessage(channelId: string, content: string, replyToId?: string): Promise<SharedChatMessage> {
  const response = await fetch(`${API_BASE}/shared-chat/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ channelId, content, replyToId }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to send message');
  }

  const data = await response.json() as { message: SharedChatMessage };
  return data.message;
}

export async function getSharedChatIdentity(): Promise<{ sender?: SharedChatMessage['sender'] }> {
  const response = await fetch(`${API_BASE}/shared-chat/identity`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to load identity');
  }

  return response.json() as Promise<{ sender?: SharedChatMessage['sender'] }>;
}
