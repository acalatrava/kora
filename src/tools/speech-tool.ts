import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const SCOPE = 'speech-tool';

type SttModelSize = 'tiny' | 'base' | 'small';

export type SpeechStatusCallback = (message: string) => void;

export class SpeechToText {
  private modelName: SttModelSize;
  private modelsDir: string;
  private modelDownloaded = false;
  onStatus: SpeechStatusCallback | null = null;

  constructor(opts: { modelName?: SttModelSize; storagePath: string }) {
    this.modelName = opts.modelName || 'base';
    this.modelsDir = join(opts.storagePath, 'models', 'whisper');
    mkdirSync(this.modelsDir, { recursive: true });
  }

  isModelReady(): boolean {
    return this.modelDownloaded;
  }

  async transcribe(oggPath: string, language?: string): Promise<string> {
    logger.info(SCOPE, `Transcribing: ${oggPath} (language: ${language || 'auto'})`);

    if (!this.modelDownloaded) {
      this.onStatus?.('Downloading speech recognition model... This may take a few minutes on first use.');
      logger.info(SCOPE, `First use — whisper model "${this.modelName}" will be downloaded and compiled`);
    }

    try {
      const { nodewhisper } = await import('nodejs-whisper');

      const whisperOptions: Record<string, unknown> = {
        outputInText: false,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
        wordTimestamps: false,
      };

      if (language) {
        whisperOptions.language = language;
      }

      const result = await nodewhisper(oggPath, {
        modelName: this.modelName,
        autoDownloadModelName: this.modelName,
        whisperOptions,
        removeWavFileAfterTranscription: true,
        logger: {
          debug: (...args: unknown[]) => logger.debug(SCOPE, args.join(' ')),
          error: (...args: unknown[]) => logger.error(SCOPE, args.join(' ')),
          log: (...args: unknown[]) => logger.info(SCOPE, args.join(' ')),
        },
      });

      this.modelDownloaded = true;

      const cleaned = result
        .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '')
        .trim();

      logger.info(SCOPE, `Transcription result (${cleaned.length} chars): ${cleaned.substring(0, 100)}...`);
      return cleaned;
    } catch (err) {
      logger.error(SCOPE, `Transcription failed: ${(err as Error).message}`);
      throw err;
    }
  }
}

const PIPER_VERSION = '2023.11.14-2';
const PIPER_PHONEMIZE_VERSION = '2023.11.14-4';

const PIPER_PLATFORM_MAP: Record<string, string> = {
  'darwin-arm64': 'macos_aarch64',
  'darwin-x64': 'macos_x64',
  'linux-x64': 'linux_x86_64',
  'linux-arm64': 'linux_aarch64',
};

interface VoiceConfig {
  key: string;
  name: string;
  quality: string;
  language: string;
  downloadUrl: string;
  configUrl: string;
}

const VOICES_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const DEFAULT_VOICE_KEY = 'es_ES-davefx-medium';

function buildVoiceConfig(key: string): VoiceConfig {
  const match = key.match(/^([a-z]{2}_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
  if (!match) return buildVoiceConfig(DEFAULT_VOICE_KEY);
  const [, langCode, name, quality] = match;
  const family = langCode.split('_')[0];
  const basePath = `${family}/${langCode}/${name}/${quality}/${key}`;
  return {
    key, name, quality, language: langCode,
    downloadUrl: `${VOICES_BASE_URL}/${basePath}.onnx`,
    configUrl: `${VOICES_BASE_URL}/${basePath}.onnx.json`,
  };
}

export class TextToSpeech {
  private voiceKey: string;
  private storagePath: string;
  private piperDir: string;
  private libDir: string;
  private voicesDir: string;
  private ready = false;
  onStatus: SpeechStatusCallback | null = null;

  constructor(opts: { voiceKey?: string; storagePath: string }) {
    this.voiceKey = opts.voiceKey || 'es_ES-davefx-medium';
    this.storagePath = opts.storagePath;
    this.piperDir = join(opts.storagePath, 'models', 'piper');
    this.libDir = join(this.piperDir, 'lib');
    this.voicesDir = join(this.piperDir, 'voices');
    mkdirSync(this.voicesDir, { recursive: true });
    mkdirSync(this.libDir, { recursive: true });
  }

  private getPiperBinaryPath(): string {
    return join(this.piperDir, 'piper');
  }

  private getVoiceConfig(): VoiceConfig {
    return buildVoiceConfig(this.voiceKey);
  }

  private getVoiceModelPath(): string {
    const voice = this.getVoiceConfig();
    return join(this.voicesDir, `${voice.key}.onnx`);
  }

  private getVoiceConfigPath(): string {
    const voice = this.getVoiceConfig();
    return join(this.voicesDir, `${voice.key}.onnx.json`);
  }

  private getPiperEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    const libPaths = [this.libDir, this.piperDir];

    if (process.platform === 'darwin') {
      const existing = env['DYLD_LIBRARY_PATH'] || '';
      env['DYLD_LIBRARY_PATH'] = [...libPaths, existing].filter(Boolean).join(':');
    } else {
      const existing = env['LD_LIBRARY_PATH'] || '';
      env['LD_LIBRARY_PATH'] = [...libPaths, existing].filter(Boolean).join(':');
    }

    return env;
  }

  async ensurePiper(): Promise<void> {
    if (this.ready) return;

    const piperBin = this.getPiperBinaryPath();
    if (!existsSync(piperBin)) {
      this.onStatus?.('Downloading Piper TTS engine... This may take a minute on first use.');
      await this.downloadPiper();
    }

    await this.ensureSharedLibraries();

    const modelPath = this.getVoiceModelPath();
    if (!existsSync(modelPath)) {
      this.onStatus?.('Downloading voice model...');
      await this.downloadVoice();
    }

    this.ready = true;
    logger.info(SCOPE, `Piper TTS ready with voice "${this.voiceKey}"`);
  }

  private async downloadPiper(): Promise<void> {
    const platform = `${process.platform}-${process.arch}`;
    const piperPlatform = PIPER_PLATFORM_MAP[platform];

    if (!piperPlatform) {
      throw new Error(`Piper TTS is not available for platform: ${platform}. Supported: ${Object.keys(PIPER_PLATFORM_MAP).join(', ')}`);
    }

    const tarName = `piper_${piperPlatform}.tar.gz`;
    const url = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${tarName}`;

    logger.info(SCOPE, `Downloading Piper binary from ${url}...`);
    mkdirSync(this.piperDir, { recursive: true });

    const tarPath = join(this.piperDir, tarName);

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Failed to download Piper: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarPath, buffer);

    try {
      await execFileAsync('tar', ['xzf', tarPath, '-C', this.piperDir, '--strip-components=1']);
    } catch (err) {
      throw new Error(`Failed to extract Piper: ${(err as Error).message}`);
    }

    try {
      await execFileAsync('chmod', ['+x', this.getPiperBinaryPath()]);
    } catch { /* not needed on all platforms */ }

    logger.info(SCOPE, 'Piper binary downloaded and extracted');
  }

  private async ensureSharedLibraries(): Promise<void> {
    const libExt = process.platform === 'darwin' ? 'dylib' : 'so';
    const neededLibs = [
      `libespeak-ng.1.${libExt}`,
      `libpiper_phonemize.1.${libExt}`,
      `libonnxruntime.1.14.1.${libExt}`,
    ];

    const allPresent = neededLibs.every(
      lib => existsSync(join(this.libDir, lib)) || existsSync(join(this.piperDir, lib)),
    );
    if (allPresent) return;

    const platform = `${process.platform}-${process.arch}`;
    const piperPlatform = PIPER_PLATFORM_MAP[platform];
    if (!piperPlatform) return;

    const tarName = `piper-phonemize_${piperPlatform}.tar.gz`;
    const url = `https://github.com/rhasspy/piper-phonemize/releases/download/${PIPER_PHONEMIZE_VERSION}/${tarName}`;

    logger.info(SCOPE, `Downloading shared libraries from ${url}...`);
    const tarPath = join(this.piperDir, tarName);

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      logger.warn(SCOPE, `Failed to download piper-phonemize: HTTP ${response.status}`);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarPath, buffer);

    const extractDir = join(this.piperDir, '_phonemize_tmp');
    mkdirSync(extractDir, { recursive: true });

    try {
      await execFileAsync('tar', ['xzf', tarPath, '-C', extractDir]);
    } catch (err) {
      logger.warn(SCOPE, `Failed to extract piper-phonemize: ${(err as Error).message}`);
      return;
    }

    const { readdirSync, copyFileSync, statSync } = await import('node:fs');
    const copyLibs = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const file of readdirSync(dir)) {
        if (file.endsWith(`.${libExt}`) || file.includes(`.${libExt}.`)) {
          const src = join(dir, file);
          if (statSync(src).isFile()) {
            copyFileSync(src, join(this.libDir, file));
            logger.debug(SCOPE, `Copied library: ${file}`);
          }
        }
      }
    };

    copyLibs(extractDir);
    copyLibs(join(extractDir, 'piper-phonemize'));
    copyLibs(join(extractDir, 'piper-phonemize', 'lib'));
    copyLibs(join(extractDir, 'lib'));

    const { rmSync } = await import('node:fs');
    try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tarPath); } catch { /* ignore */ }

    logger.info(SCOPE, 'Shared libraries installed');
  }

  private async downloadVoice(): Promise<void> {
    const voice = this.getVoiceConfig();
    logger.info(SCOPE, `Downloading voice model: ${voice.key}...`);

    const modelPath = this.getVoiceModelPath();
    const configPath = this.getVoiceConfigPath();

    for (const [url, dest] of [[voice.downloadUrl, modelPath], [voice.configUrl, configPath]]) {
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      writeFileSync(dest, buf);
    }

    logger.info(SCOPE, `Voice model "${voice.key}" downloaded (${(readFileSync(modelPath).length / 1024 / 1024).toFixed(1)}MB)`);
  }

  async synthesize(text: string, outputDir?: string): Promise<string> {
    await this.ensurePiper();

    const outDir = outputDir || join(this.storagePath, 'tts-output');
    mkdirSync(outDir, { recursive: true });

    const wavPath = join(outDir, `tts-${Date.now()}.wav`);
    const oggPath = wavPath.replace(/\.wav$/, '.ogg');

    const piperBin = this.getPiperBinaryPath();
    const modelPath = this.getVoiceModelPath();
    const env = this.getPiperEnv();

    logger.info(SCOPE, `Synthesizing ${text.length} chars with voice "${this.voiceKey}"...`);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          piperBin,
          ['--model', modelPath, '--output_file', wavPath],
          { timeout: 30_000, env },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
        if (child.stdin) {
          child.stdin.write(text);
          child.stdin.end();
        }
      });
    } catch (err) {
      throw new Error(`Piper synthesis failed: ${(err as Error).message}`);
    }

    if (!existsSync(wavPath)) {
      throw new Error('Piper did not produce output WAV file');
    }

    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', wavPath,
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-application', 'voip',
        oggPath,
      ], { timeout: 30_000 });
    } catch (err) {
      throw new Error(`ffmpeg WAV→OGG conversion failed: ${(err as Error).message}. Ensure ffmpeg is installed.`);
    }

    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(wavPath);
    } catch { /* ignore cleanup errors */ }

    logger.info(SCOPE, `TTS output: ${oggPath}`);
    return oggPath;
  }

  static checkDependencies(): { ffmpeg: boolean; piper: boolean } {
    let ffmpeg = false;
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 5000 });
      ffmpeg = true;
    } catch { /* not available */ }

    return { ffmpeg, piper: false };
  }
}
