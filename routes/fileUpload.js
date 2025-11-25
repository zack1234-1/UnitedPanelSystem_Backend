// Install: npm install express multer
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../db/connection'); // Assuming your database connection
const fs = require('fs'); // For checking/creating directories

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads'); // Root upload directory

// --- Multer Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 1. Get projectNo from the form data (must be passed in the form)
        const projectNo = req.body.projectNo; 
        if (!projectNo) {
            return cb(new Error("Project number is required for file upload."), false);
        }
        
        // 2. Create a dedicated folder for the project (e.g., /uploads/J1001)
        const projectDir = path.join(UPLOAD_DIR, projectNo);
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
        }
        cb(null, projectDir);
    },
    filename: (req, file, cb) => {
        // 3. Create a unique filename (e.g., job123-timestamp.jpg)
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, path.basename(file.originalname, path.extname(file.originalname)) + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
// ----------------------------

// routes/fileUpload.js (continued)

// POST /api/files/upload
router.post('/upload', upload.array('files'), async (req, res) => {
    // 'files' must match the name used in MultiPhotoUploader's FormData key
    const { projectNo } = req.body;
    const uploadedFiles = req.files; // Array of file objects from Multer

    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ error: "No files selected for upload." });
    }

    try {
        // 1. Find the project ID based on projectNo
        const [projectResult] = await db.query('SELECT id FROM projects WHERE projectNo = ?', [projectNo]);

        if (projectResult.length === 0) {
            return res.status(404).json({ error: `Project No. ${projectNo} not found.` });
        }
        const projectId = projectResult[0].id;

        // 2. Insert each file record into the project_files table
        const fileInsertQueries = uploadedFiles.map(file => {
            const relativePath = path.join(path.basename(file.destination), file.filename);
            
            return db.query(
                'INSERT INTO project_files (project_id, file_name, file_path, upload_date) VALUES (?, ?, ?, NOW())', 
                [projectId, file.originalname, relativePath]
            );
        });

        await Promise.all(fileInsertQueries);

        res.status(200).json({ 
            message: `${uploadedFiles.length} files uploaded successfully for project ${projectNo}.` 
        });

    } catch (err) {
        console.error('File upload database error:', err);
        res.status(500).json({ error: 'Failed to process file records in database.' });
    }
});

module.exports = router;