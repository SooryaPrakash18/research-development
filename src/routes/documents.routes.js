const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

const cleanPath = (v) => String(v || '').split('/').filter(Boolean).join('/');
const decodePath = (req) => cleanPath(decodeURIComponent(req.params.path || ''));
const idFromPath = (p) => p.split('/').pop();
const parentFromPath = (p) => p.split('/').slice(0,-1).join('/');
const collectionFromPath = (p) => p.split('/').slice(0,-1).pop() || '';
const decodeValue = (v) => {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === 'object') {
    if (v.__serverTimestamp) return { __mysqlTimestamp: true, seconds: Math.floor(Date.now()/1000), nanoseconds: (Date.now()%1000)*1e6 };
    if (v.__mysqlTimestamp) return { __mysqlTimestamp: true, seconds: Number(v.seconds), nanoseconds: Number(v.nanoseconds || 0) };
    return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, decodeValue(x)]));
  }
  return v;
};
const fieldValue = (obj, field) => String(field || '').split('.').reduce((v,k)=>v == null ? undefined : v[k], obj);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function matches(row, constraints) {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  for (const c of constraints.filter(x=>x.type==='where')) {
    const actual = fieldValue(data,c.field); const expected = decodeValue(c.value);
    switch (c.op) {
      case '==': if (!equal(actual, expected)) return false; break;
      case '!=': if (equal(actual, expected)) return false; break;
      case '>': if (!(actual > expected)) return false; break;
      case '>=': if (!(actual >= expected)) return false; break;
      case '<': if (!(actual < expected)) return false; break;
      case '<=': if (!(actual <= expected)) return false; break;
      case 'array-contains': if (!Array.isArray(actual) || !actual.some(x=>equal(x,expected))) return false; break;
      case 'in': if (!Array.isArray(expected) || !expected.some(x=>equal(x,actual))) return false; break;
      case 'not-in': if (!Array.isArray(expected) || expected.some(x=>equal(x,actual))) return false; break;
      case 'array-contains-any': if (!Array.isArray(actual) || !Array.isArray(expected) || !actual.some(x=>expected.some(y=>equal(x,y)))) return false; break;
      default: throw Object.assign(new Error(`Unsupported query operator: ${c.op}`), { status:400 });
    }
  }
  return true;
}
function serialize(row) { return { path: row.path, id: row.document_id, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data }; }
async function findDoc(path) {
  const [rows] = await pool.execute('SELECT path, document_id, data FROM documents WHERE path = ? LIMIT 1', [path]);
  return rows[0] || null;
}
router.post('/query', async (req,res,next) => {
  try {
    const { path, collectionGroup, constraints = [] } = req.body || {};
    let rows;
    if (collectionGroup) {
      [rows] = await pool.execute('SELECT path, document_id, collection_name, parent_path, data FROM documents WHERE collection_name = ?', [String(collectionGroup)]);
    } else {
      const collectionPath = cleanPath(path);
      if (!collectionPath) return res.status(400).json({ error:'A collection path is required' });
      [rows] = await pool.execute('SELECT path, document_id, collection_name, parent_path, data FROM documents WHERE parent_path = ?', [collectionPath]);
    }
    let filtered = rows.filter(row => matches(row, constraints));
    const sorts = constraints.filter(x=>x.type==='orderBy');
    for (const sort of [...sorts].reverse()) {
      const dir = sort.direction === 'desc' ? -1 : 1;
      filtered.sort((a,b) => {
        const av=fieldValue(typeof a.data==='string'?JSON.parse(a.data):a.data,sort.field); const bv=fieldValue(typeof b.data==='string'?JSON.parse(b.data):b.data,sort.field);
        if (av == null && bv == null) return 0; if (av == null) return -1*dir; if (bv == null) return 1*dir;
        const aa = av && av.__mysqlTimestamp ? av.seconds*1000+(av.nanoseconds||0)/1e6 : av;
        const bb = bv && bv.__mysqlTimestamp ? bv.seconds*1000+(bv.nanoseconds||0)/1e6 : bv;
        return (aa < bb ? -1 : aa > bb ? 1 : 0)*dir;
      });
    }
    const limitConstraint = constraints.find(x=>x.type==='limit');
    if (limitConstraint) filtered = filtered.slice(0, Math.max(0, Number(limitConstraint.count)));
    res.json({ documents: filtered.map(serialize) });
  } catch (e) { next(e); }
});
router.get('/:path(*)', async (req,res,next) => {
  try {
    const path = decodePath(req); const row = await findDoc(path);
    if (!row) return res.json({ document:null });
    res.json({ document: serialize(row) });
  } catch(e) { next(e); }
});
router.post('/', async (req,res,next) => {
  try {
    const collectionPath = cleanPath(req.body?.path); if (!collectionPath) return res.status(400).json({error:'A collection path is required'});
    const id = require('crypto').randomUUID().replace(/-/g,''); const path = `${collectionPath}/${id}`;
    const data = decodeValue(req.body?.data || {});
    await pool.execute('INSERT INTO documents (path, document_id, collection_name, parent_path, data) VALUES (?, ?, ?, ?, ?)', [path,id,collectionFromPath(path),parentFromPath(path),JSON.stringify(data)]);
    res.status(201).json({ path, id });
  } catch(e) { next(e); }
});
router.put('/:path(*)', async (req,res,next) => {
  const conn = await pool.getConnection();
  try {
    const path=decodePath(req); const data=decodeValue(req.body?.data || {}); const merge=!!req.body?.merge;
    await conn.beginTransaction();
    const [rows]=await conn.execute('SELECT data FROM documents WHERE path=? FOR UPDATE',[path]);
    const merged=merge && rows.length ? { ...(typeof rows[0].data==='string'?JSON.parse(rows[0].data):rows[0].data), ...data } : data;
    await conn.execute('INSERT INTO documents (path, document_id, collection_name, parent_path, data) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)', [path,idFromPath(path),collectionFromPath(path),parentFromPath(path),JSON.stringify(merged)]);
    await conn.commit(); res.json({success:true});
  } catch(e) { await conn.rollback(); next(e); } finally { conn.release(); }
});
router.patch('/:path(*)', async (req,res,next) => {
  const conn = await pool.getConnection();
  try {
    const path=decodePath(req); const patch=decodeValue(req.body?.data || {});
    await conn.beginTransaction(); const [rows]=await conn.execute('SELECT data FROM documents WHERE path=? FOR UPDATE',[path]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({error:'Document not found'}); }
    const old=typeof rows[0].data==='string'?JSON.parse(rows[0].data):rows[0].data;
    const merged={...old,...patch};
    await conn.execute('UPDATE documents SET data=? WHERE path=?',[JSON.stringify(merged),path]); await conn.commit(); res.json({success:true});
  } catch(e) { await conn.rollback(); next(e); } finally { conn.release(); }
});
router.delete('/:path(*)', async (req,res,next) => {
  try { const path=decodePath(req); await pool.execute('DELETE FROM documents WHERE path=?',[path]); res.status(204).end(); }
  catch(e) { next(e); }
});
module.exports = router;
