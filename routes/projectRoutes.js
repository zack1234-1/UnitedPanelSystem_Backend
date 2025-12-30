const express = require('express');
const router = express.Router();
const db = require('../db/connection'); 
const multer = require('multer'); 
const path = require('path');    

// =========================================================
// 📝 ACTIVITY LOGGING HELPER
// =========================================================

/**
 * Inserts an activity record into the database.
 * @param {string} activityType - CRUD action (e.g., 'CREATE', 'UPDATE', 'DELETE', 'UPLOAD').
 * @param {string} resourceType - The table/object type (e.g., 'PROJECT', 'FILE').
 * @param {number|string} resourceId - The ID of the affected resource (e.g., Project ID or File ID).
 * @param {string} message - A human-readable description.
 * @param {object} [details={}] - Optional JSON object for specific details.
 */
async function logActivity(activityType, resourceType, resourceId, message, details = {}) {
    const userId = 1; // ⚠️ FIX THIS: Replace with actual authenticated user ID
    
    try {
        const query = `
            INSERT INTO activity_logs 
            (timestamp, user_id, activity_type, resource_type, resource_id, message, details) 
            VALUES (NOW(), ?, ?, ?, ?, ?, ?)
        `;
        const detailsJson = JSON.stringify(details);

        await db.query(query, [
            userId, 
            activityType, 
            resourceType, 
            resourceId, 
            message, 
            detailsJson
        ]);
    } catch (err) {
        // CRITICAL: Log the error but DO NOT throw it or break the main request chain.
        console.error('CRITICAL: Activity logging failed:', err);
    }
}

// =========================================================
// MULTER CONFIGURATION (Memory Storage for BLOBs)
// =========================================================

const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// =========================================================
// 🗑️ FILE DELETION HELPERS
// =========================================================

/**
 * Helper to delete all file records for a project from the database.
 * @param {string} projectNo - The project number to clean up.
 */
async function deleteAllProjectFiles(projectNo) {
    await db.query('DELETE FROM project_files WHERE projectNo = ?', [projectNo]);
    console.log(`Cleaned up all BLOB file records for project ${projectNo}.`);
}

// =========================================================
// 📊 PROJECT COMPLETION CALCULATION
// =========================================================

/**
 * Calculate completion percentages for all task categories
 */
async function calculateCompletionPercentage(projectNo) {
    try {
        // Initialize completion object
        const completion = {
            panelSlab: { completed: 0, total: 0, percentage: 0 },
            cutting: { completed: 0, total: 0, percentage: 0 },
            door: { completed: 0, total: 0, percentage: 0 },
            stripCurtain: { completed: 0, total: 0, percentage: 0 },
            accessories: { completed: 0, total: 0, percentage: 0 },
            system: { completed: 0, total: 0, percentage: 0 }
        };

        // Calculate for each task type
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
                WHERE project_no = ?`,
                [projectNo]
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
// 📂 FILE ROUTES (MANAGEMENT)
// =========================================================

// Add this route for better compatibility

router.get('/status/:status', async (req, res) => {
    const { status } = req.params;
    
    try {
        // Check if status column exists
        const [columns] = await db.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);

        // Get projects by status
        let query;
        let params = [];
        
        if (status === 'active') {
            query = "SELECT * FROM projects WHERE status = 'Active' ORDER BY created_at DESC, id DESC";
        } else if (status === 'done') {
            query = "SELECT * FROM projects WHERE status = 'Done' ORDER BY created_at DESC, id DESC";
        } else if (status === 'approved') {
            query = "SELECT * FROM projects WHERE status = 'Approved' ORDER BY created_at DESC, id DESC";
        } else {
            // For any other status, return empty
            return res.json([]);
        }
        
        const [projects] = await db.query(query, params);
        
        // Calculate completion for each project
        const projectsWithCompletion = await Promise.all(
            projects.map(async (project) => {
                const completion = await calculateCompletionPercentage(project.projectNo);
                return {
                    ...project,
                    completion: completion
                };
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

router.get('/:projectNo/files', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
            FROM project_files 
            WHERE projectNo = ?
        `;
        const params = [projectNo];

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

// Also update the existing /files/:projectNo route to return consistent format
router.get('/files/:projectNo', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
            FROM project_files 
            WHERE projectNo = ?
        `;
        const params = [projectNo];

        if (category && category !== 'all') {
            query += ' AND category = ?';
            params.push(category);
        }

        const [files] = await db.query(query, params);
        
        res.json(files); // Fix: Return the array directly, not wrapped in object

    } catch (err) {
        console.error('Error fetching files:', err);
        res.status(500).json({ 
            success: false,
            error: 'Failed to retrieve files from database.',
            details: err.message
        });
    }
});

router.post('/upload', upload.array('files'), async (req, res) => {
    const { projectNo, category } = req.body;
    const uploadedFiles = req.files;

    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ error: "No files selected for upload." });
    }

    // Define the task table map for quick lookup
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

    // Define category-specific task titles and descriptions
    const getCategoryDetails = (cat, customer, fileName) => {
        // Updated to use fileName in the description for better tracking
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

    // Map category to the correct total column for projects table
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
        // 1. Basic Project existence check
        const [projectResult] = await db.query('SELECT id, customer, status, requestedDelivery FROM projects WHERE projectNo = ?', [projectNo]);
        if (projectResult.length === 0) {
            return res.status(404).json({ error: `Project No. ${projectNo} not found.` });
        }
        
        const projectId = projectResult[0].id;
        const customer = projectResult[0].customer;
        const projectStatus = projectResult[0].status;
        const projectDueDate = projectResult[0].requestedDelivery;
        
        // 2. Process each file sequentially to link the created task ID to the project_files record
        const taskTable = taskTableMap[category];
        const totalColumn = categoryToColumn[category];

        for (const file of uploadedFiles) {
            try {
                const fileData = file.buffer;
                if (!fileData || fileData.length === 0) {
                    console.error(`Skipping file: ${file.originalname} due to empty buffer.`);
                    continue; // Skip to the next file
                }
                
                // --- FILE INSERTION ---
                // FIX: Use AUTO_INCREMENT properly by not specifying id in INSERT
                const fileInsertQuery = `
                    INSERT INTO project_files 
                    (projectNo, file_name, file_size, mime_type, file_data, category) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `.trim();
                
                const [fileResult] = await db.query(fileInsertQuery, [
                    projectNo, 
                    file.originalname, 
                    file.size, 
                    file.mimetype, 
                    fileData,
                    category || null
                ]);
                
                const projectFileId = fileResult.insertId;
                successfulUploadsCount++;

                // --- TASK CREATION (Conditional) ---
                let createdTaskId = null;

                if (category && taskTable) 
                {
                    
                    const details = getCategoryDetails(category, customer, file.originalname);
                    let approveStatus = 'Pending';
                    if (projectStatus === 'Approved') {
                        approveStatus = 'Approved';
                    }
                    
                      const taskInsertQuery = `
                        INSERT INTO ${taskTable} 
                        (title, description, priority, status, project_no, due_date, created_at, approve_status) 
                        VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
                    `;
                    
                    const taskInsertValues = [
                        details.title,
                        details.description, 
                        'empty', 
                        'pending', 
                        projectNo,
                        projectDueDate,
                        approveStatus
                    ];
                    
                    const [taskResult] = await db.query(taskInsertQuery, taskInsertValues);
                    createdTaskId = taskResult.insertId;
                    tasksCreatedCount++;
                    lastTaskId = createdTaskId;
                    
                    // --- TASK ID LINKING (The requested FIX) ---
                    await db.query(
                        `UPDATE project_files SET taskNo = ? WHERE id = ?`,
                        [createdTaskId, projectFileId]
                    );
                    console.log(`Linked Task ID ${createdTaskId} to File ID ${projectFileId}`);
                }
                
            } catch (fileError) {
                console.error(`Failed to process file ${file.originalname}:`, fileError);
                // Continue with next file, but log the error
            }
        } // End of file loop

        // 4. INCREMENT TOTAL COUNT for the WHOLE BATCH (Increment by the number of successful task creations)
        if (totalColumn && tasksCreatedCount > 0) {
            await db.query(
                `UPDATE projects SET ${totalColumn} = ${totalColumn} + ? WHERE projectNo = ?`,
                [tasksCreatedCount, projectNo]
            );
            console.log(`Incremented ${totalColumn} by ${tasksCreatedCount} for project ${projectNo}`);
            taskMessage = `Successfully created and linked ${tasksCreatedCount} tasks.`;
        }
        
        // 5. Log the successful uploads (Log should reflect overall success)
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
            projectId, // Log against the Project ID
            logMessage,
            logDetails
        );

        // 6. Prepare response
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

router.delete('/file/:id', async (req, res) => {
    const fileId = req.params.id;

    // Define maps for quick lookup (based on your previous logic)
    const categoryToColumn = {
        'cutting': 'total_cutting',
        'panel': 'total_panel',
        'door': 'total_door',
        'strip_curtain': 'total_strip_curtain',
        'accessories': 'total_accessories',
        'system': 'system_tasks',
        'transportation': 'transportation_tasks',
        'quotation': 'quotation_tasks'
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

    try {
        // 1. Get file details (name, projectNo, category, AND taskNo) BEFORE deletion
        const [fileInfoResult] = await db.query(
            'SELECT file_name, projectNo, category, taskNo FROM project_files WHERE id = ?', 
            [fileId]
        );

        if (fileInfoResult.length === 0) {
            return res.status(404).json({ error: 'File not found.' });
        }
        
        // Destructure all needed properties, including taskNo
        const { file_name: fileName, projectNo, category, taskNo } = fileInfoResult[0];

        // 2. Delete the file record from the database
        const [deleteResult] = await db.query('DELETE FROM project_files WHERE id = ?', [fileId]);

        if (deleteResult.affectedRows === 0) {
            // This should not happen if fileInfoResult was found, but keep for robustness.
            return res.status(404).json({ error: 'File record not found for deletion.' });
        }
        
        let taskDeleted = false;
        let taskTableName = '';

        // --- Task and Project Totals Management ---
        if (category) {
            const totalColumn = categoryToColumn[category];
            taskTableName = taskTableMap[category];
            
            // A. Decrement the project's total file count
            if (totalColumn) {
                // Decrement the total by 1, ensuring it doesn't drop below 0
                await db.query(
                    `UPDATE projects SET ${totalColumn} = GREATEST(0, ${totalColumn} - 1) WHERE projectNo = ?`,
                    [projectNo]
                );
                console.log(`Decremented ${totalColumn} file count for project ${projectNo}`);
            }

            // B. Targeted Task Deletion Logic: Delete task using the stored taskNo
            if (taskTableName && taskNo) {
                
                // Delete the specific task linked to this file's taskNo (which is the task's primary key)
                const [taskDeleteResult] = await db.query(
                    `DELETE FROM ${taskTableName} WHERE id = ?`,
                    [taskNo]
                );

                if (taskDeleteResult.affectedRows > 0) {
                    taskDeleted = true;
                    console.log(`Successfully deleted linked task (ID: ${taskNo}) from ${taskTableName}.`);
                } else {
                    console.log(`Warning: File was deleted, but linked task (ID: ${taskNo}) not found in ${taskTableName}.`);
                }
            }
        }
        
        // 4. Log the successful deletion
        await logActivity(
            'DELETE', 
            'FILE', 
            fileId, 
            `Deleted file: '${fileName}' from project ${projectNo} (Category: ${category || 'N/A'}). Linked Task ID: ${taskNo || 'N/A'}.`,
            { projectNo: projectNo, category: category, taskDeleted: taskDeleted, taskNo: taskNo }
        );

        // 5. Prepare response
        let responseMessage = `File deleted successfully from database. (File: ${fileName}, Category: ${category || 'N/A'})`;
        if (taskDeleted) {
             responseMessage += ` The corresponding task (ID: ${taskNo}) was also deleted.`;
        } else if (taskNo) {
             responseMessage += ` Linked Task ID ${taskNo} was provided but could not be deleted (may have been deleted previously).`;
        }

        res.status(200).json({ 
            message: responseMessage,
            fileId: fileId,
            taskDeleted: taskDeleted,
            taskNo: taskNo
        });

    } catch (err) {
        console.error(`Error deleting file ID ${fileId}:`, err);
        res.status(500).json({ 
            error: 'Failed to complete file/task deletion process.',
            details: err.message
        });
    }
});

// =========================================================
// 📋 PROJECT ROUTES (CRUD) WITH STATUS SUPPORT
// =========================================================

// --- GET /api/projects: Fetch all projects ---
router.get('/', async (req, res) => {
    try {
        // Check if we need to add status column (for backward compatibility)
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
        
        // Calculate completion for each project
        const projectsWithCompletion = await Promise.all(
            projects.map(async (project) => {
                try {
                    const completion = await calculateCompletionPercentage(project.projectNo);
                    return {
                        ...project,
                        completion: completion
                    };
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

// --- POST /api/projects: Create a new project ---
router.post('/', async (req, res) => {
    let { 
        drawingDate, 
        projectNo,
        projectName, 
        customer, 
        salesman, 
        poPayment, 
        requestedDelivery, 
        remark,
        sales,
        sell,
        cost,
        margin,
        status = 'active',
    } = req.body;

    console.log('Received project data:', req.body);

    if (!projectNo || !customer) {
        return res.status(400).json({ error: 'Project Number and Customer are required fields.' });
    }

    // --- SANITIZATION: Replace / with _ ---
    // This ensures filenames and database keys are safe for URLs and file systems
    const safeProjectNo = projectNo.replace(/\//g, '_'); 

    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();

        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);
        
        const columnNames = columns.map(col => col.COLUMN_NAME);
        
        // Use safeProjectNo for the database entry
        let projectsColumns = ['drawingDate', 'projectNo', 'customer', 'poPayment', 'requestedDelivery', 'remark', 'status', 'created_at'];
        let projectsPlaceholders = ['?', '?', '?', '?', '?', '?', '?', 'NOW()'];
        let projectsValues = [drawingDate, safeProjectNo, customer, poPayment, requestedDelivery, remark, status];

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

        const [tables] = await connection.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_ledger'
        `);
        
        if (tables.length > 0) {
            const [existingRecords] = await connection.query(
                'SELECT Job_No FROM job_ledger WHERE Job_No = ?',
                [safeProjectNo]
            );
            
            if (existingRecords.length === 0) {
                const ledgerData = {
                    Job_No: safeProjectNo,
                    Customer_Name: customer,
                    Date_Entry: drawingDate || new Date().toISOString().split('T')[0],
                    Sales_Amount: sales || 0,
                    Sell_Price: sell || 0,
                    Cost: cost || 0,
                    Margin: margin || 0,
                    Remarks: remark || null
                };

                const sqlColumns = Object.keys(ledgerData).join(', ');
                const placeholders = Object.keys(ledgerData).map(() => '?').join(', ');
                const ledgerValues = Object.values(ledgerData);

                await connection.query(`INSERT INTO job_ledger (${sqlColumns}) VALUES (${placeholders})`, ledgerValues);
            }
        }

        await connection.commit();
        
        const [newProject] = await connection.query('SELECT * FROM projects WHERE id = ?', [projectsResult.insertId]);
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

// --- PATCH /api/projects/:id/status: Update project status ---
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status} = req.body;

    if (!status) {
        return res.status(400).json({ error: 'Status is required.' });
    }

    try {
        // Check if status column exists
        const [columns] = await db.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'projects' AND TABLE_SCHEMA = DATABASE()
        `);
        
        // Update the project status
        const updateQuery = `
            UPDATE projects 
            SET status = ?, 
                status = status,
                updated_at = NOW()
            WHERE id = ?
        `;
        
        await db.query(updateQuery, [status || null, id]);
        
        // Get updated project
        const [updatedProject] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);

        if (updatedProject.length === 0) {
            return res.status(404).json({ error: 'Project not found after status update attempt.' });
        }
        
        // Log the status update
        await logActivity(
            'UPDATE', 
            'PROJECT', 
            id, 
            `Project ${updatedProject[0].projectNo} status updated to ${status}.`,
            { 
                oldStatus: updatedProject[0].status,
                newStatus: status,
            }
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

// --- PUT /api/projects/:id: Update a project ---
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updateFields = req.body;

    // Build dynamic update query based on provided fields
    const allowedFields = ['drawingDate', 'projectNo', 'customer', 'poPayment', 'requestedDelivery', 'remark'];
    const fieldsToUpdate = {};
    
    allowedFields.forEach(field => {
        if (updateFields[field] !== undefined) {
            fieldsToUpdate[field] = updateFields[field];
        }
    });

    if (Object.keys(fieldsToUpdate).length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    try {
        // Get current project data for logging
        const [currentProject] = await db.query('SELECT projectNo FROM projects WHERE id = ?', [id]);
        
        if (currentProject.length === 0) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        // Build SET clause for query
        const setClause = Object.keys(fieldsToUpdate)
            .map(field => `${field} = ?`)
            .join(', ');
        
        const query = `UPDATE projects SET ${setClause}, updated_at = NOW() WHERE id = ?`;
        const values = [...Object.values(fieldsToUpdate), id];

        await db.query(query, values);
        
        const [updatedProject] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);

        // Log the project update
        await logActivity(
            'UPDATE', 
            'PROJECT', 
            id, 
            `Project ${updatedProject[0].projectNo} updated.`,
            { fieldsUpdated: Object.keys(fieldsToUpdate) }
        );

        res.status(200).json(updatedProject[0]);

    } catch (err) {
        console.error('Error updating project:', err);
        res.status(500).json({ 
            error: 'Failed to update project data in the database.',
            details: err.message
        });
    }
});

// --- DELETE /api/projects/:id: Delete a project AND all associated files ---
router.delete('/:id', async (req, res) => {
    const { id } = req.params; 

    try {
        // 1. Get the projectNo and customer before deletion (for logging)
        const [projectResult] = await db.query('SELECT projectNo, customer FROM projects WHERE id = ?', [id]);
        
        if (projectResult.length === 0) {
            return res.status(404).json({ error: 'Project not found with that ID.' });
        }
        const { projectNo, customer } = projectResult[0];

        // 2. Delete all associated file records 
        await deleteAllProjectFiles(projectNo);

        // 3. Delete the project row from the main table
        await db.query('DELETE FROM projects WHERE id = ?', [id]);
        
        // 4. Log the project deletion
        await logActivity(
            'DELETE', 
            'PROJECT', 
            id, 
            `Project ${projectNo} for ${customer} and all associated files deleted.`,
            { projectNo: projectNo, customer: customer }
        );
        
        res.status(204).send();

    } catch (err) {
        console.error('Error deleting project and files:', err);
        res.status(500).json({
            error: 'Failed to delete project, file cleanup may be incomplete.',
            details: err.message
        });
    }
});

// FIXED: This route should return an array, not an object
router.get('/:projectNo/files', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category, taskNo
            FROM project_files 
            WHERE projectNo = ?
        `;
        const params = [projectNo];

        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }

        const [files] = await db.query(query, params);
        
        // FIX: Return array directly for frontend compatibility
        res.json(files);

    } catch (err) {
        console.error('Error fetching files:', err);
        res.status(500).json({ 
            error: 'Failed to retrieve files from database.',
            details: err.message
        });
    }
});

// --- GET /api/projects/file/blob/:id: Stream file BLOB data ---
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

// --- GET /api/projects/completion/:projectNo: Get completion percentages ---
router.get('/completion/:projectNo', async (req, res) => {
    try {
        const { projectNo } = req.params;

        // Validate project exists first
        const [projectCheck] = await db.query(
            'SELECT id FROM projects WHERE projectNo = ?',
            [projectNo]
        );

        if (projectCheck.length === 0) {
            return res.status(404).json({ 
                error: `Project with number ${projectNo} not found` 
            });
        }

        // Calculate completion percentages
        const completion = await calculateCompletionPercentage(projectNo);

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
