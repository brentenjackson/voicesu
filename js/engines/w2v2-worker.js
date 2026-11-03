// Web Worker for the wav2vec 2.0 engine: runs the exported probe graph
// (400 ms of 16 kHz audio in, Bark F1/F2 out) with onnxruntime-web.
// A classic worker, so importScripts can load onnxruntime-web's bundle.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let session = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      importScripts(msg.ortUrl ?? `${ORT_BASE}ort.min.js`);
      ort.env.wasm.wasmPaths = msg.wasmPaths ?? ORT_BASE;
      // Multi-threaded WASM needs a cross-origin-isolated page; one thread works anywhere.
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const t0 = performance.now();
      session = await ort.InferenceSession.create(msg.modelUrl, {
        executionProviders: msg.providers ?? ['wasm'],
        graphOptimizationLevel: 'all',
      });
      self.postMessage({ type: 'ready', loadMs: performance.now() - t0, threads: ort.env.wasm.numThreads });
    } else if (msg.type === 'run') {
      const t0 = performance.now();
      const out = await session.run({ wave: new ort.Tensor('float32', msg.wave, [1, msg.wave.length]) });
      self.postMessage({
        type: 'result', id: msg.id, endTime: msg.endTime,
        bark: Array.from(out.bark.data), inferMs: performance.now() - t0,
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
