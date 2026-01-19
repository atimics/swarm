/**
 * Chat Panel - Main chat area for active avatar
 * 
 * Access modes:
 * - Admin mode: Full access to chat with tools (inhabited avatar or created by user)
 * - Chat mode: Simple chat without admin tools (other avatars)
 * - Browse mode: Read-only profile view (no wallet connected)
 */
import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useAvatarStore, useActiveAvatar, useActiveChat, useWalletAuth } from '../store';
import { sendChatMessage, saveAvatarSecret, submitToolResult, pollJobCompletion, updateAvatar as updateAvatarApi, transcribeAudio, type JobStatus } from '../api';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AvatarDisplay } from './AvatarSidebar';
import { PromptPreviewPanel } from './PromptPreviewPanel';

// Track active polling jobs to avoid duplicate polling
const activePollers = new Map<string, { controller: AbortController; avatarId: string }>();

interface ChatPanelProps {
  onMenuClick?: () => void;
  onOpenLogs?: (avatarId: string) => void;
}

export function ChatPanel({ onMenuClick, onOpenLogs }: ChatPanelProps) {
  const activeAvatar = useActiveAvatar();
  const messages = useActiveChat();
  const { addMessage, updateMessage, removeMessage, clearChat, updateAvatar, isLoading, setLoading, setError, createAvatar } = useAvatarStore();
  const { user: walletUser, isAuthenticated: isWalletAuthenticated, gateStatus } = useWalletAuth();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const [isCreatingAvatar, setIsCreatingAvatar] = useState(false);
  const [showHint, setShowHint] = useState(true);

  // Derive hasOrb from gateStatus
  const hasOrb = (gateStatus?.nftsHeld ?? 0) > 0;

  // Determine access mode for this avatar
  // - 'browse': Not authenticated - read-only
  // - 'limited': Authenticated but no Orb - can chat with limits
  // - 'chat': Has Orb but not admin - full chat access
  // - 'admin': Inhabiting or created - full admin access
  const accessMode = useMemo(() => {
    if (!isWalletAuthenticated || !walletUser) {
      return 'browse'; // Not authenticated - read-only
    }
    
    const isInhabited = walletUser.inhabitedAvatarId === activeAvatar?.id;
    const isCreator = activeAvatar?.creatorWallet === walletUser.walletAddress;
    
    if (isInhabited || isCreator) {
      return 'admin'; // Full admin access
    }
    
    if (!hasOrb) {
      return 'limited'; // Can chat but with message limits
    }
    
    return 'chat'; // Can chat but no admin tools
  }, [isWalletAuthenticated, walletUser, activeAvatar, hasOrb]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cancel pollers when switching avatars or unmounting
  useEffect(() => {
    const currentAvatarId = activeAvatar?.id;
    return () => {
      if (!currentAvatarId) return;
      for (const [jobId, poller] of activePollers) {
        if (poller.avatarId === currentAvatarId) {
          poller.controller.abort();
          activePollers.delete(jobId);
        }
      }
    };
  }, [activeAvatar?.id]);

  // Handle sending a message - creates avatar first if needed
  const handleSendMessage = useCallback(
    async (content: string) => {
      // Hide the hint when user starts chatting
      setShowHint(false);
      
      // If no avatar exists, create one first
      let targetAvatar = activeAvatar;
      if (!targetAvatar) {
        if (isCreatingAvatar) return; // Already creating
        setIsCreatingAvatar(true);
        try {
          targetAvatar = await createAvatar();
        } catch (err) {
          console.error('Failed to create avatar:', err);
          setError('Failed to create avatar');
          setIsCreatingAvatar(false);
          return;
        }
        setIsCreatingAvatar(false);
        if (!targetAvatar) return;
      }
      
      if (accessMode === 'browse') return; // Can't send in browse mode

      // Build sender context from wallet auth
      const sender = isWalletAuthenticated && walletUser ? {
        walletAddress: walletUser.walletAddress,
        displayName: walletUser.displayName,
        avatarUrl: walletUser.avatarUrl,
        inhabitedAvatarId: walletUser.inhabitedAvatarId,
      } : undefined;

      // Add user message with sender info
      addMessage(targetAvatar.id, { role: 'user', content, sender });

      // Add loading message
      addMessage(targetAvatar.id, {
        role: 'assistant',
        content: '',
        isLoading: true,
      });

      setLoading(true);
      setError(null);

      try {
        // Build history for API - existing messages only, the server will add the new user message
        // Note: messages is from the closure before we called addMessage, 
        // so it doesn't include the user message we just added
        const history = messages
          .filter((m) => m.id !== 'welcome' && !m.isLoading && !m.isToolResult)
          .map((m) => ({
            role: m.role,
            content: m.content,
          }));

        // Send to API with avatar context and sender info
        const response = await sendChatMessage(content, history, {
          id: targetAvatar.id,
          name: targetAvatar.name,
          description: targetAvatar.description,
          persona: targetAvatar.persona,
        }, sender);

        // Update avatar avatar if profile image was changed
        if (response.avatarUpdates?.profileImageUrl) {
          updateAvatar(targetAvatar.id, { avatar: response.avatarUpdates.profileImageUrl });
        }
        
        // Update avatar name if it was changed
        if (response.avatarUpdates?.name) {
          updateAvatar(targetAvatar.id, { name: response.avatarUpdates.name });
        }

        // Update the loading message with the response
        const currentMessages = useAvatarStore.getState().chats[targetAvatar.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          // Check if there's a pending tool call that needs user input
          const pendingToolCall = response.pendingToolCall;
          
          // DEBUG: Log pendingToolCall to diagnose missing tool prompts
          console.log('[ChatPanel] Response received:', {
            hasContent: !!response.response,
            contentLength: response.response?.length,
            pendingToolCall: pendingToolCall ? { id: pendingToolCall.id, name: pendingToolCall.name } : null,
            pendingJobsCount: response.pendingJobs?.length || 0,
          });

          // Check for pending jobs from the response (explicit pendingJobs array)
          const pendingJobsList = response.pendingJobs || [];
          
          // Also try to extract job IDs from the response text as fallback
          const responseText = response.response;

          // If the assistant asks to connect Twitter/X but the backend didn't include a pendingToolCall,
          // inject a local pending tool call so the UI shows the connect dialog reliably.
          const shouldInjectTwitterConnect =
            !pendingToolCall &&
            /please\s+connect\s+your\s+(x\/?twitter|twitter\/?x)\s+account\s*:/i.test(responseText);

          const injectedTwitterToolCall = shouldInjectTwitterConnect
            ? {
                id: (globalThis.crypto && 'randomUUID' in globalThis.crypto)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ? (globalThis.crypto as any).randomUUID()
                  : `twitter-connect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                name: 'request_twitter_connection',
                arguments: {
                  type: 'twitter_connect',
                  message: 'Authorize this avatar to post and manage tweets.',
                },
                status: 'pending' as const,
              }
            : null;
          const jobIdMatch = responseText.match(/jobId[:\s]+["']?([a-f0-9-]{36})["']?/i);
          if (jobIdMatch && !pendingJobsList.find(j => j.jobId === jobIdMatch[1])) {
            pendingJobsList.push({ jobId: jobIdMatch[1], type: 'image' });
          }

          // Convert pending jobs to PendingJob format for display
          const pendingJobsForState = pendingJobsList.map(j => ({
            jobId: j.jobId,
            type: (j.type || 'image') as 'image' | 'video' | 'sticker',
            status: 'pending' as const,
            prompt: j.prompt,
            purpose: j.purpose,
          }));

          // Pull tool-result messages (role=tool) from the backend response history
          // so rich cards (Twitter Connected / Tweet Posted) show immediately.
          const historyFromServer = Array.isArray(response.history) ? response.history : [];
          const lastUserIndex = (() => {
            for (let i = historyFromServer.length - 1; i >= 0; i--) {
              const msg = historyFromServer[i];
              if (msg && msg.role === 'user' && msg.content === content) return i;
            }
            return -1;
          })();
          const toolResultContents: string[] = [];
          if (lastUserIndex >= 0) {
            for (const msg of historyFromServer.slice(lastUserIndex + 1)) {
              if (msg && msg.role === 'tool' && typeof msg.content === 'string') {
                toolResultContents.push(msg.content);
              }
            }
          }

          // Replace the loading message in-place (preserve messageId for job polling),
          // and splice tool-result messages right before it.
          const current = useAvatarStore.getState().chats[targetAvatar.id] || [];
          const loadingIndex = current.findIndex(m => m.id === loadingMessage.id);
          const toolMessages = toolResultContents.map((toolContent) => ({
            id: (globalThis.crypto && 'randomUUID' in globalThis.crypto)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? (globalThis.crypto as any).randomUUID()
              : `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'assistant' as const,
            content: toolContent,
            timestamp: Date.now(),
            isToolResult: true,
          }));

          const updatedLoading = {
            ...loadingMessage,
            content: response.response,
            isLoading: false,
            toolCalls: pendingToolCall
              ? [{
                  id: pendingToolCall.id,
                  name: pendingToolCall.name,
                  arguments: pendingToolCall.arguments,
                  status: 'pending' as const,
                }]
              : injectedTwitterToolCall
                ? [injectedTwitterToolCall]
                : undefined,
            pendingJobs: pendingJobsForState.length > 0 ? pendingJobsForState : undefined,
            media: response.media,
          };

          if (loadingIndex >= 0) {
            const next = [
              ...current.slice(0, loadingIndex),
              ...toolMessages,
              updatedLoading,
              ...current.slice(loadingIndex + 1),
            ];
            useAvatarStore.getState().setChat(targetAvatar.id, next);
          } else {
            // Fallback: if loading message vanished, just append.
            for (const tm of toolMessages) {
              addMessage(targetAvatar.id, {
                role: tm.role,
                content: tm.content,
                isToolResult: true,
              });
            }
            addMessage(targetAvatar.id, {
              role: 'assistant',
              content: updatedLoading.content,
              toolCalls: updatedLoading.toolCalls,
              pendingJobs: updatedLoading.pendingJobs,
              media: updatedLoading.media,
            });
          }
          
          // Start polling for all pending jobs
          for (const pendingJob of pendingJobsList) {
            const jobId = pendingJob.jobId;
            if (!activePollers.has(jobId)) {
              const messageId = loadingMessage.id;
              const avatarIdForPolling = targetAvatar.id;
              const controller = new AbortController();
              activePollers.set(jobId, { controller, avatarId: avatarIdForPolling });

              // Poll in background - don't await
              pollJobCompletion(jobId, {
                intervalMs: 2000,
                maxIntervalMs: 12000,
                signal: controller.signal,
                onProgress: (status: JobStatus) => {
                  const currentMsgs = useAvatarStore.getState().chats[avatarIdForPolling] || [];
                  const msg = currentMsgs.find(m => m.id === messageId);
                  if (!msg) {
                    const poller = activePollers.get(jobId);
                    poller?.controller.abort();
                    activePollers.delete(jobId);
                    return;
                  }

                  const mediaUrl = status.resultUrl || status.url;
                  const jobPurpose = msg.pendingJobs?.find(j => j.jobId === jobId)?.purpose;
                  
                  // Update pendingJobs status for this job
                  const updatedPendingJobs = (msg.pendingJobs || []).map(j => 
                    j.jobId === jobId 
                      ? { 
                          ...j, 
                          status: status.status as 'pending' | 'processing' | 'completed' | 'failed',
                          prompt: status.prompt,
                          resultUrl: mediaUrl,
                          error: status.error,
                        }
                      : j
                  );

                  if (status.status === 'completed' && mediaUrl) {
                    // Job completed - update status and add to toolCalls for image display
                    const existingToolCalls = msg.toolCalls || [];
                    updateMessage(avatarIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                      toolCalls: [
                        ...existingToolCalls,
                        {
                          id: `job-${jobId}`,
                          name: status.type === 'image' ? 'generate_image' : 'generate_video',
                          arguments: { prompt: status.prompt },
                          status: 'completed' as const,
                          result: {
                            url: mediaUrl,
                            prompt: status.prompt,
                            jobId: status.jobId,
                          },
                        },
                      ],
                    });
                    activePollers.delete(jobId);

                    if (jobPurpose === 'profile_image') {
                      void (async () => {
                        try {
                          const updated = await updateAvatarApi(avatarIdForPolling, {
                            profileImage: {
                              url: mediaUrl,
                              updatedAt: Date.now(),
                            },
                          });
                          updateAvatar(avatarIdForPolling, {
                            avatar: updated.profileImage?.url || mediaUrl,
                          });
                          addMessage(avatarIdForPolling, {
                            role: 'assistant',
                            content: '✅ Profile image updated.',
                          });
                        } catch (err) {
                          console.error('Failed to save profile image:', err);
                        }
                      })();
                    }
                  } else if (status.status === 'failed') {
                    // Job failed - update status
                    updateMessage(avatarIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                    });
                    activePollers.delete(jobId);
                  } else {
                    // Job still processing - update status
                    updateMessage(avatarIdForPolling, messageId, {
                      pendingJobs: updatedPendingJobs,
                    });
                  }
                },
              }).catch((err) => {
                if (err instanceof Error && err.name === 'AbortError') {
                  activePollers.delete(jobId);
                  return;
                }
                console.error('Job polling failed:', err);
                // Update job to failed state on error
                const currentMsgs = useAvatarStore.getState().chats[avatarIdForPolling] || [];
                const msg = currentMsgs.find(m => m.id === messageId);
                if (msg) {
                  const updatedPendingJobs = (msg.pendingJobs || []).map(j => 
                    j.jobId === jobId 
                      ? { ...j, status: 'failed' as const, error: err.message }
                      : j
                  );
                  updateMessage(avatarIdForPolling, messageId, {
                    pendingJobs: updatedPendingJobs,
                  });
                }
                activePollers.delete(jobId);
              });
            }
          }
        }
      } catch (error) {
        const currentMessages = useAvatarStore.getState().chats[targetAvatar.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          removeMessage(targetAvatar.id, loadingMessage.id);
        }

        const errorMsg = error instanceof Error ? error.message : 'Failed to send message';
        setError(errorMsg);
        addMessage(targetAvatar.id, {
          role: 'assistant',
          content: `❌ **Error:** ${errorMsg}\n\nPlease try again or check the avatar configuration.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [activeAvatar, messages, addMessage, updateMessage, removeMessage, setLoading, setError, createAvatar, isCreatingAvatar, accessMode, isWalletAuthenticated, walletUser, updateAvatar]
  );

  // Handle audio message - transcribe and send as text
  const handleSendAudio = useCallback(
    async (audioBlob: Blob) => {
      // Audio requires an existing avatar for now
      if (!activeAvatar) {
        // Create avatar first, then handle audio
        const newAvatar = await createAvatar();
        if (!newAvatar) return;
      }
      if (accessMode === 'browse') return;

      const targetAvatar = activeAvatar || useAvatarStore.getState().avatars.find(a => a.id === useAvatarStore.getState().activeAvatarId);
      if (!targetAvatar) return;

      setLoading(true);
      try {
        // Transcribe the audio
        const result = await transcribeAudio(audioBlob, targetAvatar.id);
        if (result.text) {
          // Send the transcribed text as a regular message
          handleSendMessage(`🎤 ${result.text}`);
        }
      } catch (error) {
        console.error('Failed to transcribe audio:', error);
        setError(error instanceof Error ? error.message : 'Failed to transcribe audio');
        setLoading(false);
      }
    },
    [activeAvatar, accessMode, handleSendMessage, setLoading, setError]
  );

  // Handle tool submissions (secrets, confirmations, uploads, etc.)
  const handleToolSubmit = useCallback(
    async (toolCallId: string, result: unknown) => {
      if (!activeAvatar) return;

      const resultObj = result as Record<string, unknown>;
      
      // Find the tool call to get its name
      const currentMessages = useAvatarStore.getState().chats[activeAvatar.id] || [];
      let toolName: string | undefined;
      for (const msg of currentMessages) {
        const tc = msg.toolCalls?.find(tc => tc.id === toolCallId);
        if (tc) {
          toolName = tc.name;
          break;
        }
      }
      
      // Update the tool call status in the message
      const updateToolCallStatus = () => {
        const msgs = useAvatarStore.getState().chats[activeAvatar.id] || [];
        for (const msg of msgs) {
          const toolCall = msg.toolCalls?.find(tc => tc.id === toolCallId);
          if (toolCall) {
            updateMessage(activeAvatar.id, msg.id, {
              toolCalls: msg.toolCalls?.map(tc => 
                tc.id === toolCallId 
                  ? { ...tc, status: 'completed' as const, result }
                  : tc
              ),
            });
            break;
          }
        }
      };

      // Handle secret submission
      if (resultObj.secretKey && resultObj.value) {
        try {
          await saveAvatarSecret(activeAvatar.id, resultObj.secretKey as string, resultObj.value as string);
          updateToolCallStatus();

          const resumed = await submitToolResult(activeAvatar.id, toolCallId, {
            stored: true,
            secretKey: resultObj.secretKey,
          });

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save secret';
          setError(errorMsg);
        }
        return;
      }

      // Handle image upload completion
      if (resultObj.success && resultObj.s3Key && resultObj.publicUrl) {
        try {
          updateToolCallStatus();

          // Check if this is a character reference upload
          const isCharacterReferenceUpload = toolName === 'set_character_reference' ||
                                              toolName === 'get_character_reference_upload_url' ||
                                              resultObj.purpose === 'character_reference';

          // Check if this was a profile image upload (from set_profile_image or get_profile_upload_url)
          const isProfileUpload = !isCharacterReferenceUpload && (
                                   toolName === 'set_profile_image' ||
                                   toolName === 'get_profile_upload_url' ||
                                   !resultObj.category);

          if (isCharacterReferenceUpload) {
            // For character reference, save directly via API
            const { updateAvatar: updateAvatarApi } = await import('../api/avatars');
            await updateAvatarApi(activeAvatar.id, {
              characterReference: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                description: resultObj.description as string | undefined,
                updatedAt: Date.now(),
              },
            });

            // Add a simple confirmation message
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '✅ Character reference updated. This will be used for consistent image and video generation.',
            });
          } else if (isProfileUpload) {
            // For profile images, save directly via API - don't rely on LLM
            const { updateAvatar: updateAvatarApi } = await import('../api/avatars');
            await updateAvatarApi(activeAvatar.id, {
              profileImage: {
                url: resultObj.publicUrl as string,
                s3Key: resultObj.s3Key as string,
                updatedAt: Date.now(),
              },
            });

            // Update local state immediately
            updateAvatar(activeAvatar.id, { avatar: resultObj.publicUrl as string });

            // Add a simple confirmation message instead of asking LLM
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '✅ Profile image updated.',
            });
          } else {
            // For reference images, resume the tool loop with a tool result (no synthetic user message)
            const resumed = await submitToolResult(activeAvatar.id, toolCallId, {
              success: true,
              s3Key: resultObj.s3Key,
              publicUrl: resultObj.publicUrl,
              filename: resultObj.filename,
              category: resultObj.category,
              purpose: resultObj.purpose,
              description: resultObj.description,
            });

            if (resumed.avatarUpdates?.profileImageUrl) {
              updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
            }
            if (resumed.avatarUpdates?.name) {
              updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
            }

            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: resumed.response,
              toolCalls: resumed.pendingToolCall ? [{
                id: resumed.pendingToolCall.id,
                name: resumed.pendingToolCall.name,
                arguments: resumed.pendingToolCall.arguments,
                status: 'pending',
              }] : undefined,
              media: resumed.media,
            });
          }
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to process upload';
          setError(errorMsg);
        }
        return;
      }

      // Handle model selection updates
      if (typeof resultObj.selectedModel === 'string') {
        try {
          const { getAvatar, updateAvatar: updateAvatarApi } = await import('../api/avatars');
          const avatar = await getAvatar(activeAvatar.id);
          const currentConfig = avatar.llmConfig || {
            provider: 'openrouter',
            model: resultObj.selectedModel,
            temperature: 0.8,
            maxTokens: 1024,
            useGlobalKey: true,
          };

          await updateAvatarApi(activeAvatar.id, {
            llmConfig: {
              ...currentConfig,
              model: resultObj.selectedModel,
            },
          });

          updateAvatar(activeAvatar.id, { model: resultObj.selectedModel });
          updateToolCallStatus();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to update model';
          setError(errorMsg);
        }
        return;
      }

      // Handle feature toggle updates
      if (typeof resultObj.feature === 'string' && typeof resultObj.enabled === 'boolean') {
        try {
          const { toggleFeature } = await import('../api/avatars');
          await toggleFeature(
            activeAvatar.id,
            resultObj.feature as 'media' | 'voice' | 'twitter' | 'telegram' | 'discord',
            resultObj.enabled
          );
          updateToolCallStatus();

          const resumed = await submitToolResult(activeAvatar.id, toolCallId, {
            feature: resultObj.feature,
            enabled: resultObj.enabled,
            applied: true,
          });

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });

          // Fallback UX: if Twitter was enabled but model didn't prompt for connect
          if (resultObj.feature === 'twitter' && resultObj.enabled && !resumed.pendingToolCall) {
            addMessage(activeAvatar.id, {
              role: 'assistant',
              content: '', // TwitterConnectPrompt renders its own UI
              toolCalls: [{
                id: crypto.randomUUID(),
                name: 'request_twitter_connection',
                arguments: {
                  type: 'twitter_connect',
                  message: 'Authorize this avatar to post and manage tweets.',
                },
                status: 'pending',
              }],
            });
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to toggle feature';
          setError(errorMsg);
        }
        return;
      }

      // Handle confirmation response
      if ('confirmed' in resultObj) {
        updateToolCallStatus();
        try {
          const resumed = await submitToolResult(activeAvatar.id, toolCallId, resultObj);

          if (resumed.avatarUpdates?.profileImageUrl) {
            updateAvatar(activeAvatar.id, { avatar: resumed.avatarUpdates.profileImageUrl });
          }
          if (resumed.avatarUpdates?.name) {
            updateAvatar(activeAvatar.id, { name: resumed.avatarUpdates.name });
          }

          addMessage(activeAvatar.id, {
            role: 'assistant',
            content: resumed.response,
            toolCalls: resumed.pendingToolCall ? [{
              id: resumed.pendingToolCall.id,
              name: resumed.pendingToolCall.name,
              arguments: resumed.pendingToolCall.arguments,
              status: 'pending',
            }] : undefined,
            media: resumed.media,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to submit tool result';
          setError(errorMsg);
        }
        return;
      }

      // Generic tool result - just update status
      updateToolCallStatus();
    },
    [activeAvatar, updateMessage, setError, handleSendMessage, addMessage, updateAvatar]
  );

  if (!activeAvatar) {
    // Show chat interface ready to create avatar on first message
    return (
      <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
        {/* Minimal header with menu button */}
        <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
          <div className="flex items-center gap-3 lg:gap-4">
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
              aria-label="Open menu"
              data-testid="menu-button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 lg:w-6 lg:h-6 text-white">
                <path d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 9a.75.75 0 00-1.5 0v2.25H9a.75.75 0 000 1.5h2.25V15a.75.75 0 001.5 0v-2.25H15a.75.75 0 000-1.5h-2.25V9z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)]">New Avatar</h1>
              <p className="text-xs text-[var(--color-text-tertiary)]">Start chatting to create</p>
            </div>
          </div>
        </header>

        {/* Empty chat area with hint */}
        <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4 flex items-center justify-center">
          <div 
            className={`text-center transition-opacity duration-500 ${showHint ? 'opacity-100' : 'opacity-0'}`}
          >
            <div className="w-20 h-20 lg:w-24 lg:h-24 mx-auto mb-4 lg:mb-6 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-700/20 ring-2 ring-brand-600/30 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 lg:w-12 lg:h-12 text-brand-500">
                <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-lg lg:text-xl font-medium text-[var(--color-text-secondary)] mb-2">
              Chat to create your first avatar
            </p>
            <p className="text-sm text-[var(--color-text-muted)]">
              Just say hello and we'll get started
            </p>
          </div>
        </div>

        {/* Input area */}
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput 
              onSend={handleSendMessage} 
              onSendAudio={handleSendAudio} 
              disabled={isLoading || isCreatingAvatar}
              placeholder={isCreatingAvatar ? "Creating your avatar..." : "Say hello to create your avatar..."}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
      {/* Avatar Header */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 lg:gap-4">
            {/* Hamburger menu - mobile only */}
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
              aria-label="Open menu"
              data-testid="menu-button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            <AvatarDisplay avatar={activeAvatar} size="md" />
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate">{activeAvatar.name}</h1>
              <p className="text-xs text-[var(--color-text-tertiary)] truncate hidden sm:block">
                {accessMode === 'admin' && (
                  <span className="text-brand-400">Admin access</span>
                )}
                {accessMode === 'chat' && (
                  <span>Chat mode</span>
                )}
                {accessMode === 'limited' && (
                  <span className="text-amber-400">Limited access • Get an Orb for full access</span>
                )}
                {accessMode === 'browse' && (
                  <span>Connect wallet to chat</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {accessMode === 'admin' && (
              <>
                <button
                  onClick={() => setPromptPreviewOpen(true)}
                  className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
                  title="Preview prompt sent to LLM"
                >
                  <span className="hidden sm:inline">Preview</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                    <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                    <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  onClick={() => clearChat(activeAvatar.id)}
                  className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
                >
                  <span className="hidden sm:inline">Clear Chat</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                  </svg>
                </button>
              </>
            )}
          </div>
          {onOpenLogs && (accessMode === 'admin' || accessMode === 'chat') && (
            <button
              onClick={() => onOpenLogs(activeAvatar.id)}
              className="px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] text-xs font-medium transition-colors"
            >
              View logs
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((message) => (
            <ChatMessageComponent 
              key={message.id} 
              message={message} 
              onToolSubmit={handleToolSubmit}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area - varies by access mode */}
      {accessMode === 'browse' ? (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-4">
          <div className="max-w-3xl mx-auto text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Connect your wallet to chat with this avatar
            </p>
          </div>
        </div>
      ) : accessMode === 'limited' ? (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto space-y-2">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} disabled={isLoading} />
            <div className="flex items-center justify-center gap-2 text-xs text-amber-400">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Limited mode • Get an Orb to unlock full access &amp; inhabit avatars</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-input-container border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
          <div className="max-w-3xl mx-auto">
            <ChatInput onSend={handleSendMessage} onSendAudio={handleSendAudio} disabled={isLoading} />
          </div>
        </div>
      )}

      {/* Prompt Preview Panel */}
      <PromptPreviewPanel
        isOpen={promptPreviewOpen}
        onClose={() => setPromptPreviewOpen(false)}
      />
    </div>
  );
}
