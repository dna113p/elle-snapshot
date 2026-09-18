import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFigmaSnapshotReceiver } from '../../src/core.ts';
import { pngBytes, root, temporaryDirectory } from '../helpers.ts';

const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});
const portOf = (server: Server) => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
};

test('plugin UI explains missing tokens and sends authenticated exports with CORS', async () => {
  const dir = await temporaryDirectory();
  const token = 'test-only-plugin-ui-token';
  const receiver = await startFigmaSnapshotReceiver({port:0,outputDir:dir,token});
  const html = (await readFile(join(root,'figma-plugin/ui.html'),'utf8'))
    .replaceAll('http://127.0.0.1:4317',`http://127.0.0.1:${portOf(receiver)}`);
  const ui = createServer((_req,res) => {res.setHeader('content-type','text/html'); res.end(html);});
  await new Promise<void>(resolve => ui.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:400,height:620}});
    await page.goto(`http://127.0.0.1:${portOf(ui)}`);
    const message = {
      kind:'selection-export', selection:{name:'Test card',width:16,height:16},
      pngBytes:Array.from(pngBytes()), designEvidence:{name:'Test card',type:'FRAME'},
    };
    const send = () => page.evaluate(message => window.postMessage({pluginMessage:message},'*'),message);
    await send();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Paste the receiver token'));
    await page.locator('#receiverToken').fill('wrong-token');
    await send();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('401'));
    await page.locator('#receiverToken').fill(token);
    await send();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Sent.'));
    assert.match(await page.locator('#status').innerText(), /Design evidence: yes/);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('test-only-plugin-ui-token'))), false);
    const button = await page.locator('#send').boundingBox();
    assert.ok(button && button.y + button.height <= 620, 'Send button should be visible in the plugin viewport');
  } finally {
    await browser.close();
    await close(ui);
    await close(receiver);
    await rm(dir,{recursive:true,force:true});
  }
});
