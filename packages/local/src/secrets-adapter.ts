/**
 * LocalSecretsAdapter — routes SecretsManager commands (GetSecretValue)
 * through the env-based FileSecretsService.
 */
import type { SecretsService } from '@swarm/core';

export class LocalSecretsAdapter {
  constructor(private secrets: SecretsService) {}

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const cmdName = command.constructor.name;
    const input = command.input;

    switch (cmdName) {
      case 'GetSecretValueCommand': {
        const secretId = input.SecretId as string;
        try {
          const value = await this.secrets.getSecret(secretId);
          return {
            $metadata: { httpStatusCode: 200 },
            SecretString: value,
          };
        } catch {
          // Try as JSON
          try {
            const json = await this.secrets.getSecretJson(secretId);
            return {
              $metadata: { httpStatusCode: 200 },
              SecretString: JSON.stringify(json),
            };
          } catch {
            const err = new Error('ResourceNotFoundException') as Error & { $metadata: Record<string, unknown>; name: string };
            err.$metadata = { httpStatusCode: 404 };
            err.name = 'ResourceNotFoundException';
            throw err;
          }
        }
      }

      default:
        throw new Error(`LocalSecretsAdapter: unsupported command "${cmdName}"`);
    }
  }
}
