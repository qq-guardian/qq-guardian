#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchiveEntries, writeDeterministicTarGzip, writeDeterministicZip, writeSha256Sidecar } from './lib/deterministic-zip.mjs';
import { isSnowLumaRuntimeReleaseFile } from './lib/release-entry-policy.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(readFileSync(join(ROOT,'UPSTREAM-SNOWLUMA.json'),'utf8'));
const project=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8'));
const platform=arg('--platform')||detect();
const out=resolve(ROOT,arg('--output-dir')||'release');
if(!['win-x64','linux-x64','linux-arm64'].includes(platform)) throw new Error('Unsupported platform: '+platform);
if(!existsSync(join(ROOT,'dist-snowluma','index.mjs'))) throw new Error('Run pnpm run build first');
const asset=manifest.platforms[platform].full;
const root='qq-guardian-snowluma-installer-v'+project.version;
const base=root+'-'+platform;
const archive=join(out,platform==='win-x64'?base+'.zip':base+'.tar.gz');
const ext=platform==='win-x64' ? ['guardian.env.example','snowluma-install.ps1','start-snowluma-guardian.ps1'] : ['guardian.env.example','snowluma-install.sh','start-snowluma-guardian.sh'];
const entries=collectArchiveEntries([{directory:join(ROOT,'dist-snowluma'),prefix:root+'/dist-snowluma',include:p=>isSnowLumaRuntimeReleaseFile(join(ROOT,'dist-snowluma'),p)}]);
for(const name of ext){const file=join(ROOT,'deploy','native',name);entries.push({name:root+'/deploy/native/'+name,data:readFileSync(file),mode:name.endsWith('.sh')?0o755:0o644});}
entries.push({name:root+'/UPSTREAM-SNOWLUMA.json',data:readFileSync(join(ROOT,'UPSTREAM-SNOWLUMA.json')),mode:0o644});
entries.push({name:root+'/docs/deployment/snowluma.md',data:readFileSync(join(ROOT,'docs','deployment','snowluma.md')),mode:0o644});
entries.push({name:root+'/README.md',data:Buffer.from(readme(project.version,platform,asset),'utf8'),mode:0o644});
entries.sort((a,b)=>a.name.localeCompare(b.name));
if(platform==='win-x64') writeDeterministicZip({outputPath:archive,entries}); else writeDeterministicTarGzip({outputPath:archive,entries});
const sidecar=writeSha256Sidecar(archive);
console.log('Created '+relative(ROOT,archive)+' ('+statSync(archive).size+' bytes)');
console.log(sidecar.digest);
function arg(name){return process.argv.find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
function detect(){if(process.platform==='win32'&&process.arch==='x64')return 'win-x64';if(process.platform==='linux'&&process.arch==='x64')return 'linux-x64';if(process.platform==='linux'&&process.arch==='arm64')return 'linux-arm64';throw new Error('Unsupported host platform');}
function readme(version,target,a){
 const command=target==='win-x64'?'powershell -ExecutionPolicy Bypass -File .\\deploy\\native\\snowluma-install.ps1 -OfficialPackage C:\\Packages\\'+a.file+' -AcceptEula -AcceptPrivacy -Unattended':'sh ./deploy/native/snowluma-install.sh --package /srv/packages/'+a.file+' --accept-eula --accept-privacy --unattended';
 return ['QQ Guardian SnowLuma installer v'+version,'','This is an integration/installer package, not the official SnowLuma distribution.','Required official asset: '+a.file,'Required size: '+a.size+' bytes','Required SHA-256: '+a.sha256,'','Provide the exact official full archive on the target host. The installer verifies it before extraction.','',command,'','SnowLuma native binaries are never included in this Guardian archive.'].join('\n')+'\n';
}
