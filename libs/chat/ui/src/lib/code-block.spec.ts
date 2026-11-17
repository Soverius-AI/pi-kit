import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CodeBlock } from './code-block';

describe('CodeBlock', () => {
  let fixture: ComponentFixture<CodeBlock>;
  let writeText: ReturnType<typeof vi.fn>;
  const root = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fixture = TestBed.createComponent(CodeBlock);
    fixture.componentRef.setInput('code', 'const x = "<script>";');
    fixture.componentRef.setInput('language', 'ts');
    await fixture.whenStable();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('highlights escaped code and copies the original source rather than rendered markup', async () => {
    expect(root().querySelector('.hljs-keyword')).not.toBeNull();
    expect(root().querySelector('script')).toBeNull();
    root().querySelector('button')!.click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith('const x = "<script>";');
    expect(root().querySelector('button')?.textContent).toContain('Copied');
  });

  it('shows an accessible failure state when clipboard permission is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeText.mockRejectedValue(new Error('denied'));
    root().querySelector('button')!.click();
    await fixture.whenStable();
    expect(root().querySelector('[role="status"]')?.textContent).toContain('Could not copy');
    expect(root().querySelector('button')?.textContent).not.toContain('Copied');
  });
});
