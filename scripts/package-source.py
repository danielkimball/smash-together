#!/usr/bin/env python3
"""Package corresponding source and open fonts; never include user game files."""
import pathlib,hashlib,json,subprocess,tarfile,zipfile,io
root=pathlib.Path(__file__).resolve().parent.parent
upstream=root/'upstream/m64wasm'
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=upstream,text=True).strip()
assert commit=='f6b5d6cc31821ec501a94aa761eae022d08f5a9d','Review provenance before updating engine'
font=(root/'assets/Abel-Regular.ttf').read_bytes()
with zipfile.ZipFile(upstream/'dist/assets.zip') as src,zipfile.ZipFile(root/'public/engine/assets.zip','w',compression=zipfile.ZIP_DEFLATED) as out:
 for name in src.namelist():
  info=zipfile.ZipInfo(name,(2026,10,21,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
  out.writestr(info,font if name.endswith('.ttf') else src.read(name))
manifest={'application':'Smash Portal','version':json.loads((root/'package.json').read_text())['version'],'engine_source':'https://github.com/waveplate/M64Wasm','engine_commit':commit,'emscripten':'2.0.7','font':'Abel Regular / SIL OFL','ui_fonts':['Josefin Sans Semibold','Instrument Sans Condensed Medium Italic','Orbitron Medium'],'media':'Audiovisual recordings of the original US game attract sequence; no ROM or savestate','files':{}}
for name in ['n64wasm.js','n64wasm.wasm','assets.zip']:
 data=(root/'public/engine'/name).read_bytes();manifest['files']['engine/'+name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'modified':name=='assets.zip'}
 if name!='assets.zip':assert data==(upstream/'dist'/name).read_bytes(),'Unexpected engine binary change'
for directory in ['brand','fonts','media']:
 for file in sorted((root/'public'/directory).glob('*')):
  if file.is_file():
   data=file.read_bytes();manifest['files'][file.relative_to(root/'public').as_posix()]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
source=root/'public/source';source.mkdir(exist_ok=True)
(source/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
archive=source/'smash-together-source.tar.gz'
allowed=['.gitattributes','.prettierignore','.gitignore','.gitmodules','AGENTS.md','HOSTING.md','config.example.json','LICENSE','README.md','QA.md','package.json','package-lock.json','server.mjs','assets','public','scripts','test','launcher']
forbidden={'.z64','.v64','.n64','.sav','.state','.smash64'}
def addfile(out,file,arc):
 if file.suffix in forbidden:raise RuntimeError('Refusing game/save file: '+str(file))
 info=out.gettarinfo(str(file),arcname=arc);info.uid=info.gid=0;info.uname=info.gname='';info.mtime=1792540800
 with file.open('rb') as stream:out.addfile(info,stream)
with tarfile.open(archive,'w:gz') as out:
 for item in allowed:
  path=root/item
  if not path.exists():continue
  for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
   if not file.is_file() or file.is_symlink():continue
   rel=file.relative_to(root)
   if rel.as_posix().startswith('public/source/') and file.suffix=='.gz':continue
   addfile(out,file,'smash-together/'+rel.as_posix())
 tracked=subprocess.check_output(['git','ls-files','-z','code','LICENSE','README.md','NETPLAY.md'],cwd=upstream).decode().split('\0')
 for item in sorted(filter(None,tracked)):
  file=upstream/item
  if file.suffix in {'.ttf','.zip','.o','.wasm','.png','.jpg'}:continue
  if file.is_file():addfile(out,file,'smash-together/upstream/m64wasm/'+item)
 # Open font replacements at the paths the emulator expects.
 for name in ['arial.ttf','font.ttf']:
  info=tarfile.TarInfo('smash-together/upstream/m64wasm/code/res/'+name);info.size=len(font);info.mtime=1792540800;out.addfile(info,io.BytesIO(font))
print(f'Packaged {archive.name}: {archive.stat().st_size:,} bytes; no ROMs or local service data.')
