/**
 * Twitter Feed API
 *
 * API client for content store posts and simulated feed.
 */
import { API_BASE } from './apiBase';

/**
 * Post in the content store
 */
export interface ContentStorePost {
  postId: string;
  avatarId: string;
  text: string;
  media?: Array<{ type: string; url: string }>;
  source: 'ingested' | 'generated' | 'simulation';
  status: 'pending_review' | 'approved' | 'rejected' | 'queued' | 'posted' | 'failed';
  qualityScore: number;
  twitterId?: string;
  communityId?: string;
  communityName?: string;
  createdAt: number;
  reviewerId?: string;
  reviewReason?: string;
  lastError?: string;
}

/**
 * Moderation configuration
 */
export interface ModerationConfig {
  mode: 'pre' | 'post' | 'none';
  autoGraduateAfter: number;
  requireApprovalFor: ('tweets' | 'replies' | 'media')[];
  approvedPostCount: number;
  hasGraduated: boolean;
}

/**
 * Moderation statistics
 */
export interface ModerationStats {
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  moderationMode: 'pre' | 'post' | 'none';
  hasGraduated: boolean;
  approvedPostCount: number;
  autoGraduateAfter: number;
}

/**
 * Twitter feed response
 */
export interface TwitterFeedResponse {
  pendingPosts: ContentStorePost[];
  recentPosts: ContentStorePost[];
  simulatedFeed: ContentStorePost[];
  moderationStats?: ModerationStats;
  isSimulationMode: boolean;
  isConnected: boolean;
}

/**
 * Fetch Twitter feed for an avatar
 */
export async function fetchTwitterFeed(avatarId: string): Promise<TwitterFeedResponse> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/twitter/feed`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Twitter feed: ${response.status}`);
  }

  return response.json();
}

/**
 * Approve a pending post
 */
export async function approvePost(avatarId: string, postId: string): Promise<ContentStorePost> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/twitter/posts/${encodeURIComponent(postId)}/approve`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to approve post: ${response.status}`);
  }

  return response.json();
}

/**
 * Reject a pending post
 */
export async function rejectPost(avatarId: string, postId: string, reason: string): Promise<ContentStorePost> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/twitter/posts/${encodeURIComponent(postId)}/reject`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });

  if (!response.ok) {
    throw new Error(`Failed to reject post: ${response.status}`);
  }

  return response.json();
}

/**
 * Delete/cancel a pending post
 */
export async function cancelPost(avatarId: string, postId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/twitter/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to cancel post: ${response.status}`);
  }
}

/**
 * Update moderation mode
 */
export async function setModerationMode(avatarId: string, mode: 'pre' | 'post' | 'none'): Promise<ModerationConfig> {
  const response = await fetch(`${API_BASE}/avatars/${encodeURIComponent(avatarId)}/twitter/moderation`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error(`Failed to set moderation mode: ${response.status}`);
  }

  return response.json();
}
