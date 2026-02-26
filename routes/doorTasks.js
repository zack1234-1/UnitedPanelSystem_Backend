const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer'); // <--- Import the update utility

// Define the specific task type for this router's database columns
const TASK_TYPE_PREFIX = 'door'; 

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    }
});

// Utility function (updated with project_no)
const formatTask = (task) => {
    const result = {
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        projectNo: task.project_no,
        dueDate: task.due_date,
        createdAt: task.created_at,
        signatureDate: task.signature_date,
        imageDate: task.image_date
    };
    if (task.signature_data && task.signature_mimetype) {
        result.signatureUrl = `data:${task.signature_mimetype};base64,${task.signature_data.toString('base64')}`;
    }
    if (task.image_data && task.image_mimetype) {
        result.imageUrl = `data:${task.image_mimetype};base64,${task.image_data.toString('base64')}`;
    }
    return result;
};

// =========================================================
// GET /api/door-tasks - Get all door tasks
// (No change needed here)
// =========================================================
router.get('/', async (req, res) => {
    // 🚨 FIX: The string value 'Approved' must be wrapped in single quotes within the SQL query.
    const query = `
        SELECT * FROM door_tasks 
        WHERE approve_status = 'Approved' 
        ORDER BY created_at DESC
    `;
    
    try {
        const [results] = await pool.execute(query);
        const tasks = results.map(formatTask);
        res.json(tasks);
    } catch (err) {
        console.error('Error fetching approved door tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch approved door tasks' });
    }
});

// =========================================================
// POST /api/door-tasks - Create (Increments total_door)
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

    const insertSql = `INSERT INTO door_tasks (title, description, priority, status, project_no, due_date) 
                       VALUES (?, ?, ?, ?, ?, ?)`;
    
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
        const insertId = insertResults.insertId;

        // 2. Update project counts: Increment total_door
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);

        // 3. If the task is created as 'completed', also increment completed_door
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        
        // 4. Fetch and return the newly created task
        const selectSql = 'SELECT * FROM door_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [insertId]);
        
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }
        
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating door task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to create door task' });
    }
});

// =========================================================
// PATCH /api/door-tasks/:id - Update (Handles status change)
// =========================================================
router.patch('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }

    let previousTask;

    try {
        // 1. Fetch the existing task status and project number BEFORE updating
        const [existingRows] = await pool.execute('SELECT project_no, status FROM door_tasks WHERE id = ?', [taskId]);
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
            
            // Convert empty string to null for description and due_date
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
        // 2. Execute the task update
        await pool.execute(updateSql, finalBindValues);
        
        // 3. Update project counts based on status change
        const newStatus = updates.status ? updates.status.toLowerCase() : previousTask.status.toLowerCase();
        const oldStatus = previousTask.status.toLowerCase();

        // Check for transition to 'completed' (+1 to completed_door)
        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } 
        // Check for transition away from 'completed' (-1 to completed_door)
        else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        // 4. Fetch and return the updated row
        const selectSql = 'SELECT * FROM door_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);

        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating door task or project counts:', err);
        return res.status(500).json({ error: 'Failed to update door task' });
    }
});

// =========================================================
// DELETE /api/door-tasks/:id - Delete (Decrements total/completed_door)
// =========================================================
router.delete('/:id', async (req, res) => {
    const taskId = parseInt(req.params.id);
    
    let taskToDelete;

    try {
        // 1. Fetch the task's project number and status BEFORE deletion
        const [existingRows] = await pool.execute('SELECT project_no, status FROM door_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];
        
        // 2. Delete the task
        const deleteSql = 'DELETE FROM door_tasks WHERE id = ?';
        const [results] = await pool.execute(deleteSql, [taskId]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 3. Update project counts: Decrement total_door
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        
        // 4. If the deleted task was 'completed', also decrement completed_door
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
        
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting door task or updating project counts:', err);
        return res.status(500).json({ error: 'Failed to delete door task' });
    }
});

// =========================================================
// POST /api/panel-tasks/:id/media - Upload both signature and image in one request
// =========================================================
router.post('/:id/media', upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/door_tasks/${req.params.id}/media called`);

    const taskId = parseInt(req.params.id);
    const files = req.files; // { signature?: [file], image?: [file] }

    // Ensure at least one file is provided
    if (!files || (!files.signature && !files.image)) {
        return res.status(400).json({ error: 'At least one file (signature or image) must be uploaded' });
    }

    try {
        // Dynamically build the SET clause and values based on which files are present
        const setClauses = [];
        const values = [];

        if (files.signature) {
            const signatureFile = files.signature[0];
            console.log('Signature file details:', {
                fieldname: signatureFile.fieldname,
                originalname: signatureFile.originalname,
                mimetype: signatureFile.mimetype,
                size: signatureFile.size,
            });
            setClauses.push('signature_data = ?, signature_mimetype = ?, signature_date = NOW()');
            values.push(signatureFile.buffer, signatureFile.mimetype);
        }

        if (files.image) {
            const imageFile = files.image[0];
            console.log('Image file details:', {
                fieldname: imageFile.fieldname,
                originalname: imageFile.originalname,
                mimetype: imageFile.mimetype,
                size: imageFile.size,
            });
            setClauses.push('image_data = ?, image_mimetype = ?, image_date = NOW()');
            values.push(imageFile.buffer, imageFile.mimetype);
        }

        const updateSql = `UPDATE door_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);

        await pool.execute(updateSql, values);

        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM door_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error uploading media:', err);
        return res.status(500).json({ error: 'Failed to upload media' });
    }
});


module.exports = router;