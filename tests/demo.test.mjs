import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public/demo');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const script=fs.readFileSync(path.join(dir,'demo.js'),'utf8');
const css=fs.readFileSync(path.join(dir,'demo.css'),'utf8');
test('all demo text is available in six languages',()=>{
 const before=script.slice(0,script.indexOf('let language'));
 const {keys,translations}=vm.runInNewContext(`${before};({keys,translations})`);
 for(const locale of ['zh-CN','zh-TW','en','es','ja','ko']){
  assert.equal(translations[locale].length,keys.length,locale);
  for(const [,key] of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) assert.ok(translations[locale][keys.indexOf(key)]?.trim(),`${locale}:${key}`);
 }
});
test('demo is self-contained, supports reduced motion and uses no archives',()=>{
 for(const [,ref] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g))assert.ok(fs.existsSync(path.join(dir,ref)),ref);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/i);
 assert.match(css,/prefers-reduced-motion/);
 assert.doesNotMatch(html,/\.cbz/i);
 assert.ok(fs.readdirSync(dir).every(name=>!name.endsWith('.cbz')));
});
test('interactive reader turns pages, switches books and scrolls',()=>{
 class E{constructor(dataset={}){this.dataset=dataset;this.listeners={};this.children=[];this.hidden=false;this.disabled=false;this.classList={toggle(){}};}setAttribute(){}addEventListener(n,f){this.listeners[n]=f;}replaceChildren(...x){this.children=x;}appendChild(x){this.children.push(x);}click(){if(!this.disabled)this.listeners.click?.({target:this});}}
 const map=Object.fromEntries(['#pages','#canvas','#count','#prev','#next','#book-title'].map(k=>[k,new E()]));
 const books=[new E({book:'0'}),new E({book:'1'})],modes=[new E({mode:'page'}),new E({mode:'scroll'})],external=[new E()];
 const document={documentElement:{dataset:{}},querySelector:k=>map[k],querySelectorAll:k=>k==='[data-book]'?books:k==='[data-mode]'?modes:k==='[data-external]'?external:[],createElement:()=>new E()};
 const window={};window.parent=window;
 vm.runInNewContext(script,{document,window,localStorage:{getItem:()=>null},navigator:{language:'en'}});
 assert.equal(map['#count'].textContent,'1 / 2');map['#next'].click();assert.equal(map['#count'].textContent,'2 / 2');
 modes[1].click();assert.equal(map['#pages'].children.length,2);assert.equal(map['#next'].hidden,true);
 books[1].click();assert.equal(map['#book-title'].textContent,'Echoes of Europa');
 assert.equal(external[0].hidden,false);
});

test('all sample pages exist and stay below the asset budget',()=>{
 const art=path.join(dir,'art');
 const files=['sky-cover.webp','sky-page.webp','europa-cover.webp','europa-01.webp','europa-02.webp','europa-03.webp','europa-04.webp','library.webp'];
 let total=0;for(const f of files)total+=fs.statSync(path.join(art,f)).size;
 assert.ok(total<1_000_000,`assets are ${total} bytes`);
});
