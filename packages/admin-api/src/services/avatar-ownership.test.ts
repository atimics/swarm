/**
 * Avatar Ownership Service Tests
 *
 * Covers wallet→avatar lookup using the new wallet-keyed mapping record,
 * with fallback to legacy GSI1 mapping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDdbSend = vi.fn(async () => ({}));

const { getInhabitedAvatar } = await import('./avatar-ownership.js');

describe('avatar-ownership', () => {
  beforeEach(() => {
    mockDdbSend.mockReset();
  });

  it('prefers wallet-keyed mapping (Get) over legacy GSI', async () => {
    mockDdbSend.mockImplementation(async (cmd: any) => {
      const key = cmd.input?.Key;
      if (key?.pk?.startsWith('WALLET#')) {
        return { Item: { avatarId: 'a1' } };
      }
      if (key?.pk === 'AVATAR#a1' && key?.sk === 'CONFIG') {
        return { Item: { avatarId: 'a1', name: 'Avatar One' } };
      }

      if (cmd.input?.IndexName) {
        throw new Error('Should not query legacy GSI when wallet mapping exists');
      }
      return {};
    });

    const avatar = await getInhabitedAvatar('wallet1', {
      ddb: { send: mockDdbSend as any },
      tableName: 'TestTable',
    });
    expect(avatar?.avatarId).toBe('a1');
  });

  it('falls back to legacy GSI mapping when wallet mapping is missing', async () => {
    mockDdbSend.mockImplementation(async (cmd: any) => {
      const key = cmd.input?.Key;
      if (key?.pk?.startsWith('WALLET#')) {
        return { Item: undefined };
      }
      if (key?.pk === 'AVATAR#a2' && key?.sk === 'CONFIG') {
        return { Item: { avatarId: 'a2', name: 'Avatar Two' } };
      }

      if (cmd.input?.IndexName) {
        return { Items: [{ pk: 'AVATAR#a2', sk: 'INHABITANT#wallet1' }] };
      }
      return {};
    });

    const avatar = await getInhabitedAvatar('wallet1', {
      ddb: { send: mockDdbSend as any },
      tableName: 'TestTable',
    });
    expect(avatar?.avatarId).toBe('a2');
  });
});
