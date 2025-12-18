const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater'); // <--- Import the update utility

// Define the specific task type for this router's database columns
const TASK_TYPE_PREFIX = 'accessories'; 

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
// GET /api/accessories-tasks
// =========================================================
router.get('/', async (req, res) => {
    // 1. Modify the query to include a WHERE clause to filter by approve_status
    const query = `
        SELECT * FROM accessories_tasks 
        WHERE approve_status = 'Approved'
        ORDER BY created_at DESC
    `;
    try {
        // 2. Execute the modified query
        const [results] = await pool.execute(query);
        
        // 3. Send the filtered and formatted results
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching approved accessories tasks:', err);
        // 4. Return a 500 status on database error
        return res.status(500).json({ error: 'Failed to fetch approved accessories tasks' });
    }
});

// =========================================================
// POST /api/accessories-tasks - Create (Increments total_accessories)
// =========================================================
router.post('/', async (req, res) => {
    const { title, description, priority, status, project_no, due_date } = req.body;
    
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    // Sanitize optional fields
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    const initialStatus = status || 'pending'; // Default status

    const insertSql = `INSERT INTO accessories_tasks (title, description, priority, status, project_no, due_date) VALUES (?, ?, ?, ?, ?, ?)`;
    
    try {
        // 1. Create the task
        const [insertResults] = await pool.execute(insertSql, [
            title, 
            sanitizedDescription, 
            priority, 
            initialStatus, 
            project_no, 
            sanitizedDueDate 
        ]);

        // 2. Update project counts: Increment total_accessories
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);

        // 3. If the task is created as 'completed', also increment completed_accessories
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        
        // 4. Fetch and return the newly created task
        const [rows] = await pool.execute('SELECT * FROM accessories_tasks WHERE id = ?', [insertResults.insertId]);
        
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }
        
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating accessories task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to create accessories task' });
    }
});

// =========================================================
// PATCH /api/accessories-tasks/:id - Update (Handles status change)
// =========================================================
router.patch('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body required.' });
    }

    let previousTask;

    try {
        // 1. Fetch the existing task status and project number BEFORE updating
        const [existingRows] = await pool.execute('SELECT project_no, status FROM accessories_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        previousTask = existingRows[0];
    } catch (err) {
        console.error('Error fetching existing task:', err);
        return res.status(500).json({ error: 'Database error before update' });
    }

    // --- Dynamic UPDATE Query Construction ---
    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date'];
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
    const updateSql = `UPDATE accessories_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        // 2. Execute the task update
        await pool.execute(updateSql, finalBindValues);
        
        // 3. Update project counts based on status change
        const newStatus = updates.status ? updates.status.toLowerCase() : previousTask.status.toLowerCase();
        const oldStatus = previousTask.status.toLowerCase();

        // Check for transition to 'completed' (+1 to completed_accessories)
        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } 
        // Check for transition away from 'completed' (-1 to completed_accessories)
        else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        // 4. Fetch and return the updated row
        const [rows] = await pool.execute('SELECT * FROM accessories_tasks WHERE id = ?', [taskId]);
        if (rows.length === 0) {
            // This should not happen if affectedRows > 0, but good for safety
            return res.status(404).json({ error: 'Task not found after update' });
        }
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating accessories task or project counts:', err);
        return res.status(500).json({ error: 'Failed to update accessories task' });
    }
});

// =========================================================
// DELETE /api/accessories-tasks/:id - Delete (Decrements total/completed_accessories)
// =========================================================
router.delete('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    
    let taskToDelete;

    try {
        // 1. Fetch the task's project number and status BEFORE deletion
        const [existingRows] = await pool.execute('SELECT project_no, status FROM accessories_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];
        
        // 2. Delete the task
        const [results] = await pool.execute('DELETE FROM accessories_tasks WHERE id = ?', [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 3. Update project counts: Decrement total_accessories
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        
        // 4. If the deleted task was 'completed', also decrement completed_accessories
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting accessories task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to delete accessories task' });
    }
});

module.exports = router;