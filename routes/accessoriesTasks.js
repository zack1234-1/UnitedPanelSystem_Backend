const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');
const auth = require('../middleware/auth');

const TASK_TYPE_PREFIX = 'accessories'; 

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

// ---------- Utility: formatTask with uploader info ----------
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

// =========================================================
// 🚚 Transportation Task Helpers
// =========================================================
const createOrUpdateTransportationTaskFromAccessories = async (accessoriesTask) => {
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM transportation_tasks WHERE accessories_task_id = ?',
            [accessoriesTask.id]
        );
        if (existing.length > 0) {
            await pool.execute(
                `UPDATE transportation_tasks 
                 SET status = 'pending',
                     title = ?,
                     description = ?,
                     priority = ?,
                     project_no = ?,
                     due_date = ?
                 WHERE accessories_task_id = ?`,
                [
                    accessoriesTask.title,
                    accessoriesTask.description || null,
                    accessoriesTask.priority || 'empty',
                    accessoriesTask.projectNo || accessoriesTask.project_no || null,
                    accessoriesTask.dueDate || accessoriesTask.due_date || null,
                    accessoriesTask.id
                ]
            );
            console.log(`✅ Updated transportation task for accessories task ${accessoriesTask.id}`);
        } else {
            await pool.execute(
                `INSERT INTO transportation_tasks 
                 (title, description, priority, status, project_no, approve_status, due_date, accessories_task_id, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    accessoriesTask.title,
                    accessoriesTask.description || null,
                    accessoriesTask.priority || 'empty',
                    'pending',
                    accessoriesTask.projectNo || accessoriesTask.project_no || null,
                    'Approved',
                    accessoriesTask.dueDate || accessoriesTask.due_date || null,
                    accessoriesTask.id
                ]
            );
            console.log(`✅ Created new transportation task for accessories task ${accessoriesTask.id}`);
        }
    } catch (err) {
        console.error('Failed to create/update transportation task for accessories:', err);
    }
};

const updateTransportationTaskStatusForAccessories = async (accessoriesTaskId, newStatus) => {
    try {
        const [result] = await pool.execute(
            'UPDATE transportation_tasks SET status = ? WHERE accessories_task_id = ?',
            [newStatus, accessoriesTaskId]
        );
        if (result.affectedRows > 0) {
            console.log(`✅ Transportation task status updated to '${newStatus}' for accessories task ${accessoriesTaskId}`);
        }
    } catch (err) {
        console.error('Failed to update transportation task status for accessories:', err);
    }
};

// =========================================================
// GET /api/accessories-tasks
// =========================================================
router.get('/', auth, async (req, res) => {
    const query = `
        SELECT at.*,
               su.username AS signature_uploader_username,
               iu.username AS image_uploader_username
        FROM accessories_tasks at
        LEFT JOIN users su ON at.signature_uploaded_by = su.id
        LEFT JOIN users iu ON at.image_uploaded_by = iu.id
        WHERE at.approve_status = 'Approved'
        ORDER BY at.created_at DESC
    `;
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatTask));
    } catch (err) {
        console.error('Error fetching approved accessories tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch approved accessories tasks' });
    }
});

// =========================================================
// POST /api/accessories-tasks
// =========================================================
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

    const insertSql = `INSERT INTO accessories_tasks (title, description, priority, status, project_no, due_date, created_at) 
                   VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    
    try {
        const [insertResults] = await pool.execute(insertSql, [
            title, 
            sanitizedDescription, 
            priority, 
            initialStatus, 
            project_no, 
            sanitizedDueDate 
        ]);

        const insertId = insertResults.insertId;
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        
        // Fetch the created task
        const [rows] = await pool.execute('SELECT * FROM accessories_tasks WHERE id = ?', [insertId]);
        if (rows.length === 0) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }

        // If created as completed, create/update transportation task
        if (initialStatus.toLowerCase() === 'completed') {
            await createOrUpdateTransportationTaskFromAccessories(rows[0]);
        }

        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating accessories task:', err);
        return res.status(500).json({ error: 'Failed to create accessories task' });
    }
});

// =========================================================
// PATCH /api/accessories-tasks/:id (UPDATED with clearImage/clearSignature)
// =========================================================
router.patch('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body required.' });
    }

    let previousTask;
    try {
        const [existingRows] = await pool.execute('SELECT project_no, status FROM accessories_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        previousTask = existingRows[0];
    } catch (err) {
        console.error('Error fetching existing task:', err);
        return res.status(500).json({ error: 'Database error before update' });
    }

    const oldStatus = previousTask.status.toLowerCase();
    const newStatus = updates.status ? updates.status.toLowerCase() : oldStatus;

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
    const updateSql = `UPDATE accessories_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        await pool.execute(updateSql, finalBindValues);
        
        // Update project counts if status changed
        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        // --- 🚚 Transportation Task Logic ---
        const [updatedTaskRows] = await pool.execute('SELECT * FROM accessories_tasks WHERE id = ?', [taskId]);
        if (updatedTaskRows.length === 0) {
            return res.status(404).json({ error: 'Task not found after update' });
        }
        const updatedTask = updatedTaskRows[0];

        if (oldStatus !== 'completed' && newStatus === 'completed') {
            await createOrUpdateTransportationTaskFromAccessories(updatedTask);
        } else if (newStatus === 'on-hold' || (oldStatus === 'completed' && newStatus !== 'completed')) {
            await updateTransportationTaskStatusForAccessories(taskId, 'on-hold');
        }

        // Fetch and return updated task with uploader info
        const [rows] = await pool.execute(
            `SELECT at.*,
                    su.username AS signature_uploader_username,
                    iu.username AS image_uploader_username
             FROM accessories_tasks at
             LEFT JOIN users su ON at.signature_uploaded_by = su.id
             LEFT JOIN users iu ON at.image_uploaded_by = iu.id
             WHERE at.id = ?`,
            [taskId]
        );
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating accessories task or handling transportation:', err);
        return res.status(500).json({ error: 'Failed to update accessories task' });
    }
});

// POST /api/accessories-tasks/:id/media (record uploader)
router.post('/:id/media', auth, upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/accessories-tasks/${req.params.id}/media called`);
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
        const updateSql = `UPDATE accessories_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);
        await pool.execute(updateSql, values);
        const selectSql = `
            SELECT at.*,
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM accessories_tasks at
            LEFT JOIN users su ON at.signature_uploaded_by = su.id
            LEFT JOIN users iu ON at.image_uploaded_by = iu.id
            WHERE at.id = ?
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

// DELETE /api/accessories-tasks/:id (now also deletes linked project_files)
router.delete('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    let taskToDelete;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Get task details - now also fetch project_id
        const [existingRows] = await connection.execute(
            'SELECT project_id, project_no, status FROM accessories_tasks WHERE id = ?',
            [taskId]
        );
        if (existingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];

        // Ensure project_id exists (sanity check)
        if (!taskToDelete.project_id) {
            await connection.rollback();
            return res.status(400).json({ error: 'Task has no associated project_id' });
        }

        // 2. Find and delete linked project_files
        const [fileRows] = await connection.execute(
            'SELECT id FROM project_files WHERE taskNo = ?',
            [taskId]
        );
        if (fileRows.length > 0) {
            const fileIds = fileRows.map(f => f.id);
            const placeholders = fileIds.map(() => '?').join(',');
            await connection.execute(
                `DELETE FROM project_files WHERE id IN (${placeholders})`,
                fileIds
            );
            console.log(`🗑️ Deleted ${fileRows.length} file(s) linked to task ${taskId}`);
        }

        // 3. Delete the task itself
        const [deleteResult] = await connection.execute(
            'DELETE FROM accessories_tasks WHERE id = ?',
            [taskId]
        );
        if (deleteResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }

        // 4. Update project totals
        // TODO: If updateProjectCounts is updated to accept project_id, use it here.
        // For now, we continue using project_no (string) as the key.
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        if (taskToDelete.status && taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        await connection.commit();

        // 5. Optionally log activity – you can include project_id in the log
        // await logActivity('DELETE', 'TASK', taskId, `Deleted accessories task ${taskId}`, { project_id: taskToDelete.project_id });

        res.status(200).json({
            message: 'Task and linked files deleted successfully',
            taskId,
            project_id: taskToDelete.project_id,
            project_no: taskToDelete.project_no,
            filesDeleted: fileRows.length
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting accessories task with files:', err);
        return res.status(500).json({ error: 'Failed to delete task and its files' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;