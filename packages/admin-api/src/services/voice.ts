/**
 * Voice Service
 * Handles transcription, voice profile creation, and TTS generation.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import type { AudioAsset, VoiceProfile } from '../types.js';
import { _getSecretValueInternal } from './secrets.js';
import { syncAvatarConfig } from './config-sync.js';
import { getAvatar } from './avatars.js';
import * as credits from './credits.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// Replicate models for voice generation
// STABLE_AUDIO_MODEL: Used for generating abstract audio seed from text prompts
// Default: stability-ai/stable-audio-2.5 - generates audio/music/sound effects (WARM, fast!)
// The abstract audio seed defines the voice's tonal character when cloned
const STABLE_AUDIO_MODEL = process.env.STABLE_AUDIO_MODEL || 'stability-ai/stable-audio-2.5';

// VOICE_TTS_MODEL: Used for voice cloning and TTS with a reference audio  
// Default: lucataco/xtts-v2 - popular voice cloning model (4.7M runs)
// We run TWO clone passes: first to create voice from abstract audio, second to smooth it
const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || 'lucataco/xtts-v2';

// Official models (like stability-ai) use a different endpoint than community models
const OFFICIAL_MODEL_PREFIXES = ['stability-ai', 'meta', 'openai', 'mistralai', 'resemble-ai'];

const FETCH_TIMEOUT_MS = 10_000;

type AudioFormat = 'ogg' | 'mp3' | 'wav';

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | { uri?: string };
  error?: string;
}

function detectAudioFormat(contentType?: string | null, url?: string | null): AudioFormat {
  const type = (contentType || '').toLowerCase();
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';

  const lowerUrl = (url || '').toLowerCase();
  if (lowerUrl.endsWith('.mp3')) return 'mp3';
  if (lowerUrl.endsWith('.wav')) return 'wav';
  if (lowerUrl.endsWith('.ogg') || lowerUrl.endsWith('.oga') || lowerUrl.endsWith('.opus')) return 'ogg';
  return 'ogg';
}

function formatToContentType(format: AudioFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    default:
      return 'audio/ogg';
  }
}

function extractOutputUrl(output: ReplicatePrediction['output']): string | undefined {
  if (Array.isArray(output)) return output[0];
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'uri' in output) return output.uri;
  return undefined;
}

function parseS3Key(url: string): { bucket: string; key: string } | null {
  const match = url.match(/https:\/\/([^.]+)\.s3[^/]*\.amazonaws\.com\/(.+)/);
  if (!match) return null;
  return { bucket: match[1], key: decodeURIComponent(match[2]) };
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function makeUrlAccessible(url: string): Promise<string> {
  if (!url.includes('.s3.amazonaws.com') && !url.includes('.s3.us-')) {
    return url;
  }

  if (CDN_URL) {
    const parsed = parseS3Key(url);
    if (parsed) {
      return `${CDN_URL}/${parsed.key}`;
    }
    return url;
  }

  const parsed = parseS3Key(url);
  if (!parsed) return url;

  const command = new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

async function getSecret(avatarId: string, type: 'openai_api_key' | 'replicate_api_key'): Promise<string | null> {
  const key = await _getSecretValueInternal(avatarId, type, 'default');
  if (key) return key;
  return _getSecretValueInternal('GLOBAL', type, 'default');
}

// Cache for model versions (community models need version hash)
const modelVersionCache = new Map<string, string>();

async function getModelVersion(apiKey: string, model: string): Promise<string> {
  if (modelVersionCache.has(model)) {
    return modelVersionCache.get(model)!;
  }
  
  const response = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get model version for ${model}: ${response.status}`);
  }
  
  const data = await response.json() as { latest_version?: { id: string } };
  const version = data.latest_version?.id;
  if (!version) {
    throw new Error(`No version found for model ${model}`);
  }
  
  modelVersionCache.set(model, version);
  return version;
}

function isOfficialModel(model: string): boolean {
  return OFFICIAL_MODEL_PREFIXES.some(prefix => model.startsWith(prefix));
}

async function runReplicatePrediction(
  apiKey: string,
  model: string,
  input: Record<string, unknown>
): Promise<string> {
  // Official models use /v1/models/{owner}/{model}/predictions
  // Community models use /v1/predictions with a version hash
  const isOfficial = isOfficialModel(model);
  
  let endpoint: string;
  let body: Record<string, unknown>;
  
  if (isOfficial) {
    endpoint = `https://api.replicate.com/v1/models/${model}/predictions`;
    body = { input };
  } else {
    const version = await getModelVersion(apiKey, model);
    endpoint = REPLICATE_ENDPOINT;
    body = { version, input };
  }
  
  const createResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Prefer': 'wait',
    },
    body: JSON.stringify(body),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Replicate prediction failed: ${createResponse.status} - ${errorText}`);
  }

  let prediction = await createResponse.json() as ReplicatePrediction;
  let attempts = 0;
  const maxAttempts = 120;
  const pollIntervalMs = 1000;

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    attempts++;

    const pollResponse = await fetch(`${REPLICATE_ENDPOINT}/${prediction.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Replicate poll failed: ${pollResponse.status} - ${errorText}`);
    }

    prediction = await pollResponse.json() as ReplicatePrediction;
  }

  if (prediction.status !== 'succeeded') {
    const reason = prediction.error || `status=${prediction.status}`;
    throw new Error(`Replicate prediction failed: ${reason}`);
  }

  const outputUrl = extractOutputUrl(prediction.output);
  if (!outputUrl) {
    throw new Error('Replicate prediction returned no output');
  }

  return outputUrl;
}

async function uploadAudioAsset(params: {
  avatarId: string;
  buffer: Buffer;
  source: AudioAsset['source'];
  format: AudioFormat;
  durationMs?: number;
}): Promise<AudioAsset> {
  const now = Date.now();
  const assetId = uuid();
  const extension = params.format;
  const s3Key = `avatars/${params.avatarId}/audio/${assetId}.${extension}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: params.buffer,
    ContentType: formatToContentType(params.format),
    CacheControl: 'max-age=31536000',
  }));

  const url = CDN_URL
    ? `${CDN_URL}/${s3Key}`
    : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  const asset: AudioAsset = {
    pk: `AUDIO#${assetId}`,
    sk: 'ASSET',
    assetId,
    avatarId: params.avatarId,
    source: params.source,
    format: params.format,
    durationMs: params.durationMs,
    url,
    createdAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: asset,
  }));

  return asset;
}

async function getAudioAsset(assetId: string): Promise<AudioAsset | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AUDIO#${assetId}`, sk: 'ASSET' },
  }));
  return (result.Item as AudioAsset) || null;
}

async function getVoiceProfile(voiceId: string): Promise<VoiceProfile | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `VOICE#${voiceId}`, sk: 'PROFILE' },
  }));
  return (result.Item as VoiceProfile) || null;
}

async function saveVoiceProfile(profile: VoiceProfile): Promise<void> {
  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: profile,
  }));
}

export async function transcribeAudio(params: {
  avatarId: string;
  assetId?: string;
  url?: string;
  language?: string;
  model?: string;
  diarize?: boolean;
}): Promise<{ text: string; language?: string; confidence?: number }> {
  const apiKey = await getSecret(params.avatarId, 'openai_api_key');
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  let audioUrl = params.url;
  if (!audioUrl && params.assetId) {
    const asset = await getAudioAsset(params.assetId);
    if (!asset) throw new Error(`Audio asset not found: ${params.assetId}`);
    audioUrl = asset.url;
  }

  if (!audioUrl) {
    throw new Error('No audio source provided');
  }

  const accessibleUrl = await makeUrlAccessible(audioUrl);
  const response = await fetchWithTimeout(accessibleUrl);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download audio: ${response.status} - ${errorText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type');
  const format = detectAudioFormat(contentType, accessibleUrl);
  const filename = `audio.${format}`;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || formatToContentType(format) }), filename);
  form.append('model', params.model || 'whisper-1');
  if (params.language) {
    form.append('language', params.language);
  }

  const transcribeResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!transcribeResponse.ok) {
    const errorText = await transcribeResponse.text();
    throw new Error(`OpenAI transcription failed: ${transcribeResponse.status} - ${errorText}`);
  }

  const data = await transcribeResponse.json() as { text: string; language?: string };
  return { text: data.text, language: data.language };
}

export async function createVoiceSeed(params: {
  avatarId: string;
  prompt: string;
  durationMs: number;
  styleTags?: string[];
  negativeTags?: string[];
}): Promise<{ assetId: string; url: string; durationMs?: number }> {
  const apiKey = await getSecret(params.avatarId, 'replicate_api_key');
  if (!apiKey) {
    throw new Error('Replicate API key not configured');
  }

  const durationSeconds = Math.max(1, Math.round(params.durationMs / 1000));
  
  // Build the prompt - for abstract audio, we want tonal qualities not speech
  const style = params.styleTags?.length ? `, ${params.styleTags.join(', ')}` : '';
  const prompt = `${params.prompt}${style}`.trim();

  // Stable Audio 2.5 parameters optimized for voice seed generation
  const outputUrl = await runReplicatePrediction(apiKey, STABLE_AUDIO_MODEL, {
    prompt,
    duration: durationSeconds,
    steps: 8, // Faster inference, still high quality
    cfg_scale: 1, // Low CFG for more natural audio
  });

  const audioResponse = await fetchWithTimeout(outputUrl);
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Failed to download seed audio: ${audioResponse.status} - ${errorText}`);
  }

  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  const contentType = audioResponse.headers.get('content-type');
  const format = detectAudioFormat(contentType, outputUrl);

  const asset = await uploadAudioAsset({
    avatarId: params.avatarId,
    buffer,
    source: 'stable-audio',
    format,
    durationMs: params.durationMs,
  });

  return { assetId: asset.assetId, url: asset.url, durationMs: asset.durationMs };
}

/**
 * Run a voice clone pass using XTTS-v2
 * Takes a reference audio URL and generates speech with that voice character
 * 
 * @param avatarId - Avatar ID for API key lookup
 * @param referenceUrl - URL to reference audio (can be abstract audio or previous clone)
 * @param text - Text to speak with the cloned voice
 * @param cleanupVoice - Whether to apply voice cleanup (true for first clone from abstract audio)
 * @returns URL to the generated audio and optionally the uploaded asset
 */
async function runVoiceClonePass(params: {
  avatarId: string;
  referenceUrl: string;
  text: string;
  cleanupVoice?: boolean;
  saveAsAsset?: boolean;
  assetSource?: 'voice-clone' | 'voice-clone-smoothed';
}): Promise<{ url: string; assetId?: string; asset?: AudioAsset }> {
  const apiKey = await getSecret(params.avatarId, 'replicate_api_key');
  if (!apiKey) {
    throw new Error('Replicate API key not configured');
  }

  const outputUrl = await runReplicatePrediction(apiKey, VOICE_TTS_MODEL, {
    text: params.text,
    speaker: params.referenceUrl,
    language: 'en',
    cleanup_voice: params.cleanupVoice ?? false,
  });

  if (!params.saveAsAsset) {
    return { url: outputUrl };
  }

  // Download and save as asset
  const audioResponse = await fetchWithTimeout(outputUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download cloned audio: ${audioResponse.status}`);
  }

  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  const contentType = audioResponse.headers.get('content-type');
  const format = detectAudioFormat(contentType, outputUrl);

  const asset = await uploadAudioAsset({
    avatarId: params.avatarId,
    buffer,
    source: params.assetSource || 'voice-clone',
    format,
  });

  return { url: asset.url, assetId: asset.assetId, asset };
}

export async function cloneVoiceFromSeed(params: {
  avatarId: string;
  seedAssetId: string;
  name?: string;
}): Promise<{ voiceId: string; status: 'creating' | 'ready' | 'failed'; previewAssetId?: string }> {
  const now = Date.now();
  const voiceId = uuid();

  const profile: VoiceProfile = {
    pk: `VOICE#${voiceId}`,
    sk: 'PROFILE',
    voiceId,
    avatarId: params.avatarId,
    status: 'ready',
    provider: 'voice-clone',
    seedAssetId: params.seedAssetId,
    createdAt: now,
    updatedAt: now,
  };

  await saveVoiceProfile(profile);

  return { voiceId, status: 'ready' };
}

export async function createVoiceProfile(params: {
  avatarId: string;
  seedPrompt?: string;
  seedAssetId?: string;
  voiceName?: string;
}): Promise<{ voiceId: string; status: 'creating' | 'ready' | 'failed' }> {
  let seedAssetId = params.seedAssetId;
  if (!seedAssetId) {
    if (!params.seedPrompt) {
      throw new Error('seedPrompt or seedAssetId is required');
    }
    const seed = await createVoiceSeed({
      avatarId: params.avatarId,
      prompt: params.seedPrompt,
      durationMs: 8000,
    });
    seedAssetId = seed.assetId;
  }

  const clone = await cloneVoiceFromSeed({
    avatarId: params.avatarId,
    seedAssetId,
    name: params.voiceName,
  });

  return { voiceId: clone.voiceId, status: clone.status };
}

/**
 * Check if an avatar has a voice configured
 */
export async function hasVoice(avatarId: string): Promise<{
  hasVoice: boolean;
  voiceId?: string;
  voiceStyle?: string;
  referenceUrl?: string;
}> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return { hasVoice: false };
  }

  const voiceConfig = avatar.voiceConfig;
  if (!voiceConfig?.enabled) {
    return { hasVoice: false };
  }

  const hasVoiceProfile = !!(voiceConfig.defaultVoiceId || voiceConfig.referenceUrl);
  
  return {
    hasVoice: hasVoiceProfile,
    voiceId: voiceConfig.defaultVoiceId,
    voiceStyle: voiceConfig.ttsProvider,
    referenceUrl: voiceConfig.referenceUrl,
  };
}

/**
 * Create a voice for the avatar based on a description.
 * 
 * 3-Step Voice Creation Pipeline (Sound → Voice):
 * 1. Generate ABSTRACT AUDIO with Stable Audio 2.5 (synth drones, hums, tones)
 *    - This defines the tonal character of the voice
 *    - NOT speech - pure audio frequencies that XTTS interprets as voice qualities
 * 2. First clone pass with XTTS-v2 (abstract audio → raw voice)
 *    - XTTS creates a voice from the abstract audio's tonal qualities
 * 3. Second clone pass with XTTS-v2 (raw voice → smoothed voice)
 *    - Refines the voice, removes artifacts, produces polished result
 * 4. Set as avatar's active voice
 * 5. Generate intro message
 * 
 * This produces unique voices born from pure sound, not cloned from humans.
 */
export async function createMyVoice(params: {
  avatarId: string;
  description: string;
  updatedBy?: string;
}): Promise<{ voiceId: string; message: string; previewUrl?: string; introAssetId?: string; introUrl?: string }> {
  const avatar = await getAvatar(params.avatarId);
  if (!avatar) {
    throw new Error(`Avatar not found: ${params.avatarId}`);
  }

  // Check if already has a voice
  const existing = await hasVoice(params.avatarId);
  if (existing.hasVoice) {
    return {
      voiceId: existing.voiceId || 'existing',
      message: 'You already have a voice configured! Use generate_voice_message to speak.',
      previewUrl: existing.referenceUrl,
    };
  }

  // Check energy cost (voice generation costs 1 energy)
  const energyCheck = await credits.canUseEnergy(params.avatarId, credits.ENERGY_COSTS.voice);
  if (!energyCheck.allowed) {
    throw new Error(`Not enough energy to create voice. ${energyCheck.reason}`);
  }

  const avatarName = avatar.name || 'Avatar';
  const avatarDescription = params.description || avatar.description || avatar.persona || '';
  
  // Build an ABSTRACT AUDIO prompt - NOT speech, but tonal qualities
  const abstractAudioPrompt = buildAbstractAudioPrompt(avatarName, avatarDescription);
  
  console.log(`[createMyVoice] Starting 3-step pipeline for ${params.avatarId}`);
  console.log(`[createMyVoice] Step 1: Generating abstract audio with prompt: "${abstractAudioPrompt.substring(0, 80)}..."`);
  
  // ============================================================
  // STEP 1: Generate abstract audio seed with Stable Audio 2.5
  // ============================================================
  let seedUrl: string;
  let seedAssetId: string;
  
  try {
    const seed = await createVoiceSeed({
      avatarId: params.avatarId,
      prompt: abstractAudioPrompt,
      durationMs: 10000, // 10 seconds - XTTS needs at least 6
    });
    seedAssetId = seed.assetId;
    seedUrl = seed.url;
    console.log(`[createMyVoice] Step 1 complete: seed audio at ${seedUrl}`);
  } catch (err) {
    throw new Error(`Failed to generate abstract audio: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // ============================================================
  // STEP 2: First clone pass (abstract audio → raw voice)
  // ============================================================
  console.log(`[createMyVoice] Step 2: First clone pass (abstract audio → raw voice)`);
  
  const firstCloneText = `I am a voice born from pure sound. My tonal character comes from abstract audio frequencies, transformed into speech. This is my unique vocal signature.`;
  
  let firstCloneUrl: string;
  try {
    const firstClone = await runVoiceClonePass({
      avatarId: params.avatarId,
      referenceUrl: seedUrl,
      text: firstCloneText,
      cleanupVoice: true, // Clean up artifacts from abstract audio
      saveAsAsset: false, // Don't save intermediate step
    });
    firstCloneUrl = firstClone.url;
    console.log(`[createMyVoice] Step 2 complete: first clone at ${firstCloneUrl}`);
  } catch (err) {
    throw new Error(`Failed first clone pass: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // ============================================================
  // STEP 3: Second clone pass (raw voice → smoothed voice)
  // ============================================================
  console.log(`[createMyVoice] Step 3: Second clone pass (smoothing the voice)`);
  
  const smoothingText = `Now my voice is refined and polished. The raw frequencies have been smoothed into a clear, distinctive vocal character. I speak with clarity and presence.`;
  
  let smoothedUrl: string;
  let smoothedAssetId: string;
  try {
    const smoothed = await runVoiceClonePass({
      avatarId: params.avatarId,
      referenceUrl: firstCloneUrl,
      text: smoothingText,
      cleanupVoice: false, // Already clean from first pass
      saveAsAsset: true, // Save final voice as asset
      assetSource: 'voice-clone-smoothed',
    });
    smoothedUrl = smoothed.url;
    smoothedAssetId = smoothed.assetId!;
    console.log(`[createMyVoice] Step 3 complete: smoothed voice at ${smoothedUrl}`);
  } catch (err) {
    throw new Error(`Failed smoothing pass: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // ============================================================
  // STEP 4: Create voice profile and set as active
  // ============================================================
  const now = Date.now();
  const voiceId = uuid();
  
  const profile: VoiceProfile = {
    pk: `VOICE#${voiceId}`,
    sk: 'PROFILE',
    voiceId,
    avatarId: params.avatarId,
    status: 'ready',
    provider: 'voice-clone',
    seedAssetId,
    cloneAssetId: smoothedAssetId,
    createdAt: now,
    updatedAt: now,
  };
  
  await saveVoiceProfile(profile);
  await setActiveVoiceProfile(params.avatarId, voiceId, params.updatedBy || 'system');

  // Consume energy after successful creation
  await credits.consumeEnergy(params.avatarId, credits.ENERGY_COSTS.voice);
  console.log(`[createMyVoice] Voice profile ${voiceId} created and set as active`);

  // ============================================================
  // STEP 5: Generate intro message (optional, non-fatal)
  // ============================================================
  let introAssetId: string | undefined;
  let introUrl: string | undefined;
  const introText = `Hello! This is ${avatarName}. I just got my voice set up and I'm excited to speak with you!`;
  
  try {
    const introMessage = await generateVoiceMessage({
      avatarId: params.avatarId,
      text: introText,
      format: 'ogg',
    });
    introAssetId = introMessage.assetId;
    introUrl = introMessage.url;
  } catch (err) {
    console.warn(`[createMyVoice] Failed to generate intro message: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  return {
    voiceId,
    message: `Voice created successfully using 3-step pipeline! Abstract audio → first clone → smoothed voice. My voice was born from pure sound: "${abstractAudioPrompt.substring(0, 80)}..."`,
    previewUrl: smoothedUrl,
    introAssetId,
    introUrl,
  };
}

/**
 * Build an ABSTRACT AUDIO prompt for Stable Audio 2.5
 * This generates tonal qualities that XTTS interprets as voice characteristics
 * NOT speech - pure audio that defines the voice's character
 */
function buildAbstractAudioPrompt(_name: string, description: string): string {
  const descLower = description.toLowerCase();
  
  // Base tonal qualities
  const baseQualities = ['resonant hum', 'warm analog tones'];
  
  // Add gender-influenced tonal characteristics
  if (descLower.includes('female') || descLower.includes('woman') || descLower.includes('girl') || descLower.includes('she ')) {
    baseQualities.push('bright upper harmonics', 'gentle melodic undertones');
  } else if (descLower.includes('male') || descLower.includes('man') || descLower.includes('boy') || descLower.includes('he ')) {
    baseQualities.push('deep rich bass', 'strong fundamental tones');
  } else {
    baseQualities.push('balanced mid-range frequencies');
  }
  
  // Add personality-influenced tonal characteristics
  if (descLower.includes('playful') || descLower.includes('fun') || descLower.includes('silly')) {
    baseQualities.push('lively rhythmic pulses', 'bright sparkling overtones');
  } else if (descLower.includes('serious') || descLower.includes('professional')) {
    baseQualities.push('steady confident drone', 'clean precise waveforms');
  } else if (descLower.includes('calm') || descLower.includes('gentle') || descLower.includes('soft')) {
    baseQualities.push('soft ambient pad', 'gentle soothing waves');
  } else if (descLower.includes('mysterious') || descLower.includes('enigmatic')) {
    baseQualities.push('ethereal ambient drone', 'mysterious dark undertones');
  } else if (descLower.includes('wise') || descLower.includes('elder')) {
    baseQualities.push('deep measured pulses', 'ancient resonant frequencies');
  } else if (descLower.includes('young') || descLower.includes('youthful')) {
    baseQualities.push('vibrant energetic tones', 'fresh bright harmonics');
  } else if (descLower.includes('confident') || descLower.includes('commanding')) {
    baseQualities.push('commanding presence', 'powerful resonance');
  }
  
  // Add some unique character
  baseQualities.push('smooth analog synthesizer');
  
  return baseQualities.join(', ');
}

export async function setActiveVoiceProfile(
  avatarId: string,
  voiceId: string,
  updatedBy: string = 'system'
): Promise<void> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  const profile = await getVoiceProfile(voiceId);
  let referenceUrl: string | undefined;
  if (profile?.cloneAssetId || profile?.seedAssetId) {
    const assetId = profile.cloneAssetId || profile.seedAssetId;
    if (assetId) {
      const asset = await getAudioAsset(assetId);
      referenceUrl = asset?.url;
    }
  }

  const updated = {
    ...avatar,
    voiceConfig: {
      enabled: true,
      defaultVoiceId: voiceId,
      ttsProvider: avatar.voiceConfig?.ttsProvider || 'voice-clone',
      speed: avatar.voiceConfig?.speed,
      pitch: avatar.voiceConfig?.pitch,
      format: avatar.voiceConfig?.format || 'ogg',
      referenceUrl: referenceUrl || avatar.voiceConfig?.referenceUrl,
    },
    updatedAt: Date.now(),
    updatedBy,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  await syncAvatarConfig(updated);
}

export async function generateVoiceMessage(params: {
  avatarId: string;
  text: string;
  voiceId?: string;
  format?: AudioFormat;
  speed?: number;
  pitch?: number;
  emotion?: string;
  maxDurationMs?: number;
}): Promise<{ assetId: string; url: string; durationMs?: number; format?: AudioFormat }> {
  const avatar = await getAvatar(params.avatarId);
  if (!avatar) {
    throw new Error(`Avatar not found: ${params.avatarId}`);
  }

  // Check energy cost (voice message costs 1 energy)
  const energyCheck = await credits.canUseEnergy(params.avatarId, credits.ENERGY_COSTS.voice);
  if (!energyCheck.allowed) {
    throw new Error(`Not enough energy to generate voice message. ${energyCheck.reason}`);
  }

  const voiceConfig = avatar.voiceConfig;
  const voiceId = params.voiceId || voiceConfig?.defaultVoiceId;
  const referenceUrl = voiceConfig?.referenceUrl;

  if (voiceConfig?.ttsProvider !== 'voice-clone' || !VOICE_TTS_MODEL) {
    throw new Error('Voice cloning not enabled');
  }

  const apiKey = await getSecret(params.avatarId, 'replicate_api_key');
  if (!apiKey) {
    throw new Error('Replicate API key not configured');
  }

  let seedUrl = referenceUrl;
  if (!seedUrl && voiceId) {
    const profile = await getVoiceProfile(voiceId);
    const assetId = profile?.cloneAssetId || profile?.seedAssetId;
    if (assetId) {
      const asset = await getAudioAsset(assetId);
      seedUrl = asset?.url;
    }
  }

  if (!seedUrl && voiceId?.startsWith('http')) {
    seedUrl = voiceId;
  }

  if (!seedUrl) {
    throw new Error('Voice reference audio not found');
  }

  // Make URL accessible (signed URL for S3)
  const accessibleSeedUrl = await makeUrlAccessible(seedUrl);

  const outputUrl = await runReplicatePrediction(apiKey, VOICE_TTS_MODEL, {
    text: params.text,
    speaker: accessibleSeedUrl, // XTTS-v2 uses 'speaker' not 'speaker_wav'
    language: 'en',
  });

  const audioResponse = await fetchWithTimeout(outputUrl);
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Failed to download TTS audio: ${audioResponse.status} - ${errorText}`);
  }

  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  const contentType = audioResponse.headers.get('content-type');
  const detectedFormat = detectAudioFormat(contentType, outputUrl);

  const asset = await uploadAudioAsset({
    avatarId: params.avatarId,
    buffer,
    source: 'tts',
    format: detectedFormat,
  });

  // Consume energy after successful generation
  await credits.consumeEnergy(params.avatarId, credits.ENERGY_COSTS.voice);

  return { assetId: asset.assetId, url: asset.url, format: detectedFormat };
}

export async function sendVoiceMessage(params: {
  avatarId: string;
  platform: string;
  text: string;
  conversationId?: string;
  voiceId?: string;
  format?: AudioFormat;
  speed?: number;
  replyToMessageId?: string;
}): Promise<{ success: boolean; assetId?: string; url?: string; sent?: boolean }> {
  // Generate the voice message first
  const generated = await generateVoiceMessage({
    avatarId: params.avatarId,
    text: params.text,
    voiceId: params.voiceId,
    format: params.format,
    speed: params.speed,
  });

  const voiceUrl = await makeUrlAccessible(generated.url);

  // For Telegram, send directly to the chat
  if (params.platform === 'telegram') {
    if (!params.conversationId) {
      throw new Error('conversationId is required for Telegram voice messages');
    }

    const botToken = await _getSecretValueInternal(params.avatarId, 'telegram_bot_token', 'default');
    if (!botToken) {
      throw new Error('Telegram bot token not configured');
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: params.conversationId,
        voice: voiceUrl,
        reply_to_message_id: params.replyToMessageId ? Number(params.replyToMessageId) : undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram sendVoice failed: ${response.status} - ${errorText}`);
    }

    return { success: true, assetId: generated.assetId, url: generated.url, sent: true };
  }

  // For web and other platforms, return the audio URL for playback
  return {
    success: true,
    assetId: generated.assetId,
    url: generated.url,
    sent: false,
  };
}
