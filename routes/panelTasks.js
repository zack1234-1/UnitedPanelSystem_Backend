const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');

const TASK_TYPE_PREFIX = 'panel';

// Configure multer to use memory storage (for BLOB storage)
const upload = multer({
    storage: multer.memoryStorage(), // Store in memory as buffer
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
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

// Utility function to format database results for the API response
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
    
    // If signature exists, create a data URL
    if (task.signature_data && task.signature_mimetype) {
        const base64Signature = task.signature_data.toString('base64');
        result.signatureUrl = `data:${task.signature_mimetype};base64,${base64Signature}`;
    }
    
    // If image exists, create a data URL
    if (task.image_data && task.image_mimetype) {
        const base64Image = task.image_data.toString('base64');
        result.imageUrl = `data:${task.image_mimetype};base64,${base64Image}`;
    }
    
    return result;
};

// =========================================================
// GET /api/panel-tasks - Get all panel tasks
// =========================================================
router.get('/', async (req, res) => {
    console.log('GET /api/panel-tasks called');
    
    const query = `
        SELECT * FROM panel_tasks 
        WHERE approve_status = 'Approved' 
        ORDER BY created_at DESC
    `;
    
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching approved panel tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch approved panel tasks' });
    }
});

// =========================================================
// POST /api/panel-tasks - Create a new panel task
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

    const insertSql = `INSERT INTO panel_tasks(title, description, priority, status, project_no, due_date, created_at) 
                   VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    
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

// =========================================================
// POST /api/panel-tasks/:id/signature - Upload signature as BLOB
// =========================================================
router.post('/:id/signature', upload.single('signature'), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/signature called`);
    
    const taskId = parseInt(req.params.id);
    
    if (!req.file) {
        return res.status(400).json({ error: 'No signature file uploaded' });
    }
    
    // Get file buffer and mimetype
    const signatureData = req.file.buffer; // This is the BLOB data
    const signatureMimetype = req.file.mimetype;
    
    try {
        // Update the task with signature BLOB data
        const updateSql = `UPDATE panel_tasks 
                          SET signature_data = ?, signature_mimetype = ?, signature_date = NOW() 
                          WHERE id = ?`;
        
        await pool.execute(updateSql, [signatureData, signatureMimetype, taskId]);
        
        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error uploading signature:', err);
        return res.status(500).json({ error: 'Failed to upload signature' });
    }
});

// =========================================================
// DELETE /api/panel-tasks/:id/signature - Delete signature BLOB
// =========================================================
router.delete('/:id/signature', async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id}/signature called`);
    
    const taskId = parseInt(req.params.id);
    
    try {
        // Check if task exists
        const [existingRows] = await pool.execute(
            'SELECT id FROM panel_tasks WHERE id = ?', 
            [taskId]
        );
        
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        // Update the task to remove signature BLOB data
        const updateSql = `UPDATE panel_tasks 
                          SET signature_data = NULL, signature_mimetype = NULL, signature_date = NULL 
                          WHERE id = ?`;
        
        await pool.execute(updateSql, [taskId]);
        
        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error deleting signature:', err);
        return res.status(500).json({ error: 'Failed to delete signature' });
    }
});

// =========================================================
// POST /api/panel-tasks/:id/image - Upload image as BLOB
// =========================================================
router.post('/:id/image', upload.single('image'), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/image called`);
    
    const taskId = parseInt(req.params.id);
    
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }
    
    // Get file buffer and mimetype
    const imageData = req.file.buffer; // This is the BLOB data
    const imageMimetype = req.file.mimetype;
    
    try {
        // Update the task with image BLOB data
        const updateSql = `UPDATE panel_tasks 
                          SET image_data = ?, image_mimetype = ?, image_date = NOW() 
                          WHERE id = ?`;
        
        await pool.execute(updateSql, [imageData, imageMimetype, taskId]);
        
        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error uploading image:', err);
        return res.status(500).json({ error: 'Failed to upload image' });
    }
});

// =========================================================
// DELETE /api/panel-tasks/:id/image - Delete image BLOB
// =========================================================
router.delete('/:id/image', async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id}/image called`);
    
    const taskId = parseInt(req.params.id);
    
    try {
        // Check if task exists
        const [existingRows] = await pool.execute(
            'SELECT id FROM panel_tasks WHERE id = ?', 
            [taskId]
        );
        
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        // Update the task to remove image BLOB data
        const updateSql = `UPDATE panel_tasks 
                          SET image_data = NULL, image_mimetype = NULL, image_date = NULL 
                          WHERE id = ?`;
        
        await pool.execute(updateSql, [taskId]);
        
        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
        const [rows] = await pool.execute(selectSql, [taskId]);
        
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error deleting image:', err);
        return res.status(500).json({ error: 'Failed to delete image' });
    }
});

// =========================================================
// POST /api/panel-tasks/:id/media - Upload both signature and image in one request
// =========================================================
router.post('/:id/media', upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/media called`);

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

        const updateSql = `UPDATE panel_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);

        await pool.execute(updateSql, values);

        // Fetch and return the updated task
        const selectSql = 'SELECT * FROM panel_tasks WHERE id = ?';
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