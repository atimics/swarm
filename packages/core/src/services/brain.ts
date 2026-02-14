import type { MemoryFact, StateService } from '../types/service.js';

export interface BrainMemoryFact extends MemoryFact {
  strength?: number;
  source?: 'legacy' | 'canonical';
}

export interface BrainRememberResult {
  saved: boolean;
  source: 'legacy' | 'canonical' | 'dual';
  legacySaved?: boolean;
  canonicalSaved?: boolean;
}

export interface BrainRecallResult {
  source: 'legacy' | 'canonical' | 'hybrid';
  facts: BrainMemoryFact[];
}

export interface BrainService {
  remember(avatarId: string, fact: string, about?: string, userId?: string): Promise<BrainRememberResult>;
  recall(avatarId: string, query: string, userId?: string): Promise<BrainRecallResult>;
}

export function createLegacyBrainService(stateService: Pick<StateService, 'saveFact' | 'getFacts'>): BrainService {
  return {
    async remember(avatarId: string, fact: string, about?: string, userId?: string): Promise<BrainRememberResult> {
      await stateService.saveFact(avatarId, {
        fact,
        about,
        userId,
        timestamp: Date.now(),
      });

      return {
        saved: true,
        source: 'legacy',
        legacySaved: true,
      };
    },

    async recall(avatarId: string, query: string, userId?: string): Promise<BrainRecallResult> {
      const facts = await stateService.getFacts(avatarId, query, userId);
      return {
        source: 'legacy',
        facts: facts.map((item) => ({
          ...item,
          source: 'legacy',
        })),
      };
    },
  };
}
