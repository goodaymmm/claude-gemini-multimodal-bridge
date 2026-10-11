/**
 * Telling a finished WAV file from headerless PCM.
 *
 * gemini-3.1-flash-tts-preview and earlier TTS models answer generateContent
 * with raw 16-bit PCM, which CGMB wraps in a RIFF/WAVE header. The default is
 * now gemini-3.8-flash-tts, which returns a complete WAV file in the same
 * place. Wrapping that again writes a second header into the audio stream:
 * the file still opens, plays a click, and reports the wrong length -- so
 * nothing fails loudly. These cases pin the detection that decides whether a
 * header is added, and that the reported format comes from the file itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TTS_PCM_FORMAT,
  describeTtsAudio,
  hasWavHeader,
  isWavAudio,
  pcmFormatFromMimeType,
  readWavFormat,
} from '../dist/utils/wavAudio.js';

/** A minimal canonical PCM WAV file, optionally with an extra chunk before fmt. */
function wavFile({ sampleRate = 24000, bitDepth = 16, channels = 1, samples = 4, extraChunk = false } = {}) {
  const data = Buffer.alloc(samples * channels * (bitDepth / 8));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 16);
  fmt.writeUInt16LE(channels * (bitDepth / 8), 20);
  fmt.writeUInt16LE(bitDepth, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(data.length, 4);
  // An odd-sized LIST chunk, so the pad byte rule is exercised.
  const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...(extraChunk ? [list] : []), fmt, dataHeader, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** Headerless L16 PCM, as the older TTS models return it. */
const rawPcm = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x00, 0x80, 0x10, 0x20]);

describe('isWavAudio', () => {
  it('recognises a complete WAV file by its RIFF/WAVE header', () => {
    assert.equal(hasWavHeader(wavFile()), true);
    assert.equal(isWavAudio(wavFile()), true);
    assert.equal(isWavAudio(wavFile(), 'audio/wav'), true);
  });

  it('treats headerless PCM as PCM, so it still gets wrapped', () => {
    assert.equal(hasWavHeader(rawPcm), false);
    assert.equal(isWavAudio(rawPcm), false);
    assert.equal(isWavAudio(rawPcm, 'audio/L16;codec=pcm;rate=24000'), false);
    assert.equal(isWavAudio(rawPcm, 'audio/pcm'), false);
  });

  it('accepts a declared WAV MIME type', () => {
    for (const mime of ['audio/wav', 'audio/WAV', 'audio/x-wav', 'audio/wave', ' audio/wav; codecs=1']) {
      assert.equal(isWavAudio(rawPcm, mime), true, mime);
    }
  });

  it('does not mistake a RIFF container of another kind, or a short buffer, for WAV', () => {
    const avi = wavFile();
    avi.write('AVI ', 8, 'ascii');
    assert.equal(isWavAudio(avi), false);
    assert.equal(isWavAudio(Buffer.from('RIFF')), false);
    assert.equal(isWavAudio(Buffer.alloc(0)), false);
  });
});

describe('the reported audio format', () => {
  it('is read from the WAV header when the model sent a WAV file', () => {
    const file = wavFile({ sampleRate: 48000, bitDepth: 16, channels: 2, extraChunk: true });
    assert.deepEqual(readWavFormat(file), { sampleRate: 48000, bitDepth: 16, channels: 2 });
    assert.deepEqual(describeTtsAudio(file, 'audio/wav'), {
      isWav: true,
      format: { sampleRate: 48000, bitDepth: 16, channels: 2 },
    });
  });

  it('comes from the MIME rate for PCM, defaulting to 24 kHz / 16-bit / mono', () => {
    assert.deepEqual(pcmFormatFromMimeType('audio/L16;codec=pcm;rate=16000'), { sampleRate: 16000, bitDepth: 16, channels: 1 });
    assert.deepEqual(pcmFormatFromMimeType(undefined), { ...DEFAULT_TTS_PCM_FORMAT });
    assert.deepEqual(describeTtsAudio(rawPcm, 'audio/L16;codec=pcm;rate=24000'), {
      isWav: false,
      format: { sampleRate: 24000, bitDepth: 16, channels: 1 },
    });
  });

  it('returns null rather than guessing when a WAV file has no fmt chunk', () => {
    const truncated = wavFile().subarray(0, 12);
    assert.equal(readWavFormat(truncated), null);
    assert.equal(readWavFormat(rawPcm), null);
  });
});
