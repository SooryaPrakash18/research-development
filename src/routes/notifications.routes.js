
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ADMIN_EMAIL = (
  process.env.SUPER_ADMIN_EMAIL ||
  'klnarayanan@francisxavier.ac.in'
).toLowerCase();

router.use(requireAuth);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function mapNotification(row) {
  return {
    id: String(row.id),
    targetEmail: row.target_email,
    type: row.type,
    title: row.title,
    message: row.message,
    link: row.link,
    icon: row.icon,
    read: Boolean(row.is_read),
    createdByEmail: row.created_by_email,
    createdByName: row.created_by_name,
    itemId: row.item_id,
    createdAt: row.created_at,
  };
}

// GET /api/notifications
// Fetch notifications addressed to the signed-in user.
router.get('/', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);

    if (!email) {
      return res.status(401).json({
        error: 'Authenticated email is missing.',
      });
    }

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 50, 1),
      100
    );

    const [rows] = await pool.execute(
      `SELECT *
       FROM notifications
       WHERE target_email = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [email, limit]
    );

    return res.json({
      notifications: rows.map(mapNotification),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);

    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS unreadCount
       FROM notifications
       WHERE target_email = ? AND is_read = FALSE`,
      [email]
    );

    return res.json({
      unreadCount: Number(rows[0]?.unreadCount || 0),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications
// Create a notification for the super admin.
router.post('/', async (req, res, next) => {
  try {
    const createdByEmail = normalizeEmail(req.user?.email);

    if (!createdByEmail) {
      return res.status(401).json({
        error: 'Authenticated email is missing.',
      });
    }

    const {
      type,
      title,
      message,
      link,
      icon,
      createdByName,
      itemId = '',
    } = req.body || {};

    if (
      !String(type || '').trim() ||
      !String(title || '').trim() ||
      !String(message || '').trim()
    ) {
      return res.status(400).json({
        error: 'type, title and message are required.',
      });
    }

    const notificationType = String(type).trim().slice(0, 100);
    const notificationTitle = String(title).trim().slice(0, 255);
    const notificationMessage = String(message).trim();

    const notificationLink = String(link || '/dashboard').slice(0, 1024);
    const notificationIcon = String(icon || '🔔').slice(0, 50);
    const creatorName = String(createdByName || '').slice(0, 255);
    const notificationItemId = String(itemId || '').slice(0, 255);

    const [result] = await pool.execute(
      `INSERT INTO notifications
       (
         target_email,
         type,
         title,
         message,
         link,
         icon,
         is_read,
         created_by_email,
         created_by_name,
         item_id
       )
       VALUES (?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?)`,
      [
        ADMIN_EMAIL,
        notificationType,
        notificationTitle,
        notificationMessage,
        notificationLink,
        notificationIcon,
        createdByEmail,
        creatorName,
        notificationItemId,
      ]
    );

    const [rows] = await pool.execute(
      'SELECT * FROM notifications WHERE id = ? LIMIT 1',
      [result.insertId]
    );

    return res.status(201).json({
      message: 'Notification created successfully.',
      notification: mapNotification(rows[0]),
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);
    const id = String(req.params.id || '');

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        error: 'Invalid notification ID.',
      });
    }

    const [result] = await pool.execute(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = ? AND target_email = ?`,
      [id, email]
    );

    if (!result.affectedRows) {
      const [existing] = await pool.execute(
        `SELECT id FROM notifications
         WHERE id = ? AND target_email = ? LIMIT 1`,
        [id, email]
      );

      if (!existing.length) {
        return res.status(404).json({
          error: 'Notification not found.',
        });
      }
    }

    return res.json({
      message: 'Notification marked as read.',
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);

    const [result] = await pool.execute(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE target_email = ? AND is_read = FALSE`,
      [email]
    );

    return res.json({
      message: 'Notifications marked as read.',
      updatedCount: result.affectedRows,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/notifications/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);
    const id = String(req.params.id || '');

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        error: 'Invalid notification ID.',
      });
    }

    const [result] = await pool.execute(
      `DELETE FROM notifications
       WHERE id = ? AND target_email = ?`,
      [id, email]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        error: 'Notification not found.',
      });
    }

    return res.json({
      message: 'Notification deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
