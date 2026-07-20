const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const multer = require('multer');
const path = require('path');

// =========================================================
// 📝 ACTIVITY LOGGING HELPER (unchanged)
// =========================================================

async function logActivity(activityType, resourceType, resourceId, message, details = {}) {
    const userId = 1; // ⚠️ Replace with actual authenticated user ID
    try {
        const query = `
            INSERT INTO activity_logs 
            (timestamp, user_id, activity_type, resource_type, resource_id, message, details) 
            VALUES (NOW(), ?, ?, ?, ?, ?, ?)
        `;
        const detailsJson = JSON.stringify(details);
        await db.query(query, [userId, activityType, resourceType, resourceId, message, detailsJson]);
    } catch (err) {
        console.error('CRITICAL: Activity logging failed:', err);
    }
}

// =========================================================
// 🔄 CASCADE HELPERS (LINKED TRANSPORTATION ONLY) – NOW USE project_id
// =========================================================

/**
 * Update transportation tasks linked to tasks of a specific category.
 * @param {object} connection - DB connection
 * @param {number} projectId - Numeric project ID
 * @param {string} category - 'cutting', 'door', 'strip_curtain', 'accessories', 'system', 'quotation' (NOT 'panel')
 * @param {string} status - New status
 * @param {number[]} [taskIds] - Optional list of specific task IDs; if omitted, update all for the project.
 * @returns {Promise<{affected: number}>}
 */
async function updateTransportationForCategory(connection, projectId, category, status, taskIds) {
    const columnMap = {
        cutting: 'cutting_task_id',
        door: 'door_task_id',
        strip_curtain: 'strip_curtain_task_id',
        accessories: 'accessories_task_id',
        system: 'system_task_id',
        quotation: 'quotation_task_id'
    };
    const column = columnMap[category];
    if (!column) return { affected: 0 };

    let query, params;
    if (taskIds && taskIds.length > 0) {
        const placeholders = taskIds.map(() => '?').join(',');
        query = `UPDATE transportation_tasks SET status = ? WHERE ${column} IN (${placeholders})`;
        params = [status, ...taskIds];
    } else {
        const tableMap = {
            cutting: 'cutting_tasks',
            door: 'door_tasks',
            strip_curtain: 'strip_curtain_tasks',
            accessories: 'accessories_tasks',
            system: 'system_tasks',
            quotation: 'quotation_tasks'
        };
        const table = tableMap[category];
        if (!table) return { affected: 0 };

        // JOIN on project_id instead of project_no
        query = `
            UPDATE transportation_tasks t
            JOIN ${table} ct ON t.${column} = ct.id
            SET t.status = ?
            WHERE ct.project_id = ?
        `;
        params = [status, projectId];
    }
    const [result] = await connection.query(query, params);
    return { affected: result.affectedRows };
}

/**
 * Cascade status changes to dependent categories and their transportation links.
 * @param {object} connection - DB connection
 * @param {number} projectId
 * @param {string} triggeringCategory - The category being toggled
 * @param {string} status - New status
 * @param {number[]} [taskIds] - IDs of the specific task(s) being toggled (for single task: [id]; for bulk: null)
 * @returns {Promise<object>} - Counts of updated tasks per category
 */
async function cascadeStatusToDependents(connection, projectId, triggeringCategory, status, taskIds) {
    const updates = {};

    // 1. If the triggered category is NOT 'panel', update its linked transportation
    if (triggeringCategory !== 'panel') {
        const transportResult = await updateTransportationForCategory(connection, projectId, triggeringCategory, status, taskIds);
        updates.transportation = transportResult.affected;
    }

    // 2. If triggered category is 'panel', update cutting tasks and their transportation
    if (triggeringCategory === 'panel') {
        let targetStatus = status;
        let cuttingIds = [];

        if (taskIds && taskIds.length > 0) {
            // Find cutting tasks linked to these panel tasks
            const placeholders = taskIds.map(() => '?').join(',');
            const [rows] = await connection.query(
                `SELECT id FROM cutting_tasks WHERE panel_task_id IN (${placeholders}) AND project_id = ?`,
                [...taskIds, projectId]
            );
            cuttingIds = rows.map(r => r.id);
        } else {
            // Update all cutting tasks for the project
            const [rows] = await connection.query(
                `SELECT id FROM cutting_tasks WHERE project_id = ?`,
                [projectId]
            );
            cuttingIds = rows.map(r => r.id);
        }

        if (cuttingIds.length > 0) {
            const placeholders = cuttingIds.map(() => '?').join(',');
            const [cuttingResult] = await connection.query(
                `UPDATE cutting_tasks SET status = ? WHERE id IN (${placeholders})`,
                [targetStatus, ...cuttingIds]
            );
            updates.cutting = cuttingResult.affectedRows;

            const transportCutting = await updateTransportationForCategory(connection, projectId, 'cutting', targetStatus, cuttingIds);
            updates.transportation_cutting = transportCutting.affected;
        } else {
            updates.cutting = 0;
            updates.transportation_cutting = 0;
        }
    }

    return updates;
}

// =========================================================
// MULTER CONFIGURATION (Memory Storage for BLOBs)
// =========================================================

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// =========================================================
// 🗑️ FILE DELETION HELPERS (now by project_id, but still keep projectNo for logging)
// =========================================================

async function deleteAllProjectFiles(projectId) {
    await db.query('DELETE FROM project_files WHERE project_id = ?', [projectId]);
    console.log(`Cleaned up all BLOB file records for project ID ${projectId}.`);
}

// =========================================================
// 📊 PROJECT COMPLETION CALCULATION – uses project_id
// =========================================================

async function calculateCompletionPercentage(projectId) {
    try {
        const completion = {
            panelSlab: { completed: 0, total: 0, percentage: 0 },
            cutting: { completed: 0, total: 0, percentage: 0 },
            door: { completed: 0, total: 0, percentage: 0 },
            stripCurtain: { completed: 0, total: 0, percentage: 0 },
            accessories: { completed: 0, total: 0, percentage: 0 },
            system: { completed: 0, total: 0, percentage: 0 }
        };

        const taskTypes = [
            { table: 'panel_tasks', key: 'panelSlab' },
            { table: 'cutting_tasks', key: 'cutting' },
            { table: 'door_tasks', key: 'door' },
            { table: 'strip_curtain_tasks', key: 'stripCurtain' },
            { table: 'accessories_tasks', key: 'accessories' },
            { table: 'system_tasks', key: 'system' }
        ];

        for (const taskType of taskTypes) {
            const [results] = await db.query(
                `SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'Completed' OR status = 'Done' THEN 1 ELSE 0 END) as completed
                FROM ${taskType.table} 
                WHERE project_id = ?`,
                [projectId]
            );

            if (results[0]) {
                completion[taskType.key].total = results[0].total || 0;
                completion[taskType.key].completed = results[0].completed || 0;
                completion[taskType.key].percentage = results[0].total > 0
                    ? Math.round((results[0].completed / results[0].total) * 100)
                    : 0;
            }
        }

        return completion;
    } catch (error) {
        console.error('Error calculating completion:', error);
        throw error;
    }
}

// =========================================================
// 📂 FILE ROUTES (MANAGEMENT) – adjusted to use project_id internally
// =========================================================

router.get('/status/:status', async (req, res) => {
    const { status } = req.params;

    try {
        const [columns] = await db.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);

        let query;
        let params = [];

        if (status === 'active') {
            query = "SELECT * FROM projects WHERE status = 'Active' ORDER BY created_at DESC, id DESC";
        } else if (status === 'done') {
            query = "SELECT * FROM projects WHERE status = 'Done' ORDER BY created_at DESC, id DESC";
        } else if (status === 'approved') {
            query = "SELECT * FROM projects WHERE status = 'Approved' ORDER BY created_at DESC, id DESC";
        } else {
            return res.json([]);
        }

        const [projects] = await db.query(query, params);

        // Calculate completion using each project's id
        const projectsWithCompletion = await Promise.all(
            projects.map(async (project) => {
                const completion = await calculateCompletionPercentage(project.id);
                return { ...project, completion };
            })
        );

        res.json(projectsWithCompletion);
    } catch (err) {
        console.error('Error fetching projects by status:', err);
        res.status(500).json({
            error: 'Failed to retrieve projects by status.',
            details: err.message
        });
    }
});

// Keep endpoints that accept projectNo for backward compatibility
// Internally fetch project_id and use it in queries

router.get('/:projectNo/files', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        // Get project id
        const [project] = await db.query('SELECT id FROM projects WHERE projectNo = ?', [projectNo]);
        if (project.length === 0) {
            return res.status(404).json({ success: false, error: 'Project not found.' });
        }
        const projectId = project[0].id;

        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
            FROM project_files 
            WHERE project_id = ?
        `;
        const params = [projectId];

        if (category && category !== 'all') {
            query += ' AND category = ?';
            params.push(category);
        }

        const [files] = await db.query(query, params);

        res.json({
            success: true,
            count: files.length,
            files: files
        });

    } catch (err) {
        console.error('Error fetching files:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve files from database.',
            details: err.message
        });
    }
});

router.get('/files/:projectNo', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        const [project] = await db.query('SELECT id FROM projects WHERE projectNo = ?', [projectNo]);
        if (project.length === 0) {
            return res.status(404).json({ success: false, error: 'Project not found.' });
        }
        const projectId = project[0].id;

        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
            FROM project_files 
            WHERE project_id = ?
        `;
        const params = [projectId];

        if (category && category !== 'all') {
            query += ' AND category = ?';
            params.push(category);
        }

        const [files] = await db.query(query, params);

        res.json(files);

    } catch (err) {
        console.error('Error fetching files:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve files from database.',
            details: err.message
        });
    }
});

// Mapping for task tables – used in file replacement and deletion
const taskTableMap = {
    panel: 'panel_tasks',
    cutting: 'cutting_tasks',
    door: 'door_tasks',
    strip_curtain: 'strip_curtain_tasks',
    accessories: 'accessories_tasks',
    system: 'system_tasks',
    transportation: 'transportation_tasks',
    quotation: 'quotation_tasks'
};

router.put('/file/:id/replace', upload.single('file'), async (req, res) => {
    const fileId = req.params.id;
    const newFile = req.file;

    if (!newFile) {
        return res.status(400).json({ error: 'No new file provided.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Get existing file info (includes project_id)
        const [existing] = await connection.query(
            'SELECT project_id, category, taskNo, file_name FROM project_files WHERE id = ?',
            [fileId]
        );
        if (existing.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'File not found.' });
        }

        const { project_id, category, taskNo, file_name: oldName } = existing[0];
        const newFileName = newFile.originalname || oldName;

        // 2. Update file record
        await connection.query(
            `UPDATE project_files 
             SET file_data = ?, file_size = ?, mime_type = ?, file_name = ?
             WHERE id = ?`,
            [newFile.buffer, newFile.size, newFile.mimetype, newFileName, fileId]
        );

        // 3. Update linked task title if exists
        if (taskNo && category) {
            const taskTable = taskTableMap[category];
            if (taskTable) {
                const newTitle = `${category.charAt(0).toUpperCase() + category.slice(1)} Task: ${newFileName}`;
                await connection.query(
                    `UPDATE ${taskTable} SET title = ? WHERE id = ?`,
                    [newTitle, taskNo]
                );
            }
        }

        await connection.commit();

        // 4. Fetch and return the updated file record
        const [updated] = await connection.query(
            `SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
             FROM project_files WHERE id = ?`,
            [fileId]
        );

        res.json(updated[0]);

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error replacing file:', err);
        res.status(500).json({ error: 'Failed to replace file.', details: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// =========================================================
// ⏸️ TOGGLE ALL TASKS IN A CATEGORY – now uses project_id
// =========================================================
router.patch('/tasks/category/:category/status', async (req, res) => {
    const { category } = req.params;
    const { projectNo, status } = req.query;

    if (!projectNo || !status) {
        return res.status(400).json({ error: 'projectNo and status are required.' });
    }

    const tableMap = {
        panel: 'panel_tasks',
        cutting: 'cutting_tasks',
        door: 'door_tasks',
        strip_curtain: 'strip_curtain_tasks',
        accessories: 'accessories_tasks',
        system: 'system_tasks',
        transportation: 'transportation_tasks',
        quotation: 'quotation_tasks'
    };

    const table = tableMap[category];
    if (!table) {
        return res.status(400).json({ error: 'Invalid category.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Get project id from projectNo
        const [project] = await connection.query('SELECT id FROM projects WHERE projectNo = ?', [projectNo]);
        if (project.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Project not found.' });
        }
        const projectId = project[0].id;

        // 1. Update all tasks in this category for the project
        const [result] = await connection.query(
            `UPDATE ${table} SET status = ? WHERE project_id = ?`,
            [status, projectId]
        );

        // 2. Update all panels for this project to the same status
        const panelsUpdated = await updatePanelsStatusForProject(connection, projectId, status);

        // 3. Cascade to dependents – no specific task IDs, will update all linked transportation via JOIN
        const cascadeUpdates = await cascadeStatusToDependents(connection, projectId, category, status, null);

        await connection.commit();

        await logActivity(
            'UPDATE',
            'TASK',
            projectId,
            `Set all ${category} tasks to '${status}' for project ${projectNo} (ID: ${projectId}). Panels: ${panelsUpdated} updated. Cascaded: ${JSON.stringify(cascadeUpdates)}.`,
            { category, status, affectedRows: result.affectedRows, panelsUpdated, cascadeUpdates }
        );

        res.json({
            message: `Updated ${result.affectedRows} task(s) in ${category} to '${status}'. ${panelsUpdated} panel(s) updated.`,
            affectedRows: result.affectedRows,
            panelsUpdated,
            cascadeUpdates
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating tasks status:', err);
        res.status(500).json({ error: 'Failed to update tasks status.', details: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// =========================================================
// ⏸️ TOGGLE SINGLE TASK STATUS – now uses project_id
// =========================================================
router.patch('/tasks/:taskId/status', async (req, res) => {
    const { taskId } = req.params;
    const { category } = req.query;
    const { status } = req.body;

    if (!category || !status) {
        return res.status(400).json({ error: 'category and status are required.' });
    }

    const tableMap = {
        panel: 'panel_tasks',
        cutting: 'cutting_tasks',
        door: 'door_tasks',
        strip_curtain: 'strip_curtain_tasks',
        accessories: 'accessories_tasks',
        system: 'system_tasks',
        transportation: 'transportation_tasks',
        quotation: 'quotation_tasks'
    };

    const table = tableMap[category];
    if (!table) {
        return res.status(400).json({ error: 'Invalid category.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Get the project_id for this task (and also projectNo for logging)
        const [taskRows] = await connection.query(
            `SELECT project_id, project_no FROM ${table} WHERE id = ?`,
            [taskId]
        );
        if (taskRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found.' });
        }
        const projectId = taskRows[0].project_id;
        const projectNo = taskRows[0].project_no;

        // 2. Update the task status
        const [result] = await connection.query(
            `UPDATE ${table} SET status = ? WHERE id = ?`,
            [status, taskId]
        );
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Task not found.' });
        }

        // 3. Update all panels for this project to the same status
        const panelsUpdated = await updatePanelsStatusForProject(connection, projectId, status);

        // 4. Cascade to dependents – pass the specific task ID so only linked transportation is updated
        const cascadeUpdates = await cascadeStatusToDependents(connection, projectId, category, status, [parseInt(taskId)]);

        await connection.commit();

        await logActivity(
            'UPDATE',
            'TASK',
            taskId,
            `Task status updated to '${status}' (category: ${category}, project: ${projectNo}). Panels: ${panelsUpdated} updated. Cascaded: ${JSON.stringify(cascadeUpdates)}.`,
            { category, status, taskId, panelsUpdated, cascadeUpdates }
        );

        res.json({
            success: true,
            taskId,
            status,
            panelsUpdated,
            cascadeUpdates,
            message: `Task updated. ${panelsUpdated} panel(s) set to '${status}'.`
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating task status:', err);
        res.status(500).json({ error: 'Failed to update task status.', details: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// =========================================================
// 📤 UPLOAD FILES – now uses project_id
// =========================================================
router.post('/upload', upload.array('files'), async (req, res) => {
    const { projectNo, category } = req.body;
    const uploadedFiles = req.files;

    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ error: "No files selected for upload." });
    }

    const taskTableMap = {
        'panel': 'panel_tasks',
        'cutting': 'cutting_tasks',
        'door': 'door_tasks',
        'strip_curtain': 'strip_curtain_tasks',
        'accessories': 'accessories_tasks',
        'system': 'system_tasks',
        'transportation': 'transportation_tasks',
        'quotation': 'quotation_tasks'
    };

    const getCategoryDetails = (cat, customer, fileName) => {
        const baseDescription = `File '${fileName}' uploaded for projectNo ${projectNo}.`;
        const details = {
            'panel': { title: `Panel Task: ${fileName}`, description: baseDescription },
            'cutting': { title: `Cutting Task: ${fileName}`, description: baseDescription },
            'door': { title: `Door Task: ${fileName}`, description: baseDescription },
            'strip_curtain': { title: `Strip Curtain Task: ${fileName}`, description: baseDescription },
            'accessories': { title: `Accessories Task: ${fileName}`, description: baseDescription },
            'system': { title: `System Task: ${fileName}`, description: baseDescription },
            'transportation': { title: `Transport Task: ${fileName}`, description: baseDescription },
            'quotation': { title: `Quotation Task: ${fileName}`, description: baseDescription }
        };
        return details[cat] || {
            title: `${cat.charAt(0).toUpperCase() + cat.slice(1)} Task: ${fileName}`,
            description: baseDescription
        };
    };

    const categoryToColumn = {
        'cutting': 'total_cutting',
        'panel': 'total_panel',
        'door': 'total_door',
        'strip_curtain': 'total_strip_curtain',
        'accessories': 'total_accessories',
        'system': 'total_system',
        'transportation': 'total_transportation',
        'quotation': 'total_quotation'
    };

    let tasksCreatedCount = 0;
    let successfulUploadsCount = 0;
    let lastTaskId = null;
    let taskMessage = '';

    try {
        // Get project details including id
        const [projectResult] = await db.query(
            'SELECT id, customer, status, requestedDelivery FROM projects WHERE projectNo = ?',
            [projectNo]
        );
        if (projectResult.length === 0) {
            return res.status(404).json({ error: `Project No. ${projectNo} not found.` });
        }

        const projectId = projectResult[0].id;
        const customer = projectResult[0].customer;
        const projectStatus = projectResult[0].status;
        const projectDueDate = projectResult[0].requestedDelivery;

        const taskTable = taskTableMap[category];
        const totalColumn = categoryToColumn[category];

        for (const file of uploadedFiles) {
            try {
                const fileData = file.buffer;
                if (!fileData || fileData.length === 0) {
                    console.error(`Skipping file: ${file.originalname} due to empty buffer.`);
                    continue;
                }

                // Insert file with project_id and projectNo (keep projectNo for display)
                const fileInsertQuery = `
                    INSERT INTO project_files 
                    (project_id, projectNo, file_name, file_size, mime_type, file_data, category) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `.trim();

                const [fileResult] = await db.query(fileInsertQuery, [
                    projectId,
                    projectNo,
                    file.originalname,
                    file.size,
                    file.mimetype,
                    fileData,
                    category || null
                ]);

                const projectFileId = fileResult.insertId;
                successfulUploadsCount++;

                let createdTaskId = null;

                if (category && taskTable) {
                    const details = getCategoryDetails(category, customer, file.originalname);
                    let approveStatus = 'Pending';
                    if (projectStatus === 'Approved') {
                        approveStatus = 'Approved';
                    }

                    // Insert task with project_id and project_no
                    const taskInsertQuery = `
                        INSERT INTO ${taskTable} 
                        (title, description, priority, status, project_id, project_no, due_date, created_at, approve_status) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)
                    `;

                    const taskInsertValues = [
                        details.title,
                        details.description,
                        'empty',
                        'pending',
                        projectId,
                        projectNo,
                        projectDueDate,
                        approveStatus
                    ];

                    const [taskResult] = await db.query(taskInsertQuery, taskInsertValues);
                    createdTaskId = taskResult.insertId;
                    tasksCreatedCount++;
                    lastTaskId = createdTaskId;

                    await db.query(
                        `UPDATE project_files SET taskNo = ? WHERE id = ?`,
                        [createdTaskId, projectFileId]
                    );
                    console.log(`Linked Task ID ${createdTaskId} to File ID ${projectFileId}`);
                }

            } catch (fileError) {
                console.error(`Failed to process file ${file.originalname}:`, fileError);
            }
        }

        if (totalColumn && tasksCreatedCount > 0) {
            await db.query(
                `UPDATE projects SET ${totalColumn} = ${totalColumn} + ? WHERE id = ?`,
                [tasksCreatedCount, projectId]
            );
            console.log(`Incremented ${totalColumn} by ${tasksCreatedCount} for project ${projectNo}`);
            taskMessage = `Successfully created and linked ${tasksCreatedCount} tasks.`;
        }

        const fileNames = uploadedFiles.map(f => f.originalname).join(', ');

        const logMessage = category
            ? `${successfulUploadsCount} file(s) uploaded to ${category} category for project ${projectNo}: ${fileNames}. ${tasksCreatedCount} task(s) created.`
            : `${successfulUploadsCount} file(s) uploaded for project ${projectNo}: ${fileNames}`;

        const logDetails = {
            projectNo: projectNo,
            customer: customer,
            count: successfulUploadsCount,
            category: category || 'uncategorized',
            tasksCreated: tasksCreatedCount,
            lastTaskId: lastTaskId
        };

        await logActivity(
            'UPLOAD',
            'FILE',
            projectId,
            logMessage,
            logDetails
        );

        if (successfulUploadsCount === 0) {
            return res.status(500).json({ error: 'No files were successfully processed and uploaded to the database.' });
        }

        let responseMessage = `${successfulUploadsCount} file(s) uploaded successfully to ${category || 'database'} for project ${projectNo}.`;

        if (tasksCreatedCount > 0) {
            responseMessage += ` ${tasksCreatedCount} corresponding task(s) created and linked.`;
        }

        res.status(200).json({
            message: responseMessage,
            category: category,
            count: successfulUploadsCount,
            tasksCreated: tasksCreatedCount,
            taskMessage: taskMessage,
            lastTaskId: lastTaskId
        });

    } catch (err) {
        console.error('Critical upload process error:', err);
        res.status(500).json({
            error: 'Critical server error during upload process.',
            details: err.message
        });
    }
});

// =========================================================
// 🗑️ DELETE FILE – cascades to panels & production if category = 'panel'
// =========================================================
router.delete('/file/:id', async (req, res) => {
    const fileId = req.params.id;

    const categoryToColumn = {
        'cutting': 'total_cutting',
        'panel': 'total_panel',
        'door': 'total_door',
        'strip_curtain': 'total_strip_curtain',
        'accessories': 'total_accessories',
        'system': 'total_system',
        'transportation': 'total_transportation',
        'quotation': 'total_quotation'
    };

    const taskTableMap = {
        'panel': 'panel_tasks',
        'cutting': 'cutting_tasks',
        'door': 'door_tasks',
        'strip_curtain': 'strip_curtain_tasks',
        'accessories': 'accessories_tasks',
        'system': 'system_tasks',
        'transportation': 'transportation_tasks',
        'quotation': 'quotation_tasks'
    };

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Get file details (project_id, projectNo, category, taskNo)
        const [fileInfo] = await connection.query(
            'SELECT file_name, project_id, projectNo, category, taskNo FROM project_files WHERE id = ?',
            [fileId]
        );
        if (fileInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'File not found.' });
        }

        const { file_name: fileName, project_id, projectNo, category, taskNo } = fileInfo[0];

        // 2. Delete the file itself
        const [deleteFileResult] = await connection.query(
            'DELETE FROM project_files WHERE id = ?',
            [fileId]
        );
        if (deleteFileResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'File record not found for deletion.' });
        }

        let taskDeleted = false;
        let wasCompleted = false;
        let panelsDeleted = 0;
        let productionRecordsDeleted = 0;

        // 3. Process linked task (if any)
        if (category && taskNo) {
            const totalColumn = categoryToColumn[category];
            const taskTableName = taskTableMap[category];

            if (totalColumn && taskTableName) {
                // Get task status before deletion
                const [taskStatus] = await connection.query(
                    `SELECT status FROM ${taskTableName} WHERE id = ?`,
                    [taskNo]
                );
                wasCompleted = taskStatus.length > 0 &&
                    (taskStatus[0].status === 'Completed' || taskStatus[0].status === 'Done');

                // Delete the task
                const [taskDeleteResult] = await connection.query(
                    `DELETE FROM ${taskTableName} WHERE id = ?`,
                    [taskNo]
                );
                if (taskDeleteResult.affectedRows > 0) {
                    taskDeleted = true;
                    console.log(`🗑️ Deleted linked task (ID: ${taskNo}) from ${taskTableName}`);

                    // Update project totals (total and completed)
                    await connection.query(
                        `UPDATE projects SET ${totalColumn} = GREATEST(0, ${totalColumn} - 1) WHERE id = ?`,
                        [project_id]
                    );
                    if (wasCompleted) {
                        const completedColumn = totalColumn.replace('total_', 'completed_');
                        await connection.query(
                            `UPDATE projects SET ${completedColumn} = GREATEST(0, ${completedColumn} - 1) WHERE id = ?`,
                            [project_id]
                        );
                    }

                    // --- EXTRA: If category is 'panel', delete all panels & their production records ---
                    if (category === 'panel') {
                        // a) Delete production records linked to panels of this project
                        const [prodResult] = await connection.query(
                            `DELETE pr FROM production_records pr
                             JOIN panels pa ON pr.panel_id = pa.id
                             WHERE pa.project_id = ?`,
                            [project_id]
                        );
                        productionRecordsDeleted = prodResult.affectedRows;
                        console.log(`🗑️ Deleted ${productionRecordsDeleted} production record(s) for project ${projectNo}`);

                        // b) Delete all panels for this project
                        const [panelResult] = await connection.query(
                            'DELETE FROM panels WHERE project_id = ?',
                            [project_id]
                        );
                        panelsDeleted = panelResult.affectedRows;
                        console.log(`🗑️ Deleted ${panelsDeleted} panel(s) for project ${projectNo}`);
                    }
                } else {
                    console.log(`⚠️ File deleted, but linked task (ID: ${taskNo}) not found in ${taskTableName}.`);
                }
            }
        }

        await connection.commit();

        // 4. Log activity
        await logActivity(
            'DELETE',
            'FILE',
            fileId,
            `Deleted file: '${fileName}' from project ${projectNo} (Category: ${category || 'N/A'}). ` +
            `Linked Task ID: ${taskNo || 'N/A'}. ` +
            `Panels deleted: ${panelsDeleted}, Production records deleted: ${productionRecordsDeleted}`,
            { projectNo, category, taskDeleted, taskNo, wasCompleted, panelsDeleted, productionRecordsDeleted }
        );

        // 5. Build response
        let responseMessage = `File deleted successfully. (File: ${fileName}, Category: ${category || 'N/A'})`;
        if (taskDeleted) {
            responseMessage += ` The linked task (ID: ${taskNo}) was also deleted.`;
            if (wasCompleted) responseMessage += ` The completed count for this category was decreased.`;
        } else if (taskNo) {
            responseMessage += ` Linked Task ID ${taskNo} was not found for deletion.`;
        }
        if (panelsDeleted > 0) {
            responseMessage += ` ${panelsDeleted} panel(s) and ${productionRecordsDeleted} production record(s) were removed.`;
        }

        res.status(200).json({
            message: responseMessage,
            fileId,
            taskDeleted,
            taskNo,
            wasCompleted,
            panelsDeleted,
            productionRecordsDeleted
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`Error deleting file ID ${fileId}:`, err);
        res.status(500).json({
            error: 'Failed to complete file/task/panel deletion process.',
            details: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// =========================================================
// 📋 PROJECT ROUTES (CRUD) WITH STATUS SUPPORT
// =========================================================

function mapProductionStatus(status) {
    if (status === 'on-hold') return 'on_hold';
    return status; // 'pending' stays as 'pending'
}

// Updated to use project_id
async function updatePanelsStatusForProject(connection, projectId, status) {
    // 1. Update panels with the original status
    const [panelResult] = await connection.query(
        'UPDATE panels SET status = ? WHERE project_id = ?',
        [status, projectId]
    );
    console.log(`✅ Panels for project ID ${projectId} updated to '${status}' (${panelResult.affectedRows} panel(s))`);

    // 2. Update production_records with the mapped status
    const prodStatus = mapProductionStatus(status);
    const [prodResult] = await connection.query(
        `UPDATE production_records pr
         JOIN panels pa ON pr.panel_id = pa.id
         SET pr.status = ?
         WHERE pa.project_id = ?`,
        [prodStatus, projectId]
    );
    console.log(`✅ Production records for project ID ${projectId} updated to '${prodStatus}' (${prodResult.affectedRows} record(s))`);

    return panelResult.affectedRows;
}

router.get('/', async (req, res) => {
    try {
        const [columns] = await db.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);

        const hasStatusColumn = columns.some(col => col.COLUMN_NAME === 'status');

        let query = 'SELECT * FROM projects ORDER BY created_at DESC, id DESC';

        if (hasStatusColumn) {
            query = 'SELECT *, status FROM projects ORDER BY created_at DESC, id DESC';
        }

        const [projects] = await db.query(query);

        const projectsWithCompletion = await Promise.all(
            projects.map(async (project) => {
                try {
                    const completion = await calculateCompletionPercentage(project.id);
                    return { ...project, completion };
                } catch (error) {
                    console.error(`Error calculating completion for project ${project.projectNo}:`, error);
                    return {
                        ...project,
                        completion: {
                            panelSlab: { completed: 0, total: 0, percentage: 0 },
                            cutting: { completed: 0, total: 0, percentage: 0 },
                            door: { completed: 0, total: 0, percentage: 0 },
                            stripCurtain: { completed: 0, total: 0, percentage: 0 },
                            accessories: { completed: 0, total: 0, percentage: 0 },
                            system: { completed: 0, total: 0, percentage: 0 }
                        }
                    };
                }
            })
        );

        res.json(projectsWithCompletion);
    } catch (err) {
        console.error('Database GET Error:', err);
        res.status(500).json({
            error: 'Failed to retrieve projects.',
            details: err.message
        });
    }
});

router.post('/', async (req, res) => {
    let {
        drawingDate,
        projectNo,
        projectName,
        customer,
        salesman,
        poPayment,
        requestedDelivery,
        remarks,
        sales,
        sell,
        cost,
        margin,
        status = 'active',
        panelRows = []
    } = req.body;

    console.log('Received project data:', req.body);

    if (!projectNo || !customer) {
        return res.status(400).json({ error: 'Project Number and Customer are required fields.' });
    }

    const safeProjectNo = projectNo.replace(/\//g, '_');

    drawingDate = drawingDate === '' ? null : drawingDate;
    requestedDelivery = requestedDelivery === '' ? null : requestedDelivery;

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // ── 1. Insert the project ──
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);

        const columnNames = columns.map(col => col.COLUMN_NAME);

        let projectsColumns = ['drawingDate', 'projectNo', 'customer', 'poPayment', 'requestedDelivery', 'remarks', 'status', 'created_at'];
        let projectsPlaceholders = ['?', '?', '?', '?', '?', '?', '?', 'NOW()'];
        let projectsValues = [drawingDate, safeProjectNo, customer, poPayment, requestedDelivery, remarks, status];

        if (columnNames.includes('projectName')) {
            projectsColumns.push('projectName');
            projectsPlaceholders.push('?');
            projectsValues.push(projectName || '');
        }

        if (columnNames.includes('salesman')) {
            projectsColumns.push('salesman');
            projectsPlaceholders.push('?');
            projectsValues.push(salesman || '');
        }

        const completionFields = [
            'completed_cutting', 'completed_panel', 'completed_door',
            'completed_strip_curtain', 'completed_accessories',
            'completed_system', 'completed_transportation', 'completed_quotation'
        ];

        completionFields.forEach(field => {
            if (columnNames.includes(field)) {
                projectsColumns.push(field);
                projectsPlaceholders.push('?');
                projectsValues.push(req.body[field] || 0);
            }
        });

        const projectsQuery = `INSERT INTO projects 
            (${projectsColumns.join(', ')})
            VALUES (${projectsPlaceholders.join(', ')})`;

        const [projectsResult] = await connection.query(projectsQuery, projectsValues);
        const projectId = projectsResult.insertId;

        // ── 2. Insert job_ledger (if table exists) – now with project_id ──
        const [tables] = await connection.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_ledger'
        `);

        if (tables.length > 0) {
            // Check if column project_id exists in job_ledger; if not, we'll skip it.
            const [ledgerColumns] = await connection.query(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = 'job_ledger' AND TABLE_SCHEMA = DATABASE()
            `);
            const ledgerColNames = ledgerColumns.map(c => c.COLUMN_NAME);

            const ledgerData = {
                Job_No: safeProjectNo,
                Customer_Name: customer,
                Date_Entry: drawingDate || new Date().toISOString().split('T')[0],
                Sales_Amount: sales || 0,
                Sell_Price: sell || 0,
                Cost: cost || 0,
                Margin: margin || 0,
                Remarks: remarks || null
            };
            // Add project_id if column exists
            if (ledgerColNames.includes('project_id')) {
                ledgerData.project_id = projectId;
            }

            const sqlColumns = Object.keys(ledgerData).join(', ');
            const placeholders = Object.keys(ledgerData).map(() => '?').join(', ');
            const ledgerValues = Object.values(ledgerData);

            await connection.query(`INSERT INTO job_ledger (${sqlColumns}) VALUES (${placeholders})`, ledgerValues);
        }

        // ── 3. Insert panels if panelRows exist – now with project_id and keep job_no ──
        if (Array.isArray(panelRows) && panelRows.length > 0) {
            const generatePanelRef = (existingRefs = []) => {
                const now = new Date();
                const y = now.getFullYear().toString().slice(-2);
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const d = String(now.getDate()).padStart(2, '0');
                const prefix = `REF-${y}${m}${d}`;
                const todayRefs = existingRefs.filter(r => r && r.startsWith(prefix));
                let seq = 1;
                if (todayRefs.length > 0) {
                    const nums = todayRefs.map(r => { const x = r.match(/\d+$/); return x ? parseInt(x[0]) : 0; });
                    seq = Math.max(...nums) + 1;
                }
                return `${prefix}-${String(seq).padStart(3, '0')}`;
            };

            const [existingPanels] = await connection.query(
                'SELECT reference_number FROM panels WHERE reference_number IS NOT NULL'
            );
            const existingRefs = existingPanels.map(p => p.reference_number).filter(Boolean);
            const usedRefs = [...existingRefs];

            for (const row of panelRows) {
                const qty = parseInt(row.qty) || 0;
                if (qty <= 0) continue;

                if (!row.width || !row.length) {
                    throw new Error('Width and Length are required for each panel row when qty > 0.');
                }

                for (let i = 0; i < qty; i++) {
                    const ref = generatePanelRef(usedRefs);
                    usedRefs.push(ref);

                    const panelData = {
                        project_id: projectId,   // new FK
                        job_no: safeProjectNo,   // keep for display/search
                        reference_number: ref,
                        type: row.type || null,
                        panel_thk: row.thk ? parseFloat(row.thk) : null,
                        joint: row.joint || null,
                        surface_front: row.front || null,
                        surface_back: row.back || null,
                        surface_front_thk: row.frontThk ? parseFloat(row.frontThk) : null,
                        surface_back_thk: row.backThk ? parseFloat(row.backThk) : null,
                        surface_type: row.surface || null,
                        width: parseFloat(row.width) || 0,
                        length: parseFloat(row.length) || 0,
                        qty: 1,
                        balance: 1,
                        cutting: row.cutting || null,
                        salesman: row.salesman || null,
                        application: row.application || null,
                        estimated_delivery: row.delivery || null,
                        notes: row.notes || null,
                        status: 'on-hold',
                        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                    };

                    Object.keys(panelData).forEach(key => {
                        if (panelData[key] === null || panelData[key] === undefined) {
                            delete panelData[key];
                        }
                    });

                    const columns = Object.keys(panelData);
                    const values = Object.values(panelData);
                    const placeholders = columns.map(() => '?').join(', ');
                    await connection.query(
                        `INSERT INTO panels (${columns.join(', ')}) VALUES (${placeholders})`,
                        values
                    );
                }
            }
        }

        await connection.commit();

        const [newProject] = await connection.query('SELECT * FROM projects WHERE id = ?', [projectId]);
        res.status(201).json(newProject[0]);

    } catch (err) {
        await connection.rollback();
        console.error('Database Error:', err);

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: `Project Number '${safeProjectNo}' already exists.` });
        }
        res.status(500).json({ error: 'Failed to create project.', details: err.message });
    } finally {
        connection.release();
    }
});

router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({ error: 'Status is required.' });
    }

    try {
        const updateQuery = `
            UPDATE projects 
            SET status = ?, updated_at = NOW()
            WHERE id = ?
        `;

        await db.query(updateQuery, [status, id]);

        const [updatedProject] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);

        if (updatedProject.length === 0) {
            return res.status(404).json({ error: 'Project not found after status update attempt.' });
        }

        await logActivity(
            'UPDATE',
            'PROJECT',
            id,
            `Project ${updatedProject[0].projectNo} status updated to ${status}.`,
            { oldStatus: updatedProject[0].status, newStatus: status }
        );

        res.status(200).json(updatedProject[0]);

    } catch (err) {
        console.error('Error updating project status:', err);
        res.status(500).json({
            error: 'Failed to update project status.',
            details: err.message
        });
    }
});

// =========================================================
// 🛠️ UPDATE PROJECT — WITH JOB_LEDGER & TASK CASCADE (now uses project_id)
// =========================================================
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updateFields = req.body;
    const panelRows = updateFields.panelRows;

    const formatDate = (dateValue) => {
        if (!dateValue) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
        const d = new Date(dateValue);
        if (isNaN(d.getTime())) return null;
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    // Fields allowed in the projects table
    const allowedFields = [
        'drawingDate', 'projectNo', 'customer', 'poPayment',
        'requestedDelivery', 'remarks', 'salesman', 'projectName'
    ];
    const fieldsToUpdate = {};

    allowedFields.forEach(field => {
        if (updateFields[field] !== undefined) {
            if (field === 'drawingDate' || field === 'requestedDelivery') {
                const formatted = formatDate(updateFields[field]);
                if (formatted !== null) {
                    fieldsToUpdate[field] = formatted;
                }
            } else {
                fieldsToUpdate[field] = updateFields[field];
            }
        }
    });

    // Check if any ledger fields are present
    const ledgerFields = ['sales', 'sell', 'cost', 'margin'];
    const hasLedgerUpdate = ledgerFields.some(f => updateFields[f] !== undefined);

    if (Object.keys(fieldsToUpdate).length === 0 && panelRows === undefined && !hasLedgerUpdate) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // ── 1. Get current project data ──
        const [currentProject] = await connection.query(
            'SELECT id, projectNo, customer, drawingDate, remarks FROM projects WHERE id = ?',
            [id]
        );
        if (currentProject.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Project not found.' });
        }
        const oldProject = currentProject[0];
        const oldProjectNo = oldProject.projectNo;

        // ── 2. Update project fields (if any) ──
        if (Object.keys(fieldsToUpdate).length > 0) {
            // If projectNo is changing, check for duplicates
            if (fieldsToUpdate.projectNo && fieldsToUpdate.projectNo !== oldProjectNo) {
                const [dup] = await connection.query(
                    'SELECT id FROM projects WHERE projectNo = ? AND id != ?',
                    [fieldsToUpdate.projectNo, id]
                );
                if (dup.length > 0) {
                    await connection.rollback();
                    return res.status(409).json({ error: 'Project number already exists.' });
                }
            }

            const setClause = Object.keys(fieldsToUpdate)
                .map(field => `${field} = ?`)
                .join(', ');
            const query = `UPDATE projects SET ${setClause}, updated_at = NOW() WHERE id = ?`;
            const values = [...Object.values(fieldsToUpdate), id];
            await connection.query(query, values);
        }

        // ── 3. Handle project number change – update projectNo in child tables (but FK is project_id) ──
        const newProjectNo = fieldsToUpdate.projectNo || oldProjectNo;
        const projectNoChanged = (newProjectNo !== oldProjectNo);

        if (projectNoChanged) {
            // Update the projectNo column in child tables (for display/search)
            const taskTables = [
                'panel_tasks', 'cutting_tasks', 'door_tasks',
                'strip_curtain_tasks', 'accessories_tasks',
                'system_tasks', 'transportation_tasks', 'quotation_tasks'
            ];
            for (const table of taskTables) {
                await connection.query(
                    `UPDATE ${table} SET project_no = ? WHERE project_id = ?`,
                    [newProjectNo, id]
                );
            }
            await connection.query(
                'UPDATE panels SET job_no = ? WHERE project_id = ?',
                [newProjectNo, id]
            );
            await connection.query(
                'UPDATE project_files SET projectNo = ? WHERE project_id = ?',
                [newProjectNo, id]
            );
        }

        // ── 4. Update job_ledger – use project_id to locate record ──
        // Check if job_ledger table exists and has project_id column
        const [ledgerTables] = await connection.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_ledger'
        `);
        if (ledgerTables.length > 0) {
            const [ledgerColumns] = await connection.query(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = 'job_ledger' AND TABLE_SCHEMA = DATABASE()
            `);
            const ledgerColNames = ledgerColumns.map(c => c.COLUMN_NAME);

            // Build ledger update object
            const ledgerUpdate = {};
            if (updateFields.projectNo) ledgerUpdate.Job_No = updateFields.projectNo;
            if (updateFields.customer) ledgerUpdate.Customer_Name = updateFields.customer;
            if (updateFields.sales !== undefined) ledgerUpdate.Sales_Amount = updateFields.sales;
            if (updateFields.sell !== undefined) ledgerUpdate.Sell_Price = updateFields.sell;
            if (updateFields.cost !== undefined) ledgerUpdate.Cost = updateFields.cost;
            if (updateFields.margin !== undefined) ledgerUpdate.Margin = updateFields.margin;
            if (updateFields.remarks !== undefined) ledgerUpdate.Remarks = updateFields.remarks;
            if (updateFields.drawingDate !== undefined) {
                const formatted = formatDate(updateFields.drawingDate);
                if (formatted) ledgerUpdate.Date_Entry = formatted;
            }

            // Check if a ledger record exists for this project
            const [ledgerExists] = await connection.query(
                'SELECT id FROM job_ledger WHERE project_id = ?',
                [id]
            );

            if (ledgerExists.length > 0) {
                if (Object.keys(ledgerUpdate).length > 0) {
                    const setClause = Object.keys(ledgerUpdate)
                        .map(f => `${f} = ?`)
                        .join(', ');
                    const values = [...Object.values(ledgerUpdate), id];
                    await connection.query(
                        `UPDATE job_ledger SET ${setClause} WHERE project_id = ?`,
                        values
                    );
                }
            } else {
                // No existing ledger record – create one
                const newLedger = {
                    project_id: id,
                    Job_No: newProjectNo,
                    Customer_Name: updateFields.customer || oldProject.customer,
                    Date_Entry: updateFields.drawingDate
                        ? formatDate(updateFields.drawingDate)
                        : (oldProject.drawingDate || new Date().toISOString().split('T')[0]),
                    Sales_Amount: updateFields.sales !== undefined ? updateFields.sales : 0,
                    Sell_Price: updateFields.sell !== undefined ? updateFields.sell : 0,
                    Cost: updateFields.cost !== undefined ? updateFields.cost : 0,
                    Margin: updateFields.margin !== undefined ? updateFields.margin : 0,
                    Remarks: updateFields.remarks !== undefined ? updateFields.remarks : (oldProject.remarks || null),
                };
                // Ensure only existing columns are included
                const finalLedger = {};
                Object.keys(newLedger).forEach(key => {
                    if (ledgerColNames.includes(key)) {
                        finalLedger[key] = newLedger[key];
                    }
                });
                const cols = Object.keys(finalLedger);
                const vals = Object.values(finalLedger);
                const placeholders = cols.map(() => '?').join(', ');
                await connection.query(
                    `INSERT INTO job_ledger (${cols.join(', ')}) VALUES (${placeholders})`,
                    vals
                );
            }
        }

        // ── 5. Update panels ONLY if panelRows is explicitly provided ──
        if (panelRows !== undefined) {
            await connection.query('DELETE FROM panels WHERE project_id = ?', [id]);

            // Insert new panels
            const generatePanelRef = (existingRefs = []) => {
                const now = new Date();
                const y = now.getFullYear().toString().slice(-2);
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const d = String(now.getDate()).padStart(2, '0');
                const prefix = `REF-${y}${m}${d}`;
                const todayRefs = existingRefs.filter(r => r && r.startsWith(prefix));
                let seq = 1;
                if (todayRefs.length > 0) {
                    const nums = todayRefs.map(r => { const x = r.match(/\d+$/); return x ? parseInt(x[0]) : 0; });
                    seq = Math.max(...nums) + 1;
                }
                return `${prefix}-${String(seq).padStart(3, '0')}`;
            };

            const [allRefs] = await connection.query(
                'SELECT reference_number FROM panels WHERE reference_number IS NOT NULL'
            );
            const usedRefs = allRefs.map(p => p.reference_number).filter(Boolean);

            for (const row of panelRows) {
                if (!row.width || !row.length) {
                    throw new Error('Width and Length are required for each panel.');
                }

                const ref = generatePanelRef(usedRefs);
                usedRefs.push(ref);

                const panelData = {
                    project_id: id,
                    job_no: newProjectNo,
                    reference_number: ref,
                    type: row.type || null,
                    panel_thk: row.thk ? parseFloat(row.thk) : null,
                    joint: row.joint || null,
                    surface_front: row.front || null,
                    surface_back: row.back || null,
                    surface_front_thk: row.frontThk ? parseFloat(row.frontThk) : null,
                    surface_back_thk: row.backThk ? parseFloat(row.backThk) : null,
                    surface_type: row.surface || null,
                    width: parseFloat(row.width) || 0,
                    length: parseFloat(row.length) || 0,
                    qty: 1,
                    balance: 1,
                    cutting: row.cutting || null,
                    salesman: row.salesman || null,
                    application: row.application || null,
                    estimated_delivery: row.delivery || null,
                    notes: row.notes || null,
                    status: row.status || 'pending',
                    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                };

                Object.keys(panelData).forEach(key => {
                    if (panelData[key] === null || panelData[key] === undefined) {
                        delete panelData[key];
                    }
                });

                const columns = Object.keys(panelData);
                const values = Object.values(panelData);
                const placeholders = columns.map(() => '?').join(', ');
                await connection.query(
                    `INSERT INTO panels (${columns.join(', ')}) VALUES (${placeholders})`,
                    values
                );
            }
        }

        await connection.commit();

        // ── 6. Fetch and return updated project ──
        const [updatedProject] = await connection.query('SELECT * FROM projects WHERE id = ?', [id]);

        await logActivity(
            'UPDATE',
            'PROJECT',
            id,
            `Project ${updatedProject[0].projectNo} updated.`,
            {
                fieldsUpdated: Object.keys(fieldsToUpdate),
                panelRowsProvided: panelRows !== undefined,
                ledgerUpdated: hasLedgerUpdate,
                projectNoChanged
            }
        );

        res.status(200).json(updatedProject[0]);

    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error('Error updating project:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Duplicate entry (e.g., projectNo already exists).' });
        }
        res.status(500).json({
            error: 'Failed to update project data in the database.',
            details: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// ---- DELETE PROJECT (complete cleanup) ----
router.delete('/:identifier', async (req, res) => {
    const { identifier } = req.params;
    let projectId;
    let projectNo;
    let customer;

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // Find project
        let project;
        if (/^\d+$/.test(identifier)) {
            [project] = await connection.query(
                'SELECT id, projectNo, customer FROM projects WHERE id = ?',
                [parseInt(identifier, 10)]
            );
        } else {
            [project] = await connection.query(
                'SELECT id, projectNo, customer FROM projects WHERE projectNo = ?',
                [identifier]
            );
        }
        if (!project || project.length === 0) {
            throw new Error(`Project with identifier ${identifier} not found.`);
        }
        projectId = project[0].id;
        projectNo = project[0].projectNo;
        customer = project[0].customer;

        console.log(`🗑️ Starting full deletion of project ID: ${projectId} (${projectNo})`);

        // 1. Delete from all category task tables
        const taskTables = [
            'panel_tasks', 'cutting_tasks', 'door_tasks',
            'strip_curtain_tasks', 'accessories_tasks',
            'system_tasks', 'transportation_tasks', 'quotation_tasks'
        ];
        for (const table of taskTables) {
            const [result] = await connection.query(
                `DELETE FROM ${table} WHERE project_id = ?`,
                [projectId]
            );
            if (result.affectedRows > 0) {
                console.log(`🗑️ Deleted ${result.affectedRows} rows from ${table}`);
            }
        }

        // 2. Delete panels and production_records (since they reference project_id)
        const [panelsResult] = await connection.query(
            'DELETE FROM panels WHERE project_id = ?',
            [projectId]
        );
        if (panelsResult.affectedRows > 0) {
            console.log(`🗑️ Deleted ${panelsResult.affectedRows} panels`);
        }

        // 3. Delete production_records (they are linked via panels, but some may be orphaned)
        const [prodResult] = await connection.query(
            `DELETE pr FROM production_records pr
             JOIN panels pa ON pr.panel_id = pa.id
             WHERE pa.project_id = ?`,
            [projectId]
        );
        if (prodResult.affectedRows > 0) {
            console.log(`🗑️ Deleted ${prodResult.affectedRows} production records`);
        }

        // 4. Delete project_files
        const [filesResult] = await connection.query(
            'DELETE FROM project_files WHERE project_id = ?',
            [projectId]
        );
        console.log(`🗑️ Deleted ${filesResult.affectedRows} file(s) from project_files.`);

        // 5. Delete job_ledger (if table exists and has project_id column)
        const [tables] = await connection.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_ledger'
        `);
        if (tables.length > 0) {
            const [ledgerResult] = await connection.query(
                'DELETE FROM job_ledger WHERE project_id = ?',
                [projectId]
            );
            console.log(`🗑️ Deleted ${ledgerResult.affectedRows} record(s) from job_ledger.`);
        }

        // 6. Finally, delete the project itself
        const [projectResult] = await connection.query(
            'DELETE FROM projects WHERE id = ?',
            [projectId]
        );
        if (projectResult.affectedRows === 0) {
            throw new Error('Failed to delete project from database.');
        }

        await connection.commit();
        console.log(`✅ Transaction committed. Project ${projectNo} fully deleted.`);

        await logActivity(
            'DELETE',
            'PROJECT',
            projectId,
            `Project ${projectNo} (${customer}) deleted with all related data (tasks, panels, files, ledger).`,
            { projectNo, customer }
        );

        res.status(200).json({
            success: true,
            message: `Project ${projectNo} (${customer}) deleted successfully. All associated data removed.`,
            projectNo,
            customer,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error('❌ Error in project deletion:', err);
        res.status(500).json({
            error: 'Failed to delete project and all associated data.',
            details: err.message,
            identifier: identifier,
            timestamp: new Date().toISOString()
        });
    } finally {
        if (connection) connection.release();
    }
});

// =========================================================
// 📁 GET FILE BLOB (unchanged, file id is unique)
// =========================================================
router.get('/file/blob/:id', async (req, res) => {
    const fileId = req.params.id;

    try {
        const [fileResult] = await db.query(
            'SELECT file_name, mime_type, file_data FROM project_files WHERE id = ?',
            [fileId]
        );

        if (fileResult.length === 0) {
            return res.status(404).json({ error: 'File not found.' });
        }

        const file = fileResult[0];

        if (!file.file_data) {
            return res.status(404).json({ error: 'File data is empty or missing.' });
        }

        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`);

        res.send(file.file_data);

    } catch (err) {
        console.error(`Error retrieving file BLOB ID ${fileId}:`, err);
        res.status(500).json({
            error: 'Failed to retrieve file BLOB from the database.',
            details: err.message
        });
    }
});

// =========================================================
// 📊 GET COMPLETION PERCENTAGES – uses project_id
// =========================================================
router.get('/completion/:projectNo', async (req, res) => {
    try {
        const { projectNo } = req.params;

        const [project] = await db.query(
            'SELECT id FROM projects WHERE projectNo = ?',
            [projectNo]
        );

        if (project.length === 0) {
            return res.status(404).json({
                error: `Project with number ${projectNo} not found`
            });
        }

        const completion = await calculateCompletionPercentage(project[0].id);

        res.json(completion);
    } catch (error) {
        console.error('Error fetching project completion:', error);
        res.status(500).json({
            error: 'Failed to fetch project completion data',
            details: error.message
        });
    }
});

module.exports = router;