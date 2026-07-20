const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');
const auth = require('../middleware/auth');

const TASK_TYPE_PREFIX = 'cutting';

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
// Helper: Create or update transportation task
// =========================================================
const createOrUpdateTransportationTask = async (cuttingTask) => {
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM transportation_tasks WHERE cutting_task_id = ?',
            [cuttingTask.id]
        );

        if (existing.length > 0) {
            const updateSql = `
                UPDATE transportation_tasks 
                SET status = 'pending', 
                    title = ?, 
                    description = ?, 
                    priority = ?, 
                    project_no = ?, 
                    due_date = ?
                WHERE cutting_task_id = ?
            `;
            await pool.execute(updateSql, [
                cuttingTask.title,
                cuttingTask.description || null,
                cuttingTask.priority || 'empty',
                cuttingTask.project_no,
                cuttingTask.due_date || null,
                cuttingTask.id
            ]);
            console.log(`✅ Updated existing transportation task for cutting task ${cuttingTask.id} to 'pending'`);
        } else {
            const insertSql = `
                INSERT INTO transportation_tasks 
                (title, description, priority, status, project_no, approve_status, due_date, cutting_task_id, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            const values = [
                cuttingTask.title,
                cuttingTask.description || null,
                cuttingTask.priority || 'empty',
                'pending',
                cuttingTask.project_no,
                'Approved',
                cuttingTask.due_date || null,
                cuttingTask.id
            ];
            await pool.execute(insertSql, values);
            console.log(`✅ Created new transportation task for cutting task ${cuttingTask.id}`);
        }
    } catch (err) {
        console.error('Failed to create or update transportation task:', err);
    }
};

// =========================================================
// Helper: Update transportation task status (if exists)
// =========================================================
const updateTransportationTaskStatus = async (cuttingTaskId, newStatus) => {
    try {
        const updateSql = `
            UPDATE transportation_tasks 
            SET status = ? 
            WHERE cutting_task_id = ?
        `;
        const [result] = await pool.execute(updateSql, [newStatus, cuttingTaskId]);
        if (result.affectedRows > 0) {
            console.log(`✅ Transportation task status updated to '${newStatus}' for cutting task ${cuttingTaskId}`);
        } else {
            console.log(`ℹ️ No transportation task found for cutting task ${cuttingTaskId}`);
        }
    } catch (err) {
        console.error('Failed to update transportation task status:', err);
    }
};

// =========================================================
// GET /api/cutting-tasks (with uploader info)
// =========================================================
router.get('/', auth, async (req, res) => {
    const query = `
        SELECT ct.*,
               su.username AS signature_uploader_username,
               iu.username AS image_uploader_username
        FROM cutting_tasks ct
        LEFT JOIN users su ON ct.signature_uploaded_by = su.id
        LEFT JOIN users iu ON ct.image_uploaded_by = iu.id
        WHERE ct.approve_status = 'Approved'
        ORDER BY ct.created_at DESC
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
// POST /api/cutting-tasks - Create or Update (if panel_task_id exists)
// =========================================================
router.post('/', auth, async (req, res) => {
    const { 
        title, 
        description, 
        priority, 
        status, 
        project_no, 
        due_date, 
        approve_status,
        panel_task_id
    } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    const sanitizedPanelTaskId = panel_task_id ? parseInt(panel_task_id) : null;
    const initialStatus = status || 'pending';

    // --- Check if a cutting task already exists for this panel_task_id ---
    let existingTask = null;
    if (sanitizedPanelTaskId) {
        const [rows] = await pool.execute(
            'SELECT * FROM cutting_tasks WHERE panel_task_id = ?',
            [sanitizedPanelTaskId]
        );
        if (rows.length > 0) {
            existingTask = rows[0];
        }
    }

    if (existingTask) {
        // --- UPDATE existing task ---
        const oldStatus = existingTask.status.toLowerCase();
        const newStatus = initialStatus.toLowerCase();

        // Build dynamic SET clause
        const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date', 'approve_status'];
        const fieldsToUpdate = [];
        const updateValues = [];
        for (const field of allowedFields) {
            let value = req.body[field];
            if (value !== undefined) {
                if ((field === 'description' || field === 'due_date') && value === '') value = null;
                fieldsToUpdate.push(`${field} = ?`);
                updateValues.push(value);
            }
        }
        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ error: 'No fields to update.' });
        }

        const setClause = fieldsToUpdate.join(', ');
        const updateSql = `UPDATE cutting_tasks SET ${setClause} WHERE id = ?`;
        const finalBindValues = [...updateValues, existingTask.id];

        try {
            await pool.execute(updateSql, finalBindValues);

            // --- Update project counts (total remains the same; adjust completed if status changed) ---
            if (newStatus === 'completed' && oldStatus !== 'completed') {
                await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
            } else if (newStatus !== 'completed' && oldStatus === 'completed') {
                await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', -1);
            }

            // --- Transportation task logic ---
            if (oldStatus !== 'completed' && newStatus === 'completed') {
                // Fetch the updated task to pass to helper
                const [updatedTask] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [existingTask.id]);
                if (updatedTask.length > 0) {
                    await createOrUpdateTransportationTask(updatedTask[0]);
                }
            } else if (newStatus === 'on-hold' || (oldStatus === 'completed' && newStatus !== 'completed')) {
                await updateTransportationTaskStatus(existingTask.id, 'on-hold');
            }

            // Fetch and return the updated task with uploader info
            const [rows] = await pool.execute(
                `SELECT ct.*,
                        su.username AS signature_uploader_username,
                        iu.username AS image_uploader_username
                 FROM cutting_tasks ct
                 LEFT JOIN users su ON ct.signature_uploaded_by = su.id
                 LEFT JOIN users iu ON ct.image_uploaded_by = iu.id
                 WHERE ct.id = ?`,
                [existingTask.id]
            );
            res.status(200).json(formatTask(rows[0])); // 200 OK for update
        } catch (err) {
            console.error('Error updating cutting task (via panel_task_id):', err);
            return res.status(500).json({ error: 'Failed to update cutting task' });
        }
    } else {
        // --- CREATE new task ---
        const insertSql = `
            INSERT INTO cutting_tasks 
            (title, description, priority, status, project_no, due_date, approve_status, panel_task_id, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        try {
            const [insertResults] = await pool.execute(insertSql, [
                title,
                description ?? null,
                priority ?? null,
                initialStatus,
                project_no,
                due_date ?? null,
                approve_status ?? 'Pending',
                sanitizedPanelTaskId
            ]);

            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);
            if (initialStatus.toLowerCase() === 'completed') {
                await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
            }

            // If created as completed, create transportation task
            if (initialStatus.toLowerCase() === 'completed') {
                const [newTask] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [insertResults.insertId]);
                if (newTask.length > 0) {
                    await createOrUpdateTransportationTask(newTask[0]);
                }
            }

            const [rows] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [insertResults.insertId]);
            res.status(201).json(formatTask(rows[0]));
        } catch (err) {
            console.error('Error creating cutting task:', err);
            return res.status(500).json({ error: 'Failed to create cutting task' });
        }
    }
});

// =========================================================
// PATCH /api/cutting-tasks/:id - Update (with media clear flags)
// =========================================================
router.patch('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body required.' });
    }

    // Fetch previous task to get project_no and status for counts
    let previousTask;
    try {
        const [existingRows] = await pool.execute(
            'SELECT project_no, status, title, description, priority, due_date FROM cutting_tasks WHERE id = ?',
            [taskId]
        );
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

    // ------ Allowed text fields ------
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
        // no values needed for these (they are constants)
    }
    if (clearSignature) {
        fieldsToUpdate.push('signature_data = NULL, signature_mimetype = NULL, signature_date = NULL, signature_uploaded_by = NULL, signature_uploaded_at = NULL');
    }

    // If no fields to update and no clear flags, return error
    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE cutting_tasks SET ${setClause} WHERE id = ?`;
    const finalBindValues = [...updateValues, taskId];

    try {
        await pool.execute(updateSql, finalBindValues);

        // --- Project counts ---
        const oldProjectNo = previousTask.project_no;
        const newProjectNo = updates.project_no || oldProjectNo;
        if (oldProjectNo !== newProjectNo) {
            await updateProjectCounts(oldProjectNo, TASK_TYPE_PREFIX, 'total', -1);
            if (oldStatus === 'completed') {
                await updateProjectCounts(oldProjectNo, TASK_TYPE_PREFIX, 'completed', -1);
            }
            await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'total', 1);
            if (newStatus === 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', 1);
            }
        } else {
            if (newStatus === 'completed' && oldStatus !== 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', 1);
            } else if (newStatus !== 'completed' && oldStatus === 'completed') {
                await updateProjectCounts(newProjectNo, TASK_TYPE_PREFIX, 'completed', -1);
            }
        }

        // --- Transportation task logic ---
        if (oldStatus !== 'completed' && newStatus === 'completed') {
            const [updatedTask] = await pool.execute('SELECT * FROM cutting_tasks WHERE id = ?', [taskId]);
            if (updatedTask.length > 0) {
                await createOrUpdateTransportationTask(updatedTask[0]);
            }
        } else if (newStatus === 'on-hold' || (oldStatus === 'completed' && newStatus !== 'completed')) {
            await updateTransportationTaskStatus(taskId, 'on-hold');
        }

        // Fetch and return the updated task with uploader info
        const [rows] = await pool.execute(
            `SELECT ct.*,
                    su.username AS signature_uploader_username,
                    iu.username AS image_uploader_username
             FROM cutting_tasks ct
             LEFT JOIN users su ON ct.signature_uploaded_by = su.id
             LEFT JOIN users iu ON ct.image_uploaded_by = iu.id
             WHERE ct.id = ?`,
            [taskId]
        );
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error updating cutting task or handling transportation:', err);
        return res.status(500).json({ error: 'Failed to update cutting task' });
    }
});

// =========================================================
// POST /api/cutting-tasks/:id/media - Upload media (record uploader)
// =========================================================
router.post('/:id/media', auth, upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/cutting-tasks/${req.params.id}/media called`);
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
        const updateSql = `UPDATE cutting_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);
        await pool.execute(updateSql, values);
        const selectSql = `
            SELECT ct.*,
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM cutting_tasks ct
            LEFT JOIN users su ON ct.signature_uploaded_by = su.id
            LEFT JOIN users iu ON ct.image_uploaded_by = iu.id
            WHERE ct.id = ?
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

// =========================================================
// DELETE /api/cutting-tasks/:id - Delete task + linked files
// =========================================================
router.delete('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    let taskToDelete;
    let connection;

    try {
        // Acquire a connection and start transaction
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Get task details (project_no, status)
        const [existingRows] = await connection.execute(
            'SELECT project_no, status FROM cutting_tasks WHERE id = ?',
            [taskId]
        );
        if (existingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];

        // 2. Find and delete all linked project_files
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
            console.log(`🗑️ Deleted ${fileRows.length} file(s) linked to cutting task ${taskId}`);
        }

        // 3. Delete the cutting task
        const [deleteResult] = await connection.execute(
            'DELETE FROM cutting_tasks WHERE id = ?',
            [taskId]
        );
        if (deleteResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }

        // 4. Update project totals (total and completed)
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        if (taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        await connection.commit();

        res.status(200).json({
            message: 'Cutting task and linked files deleted successfully',
            taskId,
            filesDeleted: fileRows.length
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting cutting task with files:', err);
        return res.status(500).json({ error: 'Failed to delete task and its files' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;