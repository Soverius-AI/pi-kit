import assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';

/** Stress the real production UI, without sending a message or invoking a model. */
export async function assertPhoneLayout(phone: BrowserWindow): Promise<void> {
  const page = phone.webContents;
  await page.executeJavaScript(`(() => {
    const root=document.documentElement;
    root.style.setProperty('--pk-safe-top','47px');root.style.setProperty('--pk-safe-bottom','34px');
    const drawer=document.querySelector('#t-threads');drawer.checked=true;
    const settings=document.querySelector('.pk-composer-settings');
    const delivery=document.createElement('div');delivery.className='pk-chip mode';delivery.dataset.layoutFixture='delivery';
    delivery.innerHTML='<button class="btn"><span class="v">Steer</span></button>';settings.append(delivery);
    const model=document.querySelector('[data-testid="model-chip"] .v');model.dataset.originalLabel=model.textContent;
    model.textContent='gpt-6.1-sol-a-very-long-model-name';
  })()`);
  const drawer = await page.executeJavaScript(`(() => {
    const top=document.querySelector('.pk-side-top').getBoundingClientRect();
    const foot=document.querySelector('.pk-side-foot').getBoundingClientRect();
    return {top:top.top,bottom:foot.bottom,height:innerHeight};
  })()`);
  assert.ok(drawer.top >= 47, 'thread drawer header stays below the top safe area');
  assert.ok(drawer.bottom <= drawer.height - 34, 'thread drawer footer stays above the home indicator');
  await page.executeJavaScript('document.querySelector("#t-threads").checked=false');
  for (const width of [320, 390, 430]) {
    phone.setContentSize(width, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const layout = await page.executeJavaScript(`(() => {
      const box=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
        model:box('[data-testid="model-chip"]'),effort:box('[data-testid="composer-effort-control"]'),
        delivery:box('[data-layout-fixture="delivery"]'),send:box('[data-testid="send"]'),tools:box('.pk-tools'),
        settings:box('.pk-composer-settings'),fieldSize:parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize),
        headerOverflow:getComputedStyle(document.querySelector('.pk-header')).overflowX};
    })()`);
    assert.equal(layout.overflow, false, `page fits ${width}px`);
    assert.ok(Math.abs(layout.model.top - layout.effort.top) <= 4, `model and effort share a row at ${width}px`);
    assert.ok(
      Math.abs(layout.model.top - layout.delivery.top) <= 4,
      `delivery stays on the settings row at ${width}px`,
    );
    assert.ok(layout.settings.top >= layout.send.bottom, `settings never fill random gaps beside Send at ${width}px`);
    assert.ok(layout.send.right <= width && layout.delivery.right <= width, `all controls fit at ${width}px`);
    assert.ok(layout.send.height >= 44, 'Send remains a large touch target');
    assert.ok(layout.fieldSize >= 16, 'focusing the composer does not trigger iOS small-input zoom');
    assert.equal(layout.headerOverflow, 'auto', 'top bar permits horizontal swipes');
  }
  phone.setContentSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const scrolled = await page.executeJavaScript(`(() => {
    const header=document.querySelector('.pk-header'), title=header.querySelector('h1');
    const text=title.textContent;title.style.maxWidth='none';title.textContent='A long header with many controls '.repeat(8);
    header.scrollLeft=header.scrollWidth;const scrolled=header.scrollLeft>0;
    title.textContent=text;title.style.removeProperty('max-width');header.scrollLeft=0;
    const model=document.querySelector('[data-testid="model-chip"] .v');model.textContent=model.dataset.originalLabel;
    document.querySelector('[data-layout-fixture="delivery"]').remove();
    document.querySelector('[data-testid="model-chip"]').click();return scrolled;
  })()`);
  assert.equal(scrolled, true, 'a crowded top bar actually scrolls, rather than clipping');
  for (let i = 0; i < 60; i++) {
    if (await page.executeJavaScript('!!document.querySelector(".pk-model-overlay [data-testid=model-picker]")')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const popup = await page.executeJavaScript(`(() => {
    const menu=document.querySelector('.pk-model-overlay [data-testid="model-picker"]');
    if(!menu)return null;const r=menu.getBoundingClientRect();
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,
      clippedByComposer:!!menu.closest('.pk-well')};
  })()`);
  assert.ok(popup, 'model picker appears as a real overlay');
  assert.equal(popup.clippedByComposer, false, 'model popup is not trapped in the composer');
  assert.ok(popup.left >= 15 && popup.right <= popup.width - 15, 'model popup keeps a usable margin on both sides');
  assert.ok(popup.top >= 0 && popup.bottom <= popup.height, 'model popup fits the phone height');
  await page.executeJavaScript('document.querySelector(".cdk-overlay-backdrop").click()');
  console.log(
    'PASS phone widths 320/390/430, safe drawer header/footer, two composer rows, large Send, scrollable header, unclipped model overlay',
  );
}
