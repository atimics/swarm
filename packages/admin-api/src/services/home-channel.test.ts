import { describe, it, expect, spyOn } from 'bun:test';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// Ensure env is set before importing module under test.
process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

import {
  registerHomeChannel,
  removeAvatarFromAllHomeChannels,
} from './home-channel.js';

describe('home-channel registry', () => {
  it('does not overwrite owner when chatId already registered; appends registeredAvatars', async () => {
    const sendSpy = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: any) => {
      if (cmd instanceof GetCommand) {
        return {
          Item: {
            pk: 'HOME_CHANNELS',
            sk: '-1001',
            chatId: '-1001',
            avatarId: 'owner-avatar',
            botUsername: 'ownerbot',
            registeredAt: 1,
            updatedAt: 1,
            registeredAvatars: [{ avatarId: 'owner-avatar', botUsername: 'ownerbot' }],
          },
        } as any;
      }

      if (cmd instanceof PutCommand) {
        const item = (cmd as any).input?.Item;
        expect(item.avatarId).toBe('owner-avatar');
        expect(item.botUsername).toBe('ownerbot');
        expect(item.registeredAvatars).toEqual([
          { avatarId: 'owner-avatar', botUsername: 'ownerbot' },
          { avatarId: 'new-avatar', botUsername: 'newbot' },
        ]);
        return {} as any;
      }

      throw new Error(`Unexpected command: ${cmd?.constructor?.name}`);
    });

    await registerHomeChannel('new-avatar', '-1001', 'newbot');

    sendSpy.mockRestore();
  });

  it('removes avatar from all home channels (transfer owner or delete)', async () => {
    const sendSpy = spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd: any) => {
      if (cmd instanceof QueryCommand) {
        // Two records:
        // - record A owned by avatar-to-delete but has another registrant -> should Put w/ transferred owner
        // - record B owned by someone else but includes avatar-to-delete -> should Put w/ avatar removed
        return {
          Items: [
            {
              pk: 'HOME_CHANNELS',
              sk: '-2001',
              chatId: '-2001',
              avatarId: 'dead-avatar',
              botUsername: 'deadbot',
              registeredAt: 1,
              updatedAt: 1,
              registeredAvatars: [
                { avatarId: 'dead-avatar', botUsername: 'deadbot' },
                { avatarId: 'alive-avatar', botUsername: 'alivebot' },
              ],
            },
            {
              pk: 'HOME_CHANNELS',
              sk: '-2002',
              chatId: '-2002',
              avatarId: 'owner2',
              botUsername: 'owner2bot',
              registeredAt: 1,
              updatedAt: 1,
              registeredAvatars: [
                { avatarId: 'owner2', botUsername: 'owner2bot' },
                { avatarId: 'dead-avatar', botUsername: 'deadbot' },
              ],
            },
          ],
        } as any;
      }

      if (cmd instanceof PutCommand) {
        const item = (cmd as any).input?.Item;
        if (item.chatId === '-2001') {
          expect(item.avatarId).toBe('alive-avatar');
          expect(item.botUsername).toBe('alivebot');
          expect(item.registeredAvatars).toEqual([
            { avatarId: 'alive-avatar', botUsername: 'alivebot' },
          ]);
          return {} as any;
        }

        if (item.chatId === '-2002') {
          expect(item.avatarId).toBe('owner2');
          expect(item.registeredAvatars).toEqual([
            { avatarId: 'owner2', botUsername: 'owner2bot' },
          ]);
          return {} as any;
        }

        throw new Error('Unexpected PutCommand Item');
      }

      if (cmd instanceof DeleteCommand) {
        throw new Error('Should not delete any records in this test');
      }

      throw new Error(`Unexpected command: ${cmd?.constructor?.name}`);
    });

    await removeAvatarFromAllHomeChannels('dead-avatar');

    sendSpy.mockRestore();
  });
});
