#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';
const dir=resolve(arg('--directory')||'release');
const manifest=JSON.parse(readFileSync(resolve('UPSTREAM-SNOWLUMA.json'),'utf8'));
for(const p of ['win-x64','linux-x64','linux-arm64']){const a=manifest.platforms?.[p]?.full;assert.ok(a?.file&&Number.isInteger(a.size)&&/^[a-f0-9]{64}$/.test(a.sha256),'bad upstream manifest: '+p);}
const archives=readdirSync(dir).filter(n=>/^qq-guardian-snowluma-installer-v\d+\.\d+\.\d+-(?:win-x64|linux-x64|linux-arm64)\.(?:zip|tar\.gz)$/.test(n));
assert.ok(archives.length,'No SnowLuma installer archives found');
for(const name of archives) verify(resolve(dir,name));
console.log('verified '+archives.length+' SnowLuma installer archives');
function verify(path){const name=basename(path);const entries=name.endsWith('.zip')?readZipEntryNames(path):readTarGzipEntryNames(path);const roots=new Set(entries.map(e=>e.split('/')[0]));assert.equal(roots.size,1,name+' must have one root');const root=[...roots][0];const rel=entries.map(e=>e.slice(root.length+1));const set=new Set(rel);for(const r of ['README.md','UPSTREAM-SNOWLUMA.json','dist-snowluma/index.mjs','docs/deployment/snowluma.md','deploy/native/guardian.env.example'])assert.ok(set.has(r),name+' missing '+r);if(name.includes('-win-x64.')){assert.ok(set.has('deploy/native/snowluma-install.ps1'));assert.ok(set.has('deploy/native/start-snowluma-guardian.ps1'));assert.ok(!rel.some(e=>e.endsWith('.sh')));}else{assert.ok(set.has('deploy/native/snowluma-install.sh'));assert.ok(set.has('deploy/native/start-snowluma-guardian.sh'));assert.ok(!rel.some(e=>e.endsWith('.ps1')));}assert.ok(!rel.some(e=>/(?:^|\/)snowluma-[^/]+\.(?:node|dll|so)$/i.test(e)),name+' contains proprietary SnowLuma native binary');}
function arg(name){return process.argv.find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
