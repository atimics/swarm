export interface ReplicateValidationResult {
  valid: boolean;
  error?: string;
  accountType?: string;
  billingEnabled?: boolean;
}

export async function validateReplicateApiKey(apiKey: string, deps?: { fetchFn?: typeof fetch }): Promise<ReplicateValidationResult> {
  const fetchFn = deps?.fetchFn ?? fetch;

  try {
    const response = await fetchFn('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key. Please check your Replicate dashboard.' };
    }

    const account = await response.json() as { type?: string; billing_enabled?: boolean };
    const accountType = account.type || 'unknown';
    const billingEnabled = Boolean(account.billing_enabled);

    if (!billingEnabled) {
      return {
        valid: false,
        error: 'Replicate requires billing to be enabled for API access. Please add a payment method at replicate.com/account/billing.',
        accountType,
        billingEnabled,
      };
    }

    return { valid: true, accountType, billingEnabled };
  } catch {
    return { valid: false, error: 'Could not validate API key' };
  }
}
