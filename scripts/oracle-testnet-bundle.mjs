// Packs only compiled workspace code and locked package metadata for the isolated Oracle testnet sample.
import {cp,copyFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.length!==3)throw new Error('Usage: node scripts/oracle-testnet-bundle.mjs <new-output-directory>');
const output=resolve(process.argv[2]);
await mkdir(output,{recursive:false});
const stage=join(output,'release');await mkdir(stage);
for(const name of ['package.json','package-lock.json','LICENSE'])await copyFile(join(root,name),join(stage,name));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
for(const workspace of pkg.workspaces){
 const to=join(stage,workspace);await mkdir(to,{recursive:true});
 await copyFile(join(root,workspace,'package.json'),join(to,'package.json'));
 for(const name of ['dist','schemas']){
  const source=join(root,workspace,name);
  try{await stat(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  await cp(source,join(to,name),{recursive:true,filter:path=>!path.endsWith('.tsbuildinfo')});
 }
}
await stat(join(stage,'examples/paid-service/dist/server.js'));
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const workingTreeChanges=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='';
await writeFile(join(stage,'release.json'),JSON.stringify({sourceCommit,workingTreeChanges,builtAt:new Date().toISOString(),network:'stellar:testnet'},null,2)+'\n');
const archive=join(output,'release.tgz');
const portable=process.platform==='darwin'?['--no-xattrs','--disable-copyfile']:[];
execFileSync('tar',[...portable,'-czf',archive,'-C',stage,'.']);
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
console.log(JSON.stringify({archive,sha256,releaseId:sourceCommit.slice(0,12)+'-'+sha256.slice(0,12),sourceCommit,workingTreeChanges}));
