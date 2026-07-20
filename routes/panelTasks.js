const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');
const auth = require('../middleware/auth');

const TASK_TYPE_PREFIX = 'panel';

// Configure multer to use memory storage (for BLOB storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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

// =========================================================
// Utility: format task with uploader details
// =========================================================
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
        const base64Signature = task.signature_data.toString('base64');
        result.signatureUrl = `data:${task.signature_mimetype};base64,${base64Signature}`;
    }

    if (task.image_data && task.image_mimetype) {
        const base64Image = task.image_data.toString('base64');
        result.imageUrl = `data:${task.image_mimetype};base64,${base64Image}`;
    }

    return result;
};

// =========================================================
// 🔄 CASCADE HELPER – updates existing linked tasks with mapping
// =========================================================
/**
 * Cascade panel task status change to linked cutting task and its transportation.
 * Mapping:
 *   - panelStatus = 'cutting'  → cutting & transportation become 'pending'
 *   - other panelStatus        → cutting & transportation become 'on-hold'
 * Uses a transaction (connection must be provided).
 * @param {object} connection - database connection (from pool.getConnection())
 * @param {number} panelTaskId - ID of the panel task
 * @param {string} panelStatus - the new status of the panel task
 * @param {string} projectNo - for logging/debugging
 * @returns {Promise<object>} - info about updated tasks
 */
async function cascadePanelStatus(connection, panelTaskId, panelStatus, projectNo) {
    const result = { cuttingUpdated: false, transportationUpdated: false };

    // Determine the target status for cutting/transportation based on panel status
    let targetStatus;
    if (panelStatus.toLowerCase() === 'cutting') {
        targetStatus = 'pending';
    } else {
        targetStatus = 'on-hold';
    }

    // 1. Find the linked cutting task (if it exists)
    const [cuttingRows] = await connection.execute(
        'SELECT id FROM cutting_tasks WHERE panel_task_id = ?',
        [panelTaskId]
    );
    if (cuttingRows.length > 0) {
        const cuttingId = cuttingRows[0].id;
        // Update cutting task status to the mapped value
        await connection.execute(
            'UPDATE cutting_tasks SET status = ? WHERE id = ?',
            [targetStatus, cuttingId]
        );
        result.cuttingUpdated = true;

        // 2. Find the linked transportation task (via cutting_task_id)
        const [transportRows] = await connection.execute(
            'SELECT id FROM transportation_tasks WHERE cutting_task_id = ?',
            [cuttingId]
        );
        if (transportRows.length > 0) {
            const transportId = transportRows[0].id;
            // Update transportation task status to the same mapped value
            await connection.execute(
                'UPDATE transportation_tasks SET status = ? WHERE id = ?',
                [targetStatus, transportId]
            );
            result.transportationUpdated = true;
        }
    }

    console.log(
        `✅ Cascaded panel status '${panelStatus}' → cutting/transportation status '${targetStatus}' ` +
        `for panel task ${panelTaskId}, project ${projectNo}`
    );
    return result;
}

// =========================================================
// GET /api/panel-tasks - Get all approved panel tasks (with uploader info)
// =========================================================
router.get('/', auth, async (req, res) => {
    console.log('GET /api/panel-tasks called (authenticated)');

    const query = `
        SELECT 
            pt.*,
            su.username AS signature_uploader_username,
            iu.username AS image_uploader_username
        FROM panel_tasks pt
        LEFT JOIN users su ON pt.signature_uploaded_by = su.id
        LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
        WHERE pt.approve_status = 'Approved'
        ORDER BY pt.created_at DESC
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
// POST /api/panel-tasks - Create a new panel task (no cutting task created)
// =========================================================
router.post('/', auth, async (req, res) => {
    console.log('POST /api/panel-tasks called');

    const { title, description, priority, status, project_no, due_date } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }

    const sanitizedDescription = description?.trim() || null;
    const sanitizedPriority = priority || 'empty';
    const sanitizedStatus = status || 'pending';
    const sanitizedDueDate = due_date || null;

    const insertSql = `
        INSERT INTO panel_tasks 
        (title, description, priority, status, project_no, due_date, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;
    const bindValues = [
        title,
        sanitizedDescription,
        sanitizedPriority,
        sanitizedStatus,
        project_no,
        sanitizedDueDate
    ];

    try {
        const [insertResults] = await pool.execute(insertSql, bindValues);
        const insertId = insertResults.insertId;

        // Update total count
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);
        // If status is 'cutting', increment completed count (since 'cutting' is the "completed" state for panel)
        if (sanitizedStatus === 'cutting') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
            console.log(`✅ Incremented completed count for project ${project_no} (task created as cutting)`);
        }

        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
        const [rows] = await pool.execute(selectSql, [insertId]);
        res.status(201).json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error creating panel task:', err);
        return res.status(500).json({ error: 'Failed to create panel task' });
    }
});

// =========================================================
// PATCH /api/panel-tasks/:id - Update a panel task (with cascade, no creation)
// =========================================================
router.patch('/:id', auth, async (req, res) => {
    console.log(`PATCH /api/panel-tasks/${req.params.id} called`);
    const taskId = parseInt(req.params.id);
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Request body must contain fields to update.' });
    }

    // --- 1. Fetch current task before update ---
    let previousTask;
    try {
        const [existingRows] = await pool.execute('SELECT project_no, status FROM panel_tasks WHERE id = ?', [taskId]);
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

    console.log(`Status change: ${oldStatus} → ${newStatus}`);

    // --- 2. Update completed count only for 'cutting' status ---
    if (oldStatus !== 'cutting' && newStatus === 'cutting') {
        await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        console.log(`✅ Incremented completed for project ${previousTask.project_no}`);
    } else if (oldStatus === 'cutting' && newStatus !== 'cutting') {
        await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        console.log(`✅ Decremented completed for project ${previousTask.project_no}`);
    }

    // --- 3. Build and execute the update query for the panel task ---
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

    let connection;
    try {
        // Use a transaction for the cascade
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Update panel task
        await connection.execute(updateSql, finalBindValues);

        // --- 4. 🆕 CASCADE to cutting and transportation (only if status actually changed) ---
        if (oldStatus !== newStatus) {
            const cascadeResult = await cascadePanelStatus(connection, taskId, newStatus, previousTask.project_no);
            console.log('Cascade result:', cascadeResult);
        }

        await connection.commit();
        connection.release();

        // --- 5. Fetch and return updated task ---
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
        const [rows] = await pool.execute(selectSql, [taskId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found after update' });
        }

        res.json(formatTask(rows[0]));
    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error('Error updating task with cascade:', err);
        return res.status(500).json({ error: 'Failed to update task' });
    }
});
// =========================================================
// POST /api/panel-tasks/:id/signature - Upload signature (record uploader)
// =========================================================
router.post('/:id/signature', auth, upload.single('signature'), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/signature called`);
    const taskId = parseInt(req.params.id);
    const userId = req.user.id;

    if (!req.file) {
        return res.status(400).json({ error: 'No signature file uploaded' });
    }

    const signatureData = req.file.buffer;
    const signatureMimetype = req.file.mimetype;

    try {
        const updateSql = `
            UPDATE panel_tasks 
            SET signature_data = ?, 
                signature_mimetype = ?, 
                signature_date = NOW(),
                signature_uploaded_by = ?,
                signature_uploaded_at = NOW()
            WHERE id = ?
        `;
        await pool.execute(updateSql, [signatureData, signatureMimetype, userId, taskId]);

        // Fetch updated task with uploader info
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
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
// DELETE /api/panel-tasks/:id/signature - Delete signature (clear uploader)
// =========================================================
router.delete('/:id/signature', auth, async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id}/signature called`);
    const taskId = parseInt(req.params.id);

    try {
        const [existingRows] = await pool.execute('SELECT id FROM panel_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const updateSql = `
            UPDATE panel_tasks 
            SET signature_data = NULL, 
                signature_mimetype = NULL, 
                signature_date = NULL,
                signature_uploaded_by = NULL,
                signature_uploaded_at = NULL
            WHERE id = ?
        `;
        await pool.execute(updateSql, [taskId]);

        // Fetch updated task with uploader info
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
        const [rows] = await pool.execute(selectSql, [taskId]);
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error deleting signature:', err);
        return res.status(500).json({ error: 'Failed to delete signature' });
    }
});

// =========================================================
// POST /api/panel-tasks/:id/image - Upload image (record uploader)
// =========================================================
router.post('/:id/image', auth, upload.single('image'), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/image called`);
    const taskId = parseInt(req.params.id);
    const userId = req.user.id;

    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }

    const imageData = req.file.buffer;
    const imageMimetype = req.file.mimetype;

    try {
        const updateSql = `
            UPDATE panel_tasks 
            SET image_data = ?, 
                image_mimetype = ?, 
                image_date = NOW(),
                image_uploaded_by = ?,
                image_uploaded_at = NOW()
            WHERE id = ?
        `;
        await pool.execute(updateSql, [imageData, imageMimetype, userId, taskId]);

        // Fetch updated task with uploader info
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
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
// DELETE /api/panel-tasks/:id/image - Delete image (clear uploader)
// =========================================================
router.delete('/:id/image', auth, async (req, res) => {
    console.log(`DELETE /api/panel-tasks/${req.params.id}/image called`);
    const taskId = parseInt(req.params.id);

    try {
        const [existingRows] = await pool.execute('SELECT id FROM panel_tasks WHERE id = ?', [taskId]);
        if (existingRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const updateSql = `
            UPDATE panel_tasks 
            SET image_data = NULL, 
                image_mimetype = NULL, 
                image_date = NULL,
                image_uploaded_by = NULL,
                image_uploaded_at = NULL
            WHERE id = ?
        `;
        await pool.execute(updateSql, [taskId]);

        // Fetch updated task with uploader info
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
        `;
        const [rows] = await pool.execute(selectSql, [taskId]);
        res.json(formatTask(rows[0]));
    } catch (err) {
        console.error('Error deleting image:', err);
        return res.status(500).json({ error: 'Failed to delete image' });
    }
});

// =========================================================
// POST /api/panel-tasks/:id/media - Upload both signature & image (record uploaders)
// =========================================================
router.post('/:id/media', auth, upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    console.log(`POST /api/panel-tasks/${req.params.id}/media called`);
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
            const sigFile = files.signature[0];
            setClauses.push('signature_data = ?, signature_mimetype = ?, signature_date = NOW(), signature_uploaded_by = ?, signature_uploaded_at = NOW()');
            values.push(sigFile.buffer, sigFile.mimetype, userId);
        }

        if (files.image) {
            const imgFile = files.image[0];
            setClauses.push('image_data = ?, image_mimetype = ?, image_date = NOW(), image_uploaded_by = ?, image_uploaded_at = NOW()');
            values.push(imgFile.buffer, imgFile.mimetype, userId);
        }

        const updateSql = `UPDATE panel_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);
        await pool.execute(updateSql, values);

        // Fetch updated task with uploader info
        const selectSql = `
            SELECT pt.*, 
                   su.username AS signature_uploader_username,
                   iu.username AS image_uploader_username
            FROM panel_tasks pt
            LEFT JOIN users su ON pt.signature_uploaded_by = su.id
            LEFT JOIN users iu ON pt.image_uploaded_by = iu.id
            WHERE pt.id = ?
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
// DELETE /api/panel-tasks/:id - Delete panel task + linked files + panels + production records
// =========================================================
router.delete('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    let taskToDelete;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Get task details (project_no, status)
        const [existingRows] = await connection.execute(
            'SELECT project_no, status FROM panel_tasks WHERE id = ?',
            [taskId]
        );
        if (existingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }
        taskToDelete = existingRows[0];

        // 2. Delete all linked project_files
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
            console.log(`🗑️ Deleted ${fileRows.length} file(s) linked to panel task ${taskId}`);
        }

        // 3. Delete production records for all panels of this project
        const [prodDeleteResult] = await connection.execute(
            `DELETE pr FROM production_records pr
             JOIN panels p ON pr.panel_id = p.id
             WHERE p.job_no = ?`,
            [taskToDelete.project_no]
        );
        console.log(`🗑️ Deleted ${prodDeleteResult.affectedRows} production record(s) for project ${taskToDelete.project_no}`);

        // 4. Delete all panels belonging to this project
        const [panelDeleteResult] = await connection.execute(
            'DELETE FROM panels WHERE job_no = ?',
            [taskToDelete.project_no]
        );
        console.log(`🗑️ Deleted ${panelDeleteResult.affectedRows} panel(s) for project ${taskToDelete.project_no}`);

        // 5. Delete the panel task itself
        const [deleteResult] = await connection.execute(
            'DELETE FROM panel_tasks WHERE id = ?',
            [taskId]
        );
        if (deleteResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }

        // 6. Update project totals – panel uses 'cutting' as completed
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        if (taskToDelete.status.toLowerCase() === 'cutting') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        await connection.commit();

        res.status(200).json({
            message: 'Panel task, linked files, panels, and production records deleted successfully',
            taskId,
            project_no: taskToDelete.project_no,
            filesDeleted: fileRows.length,
            panelsDeleted: panelDeleteResult.affectedRows,
            productionRecordsDeleted: prodDeleteResult.affectedRows
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`Error deleting panel task:`, err);
        return res.status(500).json({ error: 'Failed to delete task, files, panels, and production records' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;