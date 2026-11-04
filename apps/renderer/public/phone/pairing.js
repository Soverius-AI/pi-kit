/* QR frames never leave this page. jsQR is bundled locally, not fetched from a CDN. */
(() => {
  'use strict';
  const input = document.getElementById('code');
  const form = document.getElementById('pair');
  const status = document.getElementById('status');
  const scan = document.getElementById('scan');
  const panel = document.getElementById('camera-panel');
  const video = document.getElementById('camera');
  const canvas = document.getElementById('frame');
  const request = document.getElementById('request');
  let stream,
    frame,
    generation = 0,
    pairing = false,
    pollTimer;

  function pairingCode(value) {
    const text = value.trim();
    if (/^[A-Z2-7]{12}$/i.test(text)) return text.toUpperCase();
    try {
      const url = new URL(text);
      if (
        url.protocol === 'https:' &&
        url.origin === location.origin &&
        !url.username &&
        !url.password &&
        url.pathname === '/phone' &&
        !url.search &&
        /^[A-Z2-7]{12}$/.test(url.hash.slice(1))
      )
        return url.hash.slice(1);
    } catch {
      /* Never navigate to arbitrary scanned links. */
    }
    return null;
  }

  function stopCamera() {
    generation++;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    panel.hidden = true;
    scan.disabled = pairing;
    scan.setAttribute('aria-expanded', 'false');
  }

  async function startCamera() {
    if (pairing) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent =
        'Camera scanning requires HTTPS and a supported browser. You can still enter the pairing code manually.';
      return;
    }
    if (typeof globalThis.jsQR !== 'function') {
      status.textContent = 'The QR scanner could not load. Reload this page, or enter the pairing code manually.';
      return;
    }
    stopCamera();
    const current = generation;
    scan.disabled = true;
    scan.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    status.textContent = 'Point the rear camera at the QR code on your computer.';
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      });
      if (current !== generation) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = next;
      video.srcObject = next;
      await video.play();
      if (current !== generation) return;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas unavailable');
      let lastFrame = -Infinity;
      const detect = (now) => {
        if (current !== generation) return;
        try {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight && now - lastFrame >= 180) {
            lastFrame = now;
            const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = globalThis.jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
            if (result) {
              const code = pairingCode(result.data);
              if (code) {
                input.value = code;
                stopCamera();
                status.textContent =
                  'QR code scanned. Choose Request access, then compare and approve the confirmation code on your computer.';
                request.focus();
                return;
              }
              const message =
                'That QR code is not a pairing code for this pi-kit address. Scan the QR code shown by this computer.';
              if (status.textContent !== message) status.textContent = message;
            }
          }
          frame = requestAnimationFrame(detect);
        } catch {
          stopCamera();
          status.textContent =
            'The camera scanner could not read this image. Try again, or enter the pairing code manually.';
        }
      };
      frame = requestAnimationFrame(detect);
    } catch (error) {
      if (current !== generation) return;
      stopCamera();
      status.textContent =
        error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'Camera access was blocked. Allow camera access for this site in Safari settings, or enter the pairing code manually.'
          : error?.name === 'NotFoundError'
            ? 'No camera was found. Enter the pairing code manually.'
            : 'The camera could not start. Close other apps using it and try again, or enter the pairing code manually.';
    }
  }

  function readPairingFragment() {
    const fragment = location.hash.slice(1);
    history.replaceState(null, '', '/phone');
    if (/^[A-Z2-7]{12}$/.test(fragment)) {
      stopCamera();
      input.value = fragment;
      if (!pairing) status.textContent = '';
    }
  }
  readPairingFragment();
  window.addEventListener('hashchange', readPairingFragment);
  scan.addEventListener('click', startCamera);
  document.getElementById('cancel-scan').addEventListener('click', () => {
    stopCamera();
    status.textContent = 'Scanning cancelled. Enter the code manually or scan again.';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !panel.hidden) {
      stopCamera();
      status.textContent = 'Camera paused. Choose Scan to continue, or enter the code manually.';
    }
  });
  window.addEventListener('pagehide', () => {
    stopCamera();
    clearTimeout(pollTimer);
  });
  window.addEventListener('pageshow', () => {
    if (pairing) pollTimer = setTimeout(poll, 1000);
  });

  function resetRequest(message) {
    pairing = false;
    request.disabled = false;
    scan.disabled = false;
    status.textContent = message;
  }
  async function poll() {
    try {
      const response = await fetch('/phone/pair/status');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Pairing failed');
      if (data.status === 'approved') {
        location.replace('/');
        return;
      }
      pollTimer = setTimeout(poll, 1000);
    } catch (error) {
      resetRequest(error.message);
    }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pairing) return;
    pairing = true;
    stopCamera();
    request.disabled = true;
    status.textContent = 'Requesting access…';
    try {
      const response = await fetch('/phone/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: input.value.trim().toUpperCase() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Pairing failed');
      input.value = '';
      status.textContent =
        'Confirmation code: ' + data.confirmationCode + '\nApprove this code in pi-kit on your computer.';
      pollTimer = setTimeout(poll, 1000);
    } catch (error) {
      resetRequest(error.message);
    }
  });
})();
