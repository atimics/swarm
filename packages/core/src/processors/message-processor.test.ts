import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { MessageProcessor, createMessageProcessor, type MessageProcessorDependencies, type LLMResponse, type ToolExecutionResult } from './message-processor.js';
import type { ProcessorConfig, ProcessorAvatarConfig, ProcessorMessage } from './types.js';

describe('MessageProcessor', () => {
  let mockDeps: MessageProcessorDependencies;
  let processor: MessageProcessor;
  let mockAvatar: ProcessorAvatarConfig;

  beforeEach(() => {
    mockAvatar = {
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      description: 'A test avatar',
      persona: 'You are a helpful test assistant.',
      enabledCategories: ['secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'],
      platforms: {},
      wallets: [],
      llmConfig: {
        model: 'test-model',
        temperature: 0.7,
        maxTokens: 2048,
      },
    };

    mockDeps = {
      avatarService: {
        getAvatar: mock(() => Promise.resolve(mockAvatar)),
      },
      memoryService: {
        getMemoryContext: mock(() => Promise.resolve(null)),
        remember: mock(() => Promise.resolve()),
        recall: mock(() => Promise.resolve([])),
      },
      dreamsService: {
        getDreamForResponse: mock(() => Promise.resolve({ dream: null, isGenerating: false })),
        formatDreamForPrompt: mock(() => null),
      },
      voiceService: {
        transcribeAudio: mock(() => Promise.resolve({ text: 'Transcribed text' })),
      },
      getRegisteredTools: mock(() => Promise.resolve([])),
      toLLMFormat: mock(() => Promise.resolve([])),
      callLLM: mock(() => Promise.resolve({
        content: 'Hello from the LLM!',
        finishReason: 'stop',
      } as LLMResponse)),
      executeTool: mock(() => Promise.resolve({
        success: true,
        data: { message: 'Tool executed' },
      } as ToolExecutionResult)),
    };

    processor = new MessageProcessor(mockDeps);
  });

  describe('basic processing', () => {
    it('should process a simple message without tools', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
        userId: 'user-456',
      };

      const result = await processor.process('Hello!', [], config);

      expect(result.response).toBe('Hello from the LLM!');
      expect(result.history).toBeDefined();
      expect(mockDeps.callLLM).toHaveBeenCalled();
    });

    it('should return error when avatar not found', async () => {
      (mockDeps.avatarService.getAvatar as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(null));

      const config: ProcessorConfig = {
        avatarId: 'nonexistent-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Hello!', [], config);

      expect(result.response).toBe('Avatar not found.');
    });

    it('should include conversation history in messages', async () => {
      const history: ProcessorMessage[] = [
        { role: 'user', content: 'Hi there' },
        { role: 'assistant', content: 'Hello! How can I help?' },
      ];

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('What was my first message?', history, config);

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArgs.messages.length).toBeGreaterThan(2); // system + history + new message
    });

    it('should use custom system prompt when provided', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Hello!', [], config, {
        customSystemPrompt: 'You are a custom assistant.',
      });

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArgs.messages[0].content).toBe('You are a custom assistant.');
    });
  });

  describe('tool execution', () => {
    it('should execute tool calls from LLM response', async () => {
      // First call returns tool call, second call returns final response
      let callCount = 0;
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'test_tool',
                arguments: JSON.stringify({ param: 'value' }),
              },
            }],
            finishReason: 'tool_calls',
          } as LLMResponse);
        }
        return Promise.resolve({
          content: 'Tool executed successfully!',
          finishReason: 'stop',
        } as LLMResponse);
      });

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Use a tool', [], config);

      expect(mockDeps.executeTool).toHaveBeenCalledWith(
        'test_tool',
        { param: 'value' },
        expect.any(Object)
      );
      expect(result.response).toBe('Tool executed successfully!');
    });

    it('should handle invalid tool arguments gracefully', async () => {
      let callCount = 0;
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'test_tool',
                arguments: 'invalid json{',
              },
            }],
            finishReason: 'tool_calls',
          } as LLMResponse);
        }
        return Promise.resolve({
          content: 'I encountered an error with the tool.',
          finishReason: 'stop',
        } as LLMResponse);
      });

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Use a tool', [], config);

      expect(mockDeps.executeTool).not.toHaveBeenCalled();
      expect(result.response).toBe('I encountered an error with the tool.');
    });

    it('should collect media from tool results', async () => {
      let callCount = 0;
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'generate_image',
                arguments: JSON.stringify({ prompt: 'a cat' }),
              },
            }],
            finishReason: 'tool_calls',
          } as LLMResponse);
        }
        return Promise.resolve({
          content: 'Here is your image!',
          finishReason: 'stop',
        } as LLMResponse);
      });

      (mockDeps.executeTool as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          success: true,
          media: { type: 'image', url: 'https://example.com/cat.png' },
        } as ToolExecutionResult)
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Generate an image of a cat', [], config);

      expect(result.media).toBeDefined();
      expect(result.media?.length).toBe(1);
      expect(result.media?.[0].type).toBe('image');
      expect(result.media?.[0].url).toBe('https://example.com/cat.png');
    });

    it('should collect pending jobs from tool results', async () => {
      let callCount = 0;
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'generate_video',
                arguments: JSON.stringify({ prompt: 'a dancing cat' }),
              },
            }],
            finishReason: 'tool_calls',
          } as LLMResponse);
        }
        return Promise.resolve({
          content: 'Video generation started!',
          finishReason: 'stop',
        } as LLMResponse);
      });

      (mockDeps.executeTool as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          success: true,
          pendingJob: {
            jobId: 'job-123',
            type: 'video',
            prompt: 'a dancing cat',
          },
        } as ToolExecutionResult)
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Generate a video', [], config);

      expect(result.pendingJobs).toBeDefined();
      expect(result.pendingJobs?.length).toBe(1);
      expect(result.pendingJobs?.[0].jobId).toBe('job-123');
      expect(result.pendingJobs?.[0].type).toBe('video');
    });

    it('should stop after max iterations', async () => {
      // Always return tool calls to trigger max iterations
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          content: '',
          toolCalls: [{
            id: 'call-' + Math.random(),
            type: 'function',
            function: {
              name: 'test_tool',
              arguments: '{}',
            },
          }],
          finishReason: 'tool_calls',
        } as LLMResponse)
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Keep using tools', [], config);

      expect(result.response).toBe('Processing took too long. Please try again.');
    });
  });

  describe('context injection', () => {
    it('should inject memory context when memory category is enabled', async () => {
      mockAvatar.enabledCategories = ['memory', 'profile'];
      (mockDeps.memoryService!.getMemoryContext as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve('## Memory Context\nUser likes cats.')
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Hello!', [], config);

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('Memory Context');
    });

    it('should inject dreams context when enabled', async () => {
      (mockDeps.dreamsService!.getDreamForResponse as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ dream: { content: 'A dream about cats' }, isGenerating: false })
      );
      (mockDeps.dreamsService!.formatDreamForPrompt as ReturnType<typeof mock>).mockImplementation(() =>
        '## Recent Dream\nI dreamed about cats.'
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Hello!', [], config, { dreamsEnabled: true });

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('Recent Dream');
    });
  });

  describe('attachments', () => {
    it('should transcribe audio attachments', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Check this voice message', [], config, {
        attachments: [{ type: 'audio', data: 'https://example.com/audio.ogg' }],
      });

      expect(mockDeps.voiceService!.transcribeAudio).toHaveBeenCalledWith({
        avatarId: 'test-avatar',
        url: 'https://example.com/audio.ogg',
      });

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: ProcessorMessage) => m.role === 'user');
      expect(userMessage?.content).toContain('[Voice message transcription]');
      expect(userMessage?.content).toContain('Transcribed text');
    });

    it('should handle audio transcription failure gracefully', async () => {
      (mockDeps.voiceService!.transcribeAudio as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error('Transcription failed'))
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Check this voice message', [], config, {
        attachments: [{ type: 'audio', data: 'https://example.com/audio.ogg' }],
      });

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: ProcessorMessage) => m.role === 'user');
      expect(userMessage?.content).toContain('transcription failed');
    });

    it('should include image attachments in multimodal format', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('What is in this image?', [], config, {
        attachments: [{ type: 'image', data: 'https://example.com/image.png' }],
      });

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: ProcessorMessage) => m.role === 'user');
      expect(Array.isArray(userMessage?.content)).toBe(true);
      const content = userMessage?.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(content.some(c => c.type === 'image_url')).toBe(true);
    });
  });

  describe('platform-specific behavior', () => {
    it('should use dynamic system prompt for admin-ui platform', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'admin-ui',
        conversationId: 'chat-123',
      };

      await processor.process('Hello!', [], config);

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      // Admin-UI gets full dynamic prompt with capabilities
      expect(callArgs.messages[0].content).toContain('Identity');
    });

    it('should use chat system prompt for telegram platform', async () => {
      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: 'chat-123',
      };

      await processor.process('Hello!', [], config);

      const callArgs = (mockDeps.callLLM as ReturnType<typeof mock>).mock.calls[0][0];
      // Telegram gets shorter chat prompt
      expect(callArgs.messages[0].content).toBeDefined();
    });
  });

  describe('avatar updates tracking', () => {
    it('should track profile image updates', async () => {
      let callCount = 0;
      (mockDeps.callLLM as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'set_profile_image',
                arguments: JSON.stringify({ url: 'https://example.com/new-avatar.png' }),
              },
            }],
            finishReason: 'tool_calls',
          } as LLMResponse);
        }
        return Promise.resolve({
          content: 'Profile image updated!',
          finishReason: 'stop',
        } as LLMResponse);
      });

      (mockDeps.executeTool as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          success: true,
          data: { url: 'https://example.com/new-avatar.png' },
        } as ToolExecutionResult)
      );

      const config: ProcessorConfig = {
        avatarId: 'test-avatar',
        platform: 'admin-ui',
        conversationId: 'chat-123',
      };

      const result = await processor.process('Set my profile image', [], config);

      expect(result.avatarUpdates).toBeDefined();
      expect(result.avatarUpdates?.profileImageUrl).toBe('https://example.com/new-avatar.png');
    });
  });
});

describe('createMessageProcessor', () => {
  it('should create a MessageProcessor instance', () => {
    const mockDeps: MessageProcessorDependencies = {
      avatarService: { getAvatar: mock(() => Promise.resolve(null)) },
      getRegisteredTools: mock(() => Promise.resolve([])),
      toLLMFormat: mock(() => Promise.resolve([])),
      callLLM: mock(() => Promise.resolve({ content: '', finishReason: 'stop' })),
      executeTool: mock(() => Promise.resolve({ success: true })),
    };

    const processor = createMessageProcessor(mockDeps);

    expect(processor).toBeInstanceOf(MessageProcessor);
  });
});
