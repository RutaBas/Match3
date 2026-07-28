// Minimal static file server for local preview (not shipped). Serves games/Tide-Pool.
// no-store on everything: the app shell is aggressively cached by sw.js in
// production, which makes a dev reload show stale JS. Not a concern here.
const http=require('http'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
const port=process.env.PORT||5603;
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const fp=path.join(root,p);
  if(!fp.startsWith(root)){res.writeHead(403);return res.end();}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);return res.end('404');}
    res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(d); });
}).listen(port,()=>console.log('tide-pool preview on http://localhost:'+port));
