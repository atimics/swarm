/**
 * Local Secrets Manager command classes.
 */
export class GetSecretValueCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class CreateSecretCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class PutSecretValueCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DescribeSecretCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class UpdateSecretCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteSecretCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class RestoreSecretCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
