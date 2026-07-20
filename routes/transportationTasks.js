const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');
const auth = require('../middleware/auth');

const TASK_TYPE_PREFIX = 'transportation';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype) return cb(null, true);
        else cb(new Error('Only image files are allowed!'));
    }
});

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
        imageDate: task.image_date,
        signatureUploadedBy: task.signature_uploaded_by,
        imageUploadedBy: task.image_uploaded_by,
        signatureUploadedAt: task.signature_uploaded_at,
        imageUploadedAt: task.image_uploaded_at,
        signatureUploader: task.signature_uploader_username
            ? { id: task.signature_uploaded_by, username: task.signature_uploader_username }
            : null,
        imageUploader: task.image_uploader_username
            ? { id: task.image_uploaded_by, username: task.image_uploader_username }
            : null,
    };
    if (task.signature_data && task.signature_mimetype) {
        result.signatureUrl = `data:${task.signature_mimetype};base64,${task.signature_data.toString('base64')}`;
    }
    if (task.image_data && task.image_mimetype) {
        result.imageUrl = `data:${task.image_mimetype};base64,${task.image_data.toString('base64')}`;
    }
    return result;
};

// GET /api/transportation-tasks
router.get('/', auth, async (req, res) => {
    const query = `
        SELECT tt.*,
               su.username AS signature_uploader_username,
               iu.username AS image_uploader_username
        FROM transportation_tasks tt
        LEFT JOIN users su ON tt.signature_uploaded_by = su.id
        LEFT JOIN users iu ON tt.image_uploaded_by = iu.id
        WHERE tt.approve_status = 'Approved'
        ORDER BY tt.created_at DESC
    `;
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching approved transportation tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch approved transportation tasks' });
    }
});

// POST /api/transportation-tasks
router.post('/', auth, async (req, res) => {
    const { title, description, priority, status, project_no, due_date } = req.body;
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    const initialStatus = status || 'pending';
    const insertSql = `INSERT INTO transportation_tasks (title, description, priority, status, project_no, due_date, created_at) 
                       VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    try {
        const [insertResults] = await pool.execute(insertSql, [
            title, sanitizedDescription, priority, initialStatus, project_no, sanitizedDueDate
        ]);
        const insertId = insertResults.insertId;
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        const [rows] = await pool.execute('SELECT * FROM transportation_tasks WHERE id = ?', [insertId]);
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating transportation task:', err);
        return res.status(500).json({ error: 'Failed to create transportation task' });
    }
});

// PATCH /api/transportation-tasks/:id (UPDATED with clearImage/clearSignature)
router.patch('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }
    let previousTask;
    try {
        const [existingRows] = await pool.execute('SELECT project_no, status FROM transportation_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        previousTask = existingRows[0];
    } catch (err) {
        console.error('Error fetching existing task:', err);
        return res.status(500).json({ error: 'Database error before update' });
    }

    // Build dynamic SET clause for text fields
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

    // ------ Handle media clearing flags ------
    const clearImage = updates.clearImage === true;
    const clearSignature = updates.clearSignature === true;

    if (clearImage) {
        fieldsToUpdate.push('image_data = NULL, image_mimetype = NULL, image_date = NULL, image_uploaded_by = NULL, image_uploaded_at = NULL');
    }
    if (clearSignature) {
        fieldsToUpdate.push('signature_data = NULL, signature_mimetype = NULL, signature_date = NULL, signature_uploaded_by = NULL, signature_uploaded_at = NULL');
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE transportation_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        await pool.execute(updateSql, finalBindValues);

        const newStatus = updates.status ? updates.status.toLowerCase() : previousTask.status.toLowerCase();
        const oldStatus = previousTask.status.toLowerCase();

        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        // Fetch and return updated task with uploader info
        const [rows] = await pool.execute(
            `SELECT tt.*,
                    su.username AS signature_uploader_username,
                    iu.username AS image_uploader_username
             FROM transportation_tasks tt
             LEFT JOIN users su ON tt.signature_uploaded_by = su.id
             LEFT JOIN users iu ON tt.image_uploaded_by = iu.id
             WHERE tt.id = ?`,
            [taskId]
        );
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating transportation task:', err);
        return res.status(500).json({ error: 'Failed to update transportation task' });
    }
});

// DELETE /api/transportation-tasks/:id
router.delete('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    let taskToDelete;
    try {
        const [existingRows] = await pool.execute('SELECT project_no, status FROM transportation_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];
        const deleteSql = 'DELETE FROM transportation_tasks WHERE id = ?';
        const [results] = await pool.execute(deleteSql, [taskId]);
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
        res.status(200).json({ message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Error deleting transportation task:', err);
        return res.status(500).json({ error: 'Failed to delete transportation task' });
    }
});

// POST /api/transportation-tasks/:id/media (record uploader)
router.post('/:id/media', auth, upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/transportation-tasks/${req.params.id}/media called`);
    const taskId = parseInt(req.params.id);
    const userId = req.user.id;
    const files = req.files;
    if (!files || (!files.signature && !files.image)) {
        return res.status(400).json({ error: 'At least one file (signature or image) must be uploaded' });
    }
    try {
        const setClauses = [];
        const values = [];
        if (files.signature) {
            const sig = files.signature[0];
            setClauses.push('signature_data = ?, signature_mimetype = ?, signature_date = NOW(), signature_uploaded_by = ?, signature_uploaded_at = NOW()');
            values.push(sig.buffer, sig.mimetype, userId);
        }
        if (files.image) {
            const img = files.image[0];
            setClauses.push('image_data = ?, image_mimetype = ?, image_date = NOW(), image_uploaded_by = ?, image_uploaded_at = NOW()');
            values.push(img.buffer, img.mimetype, userId);
        }
        const updateSql = `UPDATE transportation_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);
        await pool.execute(updateSql, values);
        const selectSql = `
            SELECT tt.*,
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM transportation_tasks tt
            LEFT JOIN users su ON tt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON tt.image_uploaded_by = iu.id
            WHERE tt.id = ?
        `;
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