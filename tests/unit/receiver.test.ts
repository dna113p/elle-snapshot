import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startFigmaSnapshotReceiver } from '../../src/core.ts';
import { json, pngBytes, temporaryDirectory } from '../helpers.ts';

let dir: string;
let server: Server;
let url: string;
const token = 'test-only-receiver-token';
const headers = {'content-type':'application/json',authorization:`Bearer ${token}`};
const payload = () => ({ selection:{name:'Test / selection'}, image:{format:'png',base64:pngBytes().toString('base64')},designEvidence:{name:'Test',type:'FRAME'} });
beforeEach(async () => {
  dir = await temporaryDirectory();
  server = await startFigmaSnapshotReceiver({port:0,outputDir:dir,token});
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  url = `http://127.0.0.1:${address.port}/figma-selection`;
});
afterEach(async () => {
  await new Promise<void>((resolve,reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await rm(dir,{recursive:true,force:true});
});

test('requires a token, permits preflight, rejects bad routes and content types', async () => {
  assert.equal((await fetch(url,{method:'OPTIONS'})).status,204);
  assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(payload())})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,authorization:'Bearer wrong'},body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:headers.authorization},body:'{}'})).status,415);
  assert.equal((await fetch(url)).status,405);
  assert.equal((await fetch(`${url}/bad`)).status,404);
});

test('exports portable evidence and gives concurrent exports distinct directories', async () => {
  const responses = await Promise.all([1,2].map(() => fetch(url,{method:'POST',headers,body:JSON.stringify(payload())})));
  const results = await Promise.all(responses.map(async response => {
    assert.equal(response.status,200);
    return response.json() as Promise<{filesystemName:string;bundlePath:string}>;
  }));
  assert.notEqual(results[0].filesystemName,results[1].filesystemName);
  for (const result of results) {
    const saved = await json(result.bundlePath);
    assert.ok(!JSON.stringify(saved).includes(dir));
    assert.equal(saved.metadata.designEvidencePath,'design-evidence.json');
    assert.equal((await json(join(dir,result.filesystemName,'design-evidence.json'))).type,'FRAME');
  }
});

test('invalid JSON and invalid PNGs are rejected before writing', async () => {
  for (const body of ['null','{','{}',JSON.stringify({...payload(),image:{format:'png',base64:'invalid'}})]) {
    assert.equal((await fetch(url,{method:'POST',headers,body})).status,400);
  }
});

test('oversized requests are rejected', async () => {
  const response = await fetch(url,{method:'POST',headers,body:'x'.repeat(20*1024*1024+1)});
  assert.equal(response.status,413);
});

test('busy ports reject the startup promise rather than hanging', async () => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(startFigmaSnapshotReceiver({port:address.port,outputDir:dir,token}), {code:'EADDRINUSE'});
});
