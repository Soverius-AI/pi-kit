import { Component, DestroyRef, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Language, TranslocoPipe, type LanguageCode } from '@pi-kit/i18n';
import jsQR from 'jsqr';
import { RemoteAddress } from './addresses';
import { SiteStorage } from './storage';

@Component({
  selector: 'pk-onboarding',
  imports: [TranslocoPipe],
  templateUrl: './onboarding.html',
  styleUrl: './onboarding.css',
  host: { '(document:visibilitychange)': 'onVisibility()', '(window:pagehide)': 'stopCamera()' },
})
export class Onboarding {
  protected readonly language = inject(Language);
  private readonly destroyRef = inject(DestroyRef);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly address = signal(RemoteAddress.origin(SiteStorage.read(SiteStorage.ADDRESS) ?? '') ?? '');
  protected readonly invalid = signal(false);
  protected readonly scanning = signal(false);
  protected readonly scanStatus = signal('');

  private stream?: MediaStream;
  private frame?: number;
  private generation = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopCamera());
  }

  protected setLanguage(code: LanguageCode): void {
    SiteStorage.write(SiteStorage.LANGUAGE, code);
    void this.language.activate(code);
  }

  protected open(): void {
    const origin = RemoteAddress.origin(this.address());
    this.invalid.set(!origin);
    if (!origin) return;
    SiteStorage.write(SiteStorage.ADDRESS, origin);
    location.assign(origin + '/');
  }

  protected onVisibility(): void {
    if (document.hidden) this.stopCamera();
  }

  protected async scan(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.scanStatus.set('remoteSite.scanNoCamera');
      return;
    }
    this.stopCamera();
    const mine = this.generation;
    this.scanning.set(true);
    this.scanStatus.set('remoteSite.scanHint');
    const dialog = this.dialog()?.nativeElement;
    if (dialog && !dialog.open) dialog.showModal();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      });
      const video = this.video()?.nativeElement;
      const context = this.canvas()?.nativeElement.getContext('2d', { willReadFrequently: true });
      if (mine !== this.generation || !video || !context) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
      let last = -Infinity;
      const detect = (now: number): void => {
        if (mine !== this.generation) return;
        if (video.readyState >= 2 && video.videoWidth && now - last >= 180) {
          last = now;
          const canvas = context.canvas;
          const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
          if (result) {
            const link = RemoteAddress.pairingLink(result.data);
            if (link) {
              this.stopCamera();
              SiteStorage.write(SiteStorage.ADDRESS, new URL(link).origin);
              location.assign(link);
              return;
            }
            this.scanStatus.set('remoteSite.scanWrong');
          }
        }
        this.frame = requestAnimationFrame(detect);
      };
      this.frame = requestAnimationFrame(detect);
    } catch (error) {
      if (mine !== this.generation) return;
      this.stopCamera();
      const name = (error as { name?: string } | undefined)?.name;
      this.scanStatus.set(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'remoteSite.scanDenied' : 'remoteSite.scanFailed',
      );
    }
  }

  protected cancelScan(): void {
    this.stopCamera();
    this.scanStatus.set('');
  }

  protected stopCamera(): void {
    this.generation++;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    const video = this.video()?.nativeElement;
    if (video) video.srcObject = null;
    const dialog = this.dialog()?.nativeElement;
    if (dialog?.open) dialog.close();
    this.scanning.set(false);
  }
}
