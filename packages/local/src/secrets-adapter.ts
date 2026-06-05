/**
 * LocalSecretsAdapter — routes SecretsManager commands (Get/Put/Delete)
 * through the env-based EncryptedSecretsService.
 */
import type { SecretsService } from '@swarm/core';

export class LocalSecretsAdapter {
  constructor(private secrets: SecretsService) {}

  async send(command: unknown): Promise<Record<string, unknown>> {
    const cmdName = (command as { constructor?: { name?: string } }).constructor?.name ?? '';
    const input = (command as any).input as Record<string, unknown>;

    // Match by name prefix — handles Bun-compiled name mangling
    if (cmdName.startsWith('GetSecretValue')) {
        const secretId = input.SecretId as string;
        try {
          const value = await this.secrets.getSecret(secretId);
          return { $metadata: { httpStatusCode: 200 }, SecretString: value };
        } catch {
          try {
            const json = await this.secrets.getSecretJson(secretId);
            return { $metadata: { httpStatusCode: 200 }, SecretString: JSON.stringify(json) };
          } catch {
            const err = new Error('ResourceNotFoundException') as Error & { $metadata: Record<string, unknown>; name: string };
            err.$metadata = { httpStatusCode: 404 };
            err.name = 'ResourceNotFoundException';
            throw err;
          }
        }
    }

    if (cmdName.startsWith('PutSecretValue')) {
      const secretId = input.SecretId as string;
      const secretString = input.SecretString as string;
      if (secretId && secretString) {
        try { await this.secrets.setSecret(secretId, secretString); await this.secrets.flush(); } catch { /* ok */ }
      }
      return { $metadata: { httpStatusCode: 200 } };
    }

    if (cmdName.startsWith('DeleteSecretValue')) {
      const secretId = input.SecretId as string;
      if (secretId) {
        try { await this.secrets.deleteSecret(secretId); await this.secrets.flush(); } catch { /* ok */ }
      }
      return { $metadata: { httpStatusCode: 200 } };
    }

    throw new Error(`LocalSecretsAdapter: unsupported command "${cmdName}"`);
  }
}
