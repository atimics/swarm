import {
  ONBOARDING_FUNNEL_VERSION,
  SUPPORTED_ONBOARDING_CONTRACT_VERSION,
  type OnboardingStatus,
  type OnboardingStep,
} from '../api/onboarding';

const ONBOARDING_TELEMETRY_SOURCE = 'admin_ui_onboarding_wizard';
const ONBOARDING_SESSION_STORAGE_KEY = 'swarm:onboarding:session-id';

export type OnboardingTelemetryEventName =
  | 'onboarding_stage_enter'
  | 'onboarding_stage_exit'
  | 'onboarding_action_initiated'
  | 'onboarding_action_completed'
  | 'onboarding_action_failed'
  | 'onboarding_resumed'
  | 'onboarding_abandoned'
  | 'onboarding_completed';

export interface OnboardingTelemetryPayload {
  avatarId: string;
  attemptId?: string;
  stepId?: string;
  stepRequirement?: string;
  stepStatus?: string;
  actionType?: string;
  result?: 'success' | 'failure' | 'skipped' | 'abandoned';
  contractVersion?: string;
  funnelVersion?: string;
  errorClass?: string;
  errorCode?: string;
}

interface OnboardingTelemetryEvent extends OnboardingTelemetryPayload {
  schemaVersion: string;
  contractVersion: string;
  source: string;
  sessionId: string;
  eventName: OnboardingTelemetryEventName;
  eventTimestamp: string;
}

interface TelemetrySink {
  track: (eventName: string, payload: Record<string, unknown>) => void;
}

interface SwarmWindow extends Window {
  swarmTelemetry?: TelemetrySink;
  analytics?: TelemetrySink;
}

function getSessionId(): string {
  if (typeof window === 'undefined') {
    return `session-${Math.random().toString(36).slice(2, 10)}`;
  }

  const safeWindow = window as SwarmWindow;

  try {
    const existing = safeWindow.sessionStorage.getItem(ONBOARDING_SESSION_STORAGE_KEY);
    if (existing) return existing;

    const created = `onb-${crypto.randomUUID()}`;
    safeWindow.sessionStorage.setItem(ONBOARDING_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return `session-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toCleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(input).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (value === undefined || value === null || value === '') return acc;
    acc[key] = value;
    return acc;
  }, {});
}

export function buildStepTelemetry(
  status: OnboardingStatus | null,
  step: OnboardingStep | null
): Pick<OnboardingTelemetryPayload, 'attemptId' | 'stepId' | 'stepRequirement' | 'stepStatus' | 'contractVersion' | 'funnelVersion'> {
  return {
    attemptId: status?.attemptId,
    stepId: step?.id,
    stepRequirement: step?.requirement,
    stepStatus: step?.status,
    contractVersion: status?.contractVersion,
    funnelVersion: status?.funnelVersion,
  };
}

export function trackOnboardingTelemetry(
  eventName: OnboardingTelemetryEventName,
  payload: OnboardingTelemetryPayload
): void {
  if (typeof window === 'undefined') return;

  const event: OnboardingTelemetryEvent = {
    schemaVersion: ONBOARDING_FUNNEL_VERSION,
    contractVersion: payload.contractVersion || SUPPORTED_ONBOARDING_CONTRACT_VERSION,
    source: ONBOARDING_TELEMETRY_SOURCE,
    sessionId: getSessionId(),
    eventName,
    eventTimestamp: new Date().toISOString(),
    avatarId: payload.avatarId,
    attemptId: payload.attemptId,
    stepId: payload.stepId,
    stepRequirement: payload.stepRequirement,
    stepStatus: payload.stepStatus,
    actionType: payload.actionType,
    result: payload.result,
    funnelVersion: payload.funnelVersion || ONBOARDING_FUNNEL_VERSION,
    errorClass: payload.errorClass,
    errorCode: payload.errorCode,
  };

  const cleanEvent = toCleanObject(event as unknown as Record<string, unknown>);
  const safeWindow = window as SwarmWindow;

  safeWindow.dispatchEvent(new CustomEvent('swarm:onboarding-telemetry', { detail: cleanEvent }));

  try {
    safeWindow.swarmTelemetry?.track(eventName, cleanEvent);
  } catch {
    // no-op
  }

  try {
    safeWindow.analytics?.track(eventName, cleanEvent);
  } catch {
    // no-op
  }
}
