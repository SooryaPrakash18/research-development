
const express = require('express');
const pool = require('../db');
const {
  requireAuth,
  requireSuperAdmin,
} = require('../middleware/auth');

const router = express.Router();

function parseDocumentData(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' ? value : {};
}

function sanitizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[.#$\[\]]/g, '_');
}

function getUserEmail(data) {
  return String(data.email || data.userEmail || '')
    .trim()
    .toLowerCase();
}

/**
 * GET /api/admin/users
 *
 * Lists user documents stored in MySQL.
 * Requires super-admin authentication.
 */
router.get(
  '/users',
  requireAuth,
  requireSuperAdmin,
  async (_req, res, next) => {
    try {
      const [rows] = await pool.execute(
        `SELECT document_id, path, data
         FROM documents
         WHERE collection_name = 'users'
         ORDER BY path`
      );

      const users = rows.map((row) => {
        const data = parseDocumentData(row.data);

        return {
          id: row.document_id,
          path: row.path,
          name:
            data.name ||
            data.displayName ||
            data.fullName ||
            null,
          email: data.email || null,
          data,
        };
      });

      return res.json({
        success: true,
        total: users.length,
        users,
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * POST /api/admin/delete-auth-user
 *
 * Body:
 *   { "userId": "MySQL document ID" }
 *   { "userId": "researcher@francisxavier.ac.in" }
 *
 * Deletes MySQL documents under users/{sanitizedEmail},
 * including nested academic years and research records.
 *
 * This does not delete a Google account. Google accounts are
 * managed by Google, not by this application.
 */
router.post(
  '/delete-auth-user',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    let connection;

    try {
      const userId = String(req.body?.userId || '').trim();

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'A valid userId or email is required.',
        });
      }

      // Never allow the super admin to delete their own account
      // through this endpoint.
      const superAdminEmail = (
        process.env.SUPER_ADMIN_EMAIL ||
        'klnarayanan@francisxavier.ac.in'
      ).trim().toLowerCase();

      let targetEmail = '';

      // First, allow deletion by email.
      if (userId.includes('@')) {
        targetEmail = userId.toLowerCase();
      } else {
        // Otherwise resolve the user from the MySQL documents table.
        // Prefer an exact document ID match.
        const [rows] = await pool.execute(
          `SELECT document_id, path, data
           FROM documents
           WHERE collection_name = 'users'
             AND document_id = ?
           LIMIT 1`,
          [userId]
        );

        if (rows.length) {
          const data = parseDocumentData(rows[0].data);

          targetEmail = getUserEmail(data);

          // Legacy user paths commonly contain sanitized email IDs.
          if (!targetEmail && rows[0].path.startsWith('users/')) {
            const pathId = rows[0].path.slice('users/'.length);

            if (!pathId.includes('/')) {
              targetEmail = pathId.replace(/_/g, '.');
            }
          }
        }

        // Also support a full users/{id} document path.
        if (!targetEmail && userId.startsWith('users/')) {
          const [pathRows] = await pool.execute(
            `SELECT document_id, path, data
             FROM documents
             WHERE path = ?
             LIMIT 1`,
            [userId]
          );

          if (pathRows.length) {
            const data = parseDocumentData(pathRows[0].data);
            targetEmail = getUserEmail(data);

            if (!targetEmail) {
              targetEmail = userId.slice('users/'.length);
            }
          }
        }
      }

      if (!targetEmail) {
        return res.status(404).json({
          success: false,
          error:
            'The user could not be resolved from MySQL. Pass the user email or a matching MySQL document ID.',
        });
      }

      if (targetEmail === superAdminEmail) {
        return res.status(403).json({
          success: false,
          error: 'The super admin account cannot be deleted here.',
        });
      }

      const sanitizedEmail = sanitizeEmail(targetEmail);
      const userPath = `users/${sanitizedEmail}`;

      connection = await pool.getConnection();

      await connection.beginTransaction();

      // Delete the user root document and all descendants.
      // The path prefix is parameterized to avoid SQL injection.
      const [result] = await connection.execute(
        `DELETE FROM documents
         WHERE path = ?
            OR path LIKE ?`,
        [
          userPath,
          `${userPath}/%`,
        ]
      );

      await connection.commit();

      return res.json({
        success: true,
        mysqlDeleted: true,
        authDeleted: false,
        storageDeleted: false,
        firestoreDeleted: false,
        userEmail: targetEmail,
        deletedDocuments: result.affectedRows,
        message:
          'The user records stored under this MySQL document path were deleted. Google authentication and Firebase Storage files were not deleted.',
      });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error(
            'Admin deletion rollback failed:',
            rollbackError.message
          );
        }
      }

      return next(error);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

module.exports = router;
