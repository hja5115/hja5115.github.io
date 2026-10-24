import {cp,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {validatePortfolioDocument} from '../js/github-store.js';
const root=resolve(import.meta.dirname,'..');
const data=JSON.parse(await readFile(join(root,'data/portfolio.json'),'utf8'));
validatePortfolioDocument(data);
const paths=new Set([data.site.heroImage,...data.projects.flatMap(p=>[p.cover,p.fullSheet,...p.images.map(i=>i.src),...p.process.map(s=>s.image)])].filter(Boolean));
for(const path of paths){const file=await stat(join(root,path));if(!file.isFile())throw new Error(`Missing asset: ${path}`);}
const output=resolve(root,'dist');
if(output!==join(root,'dist')||!output.startsWith(root+sep))throw new Error('Unexpected output path');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const entry of ['index.html','styles.css','editor.css','.nojekyll','js','data','assets'])await cp(join(root,entry),join(root,'dist',entry),{recursive:true});
await writeFile(join(root,'dist/robots.txt'),'User-agent: *\nAllow: /\n');
console.log(`Built ${data.projects.length} projects, ${paths.size} checked assets into dist/`);
