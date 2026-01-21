/**
 * Autonomous Content Generator Service
 *
 * Generates memory-integrated content for autonomous tweets.
 * Uses avatar memories, persona, and recent posts to create
 * authentic, contextual content.
 */
import type {
  AvatarConfig,
  LLMService,
  MemoryFact,
} from '@swarm/core';
import { DynamoDBStateService } from '@swarm/core';

export type AutonomousContentTargetType = 'tweet' | 'community_post' | 'community_reply';

export interface CommunityContext {
  id: string;
  name: string;
  replyToTweet?: {
    id: string;
    text: string;
    author: string;
  };
}

export interface AutonomousContentParams {
  avatarId: string;
  avatarConfig: AvatarConfig;
  targetType: AutonomousContentTargetType;
  communityContext?: CommunityContext;
}

export interface GeneratedContent {
  text: string;
  imagePrompt?: string;
  imageUrl?: string;
  reasoning?: string;
}

/**
 * Generate autonomous content with memory integration
 */
export async function generateAutonomousContent(
  params: AutonomousContentParams,
  stateService: DynamoDBStateService,
  llmService: LLMService
): Promise<GeneratedContent> {
  const { avatarId, avatarConfig, targetType, communityContext } = params;

  // 1. Recall relevant memories
  const recentFacts = await stateService.getFacts(avatarId, 'recent');

  // Get topic-specific facts if topics are configured
  const topics = avatarConfig.platforms.twitter?.autonomousPosts?.topics;
  const topicFacts: MemoryFact[] = [];
  if (topics && topics.length > 0) {
    for (const topic of topics.slice(0, 3)) { // Limit to 3 topics
      const facts = await stateService.getFacts(avatarId, topic);
      topicFacts.push(...facts);
    }
  }

  // 2. Get recent post history to avoid repetition
  const recentPosts = await stateService.getFacts(avatarId, 'posted_tweet');

  // 3. Build context-aware system prompt
  const charLimit = avatarConfig.platforms.twitter?.charLimit ?? 280;

  const systemPrompt = buildAutonomousPrompt({
    persona: avatarConfig.persona,
    memories: [...recentFacts, ...topicFacts].slice(0, 10),
    recentPosts: recentPosts.slice(0, 5),
    targetType,
    communityContext,
    charLimit,
  });

  // 4. Generate content
  const response = await llmService.generateResponse({
    avatarId,
    systemPrompt,
    messages: [{ role: 'user', content: 'Generate content now.' }],
    config: {
      ...avatarConfig.llm,
      temperature: 0.95, // Higher temperature for more creative posts
    },
  });

  // 5. Save this post as a memory for future reference
  await stateService.saveFact(avatarId, {
    fact: `Posted ${targetType}: "${response.content.slice(0, 100)}..."`,
    about: 'posted_tweet',
    timestamp: Date.now(),
  });

  return {
    text: response.content.trim().slice(0, charLimit),
    reasoning: `Generated based on ${recentFacts.length + topicFacts.length} memories`,
  };
}

interface BuildPromptParams {
  persona: string;
  memories: MemoryFact[];
  recentPosts: MemoryFact[];
  targetType: AutonomousContentTargetType;
  communityContext?: CommunityContext;
  charLimit: number;
}

/**
 * Build the system prompt for autonomous content generation
 */
function buildAutonomousPrompt(params: BuildPromptParams): string {
  const { persona, memories, recentPosts, targetType, communityContext, charLimit } = params;

  let prompt = `${persona}\n\n`;

  // Add memory context
  if (memories.length > 0) {
    prompt += `## Recent Thoughts & Memories\n`;
    prompt += memories.map(m => `- ${m.fact}`).join('\n');
    prompt += '\n\n';
  }

  // Add recent posts to avoid repetition
  if (recentPosts.length > 0) {
    prompt += `## Your Recent Posts (avoid repeating similar content)\n`;
    prompt += recentPosts.map(p => `- ${p.fact}`).join('\n');
    prompt += '\n\n';
  }

  // Add target-specific instructions
  if (targetType === 'community_post' && communityContext) {
    prompt += `## Task: Post to "${communityContext.name}" Community\n`;
    prompt += `Generate a post relevant to this community's interests.\n`;
  } else if (targetType === 'community_reply' && communityContext?.replyToTweet) {
    prompt += `## Task: Reply in "${communityContext.name}" Community\n`;
    prompt += `Reply to this tweet by @${communityContext.replyToTweet.author}:\n`;
    prompt += `"${communityContext.replyToTweet.text}"\n`;
    prompt += `Be engaging and add value to the conversation.\n`;
  } else {
    prompt += `## Task: Generate Tweet\n`;
    prompt += `Create an authentic, engaging tweet that reflects your personality.\n`;
  }

  prompt += `\n## Constraints\n`;
  prompt += `- Maximum ${charLimit} characters\n`;
  prompt += `- Max 1-2 hashtags if any\n`;
  prompt += `- Sound natural, not promotional\n`;
  prompt += `- Draw from your memories to make it personal\n`;
  prompt += `- Be creative and original - don't repeat topics from recent posts\n`;
  prompt += `\nRespond with ONLY the tweet text, nothing else.`;

  return prompt;
}

/**
 * Generate an image prompt based on tweet content
 */
export async function generateImagePrompt(
  tweetText: string,
  avatarConfig: AvatarConfig,
  llmService: LLMService
): Promise<string> {
  const response = await llmService.generateResponse({
    avatarId: avatarConfig.id,
    systemPrompt: `You are a helpful assistant that generates short, evocative image prompts.
Given a tweet, create a brief image prompt (under 100 characters) that would complement the tweet visually.
The image should be interesting and engaging, matching the tweet's mood and topic.
Respond with ONLY the image prompt, nothing else.`,
    messages: [{ role: 'user', content: `Generate an image prompt for this tweet: "${tweetText}"` }],
    config: {
      ...avatarConfig.llm,
      maxTokens: 100,
    },
  });

  return response.content.trim().slice(0, 150);
}
