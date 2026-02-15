/**
 * Shared types for tool prompt components
 */
import type { ToolCall } from '../../types';

export interface ToolPromptProps {
  toolCall: ToolCall;
  onSubmit: (toolCallId: string, result: unknown) => void;
  disabled?: boolean;
}

export const API_BASE = import.meta.env.VITE_API_URL || '/api';
