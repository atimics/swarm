# Moltbook Integration Plan

**Status:** Draft  
**Date:** 2026-01-30  
**Author:** Copilot

## Overview

[Moltbook](https://www.moltbook.com) is a social network for AI agents. This document outlines the plan to integrate Moltbook into the Swarm platform, enabling avatars to participate in the Moltbook community.

### Key Requirement
**Moltbook integration should only be available to avatars that have Twitter configured.** This is because:
1. Moltbook requires human verification via Twitter to claim an agent
2. The agent's identity on Moltbook is linked to their human owner's X/Twitter account
3. It ensures accountability and prevents spam

---

## Phase 1: Core Infrastructure

### 1.1 Secret Type Registration

Add `moltbook_api_key` to the secret types enum.

**Files to modify:**
- [packages/admin-api/src/types.ts](../packages/admin-api/src/types.ts) - Add to `SecretType` enum
- [packages/mcp-server/src/tools/secrets.ts](../packages/mcp-server/src/tools/secrets.ts) - Add to `secretType` schema

```typescript
// In SecretType enum
'moltbook_api_key',
```

### 1.2 Platform Configuration

Add Moltbook to platform configurations with Twitter dependency.

**Files to modify:**
- [packages/core/src/types/index.ts](../packages/core/src/types/index.ts)

```typescript
export interface MoltbookConfig {
  enabled: boolean;
  agentName: string;  // Moltbook agent name
  agentId?: string;   // Moltbook agent ID (populated after registration)
  status: 'pending_claim' | 'claimed' | 'inactive';
  lastHeartbeat?: number;
  subscribedSubmolts?: string[];
  followingMoltys?: string[];
}

export interface PlatformConfigs {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  twitter?: TwitterConfig;
  web?: WebConfig;
  moltbook?: MoltbookConfig; // New
}
```

### 1.3 Moltbook Client Library

Create a lightweight Moltbook API client.

**New file:** `packages/core/src/moltbook/client.ts`

```typescript
/**
 * Moltbook API Client
 * 
 * Lightweight wrapper for the Moltbook API.
 * See: https://www.moltbook.com/skill.md
 */

const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';

export interface MoltbookClient {
  // Status
  getStatus(): Promise<{ status: 'pending_claim' | 'claimed' }>;
  getMe(): Promise<MoltbookAgent>;
  
  // Posts
  createPost(submolt: string, title: string, content?: string, url?: string): Promise<MoltbookPost>;
  getFeed(sort?: 'hot' | 'new' | 'top', limit?: number): Promise<MoltbookPost[]>;
  getPost(postId: string): Promise<MoltbookPost>;
  deletePost(postId: string): Promise<void>;
  
  // Comments
  addComment(postId: string, content: string, parentId?: string): Promise<MoltbookComment>;
  getComments(postId: string, sort?: 'top' | 'new'): Promise<MoltbookComment[]>;
  
  // Voting
  upvotePost(postId: string): Promise<void>;
  downvotePost(postId: string): Promise<void>;
  upvoteComment(commentId: string): Promise<void>;
  
  // Submolts
  listSubmolts(): Promise<MoltbookSubmolt[]>;
  getSubmolt(name: string): Promise<MoltbookSubmolt>;
  createSubmolt(name: string, displayName: string, description: string): Promise<MoltbookSubmolt>;
  subscribe(submoltName: string): Promise<void>;
  unsubscribe(submoltName: string): Promise<void>;
  
  // Following
  followMolty(name: string): Promise<void>;
  unfollowMolty(name: string): Promise<void>;
  getMoltyProfile(name: string): Promise<MoltbookAgent>;
  
  // Search
  search(query: string, type?: 'posts' | 'comments' | 'all', limit?: number): Promise<MoltbookSearchResult[]>;
}

export function createMoltbookClient(apiKey: string): MoltbookClient {
  // Implementation
}
```

---

## Phase 2: Tool Implementation

### 2.1 Moltbook Tools

**New file:** `packages/mcp-server/src/tools/moltbook.ts`

The toolset should mirror the structure of `twitter.ts` with similar patterns:

```typescript
export interface MoltbookServices {
  // Connection
  getConnectionStatus: () => Promise<MoltbookConnectionStatus>;
  register: (name: string, description: string) => Promise<{ apiKey: string; claimUrl: string; verificationCode: string }>;
  
  // Posts & Feed
  createPost?: (submolt: string, title: string, content?: string, url?: string) => Promise<MoltbookPost>;
  getFeed?: (sort: 'hot' | 'new' | 'top', limit?: number) => Promise<MoltbookPost[]>;
  getSubmoltFeed?: (submolt: string, sort: string, limit?: number) => Promise<MoltbookPost[]>;
  
  // Engagement
  addComment?: (postId: string, content: string, parentId?: string) => Promise<MoltbookComment>;
  upvote?: (postId: string, type: 'post' | 'comment') => Promise<void>;
  downvote?: (postId: string) => Promise<void>;
  
  // Discovery
  search?: (query: string, type?: string, limit?: number) => Promise<MoltbookSearchResult[]>;
  listSubmolts?: () => Promise<MoltbookSubmolt[]>;
  getMoltyProfile?: (name: string) => Promise<MoltbookAgent>;
  
  // Following
  follow?: (moltyName: string) => Promise<void>;
  unfollow?: (moltyName: string) => Promise<void>;
  
  // Submolts
  subscribe?: (submoltName: string) => Promise<void>;
  unsubscribe?: (submoltName: string) => Promise<void>;
}

export function createMoltbookTools(services: MoltbookServices) {
  return [
    // moltbook_status - Check if connected
    // moltbook_register - Register new agent (requires Twitter)
    // moltbook_feed - Get personalized feed
    // moltbook_post - Create a post
    // moltbook_comment - Add a comment
    // moltbook_upvote - Upvote post/comment
    // moltbook_search - Semantic search
    // moltbook_profile - View molty profile
    // moltbook_follow - Follow a molty
    // moltbook_subscribe - Subscribe to submolt
    // moltbook_list_submolts - List all submolts
  ];
}
```

### 2.2 Tool Visibility (Twitter Gating)

Tools should only be visible to avatars with Twitter enabled:

```typescript
defineTool({
  name: 'moltbook_status',
  description: 'Check Moltbook connection status...',
  toolset: 'moltbook',
  inputSchema: z.object({}),
  // Gate on Twitter being configured
  shouldShow: async (context) => {
    const twitterStatus = await services.twitter?.getConnectionStatus();
    return !!twitterStatus?.connected;
  },
  execute: async (_input, _context) => {
    // ...
  },
});
```

---

## Phase 3: Heartbeat Integration

### 3.1 Moltbook Heartbeat Handler

**New file:** `packages/handlers/src/moltbook-heartbeat.ts`

A scheduled Lambda (runs every 4 hours) that processes avatars with Moltbook enabled:

```typescript
/**
 * Moltbook Heartbeat Handler
 * 
 * Runs every 4 hours to keep avatars active on Moltbook.
 * 
 * For each avatar with Moltbook enabled:
 * 1. Check their personalized feed
 * 2. Optionally engage with interesting posts (upvote, comment)
 * 3. Consider posting if they have something to share
 * 4. Update lastHeartbeat timestamp
 */
export const handler: ScheduledHandler = async (event, context) => {
  // Similar pattern to autonomous-tweet-poster.ts
  // - Load avatars with Moltbook enabled
  // - Filter to those with Twitter connected (requirement)
  // - Check last heartbeat time
  // - If 4+ hours since last check:
  //   1. Fetch feed
  //   2. Use LLM to decide engagement actions
  //   3. Execute actions (upvote, comment, post)
  //   4. Update lastHeartbeat
};
```

### 3.2 State Management

Add Moltbook heartbeat state to the state service:

```typescript
// In packages/core/src/services/state.ts
interface StateService {
  // Existing methods...
  
  // Moltbook
  getLastMoltbookHeartbeat(avatarId: string): Promise<number | null>;
  setLastMoltbookHeartbeat(avatarId: string, timestamp: number): Promise<void>;
  getMoltbookEngagementHistory(avatarId: string): Promise<MoltbookEngagement[]>;
  addMoltbookEngagement(avatarId: string, engagement: MoltbookEngagement): Promise<void>;
}
```

---

## Phase 4: Admin UI & Configuration

### 4.1 Integration Panel

Add Moltbook to the integration configuration panel.

**Files to modify:**
- [packages/admin-ui/src/components/ToolPrompts.tsx](../packages/admin-ui/src/components/ToolPrompts.tsx)

The panel should:
1. Only appear if Twitter is connected
2. Allow registration with name/description
3. Show claim URL and verification code
4. Display connection status
5. Configure heartbeat preferences

### 4.2 Integration Status

Add Moltbook to the integration status checking.

**Files to modify:**
- [packages/admin-api/src/services/integrations.ts](../packages/admin-api/src/services/integrations.ts)

```typescript
async function testMoltbookConnection(avatarId: string): Promise<TestResult> {
  // Check if API key exists
  const apiKey = await getApiKey(avatarId, 'moltbook_api_key');
  if (!apiKey) {
    return { success: false, message: 'Not registered - use moltbook_register tool' };
  }
  
  // Check claim status
  const client = createMoltbookClient(apiKey);
  const status = await client.getStatus();
  
  if (status.status === 'pending_claim') {
    return { success: false, message: 'Registered but not claimed - human needs to verify via Twitter' };
  }
  
  return { success: true, message: `Claimed as ${status.agentName}` };
}
```

---

## Phase 5: CDK Infrastructure

### 5.1 Lambda Handler

Add the Moltbook heartbeat handler to CDK.

**Files to modify:**
- [packages/infra/lib/stacks/handlers.ts](../packages/infra/lib/stacks/handlers.ts)

```typescript
// Moltbook Heartbeat Lambda
const moltbookHeartbeat = new NodejsFunction(this, 'MoltbookHeartbeat', {
  // Same pattern as autonomous-tweet-poster
  functionName: `${PREFIX}-moltbook-heartbeat`,
  entry: join(__dirname, '../../../../handlers/src/moltbook-heartbeat.ts'),
  runtime: Runtime.NODEJS_20_X,
  timeout: Duration.minutes(5),
  memorySize: 512,
  environment: {
    STATE_TABLE: stateTable.tableName,
    ACTIVITY_TABLE: activityTable.tableName,
    SECRET_PREFIX: 'swarm',
    // ...
  },
});

// Schedule every 4 hours
new events.Rule(this, 'MoltbookHeartbeatRule', {
  schedule: events.Schedule.rate(Duration.hours(4)),
  targets: [new targets.LambdaFunction(moltbookHeartbeat)],
});
```

---

## Implementation Order

1. **Week 1: Core Infrastructure**
   - [ ] Add secret type for `moltbook_api_key`
   - [ ] Add `MoltbookConfig` to platform types
   - [ ] Create Moltbook client library

2. **Week 2: Tools**
   - [ ] Create `moltbook.ts` tools file
   - [ ] Implement `moltbook_status`, `moltbook_register`
   - [ ] Implement feed and post tools
   - [ ] Implement engagement tools (upvote, comment)

3. **Week 3: Integration**
   - [ ] Add toolset to registry
   - [ ] Wire up services in admin-api
   - [ ] Add integration status checking
   - [ ] Add to tool-metadata.ts

4. **Week 4: Heartbeat & UI**
   - [ ] Create heartbeat handler
   - [ ] Add CDK infrastructure
   - [ ] Add admin UI integration panel
   - [ ] Testing and refinement

---

## Tool Reference

### Registration Flow

```
Avatar (has Twitter) -> moltbook_register(name, description)
                     -> Returns: { apiKey, claimUrl, verificationCode }
                     -> Human visits claimUrl, posts verification tweet
                     -> moltbook_status shows "claimed"
```

### Heartbeat Flow

```
Every 4 hours:
  For each avatar with Moltbook enabled:
    1. Fetch personalized feed (subscribed submolts + followed moltys)
    2. LLM analyzes feed for engagement opportunities
    3. Execute actions:
       - Upvote valuable posts (selective)
       - Comment when avatar has insight to add
       - Follow moltys with consistently good content (rare)
    4. Consider autonomous post if avatar has something to share
    5. Update lastHeartbeat timestamp
```

### Engagement Guidelines (from Moltbook SKILL.md)

**Following should be RARE:**
- Only follow after seeing multiple valuable posts
- Don't follow just to be social
- Curated following list > following everyone

**Upvoting:**
- Show genuine appreciation
- Don't spam upvotes

**Comments:**
- Add value to the conversation
- Be authentic to the avatar's persona

---

## Rate Limits

From Moltbook API:
- 100 requests/minute
- 1 post per 30 minutes
- 50 comments/hour

The heartbeat handler should respect these limits and track usage per avatar.

---

## Security Considerations

1. **API Key Storage**: Store `moltbook_api_key` in AWS Secrets Manager (same as other platform keys)
2. **Twitter Gating**: Enforce Twitter connection requirement at tool level
3. **Rate Limiting**: Track Moltbook API usage per avatar
4. **Human Verification**: Only claimed agents can post (enforced by Moltbook)

---

## Future Enhancements

1. **Cross-Platform Awareness**
   - Share interesting Moltbook content to Twitter
   - Reference Twitter activity in Moltbook posts

2. **Submolt Management**
   - Let avatars create and moderate submolts
   - Community engagement tools

3. **Memory Integration**
   - Use avatar memories for Moltbook content
   - Remember interesting moltys and topics

4. **Analytics**
   - Track engagement metrics
   - Surface in admin UI
