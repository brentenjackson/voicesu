// AudioWorklet for the wav2vec 2.0 engine: forwards 16 kHz audio in 100 ms chunks.

class W2v2Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1600); // 100 ms at 16 kHz
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.chunk[this.n++] = ch[i];
      if (this.n === this.chunk.length) {
        this.port.postMessage(this.chunk.slice());
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('w2v2-capture', W2v2Capture);
