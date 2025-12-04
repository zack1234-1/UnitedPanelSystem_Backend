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

// CRITICAL: Use memoryStorage so the file content is available in file.buffer
const storage = multer.memoryStorage(); 

const upload = multer({ 
    storage: storage,
    limits: { 
        // Set a limit large enough for your needs (e.g., 50MB)
        fileSize: 50 * 1024 * 1024 
    } 
});
// =========================================================


// =========================================================
// 🗑️ FILE DELETION HELPERS (Simplified for BLOBs)
// =========================================================

/**
 * Helper to delete all file records for a project from the database.
 * No disk cleanup needed since files are BLOBs.
 * @param {string} projectNo - The project number to clean up.
 */
async function deleteAllProjectFiles(projectNo) {
    // NOTE: Logging this action is done in the main DELETE /api/projects/:id route.
    // 1. Delete file records from the database
    await db.query('DELETE FROM project_files WHERE projectNo = ?', [projectNo]);
    console.log(`Cleaned up all BLOB file records for project ${projectNo}.`);
}

// =========================================================
// 📊 PROJECT COMPLETION CALCULATION
// =========================================================

// Example usage:
// storeCompletionCounts('Project-2025-A', 'panelSlab', 0, 1);

// =========================================================
// 📂 FILE ROUTES (MANAGEMENT)
// =========================================================

router.post('/upload', upload.array('files'), async (req, res) => {
    const { projectNo, category } = req.body;
    const uploadedFiles = req.files; 

    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ error: "No files selected for upload." });
    }

    try {
        // 1. Basic Project existence check
        const [projectResult] = await db.query('SELECT id FROM projects WHERE projectNo = ?', [projectNo]);
        if (projectResult.length === 0) {
            return res.status(404).json({ error: `Project No. ${projectNo} not found.` });
        }
        
        // 2. Prepare database insertion for all uploaded files
        const fileInsertQueries = uploadedFiles.map(file => {
            const fileData = file.buffer; // Contains the BLOB content
            
            // Check if buffer is empty (due to file size limit or other error)
            if (!fileData || fileData.length === 0) {
                console.error(`File: ${file.originalname} has an empty buffer. Check Multer limits!`);
                throw new Error(`Upload failed for ${file.originalname}: File buffer is empty.`);
            }
            
            // Updated query to include category field
            const insertQuery = `
                INSERT INTO project_files 
                (projectNo, file_name, file_size, mime_type, file_data, category) 
                VALUES (?, ?, ?, ?, ?, ?)
            `.trim();
            
            return db.query(insertQuery, [
                projectNo, 
                file.originalname, 
                file.size, 
                file.mimetype, 
                fileData, // BLOB data
                category || null // Add category (can be null if not provided)
            ]);
        });

        const results = await Promise.all(fileInsertQueries);
        
        // 3. Log the successful uploads
        const fileNames = uploadedFiles.map(f => f.originalname).join(', ');
        const projectDbId = projectResult[0].id; 
        
        const logMessage = category 
            ? `${uploadedFiles.length} files uploaded to ${category} category for project ${projectNo}: ${fileNames}`
            : `${uploadedFiles.length} files uploaded for project ${projectNo}: ${fileNames}`;
        
        await logActivity(
            'UPLOAD', 
            'FILE', 
            projectDbId, 
            logMessage,
            { 
                projectNo: projectNo, 
                count: uploadedFiles.length,
                category: category || 'uncategorized'
            }
        );

        const responseMessage = category
            ? `${uploadedFiles.length} files uploaded to ${category} category for project ${projectNo}.`
            : `${uploadedFiles.length} files uploaded to database BLOBs for project ${projectNo}.`;

        res.status(200).json({ 
            message: responseMessage,
            category: category,
            count: uploadedFiles.length
        });

    } catch (err) {
        console.error('File upload database error or buffer issue:', err);
        res.status(500).json({ 
            error: 'Failed to insert file data into the database BLOB column.',
            details: err.message
        });
    }
});


// --- DELETE /api/projects/file/:id: Delete a single file (BLOB FIX) ---
router.delete('/file/:id', async (req, res) => {
    const fileId = req.params.id;

    try {
        // 1. Get file name and projectNo BEFORE deletion (for logging)
        const [fileInfoResult] = await db.query(
            'SELECT file_name, projectNo FROM project_files WHERE id = ?', 
            [fileId]
        );

        if (fileInfoResult.length === 0) {
             // File not found, but we proceed to the main delete just in case
        }
        const fileName = fileInfoResult[0]?.file_name;
        const projectNo = fileInfoResult[0]?.projectNo;

        // 2. Delete the file record from the database (no disk delete needed for BLOB)
        const [deleteResult] = await db.query('DELETE FROM project_files WHERE id = ?', [fileId]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ error: 'File record not found for deletion.' });
        }

        // 3. Log the successful deletion
        if (fileName) {
            await logActivity(
                'DELETE', 
                'FILE', 
                fileId, 
                `Deleted file: '${fileName}' from project ${projectNo}.`,
                { projectNo: projectNo }
            );
        }

        res.status(200).json({ message: 'File deleted successfully from database.' });

    } catch (err) {
        console.error(`Error deleting file ID ${fileId}:`, err);
        res.status(500).json({ 
            error: 'Failed to delete file database record.',
            details: err.message
        });
    }
});


// =========================================================
// 📋 PROJECT ROUTES (CRUD)
// =========================================================

// --- GET /api/projects: Fetch all projects ---
router.get('/', async (req, res) => {
    try {
        const [projects] = await db.query('SELECT * FROM projects ORDER BY id DESC'); 
        res.json(projects); 
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
    const { 
        drawingDate, 
        projectNo, 
        customer, 
        poPayment, 
        requestedDelivery, 
        remarks 
    } = req.body;

    if (!projectNo || !customer) {
        return res.status(400).json({ error: 'Project Number and Customer are required fields.' });
    }

    // NOTE: This query does NOT need trimming as it starts on the same line as the backtick.
    const query = `INSERT INTO projects 
(drawingDate, projectNo, customer, poPayment, requestedDelivery, remarks)
VALUES (?, ?, ?, ?, ?, ?)`; 
    
    const values = [
        drawingDate, 
        projectNo, 
        customer, 
        poPayment, 
        requestedDelivery, 
        remarks
    ];

    try {
        const [result] = await db.query(query, values);
        const [newProject] = await db.query('SELECT * FROM projects WHERE id = ?', [result.insertId]);

        // 1. Log the project creation
        await logActivity( 
            'CREATE', 
            'PROJECT', 
            result.insertId, 
            `New project created: ${projectNo} for ${customer}.`,
            { projectNo: projectNo, customer: customer }
        );

        res.status(201).json(newProject[0]); 

    } catch (err) {
        console.error('Database POST Error (Create Project):', err);
        
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: `Project Number '${projectNo}' already exists.` });
        }

        res.status(500).json({ 
            error: 'Failed to create new project in the database.',
            details: err.message 
        });
    }
});


// --- PUT /api/projects/:id: Update a project ---
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updateFields = req.body; // Capture all fields for update query and logging

    // Prepare query based on all fields provided (simplified query for fixed fields)
    const query = `UPDATE projects SET 
        drawingDate = ?, projectNo = ?, customer = ?, 
        poPayment = ?, requestedDelivery = ?, remarks = ?
        WHERE id = ?`; 
    
    const values = [
        updateFields.drawingDate, updateFields.projectNo, updateFields.customer, updateFields.poPayment, 
        updateFields.requestedDelivery, updateFields.remarks, 
        id
    ];

    try {
        // 1. (Optional but good practice) Fetch current data before update for logging diffs
        // We skip this for brevity and rely on the updated projectNo/customer for the log message.
        
        await db.query(query, values);
        
        const [updatedProject] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);

        if (updatedProject.length === 0) {
            return res.status(404).json({ error: 'Project not found after update attempt.' });
        }
        
        // 2. Log the project update
        await logActivity(
            'UPDATE', 
            'PROJECT', 
            id, 
            `Project ${updatedProject[0].projectNo} updated.`,
            { fieldsUpdated: Object.keys(updateFields) }
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
        
        // 4. Log the project deletion (and file cleanup)
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

router.get('/files/:projectNo', async (req, res) => {
    const { projectNo } = req.params;
    const { category } = req.query;

    try {
        let query = `
            SELECT id, projectNo, file_name, file_size, mime_type, category
            FROM project_files 
            WHERE projectNo = ?
        `;
        const params = [projectNo];

        // Add category filter if provided
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }

        const [files] = await db.query(query, params);
        
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
        // 1. Query the BLOB data and metadata
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

        // 2. Set headers and send the raw buffer
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`); // 'inline' for preview, 'attachment' for download
        
        // 3. Send the BLOB data buffer
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
// 📊 PROJECT COMPLETION ROUTE
// =========================================================

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