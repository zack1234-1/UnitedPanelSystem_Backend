const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { updateProjectCounts } = require('./projectUpdater');
const multer = require('multer');
const auth = require('../middleware/auth');

const TASK_TYPE_PREFIX = 'door';

// Ensure door_task_items table exists
(async function ensureTaskItemsTable() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS door_task_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                inventory_id INT NOT NULL,
                quantity INT NOT NULL,
                FOREIGN KEY (task_id) REFERENCES door_tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (inventory_id) REFERENCES door_inventory(id) ON DELETE CASCADE,
                UNIQUE KEY (task_id, inventory_id)
            )
        `);
        console.log('✅ door_task_items table ready');
    } catch (err) {
        console.error('❌ Error creating door_task_items table:', err.message);
    }
})();

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

// ---------- Helpers ----------
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

// Fetch a single task with all details (uploaders, inventory items)
async function getTaskWithDetails(taskId) {
    const query = `
        SELECT dt.*,
               su.username AS signature_uploader_username,
               iu.username AS image_uploader_username,
               COUNT(dti.inventory_id) as total_inventory_items,
               COALESCE(SUM(dti.quantity), 0) as total_inventory_quantity,
               COALESCE(
                   JSON_ARRAYAGG(
                       JSON_OBJECT(
                           'inventory_id', dti.inventory_id,
                           'inventory_name', di.name,
                           'quantity', dti.quantity
                       )
                   ),
                   JSON_ARRAY()
               ) as inventory_items
        FROM door_tasks dt
        LEFT JOIN door_task_items dti ON dt.id = dti.task_id
        LEFT JOIN door_inventory di ON dti.inventory_id = di.id
        LEFT JOIN users su ON dt.signature_uploaded_by = su.id
        LEFT JOIN users iu ON dt.image_uploaded_by = iu.id
        WHERE dt.id = ?
        GROUP BY dt.id
    `;
    const [rows] = await pool.execute(query, [taskId]);
    if (rows.length === 0) return null;
    const task = rows[0];
    const formatted = formatTask(task);
    formatted.totalInventoryItems = task.total_inventory_items || 0;
    formatted.totalInventoryQuantity = task.total_inventory_quantity || 0;
    try {
        formatted.inventoryItems = JSON.parse(task.inventory_items);
    } catch {
        formatted.inventoryItems = [];
    }
    return formatted;
}

// Deduct inventory for a task's items
async function deductInventoryForTask(taskId) {
    const [items] = await pool.execute(
        'SELECT inventory_id, quantity FROM door_task_items WHERE task_id = ?',
        [taskId]
    );
    for (const item of items) {
        await pool.execute(
            'UPDATE door_inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
            [item.quantity, item.inventory_id, item.quantity]
        );
    }
}

// Restore inventory for a task's items
async function restoreInventoryForTask(taskId) {
    const [items] = await pool.execute(
        'SELECT inventory_id, quantity FROM door_task_items WHERE task_id = ?',
        [taskId]
    );
    for (const item of items) {
        await pool.execute(
            'UPDATE door_inventory SET quantity = quantity + ? WHERE id = ?',
            [item.quantity, item.inventory_id]
        );
    }
}

// Adjust inventory when task items change
async function adjustInventoryForTask(taskId, newItems) {
    const [existing] = await pool.execute(
        'SELECT inventory_id, quantity FROM door_task_items WHERE task_id = ?',
        [taskId]
    );
    const existingMap = {};
    existing.forEach(item => existingMap[item.inventory_id] = item.quantity);
    const newMap = {};
    newItems.forEach(item => newMap[item.inventory_id] = item.quantity);

    for (const invId in newMap) {
        if (!existingMap[invId]) {
            await pool.execute(
                'UPDATE door_inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                [newMap[invId], invId, newMap[invId]]
            );
        } else if (existingMap[invId] !== newMap[invId]) {
            const diff = newMap[invId] - existingMap[invId];
            if (diff > 0) {
                await pool.execute(
                    'UPDATE door_inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                    [diff, invId, diff]
                );
            } else if (diff < 0) {
                await pool.execute(
                    'UPDATE door_inventory SET quantity = quantity + ? WHERE id = ?',
                    [-diff, invId]
                );
            }
        }
    }
    for (const invId in existingMap) {
        if (!newMap[invId]) {
            await pool.execute(
                'UPDATE door_inventory SET quantity = quantity + ? WHERE id = ?',
                [existingMap[invId], invId]
            );
        }
    }
}

// =========================================================
// 🚚 Transportation Task Helpers
// =========================================================
const createOrUpdateTransportationTaskFromDoor = async (doorTask) => {
    console.log('🚀 Creating/updating transportation for door task:', doorTask.id, doorTask.title);
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM transportation_tasks WHERE door_task_id = ?',
            [doorTask.id]
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
                WHERE door_task_id = ?
            `;
            await pool.execute(updateSql, [
                doorTask.title,
                doorTask.description || null,
                doorTask.priority || 'empty',
                doorTask.projectNo || doorTask.project_no || null,
                doorTask.dueDate || doorTask.due_date || null,
                doorTask.id
            ]);
            console.log(`✅ Updated existing transportation task for door task ${doorTask.id}`);
        } else {
            const insertSql = `
                INSERT INTO transportation_tasks 
                (title, description, priority, status, project_no, approve_status, due_date, door_task_id, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            await pool.execute(insertSql, [
                doorTask.title,
                doorTask.description || null,
                doorTask.priority || 'empty',
                'pending',
                doorTask.projectNo || doorTask.project_no || null,
                'Approved',
                doorTask.dueDate || doorTask.due_date || null,
                doorTask.id
            ]);
            console.log(`✅ Created new transportation task for door task ${doorTask.id}`);
        }
    } catch (err) {
        console.error('❌ Failed to create/update transportation task for door:', err.message);
        console.error('Full error:', err);
    }
};

const updateTransportationTaskStatusForDoor = async (doorTaskId, newStatus) => {
    try {
        const updateSql = `
            UPDATE transportation_tasks 
            SET status = ? 
            WHERE door_task_id = ?
        `;
        const [result] = await pool.execute(updateSql, [newStatus, doorTaskId]);
        if (result.affectedRows > 0) {
            console.log(`✅ Transportation task status updated to '${newStatus}' for door task ${doorTaskId}`);
        } else {
            console.log(`ℹ️ No transportation task found for door task ${doorTaskId}`);
        }
    } catch (err) {
        console.error('Failed to update transportation task status for door:', err);
    }
};

// ---------- GET /api/door-tasks (with inventory items and uploaders) ----------
router.get('/', auth, async (req, res) => {
    const query = `
        SELECT dt.*,
               su.username AS signature_uploader_username,
               iu.username AS image_uploader_username,
               COUNT(dti.inventory_id) as total_inventory_items,
               COALESCE(SUM(dti.quantity), 0) as total_inventory_quantity,
               COALESCE(
                   JSON_ARRAYAGG(
                       JSON_OBJECT(
                           'inventory_id', dti.inventory_id,
                           'inventory_name', di.name,
                           'quantity', dti.quantity
                       )
                   ),
                   JSON_ARRAY()
               ) as inventory_items
        FROM door_tasks dt
        LEFT JOIN door_task_items dti ON dt.id = dti.task_id
        LEFT JOIN door_inventory di ON dti.inventory_id = di.id
        LEFT JOIN users su ON dt.signature_uploaded_by = su.id
        LEFT JOIN users iu ON dt.image_uploaded_by = iu.id
        WHERE dt.approve_status = 'Approved'
        GROUP BY dt.id
        ORDER BY dt.created_at DESC
    `;
    try {
        const [results] = await pool.execute(query);
        const tasks = results.map(task => {
            const formatted = formatTask(task);
            formatted.totalInventoryItems = task.total_inventory_items || 0;
            formatted.totalInventoryQuantity = task.total_inventory_quantity || 0;
            try {
                formatted.inventoryItems = JSON.parse(task.inventory_items);
            } catch {
                formatted.inventoryItems = [];
            }
            return formatted;
        });
        res.json(tasks);
    } catch (err) {
        console.error('Error fetching door tasks:', err);
        return res.status(500).json({ error: 'Failed to fetch door tasks' });
    }
});

// GET /api/door-tasks/:taskId/items
router.get('/:taskId/items', auth, async (req, res) => {
    const taskId = parseInt(req.params.taskId);
    try {
        const [rows] = await pool.execute(
            `SELECT ti.*, di.name as inventory_name 
             FROM door_task_items ti
             JOIN door_inventory di ON ti.inventory_id = di.id
             WHERE ti.task_id = ?`,
            [taskId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching task items:', err);
        res.status(500).json({ error: 'Failed to fetch task items' });
    }
});

// POST /api/door-tasks (create)
router.post('/', auth, async (req, res) => {
    const { title, description, priority, status, project_no, due_date, items } = req.body;
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!project_no || !project_no.trim()) {
        return res.status(400).json({ error: 'Project No is required' });
    }
    const sanitizedDescription = description === undefined || description === '' ? null : description;
    const sanitizedDueDate = due_date === undefined || due_date === '' ? null : due_date;
    const initialStatus = status || 'pending';
    const insertSql = `INSERT INTO door_tasks (title, description, priority, status, project_no, due_date, created_at) 
                       VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    try {
        const [insertResults] = await pool.execute(insertSql, [
            title, sanitizedDescription, priority, initialStatus, project_no, sanitizedDueDate
        ]);
        const taskId = insertResults.insertId;
        await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'total', 1);
        if (initialStatus.toLowerCase() === 'completed') {
            await updateProjectCounts(project_no, TASK_TYPE_PREFIX, 'completed', 1);
        }
        if (items && Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                const { inventory_id, quantity } = item;
                if (!inventory_id || !quantity || quantity <= 0) continue;
                await pool.execute(
                    'INSERT INTO door_task_items (task_id, inventory_id, quantity) VALUES (?, ?, ?)',
                    [taskId, inventory_id, quantity]
                );
                await pool.execute(
                    'UPDATE door_inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                    [quantity, inventory_id, quantity]
                );
            }
        }
        const createdTask = await getTaskWithDetails(taskId);
        if (!createdTask) {
            return res.status(500).json({ error: 'Task created but failed to fetch.' });
        }
        if (initialStatus.toLowerCase() === 'completed') {
            await createOrUpdateTransportationTaskFromDoor(createdTask);
        }
        res.status(201).json(createdTask);
    } catch (err) {
        console.error('Error creating door task:', err);
        return res.status(500).json({ error: 'Failed to create door task' });
    }
});

// PATCH /api/door-tasks/:id (UPDATED with clearImage/clearSignature)
router.patch('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    const updates = req.body;
    const { items, ...taskUpdates } = updates;

    if (Object.keys(taskUpdates).length === 0 && items === undefined && !updates.clearImage && !updates.clearSignature) {
        return res.status(400).json({ error: 'No fields to update.' });
    }

    let previousTask;
    try {
        const [existingRows] = await pool.execute(
            'SELECT project_no, status FROM door_tasks WHERE id = ?',
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

    // Build dynamic SET clause for text fields
    const allowedFields = ['title', 'description', 'priority', 'status', 'project_no', 'due_date'];
    const fieldsToUpdate = [];
    const updateValues = [];
    for (const field of allowedFields) {
        if (taskUpdates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`);
            const value = (taskUpdates[field] === '' && (field === 'description' || field === 'due_date'))
                            ? null : taskUpdates[field];
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

    if (fieldsToUpdate.length > 0) {
        const setClause = fieldsToUpdate.join(', ');
        const updateSql = `UPDATE door_tasks SET ${setClause} WHERE id = ?`;
        const finalBindValues = [...updateValues, taskId];
        await pool.execute(updateSql, finalBindValues);
    }

    // Update project counts if status changed
    if (taskUpdates.status) {
        const newStatus = taskUpdates.status.toLowerCase();
        const oldStatus = previousTask.status.toLowerCase();
        if (newStatus === 'completed' && oldStatus !== 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', 1);
        } else if (newStatus !== 'completed' && oldStatus === 'completed') {
            await updateProjectCounts(previousTask.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }
    }

    // Handle inventory items update (unchanged)
    if (items !== undefined) {
        if (items && Array.isArray(items) && items.length > 0) {
            await adjustInventoryForTask(taskId, items);
            await pool.execute('DELETE FROM door_task_items WHERE task_id = ?', [taskId]);
            for (const item of items) {
                const { inventory_id, quantity } = item;
                if (!inventory_id || !quantity || quantity <= 0) continue;
                await pool.execute(
                    'INSERT INTO door_task_items (task_id, inventory_id, quantity) VALUES (?, ?, ?)',
                    [taskId, inventory_id, quantity]
                );
            }
        } else {
            await restoreInventoryForTask(taskId);
            await pool.execute('DELETE FROM door_task_items WHERE task_id = ?', [taskId]);
        }
    }

    // --- Transportation Task Logic ---
    const updatedTask = await getTaskWithDetails(taskId);
    if (!updatedTask) {
        return res.status(404).json({ error: 'Task not found after update' });
    }

    const oldStatus = previousTask.status.toLowerCase();
    const newStatus = taskUpdates.status ? taskUpdates.status.toLowerCase() : oldStatus;

    if (oldStatus !== 'completed' && newStatus === 'completed') {
        await createOrUpdateTransportationTaskFromDoor(updatedTask);
    } else if (newStatus === 'on-hold' || (oldStatus === 'completed' && newStatus !== 'completed')) {
        await updateTransportationTaskStatusForDoor(taskId, 'on-hold');
    }

    res.json(updatedTask);
});

// POST /api/door-tasks/:id/media (record uploader)
router.post('/:id/media', auth, upload.fields([
    { name: 'signature', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    const taskId = parseInt(req.params.id);
    const userId = req.user.id;
    const files = req.files;
    if (!files || (!files.signature && !files.image)) {
        return res.status(400).json({ error: 'At least one file must be uploaded' });
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
        const updateSql = `UPDATE door_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        values.push(taskId);
        await pool.execute(updateSql, values);

        const updatedTask = await getTaskWithDetails(taskId);
        if (!updatedTask) {
            return res.status(500).json({ error: 'Task updated but failed to fetch.' });
        }
        res.json(updatedTask);
    } catch (err) {
        console.error('Error uploading media:', err);
        res.status(500).json({ error: 'Failed to upload media' });
    }
});

// =========================================================
// DELETE /api/door-tasks/:id
// =========================================================
router.delete('/:id', auth, async (req, res) => {
    const taskId = parseInt(req.params.id);
    let taskToDelete;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Get task details – includes project_id, project_no, status
        const [existingRows] = await connection.execute(
            'SELECT project_id, project_no, status FROM door_tasks WHERE id = ?',
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
            console.log(`🗑️ Deleted ${fileRows.length} file(s) linked to door task ${taskId}`);
        }

        // 3. Delete the task itself
        const [deleteResult] = await connection.execute(
            'DELETE FROM door_tasks WHERE id = ?',
            [taskId]
        );
        if (deleteResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found' });
        }

        // 4. Update project totals – using project_no (string) for now.
        await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'total', -1);
        // Door tasks use 'completed' as the done status.
        if (taskToDelete.status && taskToDelete.status.toLowerCase() === 'completed') {
            await updateProjectCounts(taskToDelete.project_no, TASK_TYPE_PREFIX, 'completed', -1);
        }

        await connection.commit();

        res.status(200).json({
            message: 'Door task and linked files deleted successfully',
            taskId,
            project_id: taskToDelete.project_id,
            project_no: taskToDelete.project_no,
            filesDeleted: fileRows.length
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`Error deleting door task:`, err);
        return res.status(500).json({ error: 'Failed to delete task and its files' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;