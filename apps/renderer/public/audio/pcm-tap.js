// Served from the trusted app origin so strict CSP also permits live voice on paired phones.
class PkTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pk-tap', PkTap);
