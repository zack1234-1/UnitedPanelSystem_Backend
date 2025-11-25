const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 

// Utility function (updated with project_no)
const formatTask = (task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    projectNo: task.project_no, // Added project_no field
    dueDate: task.due_date, 
    createdAt: task.created_at
});

// GET /api/door-tasks - Get all door tasks
router.get('/', async (req, res) => {
    const query = 'SELECT * FROM door_tasks ORDER BY created_at DESC';
    try {
        const [results] = await pool.execute(query);
        const tasks = results.map(formatTask);
        res.json(tasks);
    } catch (err) {
        console.error('Error fetching door tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch door tasks' });
    }
});

// POST /api/door-tasks - Create a new door task
router.post('/', async (req, res) => {
    const { title, description, priority, status, project_no, due_date } = req.body;
    
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    // --- CRITICAL FIX: Sanitize optional fields to convert undefined or '' to null ---
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    // --- END CRITICAL FIX ---
    
    const insertSql = `INSERT INTO door_tasks (title, description, priority, status, project_no, due_date) 
                       VALUES (?, ?, ?, ?, ?, ?)`;
    
    try {
        const [insertResults] = await pool.execute(insertSql, [
            title, 
            sanitizedDescription, // Use sanitized value
            priority, 
            status, 
            project_no, 
            sanitizedDueDate      // Use sanitized value
        ]);
        const insertId = insertResults.insertId;

        const selectSql = 'SELECT * FROM door_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [insertId]);
        
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }
        
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating door task:', err);
        return res.status(500).json({ error: 'Failed to create door task' });
    }
});

// PATCH /api/door-tasks/:id - Update a door task
router.patch('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }

    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date']; // Added project_no
    const fieldsToUpdate = [];
    const updateValues = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`); 
            // If the value is explicitly provided as undefined (highly unlikely) 
            // or an empty string, convert it to null for optional fields.
            const value = (updates[field] === '' && (field === 'description' || field === 'due_date')) 
                          ? null : updates[field];
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE door_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        const [updateResults] = await pool.execute(updateSql, finalBindValues);
        
        if (updateResults.affectedRows === 0) {
            const [checkRows] = await pool.execute('SELECT id FROM door_tasks WHERE id = ?', [taskId]);
            if (checkRows.length === 0) {
                 return res.status(404).json({ error: 'Task not found' });
            }
        }
        
        const selectSql = 'SELECT * FROM door_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);

        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating door task:', err);
        return res.status(500).json({ error: 'Failed to update door task' });
    }
});

// DELETE /api/door-tasks/:id - Delete a door task
router.delete('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const deleteSql = 'DELETE FROM door_tasks WHERE id = ?';
    
    try {
        const [results] = await pool.execute(deleteSql, [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting door task:', err);
        return res.status(500).json({ error: 'Failed to delete door task' });
    }
});

module.exports = router;