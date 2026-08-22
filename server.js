const express = require('express');
const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const db = new sqlite3('license.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value   TEXT UNIQUE NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 1,
    duration_h  INTEGER NOT NULL DEFAULT 24,
    note        TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active   INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS activations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value    TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    device_name  TEXT,
    activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key_value, device_id)
  );
`);

function generateKey(prefix='GAME'){
  const p=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${p()}-${p()}-${p()}`;
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

function authAdmin(req,res,next){
  if(req.headers['x-admin-token']!==ADMIN_TOKEN) return res.status(401).json({error:'Unauthorized'});
  next();
}

app.post('/api/activate',(req,res)=>{
  const {key,device_id,device_name}=req.body;
  if(!key||!device_id) return res.status(400).json({error:'Thiếu key hoặc device_id'});
  const k=db.prepare('SELECT * FROM keys WHERE key_value=?').get(key);
  if(!k) return res.status(404).json({error:'Key không tồn tại'});
  if(!k.is_active) return res.status(403).json({error:'Key đã bị vô hiệu hoá'});
  const ex=db.prepare('SELECT * FROM activations WHERE key_value=? AND device_id=?').get(key,device_id);
  if(ex){
    db.prepare('UPDATE activations SET last_seen=CURRENT_TIMESTAMP WHERE id=?').run(ex.id);
    const exp=new Date(new Date(ex.activated_at).getTime()+k.duration_h*3600000);
    if(exp<new Date()) return res.status(403).json({error:`Phiên ${k.duration_h}h đã hết`});
    return res.json({success:true,expires_at:exp.toISOString(),remaining_ms:exp-new Date()});
  }
  const cnt=db.prepare('SELECT COUNT(*) as c FROM activations WHERE key_value=?').get(key).c;
  if(cnt>=k.max_devices) return res.status(403).json({error:`Key chỉ cho ${k.max_devices} thiết bị`});
  db.prepare('INSERT INTO activations(key_value,device_id,device_name) VALUES(?,?,?)').run(key,device_id,device_name||'Unknown');
  const exp=new Date(Date.now()+k.duration_h*3600000);
  res.json({success:true,message:'Kích hoạt thành công!',expires_at:exp.toISOString(),remaining_ms:exp-Date.now()});
});

app.post('/api/check',(req,res)=>{
  const {key,device_id}=req.body;
  const k=db.prepare('SELECT * FROM keys WHERE key_value=?').get(key);
  if(!k||!k.is_active) return res.json({valid:false,error:'Key không hợp lệ'});
  const a=db.prepare('SELECT * FROM activations WHERE key_value=? AND device_id=?').get(key,device_id);
  if(!a) return res.json({valid:false,error:'Thiết bị chưa kích hoạt'});
  const exp=new Date(new Date(a.activated_at).getTime()+k.duration_h*3600000);
  if(exp<new Date()) return res.json({valid:false,error:'Phiên đã hết'});
  db.prepare('UPDATE activations SET last_seen=CURRENT_TIMESTAMP WHERE id=?').run(a.id);
  res.json({valid:true,expires_at:exp.toISOString(),remaining_ms:exp-new Date()});
});

app.post('/admin/keys',authAdmin,(req,res)=>{
  const{max_devices=1,duration_h=24,note='',count=1,prefix='GAME'}=req.body;
  const keys=[];
  for(let i=0;i<Math.min(count,100);i++){
    const k=generateKey(prefix);
    db.prepare('INSERT INTO keys(key_value,max_devices,duration_h,note) VALUES(?,?,?,?)').run(k,max_devices,duration_h,note);
    keys.push(k);
  }
  res.json({success:true,keys});
});

app.get('/admin/keys',authAdmin,(req,res)=>{
  res.json(db.prepare('SELECT k.*,(SELECT COUNT(*) FROM activations a WHERE a.key_value=k.key_value) as device_count FROM keys k ORDER BY k.created_at DESC').all());
});

app.delete('/admin/keys/:key',authAdmin,(req,res)=>{
  db.prepare('UPDATE keys SET is_active=0 WHERE key_value=?').run(req.params.key);
  res.json({success:true});
});

app.get('/admin/keys/:key/devices',authAdmin,(req,res)=>{
  res.json(db.prepare('SELECT * FROM activations WHERE key_value=?').all(req.params.key));
});

app.delete('/admin/activations/:key/:did',authAdmin,(req,res)=>{
  db.prepare('DELETE FROM activations WHERE key_value=? AND device_id=?').run(req.params.key,req.params.did);
  res.json({success:true});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
