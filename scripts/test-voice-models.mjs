#!/usr/bin/env node
/**
 * Test script for Replicate voice generation models
 * 
 * Tests three key models:
 * 1. suno-ai/bark - Text-to-audio (generates voice seed from description)
 * 2. lucataco/xtts-v2 - Voice cloning TTS (uses reference audio)
 * 3. resemble-ai/chatterbox-turbo - Fast TTS with preset voices
 * 
 * Usage:
 *   node scripts/test-voice-models.mjs [model]
 *   
 * Models:
 *   bark        - Test Bark for generating seed audio from text
 *   xtts        - Test XTTS-v2 for voice cloning (requires reference audio)
 *   chatterbox  - Test Chatterbox Turbo for fast TTS
 *   all         - Test all models (default)
 * 
 * Environment:
 *   REPLICATE_API_KEY - Your Replicate API key (loaded from .env)
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root (simple parser, no external deps)
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function loadEnv() {
  try {
    const envPath = join(projectRoot, '.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  } catch {
    // .env file not found, rely on environment
  }
}

loadEnv();

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// Output directory for generated audio
const OUTPUT_DIR = join(projectRoot, 'test-outputs', 'voice');

// Cache for model versions (fetched once per session)
const versionCache = new Map();

/**
 * Get the latest version ID for a community model
 */
async function getModelVersion(modelName) {
  if (versionCache.has(modelName)) {
    return versionCache.get(modelName);
  }
  
  const response = await fetch(`https://api.replicate.com/v1/models/${modelName}`, {
    headers: { 'Authorization': `Bearer ${REPLICATE_API_KEY}` },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get model ${modelName}: ${response.status}`);
  }
  
  const model = await response.json();
  const version = model.latest_version?.id;
  
  if (!version) {
    throw new Error(`No version found for model ${modelName}`);
  }
  
  versionCache.set(modelName, version);
  return version;
}

// Model configurations
const MODELS = {
  // For generating voice seed audio from sound/music (OFFICIAL - warm, fast!)
  stableAudio: {
    name: 'stability-ai/stable-audio-2.5',
    description: 'Generates audio/music/sounds from text - use as voice seed',
    cost: '$0.20/run',
    coldBoot: false,
    isOfficial: true,
  },
  // Legacy: Text-to-audio (cold boot, slower)
  bark: {
    name: 'suno-ai/bark',
    description: 'Text-to-audio model - generates speech/audio from text prompts',
    cost: '~$0.047/run',
    coldBoot: true,
    isOfficial: false,
  },
  // For voice cloning with reference audio
  xtts: {
    name: 'lucataco/xtts-v2',
    description: 'Voice cloning TTS - synthesizes speech using a reference voice',
    cost: '~$0.005/run',
    coldBoot: false,
    isOfficial: false,
  },
  // Fast TTS with preset voices (OFFICIAL)
  chatterbox: {
    name: 'resemble-ai/chatterbox-turbo',
    description: 'Fast TTS with preset voices and paralinguistic tags',
    cost: '$0.025/1k chars',
    coldBoot: false,
    isOfficial: true,
  },
};

// Sample reference audio URL (a clear male voice sample)
const SAMPLE_REFERENCE_AUDIO = 'https://replicate.delivery/pbxt/Jt79w0xsT64R1JsiJ0LQRL8UcWspg5J4RFrU6YwEKpOT1ukS/male.wav';

/**
 * Poll a Replicate prediction until it completes
 * @param predictionId - The prediction ID to poll
 * @param maxAttempts - Max poll attempts (default 120 = 4 minutes for cold boot models)
 */
async function pollPrediction(predictionId, maxAttempts = 120) {
  const pollInterval = 2000; // 2 seconds
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${REPLICATE_ENDPOINT}/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_KEY}` },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to poll prediction: ${response.status}`);
    }
    
    const prediction = await response.json();
    
    if (prediction.status === 'succeeded') {
      return prediction.output;
    }
    
    if (prediction.status === 'failed') {
      throw new Error(`Prediction failed: ${prediction.error || 'Unknown error'}`);
    }
    
    if (prediction.status === 'canceled') {
      throw new Error('Prediction was canceled');
    }
    
    // Still processing, wait and retry
    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  throw new Error('Prediction timed out');
}

/**
 * Run a Replicate prediction
 * 
 * For official models (like resemble-ai/chatterbox-turbo), we can use the models endpoint.
 * For community models (like lucataco/xtts-v2), we need to use the predictions endpoint.
 */
async function runPrediction(model, input, isOfficial = false) {
  console.log(`\n🚀 Running ${model}...`);
  console.log(`   Input: ${JSON.stringify(input, null, 2).substring(0, 200)}...`);
  
  let response;
  
  if (isOfficial) {
    // Official models use the models endpoint
    const modelsEndpoint = `https://api.replicate.com/v1/models/${model}/predictions`;
    response = await fetch(modelsEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({ input }),
    });
  } else {
    // Community models need the full version hash
    console.log(`   Fetching latest version for ${model}...`);
    const version = await getModelVersion(model);
    console.log(`   Version: ${version.substring(0, 12)}...`);
    
    response = await fetch(REPLICATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({ version, input }),
    });
  }
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start prediction: ${response.status} - ${error}`);
  }
  
  const prediction = await response.json();
  console.log(`   Prediction ID: ${prediction.id}`);
  
  // If prediction already completed (sync mode worked)
  if (prediction.status === 'succeeded') {
    console.log(`\n   ✅ Completed (sync)`);
    return prediction.output;
  }
  
  process.stdout.write('   Waiting');
  
  const startTime = Date.now();
  const output = await pollPrediction(prediction.id);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n   ✅ Completed in ${duration}s`);
  return output;
}

/**
 * Download audio from URL and save to file
 */
async function downloadAudio(url, filename) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }
  
  const buffer = Buffer.from(await response.arrayBuffer());
  const filepath = join(OUTPUT_DIR, filename);
  
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  writeFileSync(filepath, buffer);
  console.log(`   📁 Saved to: ${filepath}`);
  return filepath;
}

/**
 * Test Stable Audio 2.5 - Sound/Music Generation (OFFICIAL - WARM!)
 * Good for: Generating abstract audio to use as voice cloning seed
 */
async function testStableAudio() {
  console.log('\n' + '='.repeat(60));
  console.log('🎵 Testing Stable Audio 2.5 (stability-ai/stable-audio-2.5)');
  console.log('   Purpose: Generate sound/music as voice seed (NO cold boot!)');
  console.log('   Cost: $0.20/run | Cold boot: No (warm, fast!)');
  console.log('='.repeat(60));
  
  // Generate abstract audio that will give the cloned voice a unique character
  // Think: tonal qualities, texture, resonance - not actual speech
  const prompt = `warm resonant humming, deep rich bass tones, 
gentle melodic whisper, ethereal ambient drone, 
smooth analog synthesizer pad, mysterious and confident`;
  
  try {
    // Stable Audio is an OFFICIAL model
    const output = await runPrediction('stability-ai/stable-audio-2.5', {
      prompt,
      duration: 10, // Just need a short clip for voice cloning
      steps: 8,
      cfg_scale: 1,
    }, true);
    
    // Stable Audio returns a URL to the generated audio
    const audioUrl = typeof output === 'string' ? output : output;
    if (audioUrl) {
      await downloadAudio(audioUrl, 'stable-audio-test.wav');
      console.log(`   🔊 Audio URL: ${audioUrl}`);
    }
    
    return { success: true, output: audioUrl };
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Test Bark - Text to Audio
 * Good for: Generating voice seed audio from text descriptions
 */
async function testBark() {
  console.log('\n' + '='.repeat(60));
  console.log('🐶 Testing Bark (suno-ai/bark)');
  console.log('   Purpose: Generate voice seed audio from text description');
  console.log('   Cost: ~$0.047/run | Cold boot: Yes (may take 1-2 min first time)');
  console.log('='.repeat(60));
  
  const prompt = `Hello, I am an AI assistant with a warm and confident voice. 
I speak clearly and with purpose, yet there's a hint of playfulness in my tone. 
[clears throat] Let me tell you something interesting about artificial intelligence.`;
  
  try {
    // Bark is a community model, not official
    const output = await runPrediction('suno-ai/bark', {
      prompt,
      text_temp: 0.7,
      waveform_temp: 0.7,
    }, false);
    
    // Bark returns a URL to the generated audio
    const audioUrl = typeof output === 'string' ? output : output?.audio_out;
    if (audioUrl) {
      await downloadAudio(audioUrl, 'bark-test.wav');
      console.log(`   🔊 Audio URL: ${audioUrl}`);
    }
    
    return { success: true, output: audioUrl };
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Test XTTS-v2 - Voice Cloning
 * Good for: Cloning a voice from reference audio for TTS
 */
async function testXTTS() {
  console.log('\n' + '='.repeat(60));
  console.log('🎙️ Testing XTTS-v2 (lucataco/xtts-v2)');
  console.log('   Purpose: Voice cloning TTS - speak with a reference voice');
  console.log('   Cost: ~$0.005/run | Cold boot: No (warm)');
  console.log('='.repeat(60));
  
  const text = `Greetings, human. I have successfully cloned this voice and can now speak 
with its characteristics. This is quite fascinating technology, wouldn't you agree?`;
  
  try {
    // XTTS-v2 is a community model, not official
    const output = await runPrediction('lucataco/xtts-v2', {
      text,
      speaker: SAMPLE_REFERENCE_AUDIO,
      language: 'en',
      cleanup_voice: false,
    }, false);
    
    // XTTS returns a URL to the generated audio
    const audioUrl = typeof output === 'string' ? output : output;
    if (audioUrl) {
      await downloadAudio(audioUrl, 'xtts-test.wav');
      console.log(`   🔊 Audio URL: ${audioUrl}`);
    }
    
    return { success: true, output: audioUrl };
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Test Chatterbox Turbo - Fast TTS
 * Good for: Quick voice generation with preset voices
 */
async function testChatterbox() {
  console.log('\n' + '='.repeat(60));
  console.log('💬 Testing Chatterbox Turbo (resemble-ai/chatterbox-turbo)');
  console.log('   Purpose: Fast TTS with preset voices and emotional tags');
  console.log('   Cost: $0.025/1k chars | Cold boot: No (warm)');
  console.log('='.repeat(60));
  
  // Chatterbox supports paralinguistic tags: [clear throat], [sigh], [cough], [groan], [sniff], [gasp], [chuckle], [laugh]
  const text = `Oh, that's quite interesting! [chuckle] Let me explain how this works. 
[clear throat] Chatterbox Turbo is a fast text-to-speech model that supports 
emotional expressions and various vocal effects. [sigh] It's really quite impressive.`;
  
  // Available preset voices: Andy, Luna, Ember, Hem, Aurora, Cliff, Josh, William, Orion, Ken
  const voice = 'Andy';
  
  try {
    // Chatterbox Turbo is an OFFICIAL model
    const output = await runPrediction('resemble-ai/chatterbox-turbo', {
      text,
      voice,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 1000,
      repetition_penalty: 1.2,
    }, true);
    
    // Chatterbox returns a URL to the generated audio
    const audioUrl = typeof output === 'string' ? output : output;
    if (audioUrl) {
      await downloadAudio(audioUrl, 'chatterbox-test.wav');
      console.log(`   🔊 Audio URL: ${audioUrl}`);
    }
    
    return { success: true, output: audioUrl };
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Test the full voice creation pipeline (FAST VERSION)
 * 1. Generate abstract audio with Stable Audio 2.5 (warm, no cold boot!)
 * 2. Clone that audio with XTTS-v2 to create a unique voice
 */
async function testVoiceCreationPipeline() {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 Testing Voice Creation Pipeline (Sound → Voice)');
  console.log('   Step 1: Generate abstract sound with Stable Audio 2.5');
  console.log('   Step 2: Clone that sound into a voice with XTTS-v2');
  console.log('='.repeat(60));
  
  // Step 1: Generate abstract audio that will define the voice character
  // The tonal qualities, texture, and resonance become voice characteristics
  console.log('\n📌 Step 1: Generating abstract audio seed...');
  const soundPrompt = `deep resonant hum, warm analog synthesizer drone, 
rich bass undertones with gentle high harmonics, 
confident commanding presence, mysterious ethereal quality`;
  
  let seedAudioUrl;
  try {
    // Stable Audio is OFFICIAL (warm, fast!)
    seedAudioUrl = await runPrediction('stability-ai/stable-audio-2.5', {
      prompt: soundPrompt,
      duration: 10, // XTTS needs at least 6 seconds
      steps: 8,
      cfg_scale: 1,
    }, true);
    
    await downloadAudio(seedAudioUrl, 'pipeline-seed-sound.wav');
    console.log('   ✅ Abstract audio seed generated');
  } catch (error) {
    console.error(`   ❌ Failed to generate seed: ${error.message}`);
    return { success: false, error: error.message };
  }
  
  // Step 2: Clone the abstract audio into a voice with XTTS
  // XTTS interprets the tonal qualities and creates a unique voice
  console.log('\n📌 Step 2: First clone pass (abstract audio → raw voice)...');
  const ttsText = `I am a voice born from pure sound. My tonal character comes from 
abstract audio frequencies, transformed into speech. This is my unique vocal signature.`;
  
  let firstCloneUrl;
  try {
    firstCloneUrl = await runPrediction('lucataco/xtts-v2', {
      text: ttsText,
      speaker: seedAudioUrl,
      language: 'en',
      cleanup_voice: true, // Clean up since seed is abstract audio
    }, false);
    
    await downloadAudio(firstCloneUrl, 'pipeline-clone-1.wav');
    console.log('   ✅ First clone pass complete');
  } catch (error) {
    console.error(`   ❌ Failed first clone: ${error.message}`);
    return { success: false, error: error.message };
  }
  
  // Step 3: Clone the cloned voice again to smooth it out
  // This refines the voice, removing artifacts from the abstract seed
  console.log('\n📌 Step 3: Second clone pass (smoothing the voice)...');
  const smoothingText = `Now my voice is refined and polished. The raw frequencies 
have been smoothed into a clear, distinctive vocal character. I speak with clarity and presence.`;
  
  try {
    const smoothedUrl = await runPrediction('lucataco/xtts-v2', {
      text: smoothingText,
      speaker: firstCloneUrl,
      language: 'en',
      cleanup_voice: false, // Already clean from first pass
    }, false);
    
    await downloadAudio(smoothedUrl, 'pipeline-final.wav');
    console.log('   ✅ Voice smoothed successfully');
    
    return { 
      success: true, 
      seedUrl: seedAudioUrl, 
      firstCloneUrl: firstCloneUrl,
      finalUrl: smoothedUrl 
    };
  } catch (error) {
    console.error(`   ❌ Failed to smooth voice: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('🎤 Replicate Voice Models Test Script');
  console.log('=====================================\n');
  
  // Check for API key
  if (!REPLICATE_API_KEY) {
    console.error('❌ REPLICATE_API_KEY not found in environment');
    console.error('   Please add it to your .env file');
    process.exit(1);
  }
  
  console.log('✅ API Key found');
  console.log(`📁 Output directory: ${OUTPUT_DIR}\n`);
  
  // Parse command line args
  const model = process.argv[2] || 'all';
  const results = {};
  
  switch (model) {
    case 'bark':
      results.bark = await testBark();
      break;
      
    case 'xtts':
      results.xtts = await testXTTS();
      break;
      
    case 'chatterbox':
      results.chatterbox = await testChatterbox();
      break;
      
    case 'stable-audio':
      results.stableAudio = await testStableAudio();
      break;
      
    case 'pipeline':
      results.pipeline = await testVoiceCreationPipeline();
      break;
      
    case 'all':
    default:
      // Run all tests (skip bark due to cold boot, use stable-audio)
      results.stableAudio = await testStableAudio();
      results.xtts = await testXTTS();
      results.chatterbox = await testChatterbox();
      break;
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));
  
  for (const [name, result] of Object.entries(results)) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${name}: ${result.success ? 'PASSED' : result.error}`);
  }
  
  console.log('\n📝 Recommended Models:');
  console.log('   - Audio Seed Generation: stability-ai/stable-audio-2.5 (WARM, fast!)');
  console.log('   - Voice Cloning TTS: lucataco/xtts-v2');
  console.log('   - Fast Preset TTS: resemble-ai/chatterbox-turbo');
  console.log('\n💡 For createMyVoice pipeline:');
  console.log('   STABLE_AUDIO_MODEL=stability-ai/stable-audio-2.5 (generates abstract audio)');
  console.log('   VOICE_TTS_MODEL=lucataco/xtts-v2 (clones audio into voice)');
  
  // Return exit code based on results
  const allPassed = Object.values(results).every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
