/** Pairing is deliberately separate from the authenticated Angular application. */
export class PairingPage {
  static html(nonce: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<meta name="theme-color" content="#14171e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="pi-kit">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>Pair device</title><style nonce="${nonce}">
*{box-sizing:border-box}body{font:17px system-ui;background:#14171e;color:#f3f4f6;margin:0;min-height:100dvh;padding:max(24px,env(safe-area-inset-top,0px)) max(20px,env(safe-area-inset-right,0px)) max(24px,env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px))}
main{max-width:420px;margin:clamp(16px,5vh,48px) auto}h1{font-size:28px;margin:0 0 16px}p{line-height:1.5}input,button{width:100%;font:inherit;min-height:48px;padding:12px 14px;margin:8px 0;border-radius:10px}input{background:#202630;color:inherit;border:1px solid #606975;letter-spacing:.1em}button{cursor:pointer;border:1px solid #606975;background:#252d39;color:inherit}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid #edbd50;outline-offset:2px}#request{background:#edbd50;color:#15181d;border-color:#edbd50;font-weight:600}.hint{font-size:14px;color:#b8c0cd}.divider{text-align:center;margin:20px 0;color:#b8c0cd}#camera{width:100%;max-height:40svh;aspect-ratio:4/3;object-fit:contain;background:#000;border-radius:12px}#status{white-space:pre-wrap;line-height:1.6}.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:20px;margin-bottom:20px}.brand img{width:36px;height:36px;border-radius:9px}canvas,[hidden]{display:none!important}
</style></head><body><main>
<div class="brand"><img src="/icons/icon-192.png" alt="">pi-kit</div>
<h1>Pair your device</h1><p>Scan the QR code shown in pi-kit on your computer, or enter its pairing code.</p>
<button id="scan" type="button" aria-controls="camera-panel" aria-expanded="false">Scan QR code with camera</button>
<p class="hint">Camera images stay on this device. Camera access is requested only when you choose Scan.</p>
<section id="camera-panel" hidden aria-label="QR scanner"><video id="camera" autoplay muted playsinline></video><canvas id="frame"></canvas><button id="cancel-scan" type="button">Cancel scanning</button></section>
<p class="divider">Or enter the code manually</p>
<form id="pair"><label for="code">Pairing code</label><input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required><button id="request" type="submit">Request access</button></form>
<p class="hint">Only approve on your computer if the confirmation codes match.</p><p id="status" role="status" aria-live="polite"></p>
</main><script nonce="${nonce}" src="/phone/jsQR.js"></script><script nonce="${nonce}" src="/phone/pairing.js"></script></body></html>`;
  }
}
