const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database('license.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value TEXT UNIQUE NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 1,
    duration_h INTEGER NOT NULL DEFAULT 24,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key_value, device_id)
  )`);
});

function generateKey(prefix='GAME'){
  const p=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${p()}-${p()}-${p()}`;
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

function authAdmin(req,res,next){
  if(req.headers['x-admin-token']!==ADMIN_TOKEN) return res.status(401).json({error:'Unauthorized'});
  next();
}

function dbGet(sql, params=[]){ return new Promise((resolve,reject)=>db.get(sql,params,(e,r)=>e?reject(e):resolve(r))); }
function dbAll(sql, params=[]){ return new Promise((resolve,reject)=>db.all(sql,params,(e,r)=>e?reject(e):resolve(r))); }
function dbRun(sql, params=[]){ return new Promise((resolve,reject)=>db.run(sql,params,function(e){e?reject(e):resolve(this)})); }

app.post('/api/activate', async (req,res)=>{
  const {key,device_id,device_name}=req.body;
  if(!key||!device_id) return res.status(400).json({error:'Thiếu key hoặc device_id'});
  const k=await dbGet('SELECT * FROM keys WHERE key_value=?',[key]);
  if(!k) return res.status(404).json({error:'Key không tồn tại'});
  if(!k.is_active) return res.status(403).json({error:'Key đã bị vô hiệu hoá'});
  const ex=await dbGet('SELECT * FROM activations WHERE key_value=? AND device_id=?',[key,device_id]);
  if(ex){
    await dbRun('UPDATE activations SET last_seen=CURRENT_TIMESTAMP WHERE id=?',[ex.id]);
    const exp=new Date(new Date(ex.activated_at).getTime()+k.duration_h*3600000);
    if(exp<new Date()) return res.status(403).json({error:`Phiên ${k.duration_h}h đã hết`});
    return res.json({success:true,expires_at:exp.toISOString(),remaining_ms:exp-new Date()});
  }
  const row=await dbGet('SELECT COUNT(*) as c FROM activations WHERE key_value=?',[key]);
  if(row.c>=k.max_devices) return res.status(403).json({error:`Key chỉ cho ${k.max_devices} thiết bị`});
  await dbRun('INSERT INTO activations(key_value,device_id,device_name) VALUES(?,?,?)',[key,device_id,device_name||'Unknown']);
  const exp=new Date(Date.now()+k.duration_h*3600000);
  res.json({success:true,message:'Kích hoạt thành công!',expires_at:exp.toISOString(),remaining_ms:exp-Date.now()});
});

app.post('/api/check', async (req,res)=>{
  const {key,device_id}=req.body;
  const k=await dbGet('SELECT * FROM keys WHERE key_value=?',[key]);
  if(!k||!k.is_active) return res.json({valid:false,error:'Key không hợp lệ'});
  const a=await dbGet('SELECT * FROM activations WHERE key_value=? AND device_id=?',[key,device_id]);
  if(!a) return res.json({valid:false,error:'Thiết bị chưa kích hoạt'});
  const exp=new Date(new Date(a.activated_at).getTime()+k.duration_h*3600000);
  if(exp<new Date()) return res.json({valid:false,error:'Phiên đã hết'});
  await dbRun('UPDATE activations SET last_seen=CURRENT_TIMESTAMP WHERE id=?',[a.id]);
  res.json({valid:true,expires_at:exp.toISOString(),remaining_ms:exp-new Date()});
});

app.post('/admin/keys', authAdmin, async (req,res)=>{
  const{max_devices=1,duration_h=24,note='',count=1,prefix='GAME'}=req.body;
  const keys=[];
  for(let i=0;i<Math.min(count,100);i++){
    const k=generateKey(prefix);
    await dbRun('INSERT INTO keys(key_value,max_devices,duration_h,note) VALUES(?,?,?,?)',[k,max_devices,duration_h,note]);
    keys.push(k);
  }
  res.json({success:true,keys});
});

app.get('/admin/keys', authAdmin, async (req,res)=>{
  const keys=await dbAll('SELECT k.*,(SELECT COUNT(*) FROM activations a WHERE a.key_value=k.key_value) as device_count FROM keys k ORDER BY k.created_at DESC');
  res.json(keys);
});

app.delete('/admin/keys/:key', authAdmin, async (req,res)=>{
  await dbRun('UPDATE keys SET is_active=0 WHERE key_value=?',[req.params.key]);
  res.json({success:true});
});

app.get('/admin/keys/:key/devices', authAdmin, async (req,res)=>{
  res.json(await dbAll('SELECT * FROM activations WHERE key_value=?',[req.params.key]));
});

app.delete('/admin/activations/:key/:did', authAdmin, async (req,res)=>{
  await dbRun('DELETE FROM activations WHERE key_value=? AND device_id=?',[req.params.key,req.params.did]);
  res.json({success:true});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
