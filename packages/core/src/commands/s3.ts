/**
 * Local S3 command classes — drop-in replacements for @aws-sdk/client-s3.
 */
export class PutObjectCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class GetObjectCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteObjectCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class ListObjectsV2Command {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
