const express = require('express');
const router = express.Router();
// CORRECTED IMPORT: Import the promise-based pool object
const pool = require('../db/connection'); 

// Utility function to format database results for the API response
const formatTask = (task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    projectNo: task.project_no,
    dueDate: task.due_date,
    createdAt: task.created_at
});

// GET /api/panel-tasks - Get all panel tasks
router.get('/', async (req, res) => {
    console.log('GET /api/panel-tasks called');
    
    const query = 'SELECT * FROM panel_tasks ORDER BY created_at DESC';
    
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// POST /api/panel-tasks - Create a new panel task
router.post('/', async (req, res) => {
    console.log('POST /api/panel-tasks called with body:', req.body);
    
    if (!req.body) {
        return res.status(400).json({ error: 'Request body is required' });
    }
    
    const { title, description, priority, status, project_no, due_date } = req.body;
    
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    // --- CRITICAL FIX: Ensure 'undefined' and empty strings for optional fields are converted to 'null' ---
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    // --- END CRITICAL FIX ---

    const insertSql = `INSERT INTO panel_tasks (title, description, priority, status, project_no, due_date) 
                       VALUES (?, ?, ?, ?, ?, ?)`;
    
    const bindValues = [
        title, 
        sanitizedDescription, // Now guaranteed to be string or null
        priority, 
        status, 
        project_no, 
        sanitizedDueDate      // Now guaranteed to be string or null
    ];

    try {
        const [insertResults] = await pool.execute(insertSql, bindValues);
        const insertId = insertResults.insertId;

        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [insertId]);
        
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }

        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating task:', err);
        // Important: Re-throw or log the detailed error if it still fails for debugging
        return res.status(500).json({ error: 'Failed to create task' });
    }
});

// PATCH /api/panel-tasks/:id - Update a panel task
router.patch('/:id', async (req, res) => {
    console.log(`PATCH /api/panel-tasks/${req.params.id} called with body:`, req.body); 
    
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }

    // 1. Prepare the list of fields that were actually sent in the request
    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date'];
    const fieldsToUpdate = [];
    const updateValues = [];

    // 2. Iterate over the fields to dynamically build the query
    for (const field of allowedFields) {
        // Use an array access to check the field in the updates object
        if (updates[field] !== undefined) {
            
            // Add the field name to the SET clause array
            fieldsToUpdate.push(`${field} = ?`); 
            
            // Add the value to the bind array. 
            // NOTE: If you need to allow 'project_no' to be set to NULL/empty string, 
            // you must add it to the conditional below. Assuming it's required for now.
            const value = (updates[field] === '' && (field === 'description' || field === 'due_date')) 
                          ? null : updates[field];
                          
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    // 3. Construct the dynamic SQL query
    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE panel_tasks SET ${setClause} WHERE id = ?`;
    
    // 4. Final bind array: updateValues + taskId
    const finalBindValues = [...updateValues, taskId];

    try {
        const [updateResults] = await pool.execute(updateSql, finalBindValues);
        
        if (updateResults.affectedRows === 0) {
            const [checkRows] = await pool.execute('SELECT id FROM panel_tasks WHERE id = ?', [taskId]);
            if (checkRows.length === 0) {
                 return res.status(404).json({ error: 'Task not found' });
            }
        }
        
        // Fetch the updated row to return it
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);

        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating task:', err);
        return res.status(500).json({ error: 'Failed to update task' });
    }
});

// DELETE /api/panel-tasks/:id - Delete a panel task
router.delete('/:id', async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id} called`); // Debug log
    
    const taskId = parseInt(req.params.id);

    const deleteSql = 'DELETE FROM panel_tasks WHERE id = ?';
    
    try {
        const [results] = await pool.execute(deleteSql, [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting task:', err);
        return res.status(500).json({ error: 'Failed to delete task' });
    }
});

module.exports = router;