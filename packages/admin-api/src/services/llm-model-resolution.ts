export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveChatModel(params: {
  requestModel: unknown;
  avatarModel: unknown;
  defaultModel: string;
}): string {
  return (
    normalizeModel(params.requestModel) ??
    normalizeModel(params.avatarModel) ??
    params.defaultModel
  );
}
