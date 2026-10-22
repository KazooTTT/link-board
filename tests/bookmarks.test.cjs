const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function app(raw=null){
 const elements=new Map();
 function element(){return {value:'',disabled:false,hidden:false,children:[],append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},setAttribute(){},reset(){elements.get('#quick-url').value=''},click(){},focus(){}}}
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)},createElement:element,addEventListener(){},activeElement:{tagName:'BODY'}};
 const storage=new Map(raw===null?[]:[['link-board:v1',raw]]);
 const context=vm.createContext({document,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},crypto:webcrypto,URL,Blob,setTimeout:()=>0,clearTimeout(){},window:{addEventListener(){}},location:{reload(){}},confirm:()=>true});
 vm.runInContext(source,context);
 return {elements,storage,run:code=>vm.runInContext(code,context),quick(url){document.querySelector('#quick-url').value=url;document.querySelector('#quick-save').onsubmit({preventDefault(){},target:document.querySelector('#quick-save')})}};
}
test('quick capture persists normalized URL and survives reload',()=>{const a=app();a.quick('example.com/article');const raw=a.storage.get('link-board:v1');const [link]=JSON.parse(raw);assert.equal(link.url,'https://example.com/article');assert.equal(link.title,'example.com');assert.equal(app(raw).run('links.length'),1);a.quick('https://example.com/article');assert.equal(a.run('links.length'),1)});
test('unsafe schemes and embedded credentials are rejected',()=>{const a=app();for(const url of ['javascript:alert(1)','data:text/html,test','ftp://example.com','https://user:secret@example.com']){a.quick(url);assert.equal(a.run('links.length'),0)}assert.equal(a.storage.size,0)});
test('corrupt storage stays intact and blocks capture',()=>{const a=app('{broken');a.quick('example.com');assert.equal(a.storage.get('link-board:v1'),'{broken');assert.equal(a.elements.get('#quick-save button').disabled,true)});
test('import merges unique URLs and rejects invalid batches atomically',async()=>{const a=app();a.quick('example.com');const input={files:[{size:100,text:async()=>JSON.stringify([{url:'https://example.com',title:'duplicate'},{url:'https://other.example',title:'Other'}])}],value:'backup'};await a.elements.get('#file').onchange({target:input});assert.equal(a.run('links.length'),2);input.files[0].text=async()=>JSON.stringify([{url:'https://third.example',title:'Third'},{url:'javascript:alert(1)',title:'Bad'}]);await a.elements.get('#file').onchange({target:input});assert.equal(a.run('links.length'),2)});
test('search includes notes and tags; pinning persists',()=>{const a=app();a.quick('example.com');a.run("links[0].note='阅读笔记';links[0].tags=['设计'];save(links)");a.elements.get('#search').value='设计';a.run('render()');assert.equal(a.elements.get('#cards').children.length,1);a.elements.get('#search').value='不存在';a.run('render()');assert.equal(a.elements.get('#cards').children.length,0);a.run('save(links.map(l=>({...l,pinned:true})))');assert.equal(JSON.parse(a.storage.get('link-board:v1'))[0].pinned,true)});
