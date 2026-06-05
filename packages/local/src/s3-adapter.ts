/**
 * LocalS3Adapter — routes S3 commands (PutObject, GetObject, DeleteObject)
 * through the filesystem-backed LocalBlobStore.
 */
import { LocalBlobStore } from './blob-store.js';

export class LocalS3Adapter {
  constructor(private blobs: LocalBlobStore) {}

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const cmdName = command.constructor.name;
    const input = command.input;

    switch (cmdName) {
      case 'PutObjectCommand': {
        const key = input.Key as string;
        const body = input.Body as Buffer | Uint8Array | string;
        const contentType = (input.ContentType as string) ?? 'application/octet-stream';
        const buf = typeof body === 'string'
          ? Buffer.from(body, 'utf-8')
          : Buffer.from(body);
        const url = this.blobs.put(key, buf, contentType);
        return { $metadata: { httpStatusCode: 200 }, url };
      }

      case 'GetObjectCommand': {
        const key = input.Key as string;
        const data = this.blobs.get(key);
        if (!data) {
          const err = new Error('NoSuchKey') as Error & { $metadata: Record<string, unknown>; Code: string };
          err.$metadata = { httpStatusCode: 404 };
          err.Code = 'NoSuchKey';
          throw err;
        }
        return {
          $metadata: { httpStatusCode: 200 },
          Body: data,
          ContentType: 'application/octet-stream',
          ContentLength: data.length,
        };
      }

      case 'DeleteObjectCommand': {
        const key = input.Key as string;
        this.blobs.delete(key);
        return { $metadata: { httpStatusCode: 204 } };
      }

      default:
        throw new Error(`LocalS3Adapter: unsupported command "${cmdName}"`);
    }
  }
}
