export type DynamoDbUpdateExpression = {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
};

function normalizePath(path: string): string[] {
  return path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export class UpdateExpressionBuilder {
  private readonly sets: string[] = [];
  private readonly removes: string[] = [];
  private readonly values: Record<string, unknown> = {};
  private readonly names: Record<string, string> = {};
  private readonly nameKeysBySegment = new Map<string, string>();
  private valueCounter = 0;

  set(path: string, value: unknown): this {
    const segments = normalizePath(path);
    if (segments.length === 0) return this;

    const attrPath = segments.map((segment) => this.nameKey(segment)).join('.');
    const valueKey = this.valueKey();

    this.values[valueKey] = value;
    this.sets.push(`${attrPath} = ${valueKey}`);
    return this;
  }

  remove(path: string): this {
    const segments = normalizePath(path);
    if (segments.length === 0) return this;

    const attrPath = segments.map((segment) => this.nameKey(segment)).join('.');
    this.removes.push(attrPath);
    return this;
  }

  build(): DynamoDbUpdateExpression {
    const expressions: string[] = [];

    if (this.sets.length) {
      expressions.push(`SET ${this.sets.join(', ')}`);
    }

    if (this.removes.length) {
      expressions.push(`REMOVE ${this.removes.join(', ')}`);
    }

    return {
      UpdateExpression: expressions.join(' '),
      ExpressionAttributeNames: this.names,
      ExpressionAttributeValues: this.values,
    };
  }

  private nameKey(segment: string): string {
    const existing = this.nameKeysBySegment.get(segment);
    if (existing) return existing;

    const safe = segment.replace(/[^a-zA-Z0-9_]/g, '_');
    const key = `#n_${safe}_${this.nameKeysBySegment.size}`;
    this.nameKeysBySegment.set(segment, key);
    this.names[key] = segment;
    return key;
  }

  private valueKey(): string {
    this.valueCounter += 1;
    return `:v${this.valueCounter}`;
  }
}
