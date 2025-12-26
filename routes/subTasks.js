// backend/routes/subtasks.js
const express = require('express');
const router = express.Router();
const db = require('../db/connection');

// POST /api/subtasks - Create a new sub-task
router.post('/', async (req, res) => {
    try {
        const { title, status, project_id, category_task_id, category } = req.body;
        
        // Basic validation
        if (!title || !project_id || !category_task_id) {
            return res.status(400).json({ 
                error: 'Title, project_id, and category_task_id are required' 
            });
        }
        
        // Insert into database
        const query = `
            INSERT INTO subtasks 
            (title, status, project_id, category_task_id, category)
            VALUES (?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            title,
            status || 'pending',
            project_id,
            category_task_id,
            category || null
        ]);
        
        // Return the created sub-task
        const [subtask] = await db.execute(
            'SELECT * FROM subtasks WHERE id = ?',
            [result.insertId]
        );
        
        res.status(201).json(subtask[0]);
        
    } catch (error) {
        console.error('Error creating sub-task:', error);
        res.status(500).json({ error: 'Failed to create sub-task' });
    }
});

// DELETE /api/subtasks/:id - Delete a sub-task
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [result] = await db.execute(
            'DELETE FROM subtasks WHERE id = ?',
            [id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Sub-task not found' });
        }
        
        res.status(204).end(); // No content
        
    } catch (error) {
        console.error('Error deleting sub-task:', error);
        res.status(500).json({ error: 'Failed to delete sub-task' });
    }
});

router.get('/', async (req, res) => {
    try {
        const [subtasks] = await db.execute('SELECT * FROM subtasks');
        res.json(subtasks);
    } catch (error) {
        console.error('Error fetching subtasks:', error);
        res.status(500).json({ error: 'Failed to fetch subtasks' });
    }
});

router.get('/task/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const [subtasks] = await db.execute(
            'SELECT * FROM subtasks WHERE category_task_id = ? AND category = ?',
            [taskId, 'Accessories']
        );
        res.json(subtasks);
    } catch (error) {
        console.error('Error fetching subtasks by task:', error);
        res.status(500).json({ error: 'Failed to fetch subtasks for this task' });
    }
});

router.patch('/:id/done', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if subtask exists
        const [existing] = await db.execute(
            'SELECT * FROM subtasks WHERE id = ?',
            [id]
        );
        
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Sub-task not found' });
        }
        
        // Update the subtask status to 'done'
        const query = `
            UPDATE subtasks 
            SET 
                status = 'done'
            WHERE id = ?
        `;
        
        await db.execute(query, [id]);
        
        // Fetch the updated subtask
        const [updated] = await db.execute(
            'SELECT * FROM subtasks WHERE id = ?',
            [id]
        );
        
        res.json(updated[0]);
        
    } catch (error) {
        console.error('Error marking sub-task as done:', error);
        res.status(500).json({ error: 'Failed to mark sub-task as done' });
    }
});

module.exports = router;