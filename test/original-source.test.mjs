import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {SourceMap,createRequire} from 'node:module';
import {mapOriginalSources,lookupOriginalAnchor} from '../src/original-source.mjs';
import {mapSourcePosition} from '../src/source-candidates.mjs';
import {sha256} from '../src/heap-identity.mjs';
const require=createRequire(import.meta.url),{TraceMap,originalPositionFor,traceSegment}=require('../node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping');

// Mapping-context fixtures only; the identity verdict is simulated, not a new
// heap capture. Generated file coordinates are checked by the real file mapper.
async function withFixture(callback,modify=()=>{},options={}){
 const temp=await mkdtemp(join(tmpdir(),'original-source-test-')),root=await realpath(temp),runDir=join(root,'run'),source=join(root,options.dependency?'node_modules/demo/src/original.ts':'src/original.ts'),mapPath=join(root,'build/out.js.map'),buildPath=join(root,'build/build.json'),contextPath=join(root,'context.json'),jsPath=join(root,'node_modules/demo/dist/original.js'),dependencyMapPath=jsPath+'.map';
 try{
  for(const dir of [runDir,dirname(source),dirname(mapPath)])await mkdir(dir,{recursive:true});
  const originalText='a😀bcdefghij\nsecond line\n',generatedText='abcdefghijklmnop\nempty line\nlast line\n',generated=join(runDir,'out.js');await writeFile(source,originalText);await writeFile(generated,generatedText);
  const payload={version:3,sources:[options.dependency?'../node_modules/demo/src/original.ts':'../src/original.ts'],sourcesContent:[originalText],names:[],mappings:'AAAA,KAAK,K;;AACL'};modify(payload);const mapBytes=JSON.stringify(payload);await writeFile(mapPath,mapBytes);
  const jsText=options.jsText??generatedText+'//# sourceMappingURL=original.js.map\n',dependencyPayload={version:3,sources:['../src/original.ts'],sourcesContent:[originalText],names:[],mappings:'AAAA,KAAK,K;;AACL'};
  if(options.dependency){await mkdir(dirname(jsPath),{recursive:true});await writeFile(jsPath,jsText);await writeFile(dependencyMapPath,JSON.stringify(dependencyPayload));}
  const captureBytes=JSON.stringify({status:'completed',runId:'unit',repo:{sha:'a'.repeat(40)}});await writeFile(join(runDir,'report.json'),captureBytes);
  const script={scriptId:'37',url:pathToFileURL(generated).href,path:generated,startLine:0,startColumn:0,hasSourceURL:false,sourceSha256:sha256(generatedText),inspectorSourceSha256:sha256(generatedText)},scriptsBytes=JSON.stringify({scripts:[script]}),scriptsPath=join(runDir,'scripts.json');await writeFile(scriptsPath,scriptsBytes);
  const build={sha:'a'.repeat(40),bundleSha256:sha256(generatedText),sourceMapSha256:sha256(mapBytes),inputCount:1,inputs:options.dependency?{'node_modules/demo/dist/original.js':sha256(jsText)}:{'src/original.ts':sha256(originalText)}},buildBytes=JSON.stringify(build);await writeFile(buildPath,buildBytes);
  const context={schemaVersion:'0.1.0',workspaceRoot:root,capture:{runId:'unit',reportSha256:sha256(captureBytes),identitySha256:'1'.repeat(64),scriptsSha256:sha256(scriptsBytes)},build:{path:'build/build.json',sha256:sha256(buildBytes)},script:{id:'37',sourceSha256:sha256(generatedText),mapPath:'build/out.js.map',mapSha256:sha256(mapBytes)}};await writeFile(contextPath,JSON.stringify(context));
  if(options.dependency){context.dependencySources={mode:'post-capture-js-map-source'};await writeFile(contextPath,JSON.stringify(context));}
  const report={runId:'unit',identity:{comparable:true,status:'validated-consistency'},registry:{status:'validated-consistency'},inputs:{runDir,captureReportSha256:sha256(captureBytes),identity:{sha256:'1'.repeat(64)},scripts:{path:scriptsPath,sha256:sha256(scriptsBytes)}},candidates:[]};
  for(const [line,column]of [[0,0],[0,3],[0,5],[0,10],[1,0],[2,0]])report.candidates.push(await mapSourcePosition({nodeId:report.candidates.length+1,nodeType:'closure',location:{scriptId:'37',line,column},relation:{kind:'direct-path-node-location'}},[script],runDir));
  await callback({root,runDir,source,mapPath,buildPath,contextPath,payload,context,build,report,originalText,jsPath,jsText,dependencyMapPath,dependencyPayload,saveContext:()=>writeFile(contextPath,JSON.stringify(context)),saveBuild:async()=>{build.inputCount=Object.keys(build.inputs).length;const bytes=JSON.stringify(build);await writeFile(buildPath,bytes);context.build.sha256=sha256(bytes);await writeFile(contextPath,JSON.stringify(context));},saveDependencyMap:()=>writeFile(dependencyMapPath,JSON.stringify(dependencyPayload))});
 }finally{const path=await realpath(temp);assert.equal(dirname(path).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(path).startsWith('original-source-test-'));await rm(path,{recursive:true,force:true});}
}

test('original mapping preserves generated witnesses and distinguishes anchors, gaps and UTF16 columns',async()=>{
 await withFixture(async({contextPath,report,payload,source})=>{
  const result=await mapOriginalSources(report,contextPath);assert.equal(result.evidence.mappedRecords,4);assert.equal(result.evidence.unknownRecords,2);assert.equal(result.evidence.invalidRecords,0);
  const mappings=result.candidates.map(c=>c.originalSourceMapping);assert.equal(mappings[0].precision,'exact-segment-start');assert.equal(mappings[1].precision,'preceding-segment-on-same-line');assert.equal(mappings[1].columnDistance,3);assert.equal(mappings[1].source.column,1);assert.equal(mappings[2].source.column,6);assert.equal(mappings[3].code,'unmapped-generated-segment');assert.equal(mappings[4].code,'no-mapping-on-query-line');assert.equal(mappings[5].source.line,2);assert.equal(mappings[5].source.column,1);
  const oracle=new TraceMap(payload);
  for(let i=0;i<result.candidates.length;i++){const {originalSourceMapping,...generated}=result.candidates[i],{originalSourceMapping:old,...prior}=report.candidates[i];assert.deepEqual(generated,prior);const {line,column}=generated.location,q=originalPositionFor(oracle,{line:line+1,column});if(originalSourceMapping.status==='mapped-original-source'){assert.equal(originalSourceMapping.source.path,source);assert.equal(originalSourceMapping.source.line,q.line);assert.equal(originalSourceMapping.source.column,q.column+1);assert.equal(originalSourceMapping.causalRole,'not-established');}else assert.equal(q.source,null);}
 });
});

test('mapping context refuses wrong run, bundle, map, build and original-byte bindings',async()=>{
 for(const [mutate,code]of [
  [async f=>{f.context.capture.runId='other';await f.saveContext();},'source-map-run-binding-mismatch'],
  [async f=>{f.context.capture.scriptsSha256='2'.repeat(64);await f.saveContext();},'source-map-run-binding-mismatch'],
  [async f=>{f.context.script.sourceSha256='2'.repeat(64);await f.saveContext();},'build-bundle-map-binding-mismatch'],
  [f=>writeFile(f.mapPath,'{}'),'map-hash-mismatch'],[f=>writeFile(f.buildPath,'{}'),'build-hash-mismatch'],
  [f=>writeFile(f.source,'changed'),'original-source-binding-contradiction'],
 ])await withFixture(async f=>{await mutate(f);const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.status,'invalid',code);assert.equal(r.evidence.code,code);});
 await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.status,'invalid');assert.ok(r.candidates.some(c=>c.originalSourceMapping.code==='embedded-source-content-mismatch'));},p=>p.sourcesContent[0]+='changed');
});

test('unsupported maps and source paths stay unknown without resolving remote or unrelated files',async()=>{
 for(const [modify,code]of [[p=>p.sections=[],'unsupported-source-map-form'],[p=>p.sourceRoot='https://invalid.example/','unsupported-source-map-form'],[p=>p.sources[0]='https://invalid.example/private.ts','unsupported-or-ambiguous-source-path'],[p=>p.sources[0]='data:text/plain,hello','unsupported-or-ambiguous-source-path'],[p=>p.sources.push(p.sources[0]),'unsupported-or-ambiguous-source-path'],[p=>p.mappings='!','malformed-source-map']])await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.status,'unknown');assert.equal(r.evidence.code,code);},modify);
 for(const [name,code]of [['../../outside.ts','source-outside-workspace'],['../unlisted.ts','source-not-in-build-inputs']])await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath);assert.ok(r.candidates.some(c=>c.originalSourceMapping.code===code));assert.equal(r.evidence.mappedRecords,0);},p=>p.sources[0]=name);
 await withFixture(async f=>{await unlink(f.source);const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.mappedRecords,0);assert.ok(r.candidates.some(c=>c.originalSourceMapping.code==='ENOENT'));});
});

test('original coordinates and malformed queries do not become guessed locations',async()=>{
 await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.mappedRecords,0);assert.ok(r.candidates.some(c=>c.originalSourceMapping.code==='original-position-out-of-range'));},p=>p.mappings='AAUA');
 const map=new SourceMap({version:3,sources:['a.ts'],names:[],mappings:'AAAA'});for(const [line,column]of [[-1,0],[0,-1],[0,NaN],[0,1.5]])assert.equal(lookupOriginalAnchor(map,line,column).code,'invalid-generated-query');
});

test('micro map segment lookup agrees with an independent parser across exact, between and empty positions',()=>{
 const payload={version:3,sources:['a.ts'],names:[],mappings:'AAAA,KAAK,K;;AACL'},native=new SourceMap(payload),oracle=new TraceMap(payload);
 for(let line=0;line<4;line++)for(let column=0;column<=12;column++){
  const actual=lookupOriginalAnchor(native,line,column),segment=traceSegment(oracle,line,column);
  if(segment?.length>=4){assert.equal(actual.status,'mapped-anchor');assert.equal(actual.entry.generatedColumn,segment[0]);assert.equal(actual.entry.originalSource,payload.sources[segment[1]]);assert.equal(actual.entry.originalLine,segment[2]);assert.equal(actual.entry.originalColumn,segment[3]);}else assert.equal(actual.status,'unknown');
 }
});

test('coordinate decoding remains visible when provenance is unknown or invalid',async()=>{
 await withFixture(async f=>{
  delete f.context.dependencySources;await f.saveContext();const r=await mapOriginalSources(f.report,f.contextPath);
  assert.equal(r.evidence.mappedRecords,0);assert.equal(r.evidence.coordinates.decodedRecords,4);assert.equal(r.evidence.coordinates.unknownRecords,2);
  assert.equal(r.candidates[0].originalSourceMapping.code,'source-not-in-build-inputs');
  assert.deepEqual(r.candidates[0].originalSourceMapping.coordinateEvidence.originalAnchor,{line:0,column:0});
 },()=>{},{dependency:true});
 await withFixture(async f=>{await writeFile(f.source,'changed');const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.coordinates.decodedRecords,4);assert.equal(r.evidence.invalidRecords,4);assert.equal(r.candidates[0].originalSourceMapping.provenance.status,'invalid');});
});

test('dependency lineage binds preserved content and current declared map with independently decoded witnesses',async()=>{
 await withFixture(async f=>{
  const start=Date.now(),r=await mapOriginalSources(f.report,f.contextPath);
  assert.equal(r.evidence.mappedRecords,4);assert.equal(r.evidence.provenance.postCaptureDependencyRecords,4);assert.equal(r.evidence.provenance.directBuildInputRecords,0);assert.equal(r.evidence.dependencyResolution.stats.uniqueJs,1);
  const oracle=new TraceMap(f.dependencyPayload);
  for(const c of r.candidates.filter(c=>c.originalSourceMapping.status==='mapped-original-source')){
   const o=c.originalSourceMapping,p=o.provenance;assert.equal(p.tier,'preserved-map-content-plus-post-capture-dependency-link');assert.equal(p.publishedJs.sha256,sha256(f.jsText));assert.equal(p.dependencyMap.historicalSha256,null);assert.equal(p.historicalDependencyMap,'not-recorded');assert.equal(p.exactIntermediateTransform,'not-established');assert.ok(Date.parse(p.dependencyMap.observedAt)>=start);assert.equal(o.source.sha256,sha256(f.originalText));assert.equal(o.causalRole,'not-established');
   for(const w of p.coordinateWitnesses){const s=traceSegment(oracle,w.generatedAnchor.line,w.generatedAnchor.column);assert.deepEqual(s.slice(0,4),[w.generatedAnchor.column,w.originalAnchor.sourceIndex,w.originalAnchor.line,w.originalAnchor.column]);assert.deepEqual(o.coordinateEvidence.originalAnchor,{line:w.originalAnchor.line,column:w.originalAnchor.column});}
  }
 },()=>{},{dependency:true});
});

test('normalized source aliases cannot bypass embedded content checks or share an ambiguous cached result',async()=>{
 const aliases=['../src/./original.ts','../src/nested/../original.ts',...(process.platform==='win32'?['../SRC/ORIGINAL.TS']:[])];
 for(const alias of aliases)await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.status,'unknown');assert.equal(r.evidence.code,'unsupported-or-ambiguous-source-path');assert.equal(r.evidence.mappedRecords,0);},p=>{p.sources.push(alias);p.sourcesContent.push('contradictory');p.mappings='AAAA,KCAA';});
 await withFixture(async f=>{f.build.inputs['src/./original.ts']=sha256('different');await f.saveBuild();const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.status,'invalid');assert.equal(r.evidence.code,'ambiguous-build-source-path');});
});

test('dependency absence and byte contradictions stay distinct from coordinate decoding',async()=>{
 const cases=[
  [async f=>{delete f.payload.sourcesContent;const b=JSON.stringify(f.payload);await writeFile(f.mapPath,b);f.context.script.mapSha256=sha256(b);f.build.sourceMapSha256=sha256(b);await f.saveBuild();},'unknown','dependency-source-missing-preserved-content'],
  [f=>writeFile(f.jsPath,'changed'),'invalid','dependency-js-build-hash-mismatch'],
  [f=>writeFile(f.source,'changed'),'invalid','embedded-source-content-mismatch'],
  [async f=>{f.dependencyPayload.sourcesContent[0]='changed';await f.saveDependencyMap();},'invalid','dependency-embedded-source-content-mismatch'],
  [f=>unlink(f.source),'unknown','ENOENT'],
 ];
 for(const [change,status,code]of cases)await withFixture(async f=>{await change(f);const r=await mapOriginalSources(f.report,f.contextPath),o=r.candidates[0].originalSourceMapping;assert.equal(o.status,status,code);assert.equal(o.code,code);assert.equal(o.coordinateEvidence.status,'decoded-anchor');assert.equal(r.evidence.mappedRecords,0);},()=>{},{dependency:true});
 await withFixture(async f=>{delete f.dependencyPayload.sourcesContent;await f.saveDependencyMap();const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.mappedRecords,4);assert.equal(r.candidates[0].originalSourceMapping.provenance.dependencyEmbeddedContentChecked,false);},()=>{},{dependency:true});
});

test('dependency declaration, map form, source and coordinate failures preserve precise attempt reasons',async()=>{
 const cases=[
  [async f=>{f.dependencyPayload.sources=['../src/unrelated.ts'];await f.saveDependencyMap();},'dependency-map-other-source'],
  [async f=>{f.dependencyPayload.sections=[];await f.saveDependencyMap();},'unsupported-source-map-form'],
  [async f=>{f.dependencyPayload.mappings='AACA';await f.saveDependencyMap();},'dependency-coordinate-not-witnessed'],
  [f=>unlink(f.dependencyMapPath),'ENOENT'],
 ];
 for(const [change,code]of cases)await withFixture(async f=>{await change(f);const r=await mapOriginalSources(f.report,f.contextPath),o=r.candidates[0].originalSourceMapping;assert.equal(o.status,'unknown');assert.equal(o.provenance.search.attempts[0].code,code);assert.equal(o.coordinateEvidence.status,'decoded-anchor');},()=>{},{dependency:true});
 for(const [text,code]of [
  ['const x=1;\n','missing-source-map-declaration'],
  ['//# sourceMappingURL=https://invalid.example/private.map\n','unsupported-source-map-declaration'],
  ['//# sourceMappingURL=data:application/json;base64,e30=\n','unsupported-source-map-declaration'],
  ['//# sourceMappingURL=../../../outside.map\n','dependency-map-outside-package'],
  ['//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n','multiple-source-map-declarations'],
  ['//# sourceMappingURL=a.map\nconst x=1;\n','unsupported-source-map-declaration'],
 ])await withFixture(async f=>{const r=await mapOriginalSources(f.report,f.contextPath),o=r.candidates[0].originalSourceMapping;assert.equal(o.status,'unknown');assert.equal(o.provenance.search.attempts[0].code,code);assert.equal(r.evidence.dependencyResolution.stats.positionQueries,0);},()=>{},{dependency:true,jsText:text});
});

test('bounded dependency query enumeration reports incomplete evidence instead of asserting no mapping',async()=>{
 await withFixture(async f=>{
  f.dependencyPayload.mappings=';AAAA';await f.saveDependencyMap();const r=await mapOriginalSources(f.report,f.contextPath),o=r.candidates[0].originalSourceMapping;
  assert.equal(o.status,'unknown');assert.equal(o.provenance.search.attempts[0].code,'dependency-coordinate-query-budget');assert.equal(o.provenance.search.attempts[0].coverage.completeWithinJsText,false);assert.equal(r.evidence.dependencyResolution.stats.positionQueries,100000);
 },()=>{},{dependency:true,jsText:'x'.repeat(100010)+'\nx;\n//# sourceMappingURL=original.js.map\n'});
});

test('generic discovery can use a differently named build input and stops at its attempt cap',async()=>{
 await withFixture(async f=>{
  const alternate=join(dirname(f.jsPath),'unrelated-name.js');await writeFile(alternate,f.jsText);delete f.build.inputs['node_modules/demo/dist/original.js'];f.build.inputs['node_modules/demo/dist/unrelated-name.js']=sha256(f.jsText);await f.saveBuild();
  const r=await mapOriginalSources(f.report,f.contextPath);assert.equal(r.evidence.mappedRecords,4);assert.equal(r.candidates[0].originalSourceMapping.provenance.publishedJs.path,alternate);
 },()=>{},{dependency:true});
 await withFixture(async f=>{
  delete f.build.inputs['node_modules/demo/dist/original.js'];
  for(let i=0;i<33;i++){const rel='node_modules/demo/dist/a'+String(i).padStart(2,'0')+'.js';await writeFile(join(f.root,rel),'const x=1;');f.build.inputs[rel]=sha256('const x=1;');}await f.saveBuild();
  const r=await mapOriginalSources(f.report,f.contextPath),o=r.candidates[0].originalSourceMapping;assert.equal(o.status,'unknown');assert.equal(o.code,'dependency-attempt-budget');assert.equal(o.provenance.search.attempts.length,32);assert.equal(o.provenance.search.eligibleInputs,33);
 },()=>{},{dependency:true});
});
