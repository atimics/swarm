export interface ReplicateValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
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

    if (response.status === 402) {
      return {
        valid: false,
        error: 'Replicate requires billing to be enabled for API access. Please add a payment method at replicate.com/account/billing.',
      };
    }

    if (!response.ok) {
      return {
        valid: false,
        error: `Replicate API error: ${response.status} ${response.statusText}`,
      };
    }

    const account = await response
      .json()
      .catch(() => ({})) as { type?: string; billing_enabled?: boolean };
    const accountType = account.type || 'unknown';
    const billingEnabled = typeof account.billing_enabled === 'boolean'
      ? account.billing_enabled
      : undefined;

    // IMPORTANT: We only validate that the token is accepted by Replicate.
    // Some accounts/tokens may report billing fields differently (or omit them),
    // and blocking on billing here causes false negatives.
    if (billingEnabled === false) {
      return {
        valid: true,
        warning: 'Billing appears disabled on this Replicate account. Some models/usage may require a payment method.',
        accountType,
        billingEnabled,
      };
    }

    return { valid: true, accountType, billingEnabled };
  } catch {
    return { valid: false, error: 'Could not validate API key' };
  }
}
