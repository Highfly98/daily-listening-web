import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } from "./voice/wasi/index.js";

const engineURL = "https://unpkg.com/@echogarden/flite-wasi@0.1.1/flite.wasm";
const engineIntegrity = "sha256-+XUnb08qbeeGE/GXUzqsIWfRgbdwIIZtFC1ZS8wqDoA=";
const maxAudioBytes = 96 * 1024 * 1024;

function readPcm(wave) {
  const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
  if (view.byteLength < 44 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    throw new Error("Invalid WAV");
  }
  let rate = 0;
  let pcm;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const name = view.getUint32(offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > view.byteLength) throw new Error("Truncated WAV");
    if (name === 0x666d7420 && length >= 16) {
      if (view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint16(start + 14, true) !== 16) throw new Error("Unexpected WAV format");
      rate = view.getUint32(start + 4, true);
    }
    if (name === 0x64617461) pcm = wave.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!rate || !pcm?.length || pcm.length % 2) throw new Error("Empty or invalid PCM");
  return { rate, pcm };
}

async function speakArticle(engine, text, voice, speed) {
  const files = new Map([
    ["article.txt", new File(new TextEncoder().encode(text.replaceAll("\0", " ")))],
    ["article.wav", new File([])]
  ]);
  const discard = () => {};
  const fds = [
    new OpenFile(new File([])), ConsoleStdout.lineBuffered(discard),
    ConsoleStdout.lineBuffered(discard), new PreopenDirectory("/", files)
  ];
  const args = [
    "flite", "-voice", voice, "--setf", `duration_stretch=${1 / speed}`,
    "-f", "/article.txt", "-o", "/article.wav"
  ];
  const wasi = new WASI(args, [], fds);
  const instance = await WebAssembly.instantiate(engine, { wasi_snapshot_preview1: wasi.wasiImport });
  if (wasi.start(instance) !== 0) throw new Error("Synthesis failed");
  return readPcm(files.get("article.wav").data);
}

function waveHeader(rate, bytes) {
  const view = new DataView(new ArrayBuffer(44));
  view.setUint32(0, 0x52494646);
  view.setUint32(4, bytes + 36, true);
  view.setUint32(8, 0x57415645);
  view.setUint32(12, 0x666d7420);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461);
  view.setUint32(40, bytes, true);
  return view.buffer;
}

export async function synthesizeTrack(engine, settings, onProgress = () => {}) {
  const { articles, infinite, repetitions, gap, speed, language } = settings;
  const voice = language === "en-GB" ? "awb" : "slt";
  const clips = [];
  let rate = 0;
  let clipBytes = 0;
  if (!articles.length || !Number.isInteger(repetitions) || repetitions < 1 ||
      !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(gap) || gap < 0) {
    throw new Error("Invalid playback settings");
  }
  for (const text of articles) {
    const clip = await speakArticle(engine, text, voice, speed);
    if (rate && clip.rate !== rate) throw new Error("Incompatible sample rates");
    rate = clip.rate;
    clipBytes += clip.pcm.byteLength;
    if (clipBytes * repetitions > maxAudioBytes) throw new RangeError("track-too-long");
    clips.push(clip.pcm);
    onProgress(clips.length, articles.length);
  }
  const pause = new Uint8Array(Math.round(rate * gap) * 2);
  const clipCount = clips.length * repetitions;
  const bytes = clipBytes * repetitions + pause.byteLength * (infinite ? clipCount : clipCount - 1);
  if (bytes > maxAudioBytes) throw new RangeError("track-too-long");
  const parts = [waveHeader(rate, bytes)];
  for (let index = 0; index < clipCount; index++) {
    parts.push(clips[index % clips.length]);
    if (pause.byteLength && (infinite || index < clipCount - 1)) parts.push(pause);
  }
  return new Blob(parts, { type: "audio/wav" });
}

async function loadEngine() {
  const signal = AbortSignal.timeout?.(120_000);
  const response = await fetch(engineURL, {
    integrity: engineIntegrity,
    signal
  });
  if (!response.ok) throw new Error("Engine download failed");
  return WebAssembly.compileStreaming(response);
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.addEventListener("message", async ({ data }) => {
    let engine;
    try {
      engine = await loadEngine();
    } catch {
      self.postMessage({ error: "engine" });
      return;
    }
    try {
      const audio = await synthesizeTrack(engine, data, (done, total) => self.postMessage({ done, total }));
      self.postMessage({ audio });
    } catch (error) {
      self.postMessage({ error: error instanceof RangeError && error.message === "track-too-long" ? "length" : "synthesis" });
    }
  }, { once: true });
}
