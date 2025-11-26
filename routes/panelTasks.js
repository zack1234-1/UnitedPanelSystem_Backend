const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater');
const TASK_TYPE_PREFIX = 'panel'; // <--- Define the type prefix for this router

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

// =========================================================
// GET /api/panel-tasks - Get all panel tasks
// =========================================================
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

// =========================================================
// POST /api/panel-tasks - Create a new panel task
// (Increments total_panel and potentially completed_panel)
// =========================================================
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

    // Sanitize optional fields to convert empty strings/undefined to null
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    const initialStatus = status || 'pending'; // Default status

    const insertSql = `INSERT INTO panel_tasks (title, description, priority, status, project_no, due_date) 
                       VALUES (?, ?, ?, ?, ?, ?)`;
    
    const bindValues = [
        title, 
        sanitizedDescription, 
        priority, 
        initialStatus, 
        project_no, 
        sanitizedDueDate 
    ];

    try {
        // 1. Create the task
        const [insertResults] = await pool.execute(insertSql, bindValues);
        const insertId = insertResults.insertId;
        
        // 2. Update project counts: Increment total_panel
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);

        // 3. If the task is created as 'completed', also increment completed_panel
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }

        // 4. Fetch and return the newly created task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [insertId]);
        
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }

        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating task:', err);
        return res.status(500).json({ error: 'Failed to create task' });
    }
});

// =========================================================
// PATCH /api/panel-tasks/:id - Update a panel task
// (Handles status change for completed_panel count)
// =========================================================
router.patch('/:id', async (req, res) => {
    console.log(`PATCH /api/panel-tasks/${req.params.id} called with body:`, req.body); 
    
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }

    let previousTask;

    try {
        // 1. Fetch the existing task to determine its current status and project number
        const [existingRows] = await pool.execute('SELECT project_no, status FROM panel_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        previousTask = existingRows[0];
    } catch (err) {
        console.error('Error fetching existing task:', err);
        return res.status(500).json({ error: 'Database error before update' });
    }

    // 2. Prepare the dynamic UPDATE query
    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date'];
    const fieldsToUpdate = [];
    const updateValues = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`); 
            
            const value = (updates[field] === '' && (field === 'description' || field === 'due_date')) 
                          ? null : updates[field];
                          
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE panel_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        // 3. Execute the task update
        await pool.execute(updateSql, finalBindValues);
        
        // 4. Update project counts based on status change
        const newStatus = updates.status ? updates.status.toLowerCase() : previousTask.status.toLowerCase();
        const oldStatus = previousTask.status.toLowerCase();

        // Check for transition to 'completed'
        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } 
        // Check for transition away from 'completed'
        else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        // 5. Fetch and return the updated row
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);

        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating task or project counts:', err);
        return res.status(500).json({ error: 'Failed to update task' });
    }
});


// =========================================================
// DELETE /api/panel-tasks/:id - Delete a panel task
// (Decrements total_panel and potentially completed_panel)
// =========================================================
router.delete('/:id', async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id} called`); 
    
    const taskId = parseInt(req.params.id);

    try {
        // 1. Fetch the task's project number and status BEFORE deletion
        const [existingRows] = await pool.execute('SELECT project_no, status FROM panel_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const taskToDelete = existingRows[0];
        
        // 2. Delete the task
        const deleteSql = 'DELETE FROM panel_tasks WHERE id = ?';
        const [results] = await pool.execute(deleteSql, [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 3. Update project counts: Decrement total_panel
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        
        // 4. If the deleted task was 'completed', also decrement completed_panel
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to delete task' });
    }
});

module.exports = router;