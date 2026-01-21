/**
 * Twitter Usage Service - Track and enforce Twitter API credit limits
 *
 * Twitter API has read quotas (tweets/month):
 * - Free tier: 100 tweets/month
 * - Basic tier: 15,000 tweets/month
 *
 * This service tracks global usage across all avatars since they share
 * a single Twitter API account.
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type TwitterApiTier = 'free' | 'basic';

export interface TwitterUsageConfig {
  tier: TwitterApiTier;
  monthlyBudget: number;
  dailyReservePct: number; // Percentage to reserve for spikes (0-100)
}

export interface GlobalTwitterUsage {
  tier: TwitterApiTier;
  monthlyBudget: number;
  usedThisMonth: number;
  usedToday: number;
  monthKey: string;      // '2024-01' for monthly reset
  dayKey: string;        // '2024-01-15' for daily tracking
  lastPollAt: number;
}

export interface TwitterBudget {
  daily: number;
  monthly: number;
  usedToday: number;
  usedThisMonth: number;
}

export interface TwitterPollConfig {
  tier: TwitterApiTier;
  monthlyBudget: number;
  dailyBudget: number;
  perAvatarDaily: number;
  pollIntervalMinutes: number;
  maxMentionsPerPoll: number;
}

const TIER_BUDGETS: Record<TwitterApiTier, number> = {
  free: 100,
  basic: 15000,
};

// Default polling rate: every 5 minutes = 288 polls/day
const POLLS_PER_DAY = 288;

export class TwitterUsageService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;
  private config: TwitterUsageConfig;

  constructor(
    tableName: string,
    config: TwitterUsageConfig,
    docClient?: DynamoDBDocumentClient
  ) {
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({ region: 'us-east-1' });
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      });
    }
    this.tableName = tableName;
    this.config = config;
  }

  /**
   * Get current date keys for month and day boundaries
   */
  private getDateKeys(): { monthKey: string; dayKey: string } {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const dayKey = `${monthKey}-${String(now.getUTCDate()).padStart(2, '0')}`;
    return { monthKey, dayKey };
  }

  /**
   * Get current global Twitter API usage
   */
  async getGlobalUsage(): Promise<GlobalTwitterUsage> {
    const { monthKey, dayKey } = this.getDateKeys();

    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: 'TWITTER_USAGE',
        sk: 'GLOBAL',
      },
    }));

    const item = result.Item as GlobalTwitterUsage | undefined;

    if (!item) {
      // No record exists, return initial state
      return {
        tier: this.config.tier,
        monthlyBudget: this.config.monthlyBudget || TIER_BUDGETS[this.config.tier],
        usedThisMonth: 0,
        usedToday: 0,
        monthKey,
        dayKey,
        lastPollAt: 0,
      };
    }

    // Check for month/day boundary resets
    let usedThisMonth = item.usedThisMonth;
    let usedToday = item.usedToday;

    if (item.monthKey !== monthKey) {
      // New month - reset both counters
      usedThisMonth = 0;
      usedToday = 0;
    } else if (item.dayKey !== dayKey) {
      // Same month, new day - reset daily counter only
      usedToday = 0;
    }

    return {
      tier: item.tier || this.config.tier,
      monthlyBudget: item.monthlyBudget || this.config.monthlyBudget || TIER_BUDGETS[this.config.tier],
      usedThisMonth,
      usedToday,
      monthKey,
      dayKey,
      lastPollAt: item.lastPollAt || 0,
    };
  }

  /**
   * Record mentions that were read from the Twitter API
   */
  async recordMentionsRead(count: number): Promise<void> {
    if (count <= 0) return;

    const { monthKey, dayKey } = this.getDateKeys();
    const now = Date.now();

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: 'TWITTER_USAGE',
        sk: 'GLOBAL',
      },
      UpdateExpression: `
        SET usedThisMonth = if_not_exists(usedThisMonth, :zero) + :count,
            usedToday = if_not_exists(usedToday, :zero) + :count,
            monthKey = :monthKey,
            dayKey = :dayKey,
            lastPollAt = :now,
            tier = if_not_exists(tier, :tier),
            monthlyBudget = if_not_exists(monthlyBudget, :budget),
            updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ':count': count,
        ':zero': 0,
        ':monthKey': monthKey,
        ':dayKey': dayKey,
        ':now': now,
        ':tier': this.config.tier,
        ':budget': this.config.monthlyBudget || TIER_BUDGETS[this.config.tier],
      },
    }));
  }

  /**
   * Check if we can read more mentions within budget
   */
  async canReadMoreMentions(requestedCount: number): Promise<boolean> {
    const budget = await this.getRemainingBudget();
    return budget.daily >= requestedCount && budget.monthly >= requestedCount;
  }

  /**
   * Get remaining budget for daily and monthly limits
   */
  async getRemainingBudget(): Promise<TwitterBudget> {
    const usage = await this.getGlobalUsage();

    const daysInMonth = 30; // Use fixed 30 for simplicity
    const dailyBudgetRaw = Math.floor(usage.monthlyBudget / daysInMonth);
    const dailyBudgetSafe = Math.floor(dailyBudgetRaw * (1 - this.config.dailyReservePct / 100));

    return {
      daily: Math.max(0, dailyBudgetSafe - usage.usedToday),
      monthly: Math.max(0, usage.monthlyBudget - usage.usedThisMonth),
      usedToday: usage.usedToday,
      usedThisMonth: usage.usedThisMonth,
    };
  }

  /**
   * Calculate safe polling parameters based on tier and avatar count
   */
  getPollConfig(avatarCount: number): TwitterPollConfig {
    const budget = this.config.monthlyBudget || TIER_BUDGETS[this.config.tier];
    const daysInMonth = 30;
    const dailyBudget = Math.floor(budget / daysInMonth);

    // Apply reserve percentage
    const safeDailyBudget = Math.floor(dailyBudget * (1 - this.config.dailyReservePct / 100));

    // Distribute across avatars
    const perAvatarDaily = avatarCount > 0
      ? Math.floor(safeDailyBudget / avatarCount)
      : safeDailyBudget;

    // Calculate max mentions per poll based on polling frequency
    const maxMentionsPerPoll = Math.max(1, Math.floor(perAvatarDaily / POLLS_PER_DAY));

    return {
      tier: this.config.tier,
      monthlyBudget: budget,
      dailyBudget: safeDailyBudget,
      perAvatarDaily,
      pollIntervalMinutes: 5,
      maxMentionsPerPoll,
    };
  }
}

/**
 * Factory function to create a Twitter usage service
 */
export function createTwitterUsageService(
  tableName: string,
  config?: Partial<TwitterUsageConfig>,
  region?: string
): TwitterUsageService {
  const tier = (config?.tier || process.env.TWITTER_API_TIER || 'basic') as TwitterApiTier;
  const monthlyBudget = config?.monthlyBudget
    || (process.env.TWITTER_MONTHLY_BUDGET ? parseInt(process.env.TWITTER_MONTHLY_BUDGET, 10) : undefined)
    || TIER_BUDGETS[tier];
  const dailyReservePct = config?.dailyReservePct
    || (process.env.TWITTER_DAILY_RESERVE_PCT ? parseInt(process.env.TWITTER_DAILY_RESERVE_PCT, 10) : 20);

  const fullConfig: TwitterUsageConfig = {
    tier,
    monthlyBudget,
    dailyReservePct,
  };

  if (region) {
    const client = new DynamoDBClient({ region });
    const docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    return new TwitterUsageService(tableName, fullConfig, docClient);
  }

  return new TwitterUsageService(tableName, fullConfig);
}
