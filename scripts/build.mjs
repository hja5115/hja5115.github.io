import {cp,mkdir,readFile,writeFile,stat,rm,readdir} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {validatePortfolioDocument} from '../js/github-store.js';
const root=resolve(import.meta.dirname,'..');
const data=JSON.parse(await readFile(join(root,'data/portfolio.json'),'utf8'));
validatePortfolioDocument(data);
const paths=new Set([data.site.heroImage,...data.projects.flatMap(p=>[p.cover,p.fullSheet,p.engineImage,p.resourceImage,...p.images.map(i=>i.src),...p.process.map(s=>s.image)])].filter(Boolean));
for(const path of paths){const file=await stat(join(root,path));if(!file.isFile())throw new Error(`Missing asset: ${path}`);}
const output=resolve(root,'dist');
if(output!==join(root,'dist')||!output.startsWith(root+sep))throw new Error('Unexpected output path');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const entry of ['index.html','styles.css','editor.css','.nojekyll','js','data','assets'])await cp(join(root,entry),join(root,'dist',entry),{recursive:true});
const javascriptFiles=(await readdir(join(root,'js'))).filter(name=>name.endsWith('.js')).sort();
const hasher=createHash('sha256');
for(const path of ['index.html','styles.css','editor.css',...javascriptFiles.map(name=>`js/${name}`)])hasher.update(await readFile(join(root,path)));
const assetVersion=hasher.digest('hex').slice(0,16);
for(const name of javascriptFiles){
  const path=join(output,'js',name);
  const source=await readFile(path,'utf8');
  await writeFile(path,source.replace(/(['"])(\.[^'"\n]+\.js)\1/g,(_match,quote,path)=>`${quote}${path}?v=${assetVersion}${quote}`).replace(/(['"])editor\.css\1/g,(_match,quote)=>`${quote}editor.css?v=${assetVersion}${quote}`));
}
const html=await readFile(join(output,'index.html'),'utf8');
await writeFile(join(output,'index.html'),html.replace(/(href|src)="(styles\.css|js\/(?:app|effects)\.js)"/g,(_match,attribute,path)=>`${attribute}="${path}?v=${assetVersion}"`));
await writeFile(join(root,'dist/robots.txt'),'User-agent: *\nAllow: /\n');
console.log(`Built ${data.projects.length} projects, ${paths.size} checked assets into dist/ (asset version ${assetVersion})`);
