// Capture worklet: hands the filtered mic signal to the analysis worker.
//
// This runs on the audio rendering thread, so it only copies. Samples are
// batched into chunks of about half a hop and transferred over the MessagePort
// the main thread sends in, which leads straight to the worker -- audio never
// passes through the main thread.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batch = options.processorOptions.batch;
    this.buf = new Float32Array(this.batch);
    this.fill = 0;
    this.out = null; // MessagePort to the worker; samples before it arrives are dropped
    this.port.onmessage = (e) => { this.out = e.data.port; };
  }

  process(inputs) {
    // Mono: the node is built with channelCount 1, so the graph down-mixes.
    const input = inputs[0][0];
    if (!input || !this.out) return true;
    for (let i = 0; i < input.length; i++) {
      this.buf[this.fill++] = input[i];
      if (this.fill === this.batch) {
        this.out.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.batch);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('voicesu-capture', CaptureProcessor);
