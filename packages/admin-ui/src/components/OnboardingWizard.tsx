import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  executeOnboardingStep,
  getOnboardingStatus,
  isOnboardingEndpointUnavailable,
  OnboardingApiError,
  restartOnboarding,
  skipOptionalOnboardingStep,
  SUPPORTED_ONBOARDING_CONTRACT_VERSION,
  type OnboardingAction,
  type OnboardingStatus,
  type OnboardingStep,
} from '../api/onboarding';
import { buildStepTelemetry, trackOnboardingTelemetry } from '../utils/onboardingTelemetry';

interface OnboardingWizardProps {
  avatarId: string;
  onMenuClick?: () => void;
  onBackToChat?: () => void;
}

const KNOWN_ACTION_TYPES = new Set(['execute', 'retry', 'continue', 'skip_optional', 'restart']);

function normalizeStatus(value: string | undefined): string {
  return (value || '').toLowerCase().trim();
}

function isStepSuccessStatus(value: string | undefined): boolean {
  const normalized = normalizeStatus(value);
  return normalized === 'completed' || normalized === 'verified' || normalized === 'success' || normalized === 'done';
}

function isStepFailureStatus(value: string | undefined): boolean {
  const normalized = normalizeStatus(value);
  return normalized === 'failed' || normalized === 'error' || normalized === 'blocked' || normalized === 'invalid';
}

function isStepSkippedStatus(value: string | undefined): boolean {
  return normalizeStatus(value) === 'skipped';
}

function isOnboardingCompleted(status: OnboardingStatus): boolean {
  const state = normalizeStatus(status.state);
  if (state === 'completed' || state === 'done' || state === 'activated' || state === 'success') {
    return true;
  }

  const activationStep = status.steps.find((step) => step.id === 'activation');
  return isStepSuccessStatus(activationStep?.status);
}

function getStepTone(status: string): string {
  const normalized = normalizeStatus(status);
  if (isStepSuccessStatus(normalized)) return 'text-green-300 bg-green-900/30 border-green-700/40';
  if (isStepFailureStatus(normalized)) return 'text-red-300 bg-red-900/30 border-red-700/40';
  if (normalized === 'in_progress' || normalized === 'running') return 'text-brand-200 bg-brand-900/30 border-brand-700/40';
  if (isStepSkippedStatus(normalized)) return 'text-slate-300 bg-slate-700/30 border-slate-600/40';
  return 'text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] border-[var(--color-border)]';
}

function getStepResult(step: OnboardingStep | null): 'success' | 'failure' | 'skipped' {
  if (!step) return 'success';
  if (isStepSkippedStatus(step.status)) return 'skipped';
  if (isStepFailureStatus(step.status)) return 'failure';
  return 'success';
}

function getActionLabel(action: OnboardingAction): string {
  if (action.label && action.label.trim()) return action.label;

  switch (action.type) {
    case 'execute':
      return 'Execute Step';
    case 'retry':
      return 'Retry Step';
    case 'continue':
      return 'Continue';
    case 'skip_optional':
      return 'Skip Optional Step';
    case 'restart':
      return 'Restart Onboarding';
    default:
      return action.type;
  }
}

function getPreferredPrimaryAction(actions: OnboardingAction[]): OnboardingAction | null {
  const ordered = ['execute', 'retry', 'continue'];

  for (const type of ordered) {
    const found = actions.find((action) => action.type === type);
    if (found) return found;
  }

  return null;
}

function getKnownActions(actions: OnboardingAction[] | undefined): OnboardingAction[] {
  if (!actions || actions.length === 0) return [];
  return actions.filter((action) => KNOWN_ACTION_TYPES.has(action.type));
}

export function OnboardingWizard({ avatarId, onMenuClick, onBackToChat }: OnboardingWizardProps) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endpointUnavailable, setEndpointUnavailable] = useState(false);
  const [unsupportedContract, setUnsupportedContract] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ stepId?: string; actionType: string } | null>(null);

  const lastActiveStepRef = useRef<OnboardingStep | null>(null);
  const latestStatusRef = useRef<OnboardingStatus | null>(null);
  const hasResumedEventRef = useRef(false);
  const hasCompletedEventRef = useRef(false);
  const warnedUnknownActionsRef = useRef<Set<string>>(new Set());

  const steps = status?.steps || [];

  const activeStep = useMemo(() => {
    if (!status || steps.length === 0) return null;

    if (status.currentStepId) {
      const exactStep = steps.find((step) => step.id === status.currentStepId);
      if (exactStep) return exactStep;
    }

    const nextWithActions = steps.find((step) => (step.validNextActions || []).length > 0);
    return nextWithActions || steps[0] || null;
  }, [status, steps]);

  const stepActions = useMemo(() => {
    return getKnownActions(activeStep?.validNextActions);
  }, [activeStep]);

  const primaryAction = useMemo(() => {
    return getPreferredPrimaryAction(stepActions);
  }, [stepActions]);

  const secondaryActions = useMemo(() => {
    return stepActions.filter((action) => action !== primaryAction);
  }, [stepActions, primaryAction]);

  const globalActions = useMemo(() => {
    return getKnownActions(status?.globalActions);
  }, [status]);

  const refreshStatus = useCallback(async (background: boolean) => {
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
      setError(null);
      setEndpointUnavailable(false);
      setUnsupportedContract(false);
    }

    try {
      const nextStatus = await getOnboardingStatus(avatarId);
      setStatus(nextStatus);
      setEndpointUnavailable(false);
      setUnsupportedContract(nextStatus.contractVersion !== SUPPORTED_ONBOARDING_CONTRACT_VERSION);

      if (!hasResumedEventRef.current) {
        const hasProgress = nextStatus.steps.some((step) => {
          const stepStatus = normalizeStatus(step.status);
          return stepStatus !== 'pending' && stepStatus !== 'not_started' && stepStatus !== 'todo';
        });

        if (hasProgress) {
          hasResumedEventRef.current = true;
          trackOnboardingTelemetry('onboarding_resumed', {
            avatarId,
            ...buildStepTelemetry(nextStatus, null),
          });
        }
      }
    } catch (err) {
      if (isOnboardingEndpointUnavailable(err)) {
        setEndpointUnavailable(true);
        setError('Onboarding backend endpoints are not available in this environment.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load onboarding status');
      }
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }, [avatarId]);

  useEffect(() => {
    hasResumedEventRef.current = false;
    hasCompletedEventRef.current = false;
    lastActiveStepRef.current = null;
    warnedUnknownActionsRef.current = new Set();
    void refreshStatus(false);
  }, [avatarId, refreshStatus]);

  useEffect(() => {
    latestStatusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!status) return;

    for (const step of status.steps) {
      for (const action of step.validNextActions || []) {
        if (KNOWN_ACTION_TYPES.has(action.type)) continue;

        const key = `${step.id}:${action.type}`;
        if (warnedUnknownActionsRef.current.has(key)) continue;
        warnedUnknownActionsRef.current.add(key);
        console.warn('[OnboardingWizard] Ignoring unknown onboarding action type from backend contract', {
          avatarId,
          stepId: step.id,
          actionType: action.type,
        });
      }
    }
  }, [status, avatarId]);

  useEffect(() => {
    if (!status || !activeStep) return;

    const previousStep = lastActiveStepRef.current;
    if (previousStep && previousStep.id !== activeStep.id) {
      trackOnboardingTelemetry('onboarding_stage_exit', {
        avatarId,
        ...buildStepTelemetry(status, previousStep),
        result: getStepResult(previousStep),
      });
    }

    if (!previousStep || previousStep.id !== activeStep.id) {
      trackOnboardingTelemetry('onboarding_stage_enter', {
        avatarId,
        ...buildStepTelemetry(status, activeStep),
      });
      lastActiveStepRef.current = activeStep;
    }
  }, [status, activeStep, avatarId]);

  useEffect(() => {
    if (!status || hasCompletedEventRef.current) return;
    if (!isOnboardingCompleted(status)) return;

    const completionStep = status.steps.find((step) => step.id === 'activation') || activeStep;
    hasCompletedEventRef.current = true;

    trackOnboardingTelemetry('onboarding_completed', {
      avatarId,
      ...buildStepTelemetry(status, completionStep || null),
      result: 'success',
    });
  }, [status, activeStep, avatarId]);

  useEffect(() => {
    return () => {
      const latestStatus = latestStatusRef.current;
      if (!latestStatus || hasCompletedEventRef.current) return;

      const latestActiveStep = latestStatus.steps.find((step) => step.id === latestStatus.currentStepId) || lastActiveStepRef.current;

      trackOnboardingTelemetry('onboarding_abandoned', {
        avatarId,
        ...buildStepTelemetry(latestStatus, latestActiveStep || null),
        result: 'abandoned',
      });
    };
  }, [avatarId]);

  const runAction = useCallback(async (action: OnboardingAction, step: OnboardingStep | null) => {
    if (pendingAction) return;
    if (action.disabled) return;

    setError(null);
    setPendingAction({ stepId: step?.id, actionType: action.type });

    const telemetryContext = {
      avatarId,
      ...buildStepTelemetry(status, step),
      actionType: action.type,
    };

    trackOnboardingTelemetry('onboarding_action_initiated', telemetryContext);

    try {
      let nextStatus: OnboardingStatus | null = null;

      switch (action.type) {
        case 'execute':
        case 'retry':
        case 'continue':
          if (!step) {
            throw new Error('Cannot execute onboarding action without a step context');
          }
          nextStatus = await executeOnboardingStep(avatarId, step.id);
          break;
        case 'skip_optional':
          if (!step) {
            throw new Error('Cannot skip onboarding step without a step context');
          }
          nextStatus = await skipOptionalOnboardingStep(avatarId, step.id);
          break;
        case 'restart':
          nextStatus = await restartOnboarding(avatarId);
          break;
        default:
          return;
      }

      if (nextStatus) {
        setStatus(nextStatus);
        setEndpointUnavailable(false);
        setUnsupportedContract(nextStatus.contractVersion !== SUPPORTED_ONBOARDING_CONTRACT_VERSION);
      } else {
        await refreshStatus(true);
      }

      trackOnboardingTelemetry('onboarding_action_completed', {
        ...telemetryContext,
        result: action.type === 'skip_optional' ? 'skipped' : 'success',
      });
    } catch (err) {
      if (isOnboardingEndpointUnavailable(err)) {
        setEndpointUnavailable(true);
      }

      const message = err instanceof Error ? err.message : 'Onboarding action failed';
      setError(message);

      trackOnboardingTelemetry('onboarding_action_failed', {
        ...telemetryContext,
        result: 'failure',
        errorClass: err instanceof OnboardingApiError ? err.errorClass : undefined,
        errorCode: err instanceof OnboardingApiError ? err.errorCode : undefined,
      });
    } finally {
      setPendingAction(null);
    }
  }, [avatarId, pendingAction, refreshStatus, status]);

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
        <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
          <div className="flex items-center gap-3 lg:gap-4">
            {onMenuClick && (
              <button
                onClick={onMenuClick}
                className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
                aria-label="Open menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)]">Avatar Onboarding</h1>
              <p className="text-xs text-[var(--color-text-tertiary)]">Loading setup status...</p>
            </div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between gap-3 lg:gap-4">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            {onMenuClick && (
              <button
                onClick={onMenuClick}
                className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
                aria-label="Open menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate">Avatar Onboarding</h1>
              <p className="text-xs text-[var(--color-text-tertiary)] truncate">
                {isRefreshing ? 'Refreshing status...' : 'Backend-driven setup flow'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshStatus(true)}
              disabled={Boolean(pendingAction) || isRefreshing}
              className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors disabled:opacity-50"
            >
              Refresh
            </button>
            {onBackToChat && (
              <button
                type="button"
                onClick={onBackToChat}
                className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
              >
                Back to Chat
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4">
        <div className="max-w-4xl mx-auto space-y-4">
          {error && (
            <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {endpointUnavailable ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 lg:p-5 space-y-3">
              <h2 className="text-base font-semibold text-[var(--color-text)]">Onboarding API unavailable</h2>
              <p className="text-sm text-[var(--color-text-secondary)]">
                This branch does not expose onboarding orchestrator endpoints yet. You can continue configuring the avatar from chat.
              </p>
              {onBackToChat && (
                <button
                  type="button"
                  onClick={onBackToChat}
                  className="px-3 py-2 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-500 transition-colors"
                >
                  Open Chat Setup
                </button>
              )}
            </div>
          ) : unsupportedContract ? (
            <div className="rounded-xl border border-amber-700/40 bg-amber-900/20 p-4 lg:p-5 space-y-2">
              <h2 className="text-base font-semibold text-amber-200">Unsupported onboarding contract</h2>
              <p className="text-sm text-amber-100/90">
                Received contract version <span className="font-mono">{status?.contractVersion || 'unknown'}</span>. This UI requires{' '}
                <span className="font-mono">{SUPPORTED_ONBOARDING_CONTRACT_VERSION}</span>.
              </p>
            </div>
          ) : !status ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 lg:p-5">
              <p className="text-sm text-[var(--color-text-secondary)]">Onboarding status is currently unavailable.</p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 lg:p-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-[var(--color-text)]">Setup Steps</h2>
                  <div className="text-xs text-[var(--color-text-muted)] font-mono">attempt: {status.attemptId || 'n/a'}</div>
                </div>

                <ol className="space-y-2">
                  {steps.map((step, index) => {
                    const isActive = activeStep?.id === step.id;
                    return (
                      <li
                        key={step.id}
                        className={`rounded-lg border px-3 py-2 ${
                          isActive
                            ? 'border-brand-500/50 bg-brand-600/10'
                            : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-[var(--color-text)] truncate">
                              {index + 1}. {step.title || step.id}
                            </div>
                            <div className="text-xs text-[var(--color-text-muted)]">
                              {step.requirement || 'required'}
                            </div>
                          </div>
                          <span className={`text-xs px-2 py-1 rounded-full border whitespace-nowrap ${getStepTone(step.status)}`}>
                            {step.status}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {activeStep && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 lg:p-5 space-y-4">
                  <div>
                    <h3 className="text-base font-semibold text-[var(--color-text)]">Current Step: {activeStep.title || activeStep.id}</h3>
                    <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                      Requirement: {activeStep.requirement}
                    </p>
                    {activeStep.description && (
                      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{activeStep.description}</p>
                    )}
                  </div>

                  {activeStep.blockingReasons && activeStep.blockingReasons.length > 0 && (
                    <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 space-y-1">
                      <div className="text-xs uppercase tracking-wide text-amber-200">Blocking Reasons</div>
                      <ul className="list-disc pl-5 space-y-1 text-sm text-amber-100/90">
                        {activeStep.blockingReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {activeStep.lastError && (
                    <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 space-y-1">
                      <div className="text-xs uppercase tracking-wide text-red-300">Last Error</div>
                      {activeStep.lastError.code && (
                        <div className="text-sm text-red-200">Code: {activeStep.lastError.code}</div>
                      )}
                      {activeStep.lastError.class && (
                        <div className="text-sm text-red-200">Class: {activeStep.lastError.class}</div>
                      )}
                      {activeStep.lastError.message && (
                        <div className="text-sm text-red-100">{activeStep.lastError.message}</div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {primaryAction && (
                      <button
                        type="button"
                        onClick={() => void runAction(primaryAction, activeStep)}
                        disabled={Boolean(pendingAction) || primaryAction.disabled}
                        title={primaryAction.reason}
                        className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 transition-colors disabled:opacity-50"
                      >
                        {pendingAction?.actionType === primaryAction.type ? 'Working...' : getActionLabel(primaryAction)}
                      </button>
                    )}

                    {secondaryActions.map((action) => {
                      const isDanger = action.type === 'restart' || action.style === 'danger';
                      return (
                        <button
                          key={action.type}
                          type="button"
                          onClick={() => void runAction(action, activeStep)}
                          disabled={Boolean(pendingAction) || action.disabled}
                          title={action.reason}
                          className={`px-3 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${
                            isDanger
                              ? 'bg-red-900/30 text-red-200 hover:bg-red-900/40 border border-red-700/40'
                              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]'
                          }`}
                        >
                          {pendingAction?.actionType === action.type ? 'Working...' : getActionLabel(action)}
                        </button>
                      );
                    })}

                    {!primaryAction && secondaryActions.length === 0 && (
                      <div className="text-sm text-[var(--color-text-muted)]">No backend actions are currently available for this step.</div>
                    )}
                  </div>
                </div>
              )}

              {globalActions.length > 0 && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 lg:p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text)] uppercase tracking-wide">Global Actions</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {globalActions.map((action) => {
                      const isDanger = action.type === 'restart' || action.style === 'danger';
                      return (
                        <button
                          key={`global-${action.type}`}
                          type="button"
                          onClick={() => void runAction(action, activeStep)}
                          disabled={Boolean(pendingAction) || action.disabled}
                          title={action.reason}
                          className={`px-3 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${
                            isDanger
                              ? 'bg-red-900/30 text-red-200 hover:bg-red-900/40 border border-red-700/40'
                              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]'
                          }`}
                        >
                          {pendingAction?.actionType === action.type ? 'Working...' : getActionLabel(action)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
