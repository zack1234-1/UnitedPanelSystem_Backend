// routes/cuttingTasks.js

const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater'); // <--- Import the update utility

// Define the specific task type for this router's database columns
const TASK_TYPE_PREFIX = 'cutting'; 

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
// GET /api/cutting-tasks
// =========================================================
router.get('/', async (req, res) => {
    // 🚨 FIX: The string value 'Approved' must be wrapped in single quotes within the SQL query.
    const query = `
        SELECT * FROM cutting_tasks 
        WHERE approve_status = 'Approved' 
        ORDER BY created_at DESC
    `;
    
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching approved cutting tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch approved cutting tasks' });
    }
});
// =========================================================
// POST /api/cutting-tasks - Create (Increments total_cutting)
// =========================================================
router.post('/', async (req, res) => {
    const { title, description, priority, status, project_no, due_date } = req.body;
    
    // --- Validation (Existing Logic) ---
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }
    
    const initialStatus = status || 'pending'; // Default status if not provided

    const insertSql = `INSERT INTO cutting_tasks (title, description, priority, status, project_no, due_date) VALUES (?, ?, ?, ?, ?, ?)`;
    
    try {
        // 1. Create the task
        const [insertResults] = await pool.execute(insertSql, [
            title, 
            description, 
            priority, 
            initialStatus, 
            project_no, 
            due_date
        ]);

        // 2. Update project counts: Increment total_cutting
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);

        // 3. If the task is created as 'completed', also increment completed_cutting
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        
        // 4. Fetch and return the newly created task
        const [rows] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [insertResults.insertId]);
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating cutting task:', err);
        return res.status(500).json({ error: 'Failed to create cutting task' });
    }
});

// =========================================================
// PATCH /api/cutting-tasks/:id - Update (Handles status change)
// =========================================================
router.patch('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    const TASK_TYPE_PREFIX = 'cutting'; // Ensure this is defined or passed in
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body required.' });
    }

    let previousTask;

    try {
        // 1. Fetch the existing task status and project number BEFORE updating
        const [existingRows] = await pool.execute('SELECT project_no, status FROM cutting_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        previousTask = existingRows[0];
    } catch (err) {
        console.error('Error fetching existing task:', err);
        return res.status(500).json({ error: 'Database error before update' });
    }

    // --- Dynamic UPDATE Query Construction (Existing Logic) ---
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
    const updateSql = `UPDATE cutting_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        // 2. Execute the task update
        await pool.execute(updateSql, finalBindValues);
        
        // --- 3. Project Count Synchronization Logic ---

        const oldProjectNo = previousTask.project_no;
        const newProjectNo = updates.project_no || oldProjectNo; // Use new if provided, otherwise stick to old
        const oldStatus = previousTask.status.toLowerCase();
        // Determine the new status after the update
        const newStatus = updates.status ? updates.status.toLowerCase() : oldStatus;
        
        // 3a. Handle Project Transfer (project_no change)
        if (oldProjectNo !== newProjectNo) {
            
            // i. Decrement counts from OLD Project (It loses one task)
            await updateProjectCounts(oldProjectNo, TASK_TYPE_PREFIX, 'total', -1);
            if (oldStatus === 'completed') {
                await updateProjectCounts(oldProjectNo, TASK_TYPE_PREFIX, 'completed', -1);
            }

            // ii. Increment counts for NEW Project (It gains one task)
            await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'total', 1);
            if (newStatus === 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', 1);
            }
        } 
        
        // 3b. Handle Status Change (Only if project_no did NOT change, or the task status was updated)
        else { 
            // Only update the completed count on the *same* project
            
            // Check for transition to 'completed' (+1 to completed_cutting)
            if (newStatus === 'completed' && oldStatus !== 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', 1);
            } 
            // Check for transition away from 'completed' (-1 to completed_cutting)
            else if (newStatus !== 'completed' && oldStatus === 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', -1);
            }
        }
        
        // 4. Fetch and return the updated row
        const [rows] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [taskId]);
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating cutting task or project counts:', err);
        return res.status(500).json({ error: 'Failed to update cutting task' });
    }
});

// =========================================================
// DELETE /api/cutting-tasks/:id - Delete (Decrements total/completed_cutting)
// =========================================================
router.delete('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    
    let taskToDelete;

    try {
        // 1. Fetch the task's project number and status BEFORE deletion
        const [existingRows] = await pool.execute('SELECT project_no, status FROM cutting_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];
        
        // 2. Delete the task
        const [results] = await pool.execute('DELETE FROM cutting_tasks WHERE id = ?', [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 3. Update project counts: Decrement total_cutting
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        
        // 4. If the deleted task was 'completed', also decrement completed_cutting
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting cutting task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to delete cutting task' });
    }
});

module.exports = router;