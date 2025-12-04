const express = require('express');
const router = express.Router();
const db = require('../db'); // Assuming you have a db connection module

/**
 * @desc Get all activity logs with optional filtering
 * @route GET /api/activity-logs
 * @access Private (Admin only typically)
 */
router.get('/', async (req, res) => {
    try {
        const {
            user_id,
            activity_type,
            resource_type,
            resource_id,
            start_date,
            end_date,
            limit = 100,
            offset = 0
        } = req.query;

        let query = 'SELECT * FROM activity_logs WHERE 1=1';
        const params = [];

        // Build dynamic WHERE clause based on query parameters
        if (user_id) {
            query += ' AND user_id = ?';
            params.push(user_id);
        }

        if (activity_type) {
            query += ' AND activity_type = ?';
            params.push(activity_type);
        }

        if (resource_type) {
            query += ' AND resource_type = ?';
            params.push(resource_type);
        }

        if (resource_id) {
            query += ' AND resource_id = ?';
            params.push(resource_id);
        }

        if (start_date) {
            query += ' AND timestamp >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND timestamp <= ?';
            params.push(end_date);
        }

        // Order by most recent first
        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [logs] = await db.execute(query, params);
        
        // Also get total count for pagination
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total')
                               .split('ORDER BY')[0]
                               .split('LIMIT')[0];
        const [countResult] = await db.execute(countQuery, params.slice(0, -2));
        
        res.json({
            success: true,
            data: logs,
            pagination: {
                total: countResult[0].total,
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });
    } catch (error) {
        console.error('Error fetching activity logs:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch activity logs',
            details: error.message 
        });
    }
});

/**
 * @desc Get activity logs for a specific project
 * @route GET /api/activity-logs/project/:projectNo
 */
router.get('/project/:projectNo', async (req, res) => {
    try {
        const { projectNo } = req.params;
        const { limit = 50 } = req.query;
        
        const query = `
            SELECT al.*, u.username, u.email 
            FROM activity_logs al
            LEFT JOIN users u ON al.user_id = u.id
            WHERE al.resource_type = 'project' 
            AND al.resource_id = ?
            ORDER BY al.timestamp DESC
            LIMIT ?
        `;
        
        const [logs] = await db.execute(query, [projectNo, parseInt(limit)]);
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error('Error fetching project activity logs:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch project activity logs' 
        });
    }
});

/**
 * @desc Get activity logs for a specific user
 * @route GET /api/activity-logs/user/:userId
 */
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;
        
        const query = `
            SELECT * FROM activity_logs 
            WHERE user_id = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `;
        
        const [logs] = await db.execute(query, [userId, parseInt(limit)]);
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error('Error fetching user activity logs:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch user activity logs' 
        });
    }
});

/**
 * @desc Get a specific activity log by ID
 * @route GET /api/activity-logs/:id
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT al.*, u.username, u.email, u.full_name
            FROM activity_logs al
            LEFT JOIN users u ON al.user_id = u.id
            WHERE al.id = ?
        `;
        
        const [logs] = await db.execute(query, [id]);
        
        if (logs.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Activity log not found' 
            });
        }
        
        res.json({ success: true, data: logs[0] });
    } catch (error) {
        console.error('Error fetching activity log:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch activity log' 
        });
    }
});

/**
 * @desc Create a new activity log
 * @route POST /api/activity-logs
 * @access Private (Typically created by other API endpoints)
 */
router.post('/', async (req, res) => {
    try {
        const {
            user_id,
            activity_type,
            resource_type,
            resource_id,
            message,
            details = null
        } = req.body;

        // Validate required fields
        if (!user_id || !activity_type || !resource_type || !resource_id || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: user_id, activity_type, resource_type, resource_id, message'
            });
        }

        const query = `
            INSERT INTO activity_logs 
            (user_id, activity_type, resource_type, resource_id, message, details) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            user_id,
            activity_type,
            resource_type,
            resource_id,
            message,
            details ? JSON.stringify(details) : null
        ]);

        // Get the newly created log
        const [newLog] = await db.execute(
            'SELECT * FROM activity_logs WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            data: newLog[0],
            message: 'Activity log created successfully'
        });
    } catch (error) {
        console.error('Error creating activity log:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to create activity log',
            details: error.message 
        });
    }
});

/**
 * @desc Update an activity log (typically used for corrections)
 * @route PATCH /api/activity-logs/:id
 * @access Private (Admin only)
 */
router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Check if log exists
        const [existingLog] = await db.execute(
            'SELECT * FROM activity_logs WHERE id = ?',
            [id]
        );
        
        if (existingLog.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Activity log not found'
            });
        }

        // Build dynamic update query
        const allowedFields = ['message', 'details'];
        const setClause = [];
        const values = [];

        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                setClause.push(`${field} = ?`);
                values.push(field === 'details' && updates[field] ? 
                    JSON.stringify(updates[field]) : updates[field]);
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        values.push(id); // For WHERE clause
        
        const query = `UPDATE activity_logs SET ${setClause.join(', ')} WHERE id = ?`;
        await db.execute(query, values);

        // Fetch updated log
        const [updatedLog] = await db.execute(
            'SELECT * FROM activity_logs WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            data: updatedLog[0],
            message: 'Activity log updated successfully'
        });
    } catch (error) {
        console.error('Error updating activity log:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update activity log'
        });
    }
});

/**
 * @desc Delete an activity log
 * @route DELETE /api/activity-logs/:id
 * @access Private (Admin only)
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if log exists
        const [existingLog] = await db.execute(
            'SELECT * FROM activity_logs WHERE id = ?',
            [id]
        );
        
        if (existingLog.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Activity log not found'
            });
        }

        await db.execute('DELETE FROM activity_logs WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Activity log deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting activity log:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete activity log'
        });
    }
});

/**
 * @desc Get activity logs by date range
 * @route GET /api/activity-logs/range
 */
router.get('/range', async (req, res) => {
    try {
        const { start, end } = req.query;
        
        if (!start || !end) {
            return res.status(400).json({
                success: false,
                error: 'Both start and end dates are required'
            });
        }

        const query = `
            SELECT * FROM activity_logs 
            WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp DESC
        `;
        
        const [logs] = await db.execute(query, [start, end]);
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error('Error fetching logs by date range:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch logs by date range'
        });
    }
});

/**
 * @desc Get activity logs by type
 * @route GET /api/activity-logs/type/:type
 */
router.get('/type/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { limit = 100 } = req.query;
        
        const query = `
            SELECT * FROM activity_logs 
            WHERE activity_type = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `;
        
        const [logs] = await db.execute(query, [type, parseInt(limit)]);
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error('Error fetching logs by type:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch logs by type'
        });
    }
});

module.exports = router;