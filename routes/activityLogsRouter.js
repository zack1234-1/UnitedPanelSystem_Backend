const express = require('express');
const router = express.Router();
// Assuming you have a db connection module
const db = require('../db/connection'); 

/**
 * @desc Get all activity logs with optional filtering, ordered descending by timestamp
 * @route GET /api/activity-logs
 * @access Private (Admin/Authenticated)
 */
router.get('/', async (req, res) => {
    try {
        // Destructure and provide defaults for pagination
        const {
            user_id,
            activity_type,
            resource_type,
            resource_id,
            start_date,
            end_date,
            limit = 100, // Default limit
            offset = 0    // Default offset
        } = req.query;

        let query = 'SELECT * FROM activity_logs WHERE 1=1';
        const params = [];

        // Build dynamic WHERE clause based on query parameters (filtering)
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

        // Date range filtering
        if (start_date) {
            query += ' AND timestamp >= ?';
            params.push(start_date);
        }

        if (end_date) {
            query += ' AND timestamp <= ?';
            params.push(end_date);
        }

        // Apply descending order by timestamp and pagination
        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        // Execute the query
        const [logs] = await db.execute(query, params);
        
        // Respond with the fetched logs
        res.json({
            success: true,
            data: logs,
            message: `Fetched ${logs.length} activity logs, ordered by timestamp descending.`
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

module.exports = router;