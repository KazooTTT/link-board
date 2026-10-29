const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=require('node:path').join(__dirname,'..');
const appSrc=readFileSync(require('node:path').join(root,'app.js'),'utf8').replace(/^import .*;\n?/m,'');
const metaStub=`function iconCandidates(url,custom,extras=[]){const list=[];if(custom)list.push(custom);return list}async function enrichLink(){}`;
const source=metaStub+appSrc;
function app(raw=null){
 const elements=new Map();
 const listeners={};
 function element(tag){const el={tagName:(tag||'DIV').toUpperCase(),value:'',disabled:false,hidden:false,open:false,children:[],src:'',alt:'',referrerPolicy:'',naturalWidth:0,onload:null,onerror:null,dataset:{},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},setAttribute(){},reset(){elements.get('#quick-url').value=''},click(){},focus(){}};return el}
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)},createElement:tag=>element(tag),addEventListener(type,fn){(listeners[type]??=[]).push(fn)},activeElement:{tagName:'BODY'}};
 const storage=new Map(raw===null?[]:[['link-board:v1',raw]]);
 const context=vm.createContext({document,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},crypto:webcrypto,URL,Blob,setTimeout:()=>0,clearTimeout(){},window:{addEventListener(){}},location:{reload(){}},confirm:()=>true});
 vm.runInContext(source,context);
 const paste=(text,target)=>{const event={clipboardData:{getData:type=>type==='text/plain'?text:''},target:target??document.activeElement,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};for(const fn of listeners.paste??[])fn(event);return event};
 return {elements,storage,run:code=>vm.runInContext(code,context),quick(url){document.querySelector('#quick-url').value=url;document.querySelector('#quick-save').onsubmit({preventDefault(){},target:document.querySelector('#quick-save')})},paste};
}
test('quick capture persists normalized URL and survives reload',()=>{const a=app();a.quick('example.com/article');const raw=a.storage.get('link-board:v1');const [link]=JSON.parse(raw);assert.equal(link.url,'https://example.com/article');assert.equal(link.title,'example.com');assert.equal(app(raw).run('links.length'),1);a.quick('https://example.com/article');assert.equal(a.run('links.length'),1)});
test('unsafe schemes and embedded credentials are rejected',()=>{const a=app();for(const url of ['javascript:alert(1)','data:text/html,test','ftp://example.com','https://user:secret@example.com']){a.quick(url);assert.equal(a.run('links.length'),0)}assert.equal(a.storage.size,0)});
test('corrupt storage stays intact and blocks capture',()=>{const a=app('{broken');a.quick('example.com');assert.equal(a.storage.get('link-board:v1'),'{broken');assert.equal(a.elements.get('#quick-save button').disabled,true)});
test('import merges unique URLs and rejects invalid batches atomically',async()=>{const a=app();a.quick('example.com');const input={files:[{size:100,text:async()=>JSON.stringify([{url:'https://example.com',title:'duplicate'},{url:'https://other.example',title:'Other'}])}],value:'backup'};await a.elements.get('#file').onchange({target:input});assert.equal(a.run('links.length'),2);input.files[0].text=async()=>JSON.stringify([{url:'https://third.example',title:'Third'},{url:'javascript:alert(1)',title:'Bad'}]);await a.elements.get('#file').onchange({target:input});assert.equal(a.run('links.length'),2)});
test('search includes notes and tags; pinning persists',()=>{const a=app();a.quick('example.com');a.run("links[0].note='阅读笔记';links[0].tags=['设计'];save(links)");a.elements.get('#search').value='设计';a.run('render()');assert.equal(a.elements.get('#cards').children.length,1);a.elements.get('#search').value='不存在';a.run('render()');assert.equal(a.elements.get('#cards').children.length,0);a.run('save(links.map(l=>({...l,pinned:true})))');assert.equal(JSON.parse(a.storage.get('link-board:v1'))[0].pinned,true)});
test('coordinates survive reload and importing old records assigns stable positions',()=>{const a=app(JSON.stringify([{url:'https://a.example',title:'A'},{url:'https://b.example',title:'B',x:-100,y:500}]));assert.equal(a.run('links[0].x'),0);assert.equal(a.run('links[1].x'),-100);a.run('save(links)');const b=app(a.storage.get('link-board:v1'));assert.equal(b.run('links[1].y'),500);b.quick('https://c.example');assert.equal(b.run('links.find(l=>l.title==="B").x'),-100)});
test('new capture clears filters to reveal saved card',()=>{const a=app();a.elements.get('#search').value='unmatched';a.quick('https://example.com');assert.equal(a.elements.get('#search').value,'');assert.equal(a.elements.get('#cards').children.length,1)});
test('quick capture flags autoTitle for metadata enrichment',()=>{const a=app();a.quick('https://docs.example.com/page');const [link]=JSON.parse(a.storage.get('link-board:v1'));assert.equal(link.autoTitle,true);assert.equal(link.title,'docs.example.com');assert.equal(link.icon,'')});

test('pasting a link captures it immediately without pressing enter',()=>{const a=app();const event=a.paste('看看这个 https://example.com/a)。');assert.equal(event.defaultPrevented,true);assert.equal(a.run('links.length'),1);const [link]=JSON.parse(a.storage.get('link-board:v1'));assert.equal(link.url,'https://example.com/a');assert.equal(link.title,'example.com');assert.equal(link.autoTitle,true)});
test('pasting a bare domain and several links adds each unique URL once',()=>{const a=app();a.paste('example.com/article');assert.equal(a.run('links.length'),1);a.paste('https://a.example/x\nhttps://b.example/y\nhttps://a.example/x');assert.equal(a.run('links.length'),3);a.paste('https://a.example/x');assert.equal(a.run('links.length'),3)});
test('pasting non-link text is left alone',()=>{const a=app();const event=a.paste('普通文本，没有链接');assert.equal(event.defaultPrevented,false);assert.equal(a.run('links.length'),0)});
test('paste inside the open editor is left to the field',()=>{const a=app();a.run("document.querySelector('#editor').open=true");const event=a.paste('https://example.com');assert.equal(event.defaultPrevented,false);assert.equal(a.run('links.length'),0)});
