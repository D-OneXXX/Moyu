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
test('all visible landing page text is available in six languages',()=>{
 const before=script.slice(0,script.indexOf('let language'));
 const {keys,translations}=vm.runInNewContext(`${before};({keys,translations})`);
 for(const locale of ['zh-CN','zh-TW','en','es','ja','ko']){
  assert.equal(translations[locale].length,keys.length,locale);
  for(const [,key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.ok(translations[locale][keys.indexOf(key)]?.trim(),`${locale}:${key}`);
 }
});
test('landing page is self-contained and uses available local artwork',()=>{
 for(const [,ref] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) assert.ok(fs.existsSync(path.join(dir,ref)),ref);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/i);
 assert.match(css,/prefers-reduced-motion/);
 assert.doesNotMatch(html,/\.cbz/i);
 assert.doesNotMatch(html,/<button\b/i);
});
test('external links remain hidden when the page is embedded in the app',()=>{
 const external=[{hidden:true}];
 const document={documentElement:{dataset:{}},querySelectorAll:k=>k==='[data-external]'?external:[]};
 const window={__TAURI_INTERNALS__:{}};window.parent=window;
 vm.runInNewContext(script,{document,window,localStorage:{getItem:()=>null},navigator:{language:'en'}});
 assert.equal(external[0].hidden,true);
});
