// routes/cuttingTasks.js

const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 

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

// GET /api/cutting-tasks
router.get('/', async (req, res) => {
    const query = 'SELECT * FROM cutting_tasks ORDER BY created_at DESC';
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching cutting tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch cutting tasks' });
    }
});

// POST /api/cutting-tasks
router.post('/', async (req, res) => {
    const { title, description, priority, status, project_no, due_date } = req.body;
    
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    const insertSql = `INSERT INTO cutting_tasks (title, description, priority, status, project_no, due_date) VALUES (?, ?, ?, ?, ?, ?)`;
    
    try {
        const [insertResults] = await pool.execute(insertSql, [
            title, 
            description, 
            priority, 
            status, 
            project_no, 
            due_date
        ]);
        const [rows] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [insertResults.insertId]);
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating cutting task:', err);
        return res.status(500).json({ error: 'Failed to create cutting task' });
    }
});

// PATCH /api/cutting-tasks/:id
router.patch('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body required.' });
    }

    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date']; // Added project_no
    const fieldsToUpdate = [];
    const updateValues = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`); 
            const value = (updates[field] === '' && (field === 'description' || field === 'due_date')) ? null : updates[field];
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE cutting_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        const [updateResults] = await pool.execute(updateSql, finalBindValues);
        
        if (updateResults.affectedRows === 0) {
            const [checkRows] = await pool.execute('SELECT id FROM cutting_tasks WHERE id = ?', [taskId]);
            if (checkRows.length === 0) {
                return res.status(404).json({ error: 'Task not found' });
            }
        }
        
        const [rows] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [taskId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating cutting task:', err);
        return res.status(500).json({ error: 'Failed to update cutting task' });
    }
});

// DELETE /api/cutting-tasks/:id
router.delete('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    try {
        const [results] = await pool.execute('DELETE FROM cutting_tasks WHERE id = ?', [taskId]);
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting cutting task:', err);
        return res.status(500).json({ error: 'Failed to delete cutting task' });
    }
});

module.exports = router;