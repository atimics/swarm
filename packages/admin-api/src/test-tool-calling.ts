/**
 * Tool Calling Test CLI
 * 
 * Tests the OpenRouter SDK's agentic tool calling to debug chaining issues.
 * 
 * Usage:
 *   pnpm tsx src/test-tool-calling.ts [options]
 * 
 * Options:
 *   --simple       Test a single tool call
 *   --chain        Test chained tool calls (gallery → post)
 *   --verbose      Show detailed logging
 *   --model <m>    Override model (default: anthropic/claude-sonnet-4)
 *   --aws          Fetch API key from AWS Secrets Manager (staging)
 *   --direct       Use direct API calls instead of SDK (to bypass SDK validation issues)
 */

import { OpenRouter, stepCountIs, toChatMessage, fromChatMessages } from '@openrouter/sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
// Must use zod/v4 for compatibility with OpenRouter SDK
import { z } from 'zod/v4';
import zodToJsonSchema from 'zod-to-json-schema';

async function getApiKey(): Promise<string> {
  const args = process.argv.slice(2);
  const useAws = args.includes('--aws');
  
  // Try environment variable first
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  
  if (useAws) {
    console.log('🔑 Fetching API key from AWS Secrets Manager...');
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({
      SecretId: 'swarm/staging/openrouter-api-key',
    }));
    
    if (!response.SecretString) {
      throw new Error('Secret value is empty');
    }
    
    // Handle both JSON and plain string secrets
    const secret = response.SecretString.trim();
    if (secret.startsWith('sk-')) {
      return secret;
    }
    
    try {
      const parsed = JSON.parse(secret);
      const key = parsed.api_key || parsed.apiKey || parsed.API_KEY;
      if (key) return key;
    } catch {
      // Not JSON, check if it's a raw key
      if (secret.includes('sk-')) {
        return secret;
      }
    }
    throw new Error('Could not parse API key from secret');
  }
  
  throw new Error('OPENROUTER_API_KEY environment variable is required (or use --aws)');
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const testSimple = args.includes('--simple');
const testChain = args.includes('--chain');
const useDirect = args.includes('--direct');
const modelIdx = args.indexOf('--model');
const model = modelIdx !== -1 ? args[modelIdx + 1] : 'anthropic/claude-sonnet-4';

const log = (msg: string, data?: unknown) => {
  if (verbose) {
    console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data, null, 2) : '');
  }
};

// Client initialized later after we get API key
let client: OpenRouter;

// Mock gallery data
const mockGallery = [
  { id: 'img-001', url: 'https://example.com/image1.jpg', prompt: 'A sunset over mountains' },
  { id: 'img-002', url: 'https://example.com/image2.jpg', prompt: 'A cat in a garden' },
  { id: 'img-003', url: 'https://example.com/image3.jpg', prompt: 'Abstract art' },
];

// Define test tools with proper typing
const getGalleryTool = {
  type: 'function' as const,
  function: {
    name: 'get_my_gallery',
    description: 'Get the list of images in my gallery. Returns image IDs, URLs, and prompts.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Max number of images to return'),
    }),
    execute: async (params: { limit?: number }) => {
      const limit = params.limit || 10;
      log('get_my_gallery called', { limit });
      const data = mockGallery.slice(0, limit);
      const result = { data, total: mockGallery.length };
      log('get_my_gallery result', result);
      return result;
    },
  },
};

const postToTwitterTool = {
  type: 'function' as const,
  function: {
    name: 'twitter_post',
    description: 'Post a tweet with optional media. Use imageId from gallery to attach an image.',
    inputSchema: z.object({
      text: z.string().describe('The tweet text'),
      imageId: z.string().optional().describe('Optional image ID from gallery to attach'),
    }),
    execute: async (params: { text: string; imageId?: string }) => {
      log('twitter_post called', params);
      const result = {
        success: true,
        tweetId: `tweet-${Date.now()}`,
        message: `Posted: "${params.text}"${params.imageId ? ` with image ${params.imageId}` : ''}`,
      };
      log('twitter_post result', result);
      return result;
    },
  },
};

const calculatorTool = {
  type: 'function' as const,
  function: {
    name: 'calculate',
    description: 'Perform a mathematical calculation',
    inputSchema: z.object({
      expression: z.string().describe('Math expression to evaluate'),
    }),
    execute: async (params: { expression: string }) => {
      log('calculate called', params);
      // Safe math evaluation - only allow digits, operators, parentheses, and whitespace
      const sanitized = params.expression.replace(/\s/g, '');
      if (!/^[\d+\-*/().]+$/.test(sanitized)) {
        throw new Error(`Invalid math expression: ${params.expression}`);
      }
      const result = Function(`"use strict"; return (${sanitized})`)();
      log('calculate result', { result });
      return { result };
    },
  },
};

async function testSimpleToolCall() {
  console.log('\n🧪 Test: Simple Tool Call (calculator)\n');
  console.log(`Model: ${model}`);
  console.log('─'.repeat(50));

  const tools = [calculatorTool] as const;

  const response = client.callModel({
    model,
    input: fromChatMessages([
      { role: 'user', content: 'What is 25 * 4 + 10?' }
    ]),
    tools,
    stopWhen: stepCountIs(3),
  });

  console.log('\n📥 Getting tool calls...');
  const toolCalls = await response.getToolCalls();
  console.log(`Found ${toolCalls.length} tool call(s):`);
  for (const tc of toolCalls) {
    console.log(`  - ${tc.name}(${JSON.stringify(tc.arguments)})`);
  }

  console.log('\n📤 Streaming new messages...');
  let messageCount = 0;
  for await (const item of response.getNewMessagesStream()) {
    messageCount++;
    const itemType = (item as { type?: string })?.type || 'unknown';
    console.log(`  [${messageCount}] type=${itemType}`);
    
    if ((item as { type?: string })?.type === 'function_call_output') {
      const outputItem = item as { callId?: string; output?: string };
      console.log(`      callId: ${outputItem.callId}`);
      console.log(`      output: ${outputItem.output?.substring(0, 100)}...`);
    } else if ((item as { type?: string })?.type === 'message') {
      const msgItem = item as { content?: Array<{ type: string; text?: string }> };
      const content = msgItem.content?.find(c => c.type === 'output_text');
      if (content) {
        console.log(`      text: ${content.text?.substring(0, 100)}...`);
      }
    }
  }

  console.log('\n📝 Getting final response...');
  const finalResponse = await response.getResponse();
  const message = toChatMessage(finalResponse);
  console.log(`Final: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);
  
  console.log('\n✅ Simple tool call test complete');
}

async function testChainedToolCalls() {
  console.log('\n🧪 Test: Chained Tool Calls (gallery → twitter)\n');
  console.log(`Model: ${model}`);
  console.log('─'.repeat(50));

  const tools = [getGalleryTool, postToTwitterTool] as const;

  const systemPrompt = `You are a helpful assistant that can access a user's image gallery and post to Twitter.
When asked to share an image on Twitter, you should:
1. First call get_my_gallery to see available images
2. Then call twitter_post with the appropriate imageId from the gallery

Always complete both steps to fulfill the user's request.`;

  console.log('\n📋 System prompt:', systemPrompt.substring(0, 100) + '...');

  const response = client.callModel({
    model,
    input: fromChatMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please share my first gallery image on Twitter with the caption "Check out this amazing image!"' }
    ]),
    tools,
    stopWhen: stepCountIs(10), // Allow up to 10 steps for chaining
  });

  console.log('\n📥 Getting initial tool calls...');
  const toolCalls = await response.getToolCalls();
  console.log(`Found ${toolCalls.length} initial tool call(s):`);
  for (const tc of toolCalls) {
    console.log(`  - ${tc.name}(${JSON.stringify(tc.arguments)})`);
  }

  console.log('\n📤 Processing message stream (watching for chained calls)...');
  let messageCount = 0;
  let functionCallOutputCount = 0;
  
  for await (const item of response.getNewMessagesStream()) {
    messageCount++;
    const itemType = (item as { type?: string })?.type || 'unknown';
    
    if ((item as { type?: string })?.type === 'function_call_output') {
      functionCallOutputCount++;
      const outputItem = item as { callId?: string; output?: string };
      console.log(`  [${messageCount}] 🔧 function_call_output #${functionCallOutputCount}`);
      console.log(`      callId: ${outputItem.callId}`);
      try {
        const parsed = JSON.parse(outputItem.output || '{}');
        console.log(`      output: ${JSON.stringify(parsed, null, 2).substring(0, 200)}...`);
      } catch {
        console.log(`      output: ${outputItem.output?.substring(0, 100)}...`);
      }
    } else if ((item as { type?: string })?.type === 'message') {
      console.log(`  [${messageCount}] 💬 message`);
      const msgItem = item as { content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> };
      const content = msgItem.content?.find(c => c.type === 'output_text');
      if (content) {
        console.log(`      text: ${content.text?.substring(0, 150)}...`);
      }
      // Check for tool calls in the message
      const toolCallContent = msgItem.content?.filter(c => c.type === 'function_call');
      if (toolCallContent?.length) {
        console.log(`      🔗 Contains ${toolCallContent.length} tool call(s):`);
        for (const tc of toolCallContent) {
          console.log(`         - ${tc.name}(${JSON.stringify(tc.arguments || {}).substring(0, 50)}...)`);
        }
      }
    } else {
      console.log(`  [${messageCount}] ❓ ${itemType}`);
    }
  }

  console.log(`\n📊 Stream summary:`);
  console.log(`   Total messages: ${messageCount}`);
  console.log(`   Function outputs: ${functionCallOutputCount}`);

  console.log('\n📝 Getting final response...');
  const finalResponse = await response.getResponse();
  const message = toChatMessage(finalResponse);
  console.log(`Final: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);

  // Check if both tools were called
  const calledTools = toolCalls.map(tc => tc.name);
  
  console.log('\n📋 Tool execution analysis:');
  console.log(`   Initial tool calls: ${calledTools.join(', ') || 'none'}`);
  console.log(`   Total function outputs: ${functionCallOutputCount}`);
  
  if (functionCallOutputCount >= 2) {
    console.log('\n✅ SUCCESS: Tool chaining appears to work! Got multiple function outputs.');
  } else if (functionCallOutputCount === 1) {
    console.log('\n⚠️  PARTIAL: Only one tool was executed. Chaining may not be working.');
  } else {
    console.log('\n❌ FAILED: No tools were executed.');
  }
}

// Store API key for direct API calls
let apiKey: string;

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

/**
 * Direct API call to OpenRouter - bypasses SDK validation issues
 */
async function directApiCall(
  messages: ChatMessage[],
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 2048,
  };
  
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  log('API request', { model, messageCount: messages.length, toolCount: tools?.length || 0 });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://swarm.admin',
      'X-Title': 'Swarm Tool Test',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }

  const data = await response.json() as ChatResponse;
  log('API response', { 
    finishReason: data.choices[0]?.finish_reason,
    hasToolCalls: !!data.choices[0]?.message?.tool_calls?.length,
    contentLength: data.choices[0]?.message?.content?.length || 0,
  });
  
  return data;
}

/**
 * Convert our test tools to OpenAI format for direct API calls
 */
function toolToOpenAIFormat(tool: typeof getGalleryTool | typeof postToTwitterTool | typeof calculatorTool) {
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: zodToJsonSchema(tool.function.inputSchema, { target: 'openApi3' }),
    },
  };
}

/**
 * Test chained tool calls using direct API (no SDK)
 * This implements the agentic loop manually
 */
async function testChainedToolCallsDirect() {
  console.log('\n🧪 Test: Chained Tool Calls (Direct API - gallery → twitter)\n');
  console.log(`Model: ${model}`);
  console.log('─'.repeat(50));

  const toolDefs = [getGalleryTool, postToTwitterTool];
  const openaiTools = toolDefs.map(toolToOpenAIFormat);

  const systemPrompt = `You are a helpful assistant that can access a user's image gallery and post to Twitter.
When asked to share an image on Twitter, you should:
1. First call get_my_gallery to see available images
2. Then call twitter_post with the appropriate imageId from the gallery

Always complete both steps to fulfill the user's request.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Please share my first gallery image on Twitter with the caption "Check out this amazing image!"' },
  ];

  let round = 0;
  const maxRounds = 10;
  let totalToolCalls = 0;

  console.log('\n🔄 Starting agentic loop (max', maxRounds, 'rounds)...\n');

  while (round < maxRounds) {
    round++;
    console.log(`\n📍 Round ${round}:`);
    
    // Make API call
    const response = await directApiCall(messages, openaiTools);
    const choice = response.choices[0];
    const assistantMessage = choice.message;
    
    // Add assistant message to history
    messages.push({
      role: 'assistant',
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    // Check if we have tool calls
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log('   ✅ No more tool calls - model finished');
      console.log(`   📝 Final response: ${assistantMessage.content?.substring(0, 200)}...`);
      break;
    }

    console.log(`   🔧 ${assistantMessage.tool_calls.length} tool call(s):`);
    
    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      totalToolCalls++;
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      
      console.log(`      [${totalToolCalls}] ${toolName}(${JSON.stringify(toolArgs)})`);
      
      // Find and execute the tool
      const toolDef = toolDefs.find(t => t.function.name === toolName);
      if (!toolDef) {
        console.log(`         ❌ Tool not found: ${toolName}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: `Tool ${toolName} not found` }),
        });
        continue;
      }

      try {
        const result = await toolDef.function.execute(toolArgs);
        const resultStr = JSON.stringify(result);
        console.log(`         ✅ Result: ${resultStr.substring(0, 100)}${resultStr.length > 100 ? '...' : ''}`);
        
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultStr,
        });
      } catch (error) {
        console.log(`         ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed' }),
        });
      }
    }

    // Check finish reason
    if (choice.finish_reason === 'stop') {
      console.log('   ⏹️  finish_reason=stop, ending loop');
      break;
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`📊 Summary:`);
  console.log(`   Rounds: ${round}`);
  console.log(`   Total tool calls: ${totalToolCalls}`);
  
  // Check which tools were called
  const toolsCalled = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsCalled.add(tc.function.name);
      }
    }
  }
  console.log(`   Tools used: ${[...toolsCalled].join(', ')}`);
  
  const hasGallery = toolsCalled.has('get_my_gallery');
  const hasTwitter = toolsCalled.has('twitter_post');
  
  if (hasGallery && hasTwitter) {
    console.log('\n✅ SUCCESS: Both tools were called - chaining works!');
  } else if (hasGallery || hasTwitter) {
    console.log(`\n⚠️  PARTIAL: Only ${hasGallery ? 'get_my_gallery' : 'twitter_post'} was called.`);
  } else {
    console.log('\n❌ FAILED: No tools were called.');
  }
}

async function runAllTests() {
  console.log('═'.repeat(60));
  console.log('  OpenRouter SDK Tool Calling Test Suite');
  console.log('═'.repeat(60));

  try {
    await testSimpleToolCall();
  } catch (error) {
    console.error('\n❌ Simple test failed:', error instanceof Error ? error.message : error);
    if (verbose && error instanceof Error) console.error(error.stack);
  }

  try {
    await testChainedToolCalls();
  } catch (error) {
    console.error('\n❌ Chain test failed:', error instanceof Error ? error.message : error);
    if (verbose && error instanceof Error) console.error(error.stack);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Test Suite Complete');
  console.log('═'.repeat(60));
}

// Main
async function main() {
  try {
    apiKey = await getApiKey();
    console.log(`🔑 API key loaded (${apiKey.substring(0, 10)}...)`);
    
    client = new OpenRouter({
      apiKey,
      debugLogger: verbose ? console : undefined,
    });
    
    if (useDirect) {
      // Direct API mode - bypasses SDK
      console.log('📡 Using direct API calls (bypassing SDK)');
      await testChainedToolCallsDirect();
    } else if (testSimple && !testChain) {
      await testSimpleToolCall();
    } else if (testChain && !testSimple) {
      await testChainedToolCalls();
    } else {
      await runAllTests();
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
