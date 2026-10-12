/**
 * One-time recursive Firestore -> MySQL migration. Run only after backing up both systems.
 * Preserves each Firestore document's full path and nested data. It does not delete Firestore data.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const pool = require('../src/db');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || 'fxec-rd' });
}
const timestampEncode = (value) => {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) return { __mysqlTimestamp: true, seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof Date) return { __mysqlTimestamp: true, seconds: Math.floor(value.getTime()/1000), nanoseconds: (value.getTime()%1000)*1e6 };
  if (Array.isArray(value)) return value.map(timestampEncode);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,timestampEncode(v)]));
  return value;
};
let count = 0;
async function saveDocument(docSnap) {
  const path = docSnap.ref.path;
  const data = timestampEncode(docSnap.data());
  const id = docSnap.id;
  const parts = path.split('/');
  const collectionName = parts.length > 1 ? parts[parts.length - 2] : '';
  const parentPath = parts.slice(0,-1).join('/');
  await pool.execute(
    'INSERT INTO documents (path, document_id, collection_name, parent_path, data) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE document_id=VALUES(document_id), collection_name=VALUES(collection_name), parent_path=VALUES(parent_path), data=VALUES(data)',
    [path,id,collectionName,parentPath,JSON.stringify(data)]
  );
  count += 1;
  if (count % 100 === 0) console.log(`Migrated ${count} documents...`);
  const subcollections = await docSnap.ref.listCollections();
  for (const subcollection of subcollections) await migrateCollection(subcollection);
}
async function migrateCollection(collectionRef) {
  let lastDoc = null;
  while (true) {
    let q = collectionRef.orderBy(admin.firestore.FieldPath.documentId()).limit(300);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snapshot = await q.get();
    if (snapshot.empty) break;
    for (const document of snapshot.docs) await saveDocument(document);
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < 300) break;
  }
}
async function main() {
  try {
    const db = admin.firestore();
    const topLevel = await db.listCollections();
    for (const collection of topLevel) await migrateCollection(collection);
    console.log(`Migration complete. ${count} documents copied to MySQL. Firestore data was not deleted.`);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await admin.app().delete().catch(()=>{});
  }
}
main();
