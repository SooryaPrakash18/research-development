
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All document operations require a valid Node.js JWT.
router.use(requireAuth);

const cleanPath = (value) =>
  String(value || '')
    .split('/')
    .filter(Boolean)
    .join('/');

// Express decodes route parameters; do not decode them a second time.
const decodePath = (req) => cleanPath(req.params.path || '');

const idFromPath = (path) => path.split('/').pop();

const parentFromPath = (path) =>
  path.split('/').slice(0, -1).join('/');

const collectionFromPath = (path) =>
  path.split('/').slice(0, -1).pop() || '';

const decodeValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }

  if (value && typeof value === 'object') {
    if (value.__serverTimestamp) {
      const milliseconds = Date.now();

      return {
        __mysqlTimestamp: true,
        seconds: Math.floor(milliseconds / 1000),
        nanoseconds: (milliseconds % 1000) * 1e6,
      };
    }

    if (value.__mysqlTimestamp) {
      return {
        __mysqlTimestamp: true,
        seconds: Number(value.seconds),
        nanoseconds: Number(value.nanoseconds || 0),
      };
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeValue(item),
      ])
    );
  }

  return value;
};

const fieldValue = (object, field) =>
  String(field || '')
    .split('.')
    .reduce(
      (value, key) =>
        value == null ? undefined : value[key],
      object
    );

const comparable = (value) => {
  if (
    value &&
    typeof value === 'object' &&
    value.__mysqlTimestamp === true
  ) {
    return (
      Number(value.seconds) * 1000 +
      Number(value.nanoseconds || 0) / 1e6
    );
  }

  return value;
};

const equal = (left, right) =>
  JSON.stringify(comparable(left)) ===
  JSON.stringify(comparable(right));

function parseData(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function matches(row, constraints = []) {
  const data = parseData(row.data);

  for (const constraint of constraints.filter(
    (item) => item.type === 'where'
  )) {
    const actual = fieldValue(data, constraint.field);
    const expected = decodeValue(constraint.value);

    switch (constraint.op) {
      case '==':
        if (!equal(actual, expected)) return false;
        break;

      case '!=':
        if (equal(actual, expected)) return false;
        break;

      case '>':
        if (!(comparable(actual) > comparable(expected))) return false;
        break;

      case '>=':
        if (!(comparable(actual) >= comparable(expected))) return false;
        break;

      case '<':
        if (!(comparable(actual) < comparable(expected))) return false;
        break;

      case '<=':
        if (!(comparable(actual) <= comparable(expected))) return false;
        break;

      case 'array-contains':
        if (
          !Array.isArray(actual) ||
          !actual.some((item) => equal(item, expected))
        ) {
          return false;
        }
        break;

      case 'in':
        if (
          !Array.isArray(expected) ||
          !expected.some((item) => equal(item, actual))
        ) {
          return false;
        }
        break;

      case 'not-in':
        if (
          !Array.isArray(expected) ||
          expected.some((item) => equal(item, actual))
        ) {
          return false;
        }
        break;

      case 'array-contains-any':
        if (
          !Array.isArray(actual) ||
          !Array.isArray(expected) ||
          !actual.some((item) =>
            expected.some((candidate) => equal(item, candidate))
          )
        ) {
          return false;
        }
        break;

      default:
        throw Object.assign(
          new Error(`Unsupported query operator: ${constraint.op}`),
          { status: 400, code: 'documents/unsupported-query-operator' }
        );
    }
  }

  return true;
}

function serialize(row) {
  return {
    path: row.path,
    id: row.document_id,
    data: parseData(row.data),
  };
}

async function findDoc(path) {
  const [rows] = await pool.execute(
    `SELECT path, document_id, data
     FROM documents
     WHERE path = ?
     LIMIT 1`,
    [path]
  );

  return rows[0] || null;
}

// Query a collection or collection group.
router.post('/query', async (req, res, next) => {
  try {
    const {
      path,
      collectionGroup,
      constraints = [],
    } = req.body || {};

    if (!Array.isArray(constraints)) {
      return res.status(400).json({
        error: 'Query constraints must be an array.',
        code: 'documents/invalid-constraints',
      });
    }

    let rows;

    if (collectionGroup) {
      [rows] = await pool.execute(
        `SELECT path, document_id, collection_name, parent_path, data
         FROM documents
         WHERE collection_name = ?`,
        [String(collectionGroup)]
      );
    } else {
      const collectionPath = cleanPath(path);

      if (!collectionPath) {
        return res.status(400).json({
          error: 'A collection path is required.',
          code: 'documents/missing-collection-path',
        });
      }

      [rows] = await pool.execute(
        `SELECT path, document_id, collection_name, parent_path, data
         FROM documents
         WHERE parent_path = ?`,
        [collectionPath]
      );
    }

    let filtered = rows.filter((row) => matches(row, constraints));

    const sortConstraints = constraints.filter(
      (item) => item.type === 'orderBy'
    );

    for (const sort of [...sortConstraints].reverse()) {
      const direction = sort.direction === 'desc' ? -1 : 1;

      filtered.sort((left, right) => {
        const leftData = parseData(left.data);
        const rightData = parseData(right.data);

        const a = comparable(fieldValue(leftData, sort.field));
        const b = comparable(fieldValue(rightData, sort.field));

        if (a == null && b == null) return 0;
        if (a == null) return -1 * direction;
        if (b == null) return 1 * direction;

        return (a < b ? -1 : a > b ? 1 : 0) * direction;
      });
    }

    const limitConstraint = constraints.find(
      (item) => item.type === 'limit'
    );

    if (limitConstraint) {
      const count = Number(limitConstraint.count);

      if (!Number.isFinite(count) || count < 0) {
        return res.status(400).json({
          error: 'Query limit must be a non-negative number.',
          code: 'documents/invalid-limit',
        });
      }

      filtered = filtered.slice(0, Math.floor(count));
    }

    return res.json({
      documents: filtered.map(serialize),
    });
  } catch (error) {
    return next(error);
  }
});

// Read a document.
router.get('/:path(*)', async (req, res, next) => {
  try {
    const path = decodePath(req);
    const row = await findDoc(path);

    if (!row) {
      return res.json({ document: null });
    }

    return res.json({ document: serialize(row) });
  } catch (error) {
    return next(error);
  }
});

// Add a document to a collection.
router.post('/', async (req, res, next) => {
  try {
    const collectionPath = cleanPath(req.body?.path);

    if (!collectionPath) {
      return res.status(400).json({
        error: 'A collection path is required.',
        code: 'documents/missing-collection-path',
      });
    }

    const id = crypto.randomUUID().replace(/-/g, '');
    const path = `${collectionPath}/${id}`;
    const data = decodeValue(req.body?.data || {});

    await pool.execute(
      `INSERT INTO documents
       (path, document_id, collection_name, parent_path, data)
       VALUES (?, ?, ?, ?, ?)`,
      [
        path,
        id,
        collectionFromPath(path),
        parentFromPath(path),
        JSON.stringify(data),
      ]
    );

    return res.status(201).json({ path, id });
  } catch (error) {
    return next(error);
  }
});

// Create or replace a document; optionally merge its top-level fields.
router.put('/:path(*)', async (req, res, next) => {
  let connection;

  try {
    const path = decodePath(req);
    const data = decodeValue(req.body?.data || {});
    const merge = Boolean(req.body?.merge);

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT data FROM documents WHERE path = ? FOR UPDATE',
      [path]
    );

    const previous = rows.length ? parseData(rows[0].data) : {};

    const merged =
      merge && rows.length
        ? { ...previous, ...data }
        : data;

    await connection.execute(
      `INSERT INTO documents
       (path, document_id, collection_name, parent_path, data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [
        path,
        idFromPath(path),
        collectionFromPath(path),
        parentFromPath(path),
        JSON.stringify(merged),
      ]
    );

    await connection.commit();

    return res.json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback();
    return next(error);
  } finally {
    if (connection) connection.release();
  }
});

// Update existing top-level fields.
router.patch('/:path(*)', async (req, res, next) => {
  let connection;

  try {
    const path = decodePath(req);
    const patch = decodeValue(req.body?.data || {});

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT data FROM documents WHERE path = ? FOR UPDATE',
      [path]
    );

    if (!rows.length) {
      await connection.rollback();

      return res.status(404).json({
        error: 'Document not found.',
        code: 'documents/not-found',
      });
    }

    const previous = parseData(rows[0].data);
    const merged = { ...previous, ...patch };

    await connection.execute(
      'UPDATE documents SET data = ? WHERE path = ?',
      [JSON.stringify(merged), path]
    );

    await connection.commit();

    return res.json({ success: true });
  } catch (error) {
    if (connection) await connection.rollback();
    return next(error);
  } finally {
    if (connection) connection.release();
  }
});

// Delete a single document.
router.delete('/:path(*)', async (req, res, next) => {
  try {
    const path = decodePath(req);

    await pool.execute(
      'DELETE FROM documents WHERE path = ?',
      [path]
    );

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
