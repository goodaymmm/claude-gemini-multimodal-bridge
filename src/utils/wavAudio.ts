/**
 * Telling a finished WAV file apart from headerless PCM.
 *
 * Gemini TTS models up to gemini-3.1-flash-tts-preview answer a unary
 * generateContent call with raw 16-bit PCM (`audio/L16;codec=pcm;rate=24000`),
 * which has to be wrapped in a RIFF/WAVE header before anything can play it.
 * gemini-3.8-flash-tts returns a complete WAV file (`audio/wav`) in the same
 * place. Wrapping that again produces a file whose "samples" start with a
 * second header -- a click, and a sample count that is wrong by 44 bytes. A
 * model override can still select an older TTS ID, so both shapes must work.
 */

export interface PcmFormat {
  sampleRate: number;
  bitDepth: number;
  channels: number;
}

/** What Gemini TTS emits when the response does not say otherwise. */
export const DEFAULT_TTS_PCM_FORMAT: Readonly<PcmFormat> = Object.freeze({
  sampleRate: 24000,
  bitDepth: 16,
  channels: 1,
});

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end));
}

/** True when the bytes begin with a RIFF ... WAVE container header. */
export function hasWavHeader(data: Uint8Array): boolean {
  return data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WAVE';
}

/**
 * True when the audio is already a WAV file and must be written unchanged.
 * The bytes are checked first; a declared `audio/wav` (or `audio/x-wav`,
 * `audio/wave`) MIME type also counts.
 */
export function isWavAudio(data: Uint8Array, mimeType?: string | null): boolean {
  if (hasWavHeader(data)) {
    return true;
  }
  const mime = (mimeType ?? '').trim().toLowerCase();
  return mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav') || mime.startsWith('audio/wave');
}

/** Reads channels, sample rate and bit depth from a WAV file's `fmt ` chunk. */
export function readWavFormat(data: Uint8Array): PcmFormat | null {
  if (!hasWavHeader(data)) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = ascii(data, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      if (offset + 8 + 16 > data.length) {
        return null;
      }
      return {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitDepth: view.getUint16(offset + 22, true),
      };
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** The PCM format a headerless response declares, e.g. `audio/L16;rate=24000`. */
export function pcmFormatFromMimeType(mimeType?: string | null): PcmFormat {
  const rate = /(?:^|;)\s*rate=(\d+)/i.exec(mimeType ?? '');
  const sampleRate = rate ? Number(rate[1]) : NaN;
  return {
    ...DEFAULT_TTS_PCM_FORMAT,
    sampleRate: sampleRate > 0 ? sampleRate : DEFAULT_TTS_PCM_FORMAT.sampleRate,
  };
}

/**
 * Classifies TTS output and reports its real format: from the WAV header when
 * the model sent a WAV file, otherwise from the MIME type (falling back to
 * 24 kHz / 16-bit / mono).
 */
export function describeTtsAudio(
  data: Uint8Array,
  mimeType?: string | null
): { isWav: boolean; format: PcmFormat } {
  if (isWavAudio(data, mimeType)) {
    return { isWav: true, format: readWavFormat(data) ?? { ...DEFAULT_TTS_PCM_FORMAT } };
  }
  return { isWav: false, format: pcmFormatFromMimeType(mimeType) };
}
