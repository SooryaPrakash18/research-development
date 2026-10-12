
const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const {
  requireAuth,
  requireSuperAdmin,
} = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/admin/users
 * List user documents stored in MySQL.
 */
router.get(
  '/users',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const [rows] = await pool.execute(
        `SELECT document_id, path, data
         FROM documents
         WHERE collection_name = 'users'
         ORDER BY path`
      );

      const users = rows.map((row) => {
        const data =
          typeof row.data === 'string'
            ? JSON.parse(row.data)
            : row.data;

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
      next(error);
    }
  }
);

/**
 * POST /api/admin/delete-auth-user
 * Body: { "userId": "Firebase Authentication UID" }
 *
 * Deletes the Firebase Auth user and MySQL documents under
 * users/{sanitizedEmail}, including nested academic-year data.
 */
router.post(
  '/delete-auth-user',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const { userId } = req.body || {};

      if (
        typeof userId !== 'string' ||
        !userId.trim()
      ) {
        return res.status(400).json({
          success: false,
          error: 'A valid userId is required.',
        });
      }

      // Resolve the target account from Firebase, not from a
      // client-supplied email address.
      let user;

      try {
        user = await admin.auth().getUser(userId.trim());
      } catch (error) {
        if (error.code === 'auth/user-not-found') {
          return res.status(404).json({
            success: false,
            error:
              'Firebase Auth user was not found. MySQL records were not deleted.',
          });
        }

        throw error;
      }

      if (!user.email) {
        return res.status(400).json({
          success: false,
          error:
            'The target account has no email. Cannot safely resolve its MySQL document path.',
        });
      }

      const sanitizedEmail = user.email.replace(
        /[.#$\[\]]/g,
        '_'
      );

      const userPath = `users/${sanitizedEmail}`;

      // Delete all MySQL records under the user document path.
      // This includes academicYears and nested research records.
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

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

        console.log(
          `Deleted ${result.affectedRows} MySQL documents for ${user.email}`
        );
      } catch (databaseError) {
        await connection.rollback();
        throw databaseError;
      } finally {
        connection.release();
      }

      // Delete Firebase Authentication after MySQL cleanup.
      // If this fails, report that the database cleanup already happened.
      try {
        await admin.auth().deleteUser(user.uid);
      } catch (authError) {
        console.error(
          'MySQL cleanup succeeded, but Auth deletion failed:',
          authError
        );

        return res.status(502).json({
          success: false,
          mysqlDeleted: true,
          authDeleted: false,
          userEmail: user.email,
          error:
            'MySQL records were deleted, but Firebase Authentication deletion failed. Check the backend logs before retrying.',
        });
      }

      return res.json({
        success: true,
        mysqlDeleted: true,
        authDeleted: true,
        storageDeleted: false,
        firestoreDeleted: false,
        userUid: user.uid,
        userEmail: user.email,
        message:
          'Firebase Authentication account and matching MySQL documents were deleted.',
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
