import { TestBed } from '@angular/core/testing';
import { LocalInstallGuide } from './local-install-guide';

describe('Linux engine installation helper', () => {
  it('shows reviewed terminal instructions and changes the selected backend without running commands', async () => {
    const fixture = TestBed.createComponent(LocalInstallGuide);
    fixture.componentRef.setInput('guide', {
      manager: 'apt',
      prerequisites: 'sudo apt-get install cmake',
      builds: [
        { id: 'cpu', command: 'cmake -DGGML_CUDA=OFF' },
        { id: 'cuda', command: 'cmake -DGGML_CUDA=ON' },
        { id: 'vulkan', command: 'cmake -DGGML_VULKAN=ON' },
      ],
      swapCommand: 'llama-swap --version',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('details')?.open).toBe(true);
    expect(element.textContent).toContain('sudo apt-get install cmake');
    expect(element.textContent).toContain('cmake -DGGML_CUDA=OFF');
    expect(element.querySelector('button')).toBeNull();
    const select = element.querySelector('select')!;
    select.value = 'cuda';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.textContent).toContain('cmake -DGGML_CUDA=ON');
    expect(element.textContent).not.toContain('cmake -DGGML_CUDA=OFF');
    expect(element.querySelector('a[href="https://developer.nvidia.com/cuda-downloads"]')).not.toBeNull();
  });
  it('preserves Homebrew guidance and hides the guide on unsupported platforms', () => {
    const fixture = TestBed.createComponent(LocalInstallGuide);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('details')).toBeNull();
    fixture.componentRef.setInput('guide', { manager: 'brew', builds: [] });
    fixture.componentRef.setInput('installed', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('details').open).toBe(false);
    expect(fixture.nativeElement.querySelector('a[href="https://brew.sh"]')).not.toBeNull();
  });
});
